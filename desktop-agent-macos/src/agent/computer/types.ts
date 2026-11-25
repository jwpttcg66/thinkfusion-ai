import { COMPUTER_KEYS, type PermissionPreset, type TaskGrant } from '../../shared/contracts';
import { redactSecrets } from '../../shared/redact';

/** 一份快照在多久之内还能被拿来操作。窗口会动，过期坐标不能继续用。 */
export const SNAPSHOT_TTL_MS = 15_000;
export const MAX_TYPED_TEXT = 2_000;

export { COMPUTER_KEYS };
export type ComputerKey = (typeof COMPUTER_KEYS)[number];

export const COMPUTER_MODIFIERS = ['command', 'shift', 'option', 'control'] as const;

export class ComputerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ComputerError';
    this.code = code;
  }
}

export function isComputerError(error: unknown): error is ComputerError {
  return error instanceof ComputerError || (
    typeof error === 'object' && error !== null && 'code' in error && 'message' in error
    && typeof (error as { code: unknown }).code === 'string'
  );
}

export interface ComputerFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputerElement {
  elementId: string;
  role: string;
  title?: string;
  value?: string;
  frame?: ComputerFrame;
  windowId?: string;
}

export interface ComputerWindow {
  windowId: string;
  title: string;
  app?: string;
  bundleId?: string;
  frame?: ComputerFrame;
}

export interface ComputerScreen {
  width: number;
  height: number;
  scaleFactor: number;
}

export interface StoredSnapshot {
  snapshotId: string;
  capturedAt: number;
  appName?: string;
  appBundleId?: string;
  windowId?: string;
  windowFrame?: ComputerFrame;
  screen?: ComputerScreen;
  screenshotRef?: string;
  accessibilityTreeRef?: string;
  windows: ComputerWindow[];
  elements: Map<string, ComputerElement>;
  tree: Record<string, unknown> | null;
}

export interface ComputerEventRecord {
  type: string;
  taskId: string;
  runId: string;
  stepId?: string;
  actionId?: string;
  snapshotId?: string;
  windowId?: string;
  sequence: number;
  timestamp: number;
  permissionDecision: string;
  evidenceRefs: string[];
}

export interface ComputerExpectation {
  textIncludes?: string;
  /** 计划里常把要比对的文字写在 value。核对时与 textIncludes 相同。 */
  value?: string;
  role?: string;
  title?: string;
  windowId?: string;
}

export interface ComputerArgs {
  maxDepth?: number;
  target?: 'screen' | 'region';
  region?: { x: number; y: number; width: number; height: number };
  path?: string;
  snapshotId?: string;
  bundleId?: string;
  /** 应用名。计划没写 bundleId 时，用它对应到已知应用。 */
  app?: string;
  windowId?: string;
  elementId?: string;
  role?: string;
  title?: string;
  value?: string;
  text?: string;
  key?: string;
  modifiers?: string[];
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  deltaX?: number;
  deltaY?: number;
  confirmRisk?: boolean;
  maxEntries?: number;
  expect?: ComputerExpectation;
}

export interface ComputerCallContext {
  stepId?: string;
  isCancelled?: () => boolean;
}

export interface ComputerToolResult {
  domain: 'computer';
  verified: boolean;
  supported: boolean;
  available?: boolean;
  code?: string;
  platform: string;
  taskId: string;
  runId: string;
  stepId?: string;
  actionId?: string;
  snapshotId?: string;
  windowId?: string;
  bundleId?: string;
  appName?: string;
  permissionDecision: string;
  summary: string;
  screenshotRef?: string;
  accessibilityTreeRef?: string;
  found?: boolean;
  element?: { elementId: string; role: string; title?: string; value?: string; frame?: ComputerFrame };
  elements?: Array<{ elementId: string; role: string; title?: string; frame?: ComputerFrame }>;
  windows?: ComputerWindow[];
  tree?: Record<string, unknown> | null;
  truncated?: boolean;
  trusted?: boolean;
  commands?: string[];
  actions?: string[];
  textSummary?: string;
  method?: string;
  verification?: { verified: boolean; reason: string };
  events: ComputerEventRecord[];
  evidenceRefs: string[];
}

export interface ComputerBridge {
  available(): Promise<{ ok: boolean; code?: string; message?: string }>;
  call(command: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
}

export interface ScreenShot {
  path: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
}

const SECRET_KEY = /password|token|secret|cookie|authorization|credential/i;
const SENSITIVE_CONTROL = /password|secure|密码|删除|支付|付款|购买|发送|提交|delete|pay|purchase|send|submit/i;

export function redactComputerArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactComputerArgs);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactSecrets(value) : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' && (SECRET_KEY.test(key) || redactSecrets(item) !== item)) {
      out[key] = `***（已隐藏，长度 ${item.length}）`;
      continue;
    }
    out[key] = redactComputerArgs(item);
  }
  return out;
}

export function textSummary(text: string): string {
  const hidden = redactComputerArgs({ text }) as { text: string };
  if (hidden.text !== text) return hidden.text;
  return text.length > 80 ? `${text.slice(0, 80)}…（长度 ${text.length}）` : text;
}

export function controlIsSensitive(element?: { role?: string; title?: string } | null): boolean {
  if (!element) return false;
  return SENSITIVE_CONTROL.test(`${element.role ?? ''} ${element.title ?? ''}`);
}

export function keyIsSensitive(key: string, modifiers: readonly string[]): boolean {
  if (!modifiers.includes('command')) return false;
  return key === 'q' || key === 'w' || key === 'delete' || key === 'forwarddelete';
}

export function permissionDecision(preset: PermissionPreset, action: string): string {
  return `${preset}:${action}`;
}

export function assertGrantFresh(grant: TaskGrant): void {
  if (!Number.isFinite(grant.expiresAt) || Date.now() > grant.expiresAt) {
    throw new ComputerError('PERMISSION_REQUIRED', '任务授权已过期');
  }
}
