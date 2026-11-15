/**
 * 终端会话的**进程状态**与**连接状态**。
 *
 * 这两件事以前混在一起：面板 detach 会被误读成进程退出，反之亦然。现在分开记：
 * 进程状态只由真实进程事件驱动，连接状态只由界面 attach/detach 驱动。
 *
 * 关于 `CANCELLED`：它表示**取消请求最终成功终止了进程**，不是「用户点过取消」。
 * 取消失败、超时或强杀失败都保留 `FAILED` 并带错误信息，不粉饰成已取消。
 */

export type TerminalProcessState =
  | 'STARTING'
  | 'RUNNING'
  | 'EXITING'
  | 'EXITED'
  | 'FAILED'
  | 'CANCELLED';

export type TerminalConnectionState = 'ATTACHED' | 'DETACHED';

export interface TerminalStateInput {
  exited: boolean;
  exitCode?: number | null;
  signal?: string | null;
  cancelled?: boolean;
  timedOut?: boolean;
  /** 取消/关闭动作是否失败（例如强杀也没成功）。 */
  terminateFailed?: boolean;
  /** 进程是否还没完成启动。 */
  starting?: boolean;
  /** 是否正在走终止流程。 */
  exiting?: boolean;
}

/** 从真实事件推出状态；输入不自洽时优先报 FAILED，不猜一个好看的状态。 */
export function deriveTerminalState(input: TerminalStateInput): TerminalProcessState {
  if (input.terminateFailed) return 'FAILED';
  if (input.starting && !input.exited) return 'STARTING';
  if (!input.exited) return input.exiting ? 'EXITING' : 'RUNNING';
  if (input.cancelled) return 'CANCELLED';
  if (input.timedOut) return 'FAILED';
  if (input.signal) return 'FAILED';
  if (input.exitCode === undefined || input.exitCode === null || input.exitCode === 0) return 'EXITED';
  return 'FAILED';
}

/** 状态栏文案；不把 FAILED 写成「已退出」，退出码和信号要如实带上。 */
export function describeTerminalState(input: TerminalStateInput & { state?: TerminalProcessState }): string {
  const state = input.state ?? deriveTerminalState(input);
  switch (state) {
    case 'STARTING': return '启动中';
    case 'RUNNING': return '运行中';
    case 'EXITING': return '正在终止';
    case 'EXITED': return `已退出（exit ${String(input.exitCode ?? 0)}）`;
    case 'CANCELLED': return '已取消并终止';
    case 'FAILED':
      return input.terminateFailed
        ? '终止失败（进程可能仍在运行）'
        : input.timedOut
          ? '超时终止'
          : input.signal
            ? `被信号终止（${input.signal}）`
            : `异常退出（exit ${String(input.exitCode ?? '?')}）`;
  }
}

/** 时长的展示形式：一秒以内显示毫秒，避免状态栏一直写「0 秒」。 */
export function describeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}
