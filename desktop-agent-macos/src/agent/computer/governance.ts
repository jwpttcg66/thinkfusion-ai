import { COMPUTER_KEYS, ComputerError, SNAPSHOT_TTL_MS, controlIsSensitive, keyIsSensitive, type ComputerFrame, type StoredSnapshot } from './types';

const MUTATING = new Set(['click', 'type', 'keypress', 'scroll', 'drag', 'focus']);

export function isMutatingComputerAction(action: string): boolean {
  return MUTATING.has(action);
}

export interface ActionCheck {
  action: 'click' | 'type' | 'keypress' | 'scroll' | 'drag' | 'focus';
  preset: 'read-only' | 'workspace-write' | 'danger-full-access';
  snapshot: StoredSnapshot | null;
  now: number;
  stopped: boolean;
  bundleId?: string;
  elementId?: string;
  point?: { x: number; y: number };
  endPoint?: { x: number; y: number };
  key?: string;
  modifiers?: string[];
  confirmRisk?: boolean;
  liveBundleId?: string | null;
}

function inside(point: { x: number; y: number }, frame: ComputerFrame): boolean {
  return point.x >= frame.x && point.y >= frame.y
    && point.x < frame.x + frame.width && point.y < frame.y + frame.height;
}

function insideScreen(point: { x: number; y: number }, snapshot: StoredSnapshot): boolean {
  if (snapshot.windowFrame && snapshot.windowFrame.width > 0 && snapshot.windowFrame.height > 0) {
    return inside(point, snapshot.windowFrame);
  }
  if (!snapshot.screen || snapshot.screen.width <= 0 || snapshot.screen.height <= 0) {
    throw new ComputerError('TARGET_UNCERTAIN', '快照没有屏幕尺寸，不能使用坐标');
  }
  return point.x >= 0 && point.y >= 0 && point.x < snapshot.screen.width && point.y < snapshot.screen.height;
}

/** 操作前的硬门槛。不过就抛错，调用方不得把请求送进 Helper。 */
export function assertComputerAction(input: ActionCheck): void {
  if (input.stopped) throw new ComputerError('CANCELLED', '桌面操作已停止');
  if (input.preset === 'read-only') {
    throw new ComputerError('PERMISSION_REQUIRED', '当前权限为“仅可查看”，不能点击、输入、滚动或改变窗口');
  }
  if (!input.snapshot) throw new ComputerError('SNAPSHOT_EXPIRED', '没有操作前快照');
  if (input.now - input.snapshot.capturedAt > SNAPSHOT_TTL_MS) {
    throw new ComputerError('SNAPSHOT_EXPIRED', '快照已过期，需要重新观察');
  }
  if (!input.bundleId) throw new ComputerError('TARGET_UNCERTAIN', '必须写明目标应用的 bundleId');
  if (!input.snapshot.appBundleId || input.snapshot.appBundleId !== input.bundleId) {
    throw new ComputerError('TARGET_UNCERTAIN', '目标应用与快照里的前台应用不一致');
  }
  // loginwindow 会在锁屏/切换时冒充前台，不能据此作废目标应用的控件快照。
  if (
    input.liveBundleId
    && input.liveBundleId !== 'com.apple.loginwindow'
    && input.liveBundleId !== input.snapshot.appBundleId
  ) {
    throw new ComputerError('WINDOW_CHANGED', '前台应用已经变了，旧快照作废');
  }

  const element = input.elementId ? input.snapshot.elements.get(input.elementId) : undefined;
  if (input.elementId && !element) throw new ComputerError('TARGET_UNCERTAIN', '快照里没有这个控件');

  if (input.action === 'click' || input.action === 'scroll') {
    if (!element && !input.point) throw new ComputerError('TARGET_UNCERTAIN', '没有控件，也没有落在快照里的坐标');
    if (input.point && !insideScreen(input.point, input.snapshot)) {
      throw new ComputerError('SNAPSHOT_EXPIRED', '坐标不在这份快照的窗口或屏幕范围内');
    }
  }
  if (input.action === 'type' && !element) {
    throw new ComputerError('TARGET_UNCERTAIN', '输入必须指向快照里的控件，不能对着未知焦点打字');
  }
  if (input.action === 'drag') {
    if (!input.point || !input.endPoint) throw new ComputerError('TARGET_UNCERTAIN', '拖动必须给出起点和终点');
    if (!insideScreen(input.point, input.snapshot) || !insideScreen(input.endPoint, input.snapshot)) {
      throw new ComputerError('SNAPSHOT_EXPIRED', '拖动坐标不在这份快照范围内');
    }
  }
  if (input.action === 'keypress') {
    if (!input.key || !(COMPUTER_KEYS as readonly string[]).includes(input.key)) {
      throw new ComputerError('UNSUPPORTED_ACTION', '这个按键不在允许列表里');
    }
    const modifiers = input.modifiers ?? [];
    if (modifiers.some(item => !['command', 'shift', 'option', 'control'].includes(item))) {
      throw new ComputerError('UNSUPPORTED_ACTION', '不认识的修饰键');
    }
  }
  if (input.action === 'focus' && input.elementId === undefined && input.snapshot.windowId === undefined && !input.bundleId) {
    throw new ComputerError('TARGET_UNCERTAIN', '没有可聚焦的窗口');
  }

  const sensitive = controlIsSensitive(element) || (input.action === 'keypress' && keyIsSensitive(input.key ?? '', input.modifiers ?? []));
  if (sensitive && input.confirmRisk !== true) {
    throw new ComputerError('RISK_CONFIRMATION_REQUIRED', '这个控件或快捷键涉及删除、发送、提交或关闭，需要 confirmRisk=true 才会执行');
  }
}
