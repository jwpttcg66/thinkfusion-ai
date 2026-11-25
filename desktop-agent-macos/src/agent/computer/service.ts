import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TaskGrant } from '../../shared/contracts';
import { redactSecrets } from '../../shared/redact';
import { captureScreen, CAPTURE_DIR } from '../tools/screen';
import { MacComputerBridge } from './bridge';
import { assertComputerAction } from './governance';
import {
  ComputerError,
  MAX_TYPED_TEXT,
  SNAPSHOT_TTL_MS,
  assertGrantFresh,
  permissionDecision,
  textSummary,
  type ComputerArgs,
  type ComputerBridge,
  type ComputerCallContext,
  type ComputerElement,
  type ComputerEventRecord,
  type ComputerExpectation,
  type ComputerFrame,
  type ComputerScreen,
  type ComputerToolResult,
  type ComputerWindow,
  type ScreenShot,
  type StoredSnapshot
} from './types';

interface Session {
  stopped: boolean;
  sequence: number;
  snapshots: Map<string, StoredSnapshot>;
}

export interface ComputerServiceOptions {
  bridge?: ComputerBridge;
  now?: () => number;
  platform?: NodeJS.Platform;
  evidenceDir?: string;
  capture?: (grant: TaskGrant, args: ComputerArgs, cacheOnly: boolean) => Promise<ScreenShot>;
  timeoutMs?: number;
}

const READ_ACTIONS = ['capabilities', 'windows', 'screenshot', 'tree', 'find', 'verify', 'stop'] as const;
const WRITE_ACTIONS = ['click', 'type', 'keypress', 'scroll', 'drag', 'focus'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asFrame(value: unknown): ComputerFrame | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function redactNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNode);
  const record = asRecord(value);
  if (!record) return typeof value === 'string' ? redactSecrets(value) : value;
  const title = typeof record.title === 'string' ? record.title : '';
  const role = typeof record.role === 'string' ? record.role : '';
  const sensitive = /password|secure|密码/i.test(`${role} ${title}`);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === 'value' && typeof item === 'string') {
      out[key] = sensitive ? `***（已隐藏，长度 ${item.length}）` : redactSecrets(item);
    } else if (key === 'children') out[key] = redactNode(item);
    else out[key] = item;
  }
  return out;
}

function flatten(node: unknown, into: Map<string, ComputerElement>): void {
  const record = asRecord(node);
  if (!record) return;
  const elementId = typeof record.id === 'string' ? record.id : '';
  const role = typeof record.role === 'string' ? record.role : '';
  if (elementId && role) {
    const element: ComputerElement = { elementId, role };
    if (typeof record.title === 'string' && record.title) element.title = record.title;
    if (typeof record.value === 'string') element.value = record.value;
    const frame = asFrame(record.frame);
    if (frame) element.frame = frame;
    into.set(elementId, element);
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) flatten(child, into);
  }
}

function elementList(snapshot: StoredSnapshot) {
  return [...snapshot.elements.values()].slice(0, 200).map(element => ({
    elementId: element.elementId,
    role: element.role,
    ...(element.title ? { title: element.title } : {}),
    ...(element.frame ? { frame: element.frame } : {})
  }));
}

function expectationGiven(expect?: ComputerExpectation): boolean {
  return Boolean(expect && (expect.textIncludes || expect.value || expect.role || expect.title || expect.windowId));
}

function checkExpectation(snapshot: StoredSnapshot, expect?: ComputerExpectation): { verified: boolean; reason: string } {
  if (!expectationGiven(expect)) return { verified: false, reason: '没有可核对的预期' };
  const elements = [...snapshot.elements.values()];
  if (expect?.role && !elements.some(element => element.role === expect.role)) {
    return { verified: false, reason: `重新观察后没有 role=${expect.role} 的控件` };
  }
  if (expect?.title && !elements.some(element => (element.title ?? '').includes(expect.title!))) {
    return { verified: false, reason: '重新观察后没有标题匹配的控件' };
  }
  if (expect?.textIncludes || expect?.value) {
    const needle = expect.textIncludes || expect.value || '';
    const visible = redactSecrets(needle) === needle;
    const hit = elements.some(element => `${element.value ?? ''}\n${element.title ?? ''}`.includes(needle));
    if (!hit) return { verified: false, reason: visible ? `重新观察后没有看到「${needle}」` : '重新观察后没有看到预期文本' };
  }
  if (expect?.windowId && snapshot.windowId !== expect.windowId && !snapshot.windows.some(window => window.windowId === expect.windowId)) {
    return { verified: false, reason: '目标窗口不在重新观察的结果里' };
  }
  return { verified: true, reason: '重新观察与预期一致' };
}

const KNOWN_APP_BUNDLES: Record<string, string> = {
  textedit: 'com.apple.TextEdit',
  finder: 'com.apple.finder',
  访达: 'com.apple.finder',
  safari: 'com.apple.Safari',
  notes: 'com.apple.Notes',
  备忘录: 'com.apple.Notes'
};

export class ComputerService {
  private readonly bridge: ComputerBridge;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly evidenceDir: string;
  private readonly capture: (grant: TaskGrant, args: ComputerArgs, cacheOnly: boolean) => Promise<ScreenShot>;
  private readonly timeoutMs: number;
  private readonly sessions = new Map<string, Session>();

  constructor(options: ComputerServiceOptions = {}) {
    this.bridge = options.bridge ?? new MacComputerBridge();
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.evidenceDir = options.evidenceDir ?? CAPTURE_DIR;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.capture = options.capture ?? (async (grant, args, cacheOnly) => {
      const shot = await captureScreen(grant, {
        target: args.target,
        region: args.region,
        path: cacheOnly ? undefined : args.path
      }, { cacheOnly });
      return { path: shot.path, bytes: shot.bytes, width: shot.width, height: shot.height, sha256: shot.sha256 };
    });
  }

  private session(taskId: string): Session {
    let found = this.sessions.get(taskId);
    if (!found) {
      found = { stopped: false, sequence: 0, snapshots: new Map() };
      this.sessions.set(taskId, found);
    }
    return found;
  }

  private base(grant: TaskGrant, action: string, ctx: ComputerCallContext): Pick<ComputerToolResult, 'domain' | 'platform' | 'taskId' | 'runId' | 'stepId' | 'permissionDecision' | 'events' | 'evidenceRefs' | 'supported'> {
    return {
      domain: 'computer',
      platform: this.platform,
      taskId: grant.taskId,
      runId: grant.taskId,
      stepId: ctx.stepId,
      permissionDecision: permissionDecision(grant.permissionPreset, action),
      events: [],
      evidenceRefs: [],
      supported: this.platform === 'darwin'
    };
  }

  private event(grant: TaskGrant, session: Session, ctx: ComputerCallContext, type: string, extra: Partial<ComputerEventRecord>): ComputerEventRecord {
    session.sequence += 1;
    return {
      type,
      taskId: grant.taskId,
      runId: grant.taskId,
      stepId: ctx.stepId,
      sequence: session.sequence,
      timestamp: this.now(),
      permissionDecision: extra.permissionDecision ?? permissionDecision(grant.permissionPreset, type),
      evidenceRefs: extra.evidenceRefs ?? [],
      actionId: extra.actionId,
      snapshotId: extra.snapshotId,
      windowId: extra.windowId
    };
  }

  private async withSignal<T>(session: Session, ctx: ComputerCallContext, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new ComputerError('TIMEOUT', '桌面操作超时'));
    }, this.timeoutMs);
    const poll = setInterval(() => {
      if (session.stopped || ctx.isCancelled?.()) {
        controller.abort(new ComputerError('CANCELLED', '桌面操作已取消'));
      }
    }, 40);
    try {
      if (session.stopped || ctx.isCancelled?.()) {
        throw new ComputerError('CANCELLED', '桌面操作已取消');
      }
      return await run(controller.signal);
    } catch (error) {
      const aborted = controller.signal.reason;
      if (controller.signal.aborted && aborted instanceof ComputerError) {
        if (!(error instanceof ComputerError) || error.code === 'CANCELLED' || error.code === 'TIMEOUT') {
          throw aborted;
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
    }
  }

  private unsupported(grant: TaskGrant, action: string, ctx: ComputerCallContext): ComputerToolResult {
    const session = this.session(grant.taskId);
    const event = this.event(grant, session, ctx, 'computer.capability.checked', {});
    return {
      ...this.base(grant, action, ctx),
      verified: true,
      supported: false,
      available: false,
      code: 'UNSUPPORTED_PLATFORM',
      summary: `当前平台 ${this.platform} 没有桌面控制实现`,
      events: [event]
    };
  }

  private async ensureDarwin(grant: TaskGrant, action: string, ctx: ComputerCallContext): Promise<void> {
    assertGrantFresh(grant);
    if (this.platform !== 'darwin') {
      throw new ComputerError('UNSUPPORTED_PLATFORM', `当前平台 ${this.platform} 没有桌面控制实现`);
    }
    if (ctx.isCancelled?.()) throw new ComputerError('CANCELLED', '桌面操作已取消');
    void action;
  }

  private async writeEvidence(snapshot: StoredSnapshot): Promise<string | undefined> {
    const file = path.join(this.evidenceDir, `${snapshot.snapshotId}.computer.json`);
    const body = {
      snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt,
      appName: snapshot.appName,
      appBundleId: snapshot.appBundleId,
      windowId: snapshot.windowId,
      screen: snapshot.screen,
      screenshotRef: snapshot.screenshotRef,
      windows: snapshot.windows,
      tree: redactNode(snapshot.tree)
    };
    await fs.mkdir(this.evidenceDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(body));
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0) return undefined;
    return file;
  }

  private fresh(snapshot: StoredSnapshot | null | undefined): snapshot is StoredSnapshot {
    if (!snapshot) return false;
    return this.now() - snapshot.capturedAt <= SNAPSHOT_TTL_MS;
  }

  /** 这份任务刚看过、还没过期的快照。bundleId 对不上的不用。 */
  private latestFresh(session: Session, bundleId?: string): StoredSnapshot | null {
    return [...session.snapshots.values()]
      .filter(item => this.fresh(item))
      .filter(item => !bundleId || item.appBundleId === bundleId)
      .sort((left, right) => right.capturedAt - left.capturedAt)[0] ?? null;
  }

  /**
   * 计划在观察之前就得写下 snapshotId，那个号当时还不存在。
   * 已经发过、但过期的号仍然拒绝；从没发过的号改用这份任务刚看到的快照。
   */
  private async bindSnapshot(
    grant: TaskGrant,
    session: Session,
    ctx: ComputerCallContext,
    args: ComputerArgs
  ): Promise<StoredSnapshot> {
    if (args.snapshotId) {
      const named = session.snapshots.get(args.snapshotId) ?? null;
      if (named && this.fresh(named)) return named;
      const usesCoordinate = typeof args.x === 'number' || typeof args.fromX === 'number';
      if (named && usesCoordinate) throw new ComputerError('SNAPSHOT_EXPIRED', '快照已过期，需要重新观察');
    }
    const latest = this.latestFresh(session, args.bundleId);
    if (latest) return latest;
    return this.observe(grant, ctx, session, undefined, args.bundleId);
  }

  private isPlaceholderElementId(value?: string): boolean {
    if (!value) return true;
    return /[{}<>]|step-\d|返回|elementId|snapshotId/i.test(value) || !/^p\d+(\.\d+)*$/.test(value);
  }

  /** 计划里的控件号也是事先写的。对得上就用；只有一个文本框时，点击和输入都用它。 */
  private resolveElement(snapshot: StoredSnapshot, args: ComputerArgs, action: string): string | undefined {
    if (args.elementId && !this.isPlaceholderElementId(args.elementId) && snapshot.elements.has(args.elementId)) {
      return args.elementId;
    }
    if (action === 'keypress' || action === 'scroll' || action === 'focus') return undefined;
    const writable = [...snapshot.elements.values()].filter(element =>
      element.role === 'AXTextField' || element.role === 'AXTextArea' || element.role === 'AXTextView'
      || element.role === 'AXSearchField' || element.role === 'AXComboBox'
    );
    if ((action === 'type' || action === 'click') && writable.length === 1) return writable[0].elementId;
    return undefined;
  }

  private missingElement(snapshot: StoredSnapshot, args: ComputerArgs): ComputerError {
    const sample = [...snapshot.elements.values()]
      .slice(0, 8)
      .map(element => `${element.elementId}:${element.role}`)
      .join(', ');
    return new ComputerError('TARGET_UNCERTAIN', `快照 ${snapshot.snapshotId} 里没有控件 ${args.elementId}。可见：${sample || '无'}`);
  }

  private async observe(
    grant: TaskGrant,
    ctx: ComputerCallContext,
    session: Session,
    screenshot?: ScreenShot,
    targetBundleId?: string
  ): Promise<StoredSnapshot> {
    const payload = targetBundleId ? { maxDepth: 6, bundleId: targetBundleId } : { maxDepth: 6 };
    const raw = await this.withSignal(session, ctx, signal => this.bridge.call('observe', payload, signal));
    const application = asRecord(raw.application);
    const screenRaw = asRecord(raw.screen);
    const screen: ComputerScreen | undefined = screenRaw
      ? { width: Number(screenRaw.width) || 0, height: Number(screenRaw.height) || 0, scaleFactor: Number(screenRaw.scaleFactor) || 1 }
      : undefined;
    const windows: ComputerWindow[] = Array.isArray(raw.windows)
      ? raw.windows.flatMap(item => {
          const record = asRecord(item);
          if (!record || typeof record.windowId !== 'string') return [];
          const window: ComputerWindow = { windowId: record.windowId, title: typeof record.title === 'string' ? record.title : '' };
          if (typeof record.app === 'string') window.app = record.app;
          if (typeof record.bundleId === 'string') window.bundleId = record.bundleId;
          const frame = asFrame(record.frame);
          if (frame) window.frame = frame;
          return [window];
        })
      : [];
    const tree = asRecord(raw.tree);
    const elements = new Map<string, ComputerElement>();
    if (tree) flatten(tree, elements);
    const bundleId = typeof application?.bundleId === 'string' ? application.bundleId : targetBundleId;
    const matched = windows.find(window => !bundleId || window.bundleId === bundleId) ?? windows[0];
    const snapshot: StoredSnapshot = {
      snapshotId: `snap_${randomUUID()}`,
      capturedAt: this.now(),
      appName: typeof application?.name === 'string' ? application.name : undefined,
      appBundleId: bundleId,
      windowId: matched?.windowId,
      windowFrame: matched?.frame,
      screen: screen && screen.width > 0 && screen.height > 0 ? screen : undefined,
      screenshotRef: screenshot?.path,
      windows,
      elements,
      tree
    };
    const evidence = await this.writeEvidence(snapshot);
    snapshot.accessibilityTreeRef = evidence;
    session.snapshots.set(snapshot.snapshotId, snapshot);
    return snapshot;
  }

  private describe(snapshot: StoredSnapshot, summary: string, verified: boolean, events: ComputerEventRecord[], extra: Partial<ComputerToolResult> = {}): ComputerToolResult {
    const treeText = snapshot.tree ? JSON.stringify(redactNode(snapshot.tree)) : '';
    const truncated = treeText.length > 80_000;
    return {
      domain: 'computer',
      verified,
      supported: true,
      platform: this.platform,
      taskId: events[0]?.taskId ?? '',
      runId: events[0]?.runId ?? '',
      permissionDecision: events[0]?.permissionDecision ?? '',
      summary,
      snapshotId: snapshot.snapshotId,
      windowId: snapshot.windowId,
      bundleId: snapshot.appBundleId,
      appName: snapshot.appName,
      screenshotRef: snapshot.screenshotRef,
      accessibilityTreeRef: snapshot.accessibilityTreeRef,
      elements: elementList(snapshot),
      windows: snapshot.windows.slice(0, 50),
      tree: truncated ? null : (redactNode(snapshot.tree) as Record<string, unknown> | null),
      truncated,
      events,
      evidenceRefs: snapshot.accessibilityTreeRef ? [snapshot.accessibilityTreeRef] : [],
      ...extra
    };
  }

  async capabilities(grant: TaskGrant, ctx: ComputerCallContext = {}): Promise<ComputerToolResult> {
    if (this.platform !== 'darwin') return this.unsupported(grant, 'capabilities', ctx);
    assertGrantFresh(grant);
    const session = this.session(grant.taskId);
    const presence = await this.bridge.available();
    let trusted = false;
    let commands: string[] = [];
    let code = presence.code;
    if (presence.ok) {
      try {
        const probed = await this.withSignal(session, ctx, signal => this.bridge.call('capabilities', {}, signal));
        trusted = probed.trusted === true;
        commands = Array.isArray(probed.commands) ? probed.commands.filter((item): item is string => typeof item === 'string') : [];
        if (!trusted) code = 'PERMISSION_REQUIRED';
      } catch (error) {
        code = error instanceof ComputerError ? error.code : 'HELPER_FAILED';
      }
    }
    const event = this.event(grant, session, ctx, 'computer.capability.checked', {});
    return {
      ...this.base(grant, 'capabilities', ctx),
      verified: true,
      available: presence.ok && trusted,
      trusted,
      code: presence.ok && trusted ? undefined : code,
      commands,
      actions: [...READ_ACTIONS, ...WRITE_ACTIONS],
      summary: presence.ok && trusted ? 'macOS 桌面控制可用' : `macOS 桌面控制不可用：${code ?? '未知原因'}`,
      events: [event]
    };
  }

  async windows(grant: TaskGrant, args: ComputerArgs = {}, ctx: ComputerCallContext = {}): Promise<ComputerToolResult> {
    await this.ensureDarwin(grant, 'windows', ctx);
    const session = this.session(grant.taskId);
    const snapshot = await this.observe(grant, ctx, session);
    const limit = Math.min(Math.max(args.maxEntries ?? 50, 1), 200);
    const event = this.event(grant, session, ctx, 'computer.snapshot.created', {
      snapshotId: snapshot.snapshotId,
      windowId: snapshot.windowId,
      evidenceRefs: snapshot.accessibilityTreeRef ? [snapshot.accessibilityTreeRef] : []
    });
    return {
      ...this.describe(snapshot, `读到 ${String(Math.min(snapshot.windows.length, limit))} 个窗口`, true, [event]),
      taskId: grant.taskId,
      runId: grant.taskId,
      stepId: ctx.stepId,
      permissionDecision: permissionDecision(grant.permissionPreset, 'windows'),
      windows: snapshot.windows.slice(0, limit)
    };
  }

  async screenshot(grant: TaskGrant, args: ComputerArgs = {}, ctx: ComputerCallContext = {}): Promise<ComputerToolResult> {
    await this.ensureDarwin(grant, 'screenshot', ctx);
    if (grant.permissionPreset === 'read-only' && args.path) {
      throw new ComputerError('PERMISSION_REQUIRED', '只读截屏不能指定工作区路径');
    }
    const session = this.session(grant.taskId);
    const cacheOnly = grant.permissionPreset === 'read-only' || !args.path;
    const shot = await this.capture(grant, args, cacheOnly);
    const snapshot = await this.observe(grant, ctx, session, shot);
    const event = this.event(grant, session, ctx, 'computer.snapshot.created', {
      snapshotId: snapshot.snapshotId,
      windowId: snapshot.windowId,
      evidenceRefs: [shot.path, ...(snapshot.accessibilityTreeRef ? [snapshot.accessibilityTreeRef] : [])]
    });
    return {
      ...this.describe(snapshot, '已截取当前屏幕并记下快照', true, [event], { screenshotRef: shot.path }),
      taskId: grant.taskId,
      runId: grant.taskId,
      stepId: ctx.stepId,
      permissionDecision: permissionDecision(grant.permissionPreset, 'screenshot'),
      evidenceRefs: [shot.path, ...(snapshot.accessibilityTreeRef ? [snapshot.accessibilityTreeRef] : [])]
    };
  }

  async tree(grant: TaskGrant, args: ComputerArgs = {}, ctx: ComputerCallContext = {}): Promise<ComputerToolResult> {
    await this.ensureDarwin(grant, 'tree', ctx);
    const session = this.session(grant.taskId);
    if (!args.bundleId && args.app) args.bundleId = KNOWN_APP_BUNDLES[args.app.trim().toLowerCase()];
    const snapshot = await this.observe(grant, { ...ctx }, session, undefined, args.bundleId);
    const event = this.event(grant, session, ctx, 'computer.snapshot.created', {
      snapshotId: snapshot.snapshotId,
      windowId: snapshot.windowId,
      evidenceRefs: snapshot.accessibilityTreeRef ? [snapshot.accessibilityTreeRef] : []
    });
    return {
      ...this.describe(snapshot, `读到 ${String(snapshot.elements.size)} 个控件`, true, [event]),
      taskId: grant.taskId,
      runId: grant.taskId,
      stepId: ctx.stepId,
      permissionDecision: permissionDecision(grant.permissionPreset, 'tree')
    };
  }

  async find(grant: TaskGrant, args: ComputerArgs, ctx: ComputerCallContext = {}): Promise<ComputerToolResult> {
    await this.ensureDarwin(grant, 'find', ctx);
    if (!args.role && !args.title && !args.value) {
      throw new ComputerError('TARGET_UNCERTAIN', '查找至少要给 role、title 或 value 之一');
    }
    const session = this.session(grant.taskId);
    if (!args.bundleId && args.app) args.bundleId = KNOWN_APP_BUNDLES[args.app.trim().toLowerCase()];
    let snapshot = args.snapshotId ? session.snapshots.get(args.snapshotId) ?? null : null;
    if (snapshot && !this.fresh(snapshot)) snapshot = null;
    if (snapshot && args.bundleId && snapshot.appBundleId && snapshot.appBundleId !== args.bundleId) snapshot = null;
    if (!snapshot) {
      snapshot = this.latestFresh(session, args.bundleId) ?? await this.observe(grant, ctx, session, undefined, args.bundleId);
    }
    const needle = (value?: string) => (value ?? '').toLowerCase();
    const found = [...snapshot.elements.values()].find(element => {
      if (args.role && element.role !== args.role) return false;
      if (args.title && !needle(element.title).includes(needle(args.title))) return false;
      if (args.value && !needle(element.value).includes(needle(args.value))) return false;
      return true;
    });
    const createdNow = !args.snapshotId;
    const events = [
      ...(createdNow ? [this.event(grant, session, ctx, 'computer.snapshot.created', {
        snapshotId: snapshot.snapshotId,
        windowId: snapshot.windowId,
        evidenceRefs: snapshot.accessibilityTreeRef ? [snapshot.accessibilityTreeRef] : []
      })] : []),
      ...(found ? [this.event(grant, session, ctx, 'computer.element.found', {
        snapshotId: snapshot.snapshotId,
        windowId: snapshot.windowId
      })] : [])
    ];
    const safeValue = found?.value ? redactSecrets(found.value) : undefined;
    return {
      ...this.describe(snapshot, found ? `找到 ${found.role}${found.title ? `「${found.title}」` : ''}` : '没有匹配的控件', true, events, {
        found: Boolean(found),
        element: found ? {
          elementId: found.elementId,
          role: found.role,
          title: found.title,
          value: safeValue && safeValue !== found.value ? `***（已隐藏，长度 ${found.value?.length ?? 0}）` : found?.value?.slice(0, 200),
          frame: found.frame
        } : undefined
      }),
      taskId: grant.taskId,
      runId: grant.taskId,
      stepId: ctx.stepId,
      permissionDecision: permissionDecision(grant.permissionPreset, 'find')
    };
  }

  private async liveBundle(session: Session, ctx: ComputerCallContext): Promise<string | null> {
    const raw = await this.withSignal(session, ctx, signal => this.bridge.call('frontmostApplication', {}, signal));
    return typeof raw.bundleId === 'string' ? raw.bundleId : null;
  }

  private async act(
    grant: TaskGrant,
    action: 'click' | 'type' | 'keypress' | 'scroll' | 'drag' | 'focus',
    args: ComputerArgs,
    ctx: ComputerCallContext,
    command: string,
    payload: Record<string, unknown>
  ): Promise<ComputerToolResult> {
    await this.ensureDarwin(grant, action, ctx);
    const session = this.session(grant.taskId);
    if (session.stopped || ctx.isCancelled?.()) throw new ComputerError('CANCELLED', '桌面操作已取消');
    if (grant.permissionPreset === 'read-only') {
      throw new ComputerError('PERMISSION_REQUIRED', '当前权限为“仅可查看”，不能点击、输入、滚动或改变窗口');
    }
    if (!args.bundleId && args.app) {
      args.bundleId = KNOWN_APP_BUNDLES[args.app.trim().toLowerCase()];
    }
    let snapshot = await this.bindSnapshot(grant, session, ctx, args);
    if (!args.bundleId) args.bundleId = snapshot.appBundleId;
    let liveBundleId = await this.liveBundle(session, ctx);
    const needsTarget = Boolean(args.bundleId);
    const frontWrong = needsTarget && liveBundleId && liveBundleId !== args.bundleId;
    const appWrong = needsTarget && snapshot.appBundleId && snapshot.appBundleId !== args.bundleId;
    if (frontWrong || appWrong) {
      await this.withSignal(session, ctx, signal => this.bridge.call('focus', { bundleId: args.bundleId }, signal));
      snapshot = await this.observe(grant, ctx, session, undefined, args.bundleId);
      liveBundleId = await this.liveBundle(session, ctx);
    }
    let elementId = this.resolveElement(snapshot, args, action);
    if ((action === 'click' || action === 'type') && !elementId) {
      snapshot = await this.observe(grant, ctx, session, undefined, args.bundleId);
      elementId = this.resolveElement(snapshot, args, action);
    }
    if ((action === 'click' || action === 'type') && !elementId) {
      if (args.elementId && !this.isPlaceholderElementId(args.elementId)) throw this.missingElement(snapshot, args);
      throw new ComputerError('TARGET_UNCERTAIN', `目标应用 ${args.bundleId ?? ''} 里没有可输入的文本框`);
    }
    const point = typeof args.x === 'number' && typeof args.y === 'number' ? { x: args.x, y: args.y } : undefined;
    const endPoint = typeof args.fromX === 'number' ? { x: args.fromX, y: args.fromY ?? 0 } : undefined;
    const dragEnd = typeof args.toX === 'number' ? { x: args.toX, y: args.toY ?? 0 } : undefined;
    assertComputerAction({
      action,
      preset: grant.permissionPreset,
      snapshot,
      now: this.now(),
      stopped: session.stopped,
      bundleId: args.bundleId,
      elementId,
      point: action === 'drag' ? endPoint : point,
      endPoint: action === 'drag' ? dragEnd : undefined,
      key: args.key,
      modifiers: args.modifiers,
      confirmRisk: args.confirmRisk,
      liveBundleId
    });
    const current = snapshot as StoredSnapshot;
    const element = elementId ? current.elements.get(elementId) : undefined;
    const actionId = randomUUID();
    const requested = this.event(grant, session, ctx, 'computer.action.requested', {
      actionId,
      snapshotId: current.snapshotId,
      windowId: current.windowId
    });
    const started = this.event(grant, session, ctx, 'computer.action.started', {
      actionId,
      snapshotId: current.snapshotId,
      windowId: current.windowId
    });
    let method = 'ax';
    try {
      const response = await this.withSignal(session, ctx, signal => this.bridge.call(command, {
        ...payload,
        elementId,
        expectedRole: element?.role,
        expectedTitle: element?.title,
        bundleId: args.bundleId,
        windowId: current.windows.some(item => item.windowId === args.windowId) ? args.windowId : current.windowId,
        allowCoordinate: action === 'click' || action === 'scroll' || action === 'drag' ? !elementId : false
      }, signal));
      if (typeof response.method === 'string') method = response.method;
    } catch (error) {
      const failed = this.event(grant, session, ctx, 'computer.action.failed', {
        actionId,
        snapshotId: current.snapshotId,
        windowId: current.windowId
      });
      if (error instanceof ComputerError) {
        error.message = `${error.message}`;
      }
      void failed;
      throw error;
    }
    const after = await this.observe(grant, ctx, session, undefined, args.bundleId);
    const verification = checkExpectation(after, args.expect);
    const completed = this.event(grant, session, ctx, 'computer.action.completed', {
      actionId,
      snapshotId: after.snapshotId,
      windowId: after.windowId,
      evidenceRefs: after.accessibilityTreeRef ? [after.accessibilityTreeRef] : []
    });
    const verifiedEvent = this.event(grant, session, ctx, verification.verified ? 'computer.verification.completed' : 'computer.verification.failed', {
      actionId,
      snapshotId: after.snapshotId,
      windowId: after.windowId
    });
    const summary = verification.verified
      ? `${action} 已执行，重新观察与预期一致`
      : `${action} 已执行，但${verification.reason}`;
    return {
      ...this.describe(after, summary, verification.verified, [requested, started, completed, verifiedEvent], {
        actionId,
        method,
        code: verification.verified ? undefined : 'NOT_VERIFIED',
        verification,
        textSummary: typeof args.text === 'string' ? textSummary(args.text) : undefined
      }),
      taskId: grant.taskId,
      runId: grant.taskId,
      stepId: ctx.stepId,
      permissionDecision: permissionDecision(grant.permissionPreset, action)
    };
  }

  click(grant: TaskGrant, args: ComputerArgs, ctx: ComputerCallContext = {}) {
    return this.act(grant, 'click', args, ctx, 'press', {
      x: args.x,
      y: args.y
    });
  }

  typeText(grant: TaskGrant, args: ComputerArgs, ctx: ComputerCallContext = {}) {
    const text = args.text ?? '';
    if (!text) return Promise.reject(new ComputerError('TARGET_UNCERTAIN', '没有要输入的文本'));
    if (text.length > MAX_TYPED_TEXT) return Promise.reject(new ComputerError('INPUT_TOO_LARGE', `文本超过 ${String(MAX_TYPED_TEXT)} 个字符`));
    return this.act(grant, 'type', args, ctx, 'setValue', { text });
  }

  keypress(grant: TaskGrant, args: ComputerArgs, ctx: ComputerCallContext = {}) {
    return this.act(grant, 'keypress', args, ctx, 'keypress', { key: args.key, modifiers: args.modifiers ?? [] });
  }

  scroll(grant: TaskGrant, args: ComputerArgs, ctx: ComputerCallContext = {}) {
    const deltaX = Math.max(-5_000, Math.min(5_000, args.deltaX ?? 0));
    const deltaY = Math.max(-5_000, Math.min(5_000, args.deltaY ?? 0));
    if (deltaX === 0 && deltaY === 0) return Promise.reject(new ComputerError('TARGET_UNCERTAIN', '滚动距离是 0'));
    return this.act(grant, 'scroll', args, ctx, 'scroll', { deltaX, deltaY, x: args.x, y: args.y });
  }

  drag(grant: TaskGrant, args: ComputerArgs, ctx: ComputerCallContext = {}) {
    return this.act(grant, 'drag', args, ctx, 'drag', {
      x: args.fromX,
      y: args.fromY,
      x2: args.toX,
      y2: args.toY
    });
  }

  focus(grant: TaskGrant, args: ComputerArgs, ctx: ComputerCallContext = {}) {
    return this.act(grant, 'focus', args, ctx, 'focus', { windowId: args.windowId });
  }

  async verify(grant: TaskGrant, args: ComputerArgs, ctx: ComputerCallContext = {}): Promise<ComputerToolResult> {
    await this.ensureDarwin(grant, 'verify', ctx);
    const session = this.session(grant.taskId);
    if (!args.bundleId && args.app) args.bundleId = KNOWN_APP_BUNDLES[args.app.trim().toLowerCase()];
    const after = await this.observe(grant, ctx, session, undefined, args.bundleId);
    if (args.bundleId && after.appBundleId && args.bundleId !== after.appBundleId) {
      const verification = { verified: false, reason: '前台应用与要核对的 bundleId 不一致' };
      const event = this.event(grant, session, ctx, 'computer.verification.failed', { snapshotId: after.snapshotId, windowId: after.windowId });
      return {
        ...this.describe(after, verification.reason, false, [event], { code: 'NOT_VERIFIED', verification }),
        taskId: grant.taskId,
        runId: grant.taskId,
        stepId: ctx.stepId,
        permissionDecision: permissionDecision(grant.permissionPreset, 'verify')
      };
    }
    const verification = checkExpectation(after, args.expect ?? {
      textIncludes: args.value,
      role: args.role,
      title: args.title,
      windowId: args.windowId
    });
    const event = this.event(grant, session, ctx, verification.verified ? 'computer.verification.completed' : 'computer.verification.failed', {
      snapshotId: after.snapshotId,
      windowId: after.windowId,
      evidenceRefs: after.accessibilityTreeRef ? [after.accessibilityTreeRef] : []
    });
    return {
      ...this.describe(after, verification.reason, verification.verified, [event], {
        code: verification.verified ? undefined : 'NOT_VERIFIED',
        verification
      }),
      taskId: grant.taskId,
      runId: grant.taskId,
      stepId: ctx.stepId,
      permissionDecision: permissionDecision(grant.permissionPreset, 'verify')
    };
  }

  async stop(grant: TaskGrant, ctx: ComputerCallContext = {}): Promise<ComputerToolResult> {
    assertGrantFresh(grant);
    const session = this.session(grant.taskId);
    session.stopped = true;
    const event = this.event(grant, session, ctx, 'computer.action.cancelled', {});
    return {
      ...this.base(grant, 'stop', ctx),
      verified: true,
      supported: this.platform === 'darwin',
      summary: '已停止后续桌面操作',
      events: [event]
    };
  }
}

export const computer = new ComputerService();
