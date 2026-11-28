import type { AgentTask, ExecutionReport, StepResult } from './contracts';

/**
 * 「换手段再来一轮」（V4 P1 M3-4b）。
 *
 * 存在的理由：GDC 判 `stop_and_wait` 时状态留在 `report_pending`，那里的三个按钮里
 * 「继续修复」先过 `verificationIsComplete`——验证四类检查全过、但目标仍有未满足标准时，
 * 它当场抛「这一轮已经完成全部检查，不需要继续修复」，另两个出口都是收尾。也就是说
 * 「按人说的换个做法再来」这条最常用的人工介入，在界面上根本没有入口。
 *
 * 这里只放**判定与清单**，不开轮次：开轮次要过预算门禁（M3-3 的单一读点），那是主进程的事。
 */

/**
 * 允许用户要求再来一轮的状态。
 *
 * `report_pending`：判定停在待确认（或人自己选了停下等），三个收尾按钮之外要有「再来一轮」。
 * `awaiting_next_round`：M3-4c 关掉自动续轮后的落点——判定已给出「该开下一轮」，等人点。
 *
 * 只列这两个：`paused` / `interrupted` / `blocked` / `budget_exhausted` 本来各自已有出口
 * （「继续任务」「追加并继续」），把同一颗按钮摊到七个状态上等于没有出口约束；而
 * `planning` / `executing` 正在跑，这时候插一轮只会两条线抢同一个工作区。
 */
export const CONTINUE_ROUND_STATUSES: readonly AgentTask['status'][] = ['report_pending', 'awaiting_next_round'];

export function isContinueRoundAllowed(status: AgentTask['status']): boolean {
  return CONTINUE_ROUND_STATUSES.includes(status);
}

/**
 * 报告已经落在用户手里、可以就地收尾的状态（M3-4 的「接受未验证并结束」出口）。
 *
 * 原来只认 `report_pending`，于是关掉无人值守停在 `awaiting_next_round` 的人反而比留着
 * 自动续轮的人少一条出口：要么再烧一整轮模型去够那颗按钮，要么点取消——把已经交付的
 * 东西记成没交付。收口判据本身没变（还是那份报告、那套验证缺口），变的只是停下的原因。
 */
export const DELIVERY_CLOSE_STATUSES: readonly AgentTask['status'][] = ['report_pending', 'awaiting_next_round'];

export function isDeliveryCloseAllowed(status: AgentTask['status']): boolean {
  return DELIVERY_CLOSE_STATUSES.includes(status);
}

/**
 * 停在这里时给用户的那句话（M3-4c「每一类停止原因都要可解释」的唯一出处）。
 *
 * 界面与活动流共用它：两处各写一遍的话，一边说「等你点继续」、另一边说「验证待你决定」，
 * 用户就分不清到底是设置停的还是判定停的。
 */
export function continueExitText(status: AgentTask['status']): { headline: string; howBack: string } | null {
  if (status === 'report_pending') {
    return {
      headline: '验证待你决定 · 未通过闸门，需选出口',
      howBack: '想按自己的判断再做一轮，写下指令点「换手段再来一轮」；不想再做就「接受未验证并结束」。'
    };
  }
  if (status === 'awaiting_next_round') {
    return {
      headline: '判定要开下一轮，按你的设置停在这里',
      // 按钮在这一档叫「继续下一轮」（App.tsx 按状态换标签），措辞得指对那颗按钮，
      // 否则「怎么回来」指的是一颗在此刻并不存在的按钮。
      // 「无人值守续轮」那句必须写清只影响之后的边界：开关是下一轮收口时才读的
      // （orchestrator.ts 的 continueAfterReport），在这里拨一下不会让已停的任务动起来。
      howBack: '点「继续下一轮」才开新一轮；这一轮的报告已经在手里，不想再做就「接受未验证并结束」。统计页的「无人值守续轮」只管之后的边界，拨开它仍要点一次「继续下一轮」。'
    };
  }
  return null;
}

/**
 * 这一轮该不该自动开（M3-4c）。
 *
 * 只认显式的 `false`：字段是后加的，老任务、老存档都没有它，把缺省读成「关」等于给每个
 * 存量任务悄悄改了行为（原来会自己开轮，升级后全停在待确认）。
 */
export function autoContinueOf(task: Pick<AgentTask, 'autoContinue'> | null | undefined): boolean {
  return task?.autoContinue !== false;
}

/**
 * 一条手段里最能说明「做了什么」的那个参数。
 *
 * 顺序挑而不是全量倒出：计划请求要的是「上一轮拿什么做的」，把 args 整坨贴进去，
 * 模型看到的还是同一份参数，等于没换。挑不到的键再退到第一个字符串值。
 */
const MEAN_KEYS = ['command', 'path', 'url', 'query', 'pattern', 'task', 'selector', 'script'] as const;

function cut(value: string, max = 96): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function meansHint(step: StepResult): string {
  const args = step.args;
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  for (const key of MEAN_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return `${key}=${cut(value)}`;
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && value.trim()) return `${key}=${cut(value)}`;
  }
  return '';
}

/**
 * 上一轮真实用过的做法清单（含结果），随新一轮计划请求下发。
 *
 * 只说「换个手段」没法核对：模型下一轮照样能交同一批调用。点名到「哪条命令、
 * 结果如何」之后，重复没重复是看得出来的。计数用 `×n`，同一条命令跑三遍比列三行
 * 更能说明「上一轮就是在原地打转」。
 */
export function meansOfRound(report: ExecutionReport | null | undefined, cap = 12): string[] {
  if (!report) return [];
  const counts = new Map<string, number>();
  for (const step of report.results ?? []) {
    const hint = meansHint(step);
    const outcome = step.status === 'failed' ? '（失败）' : step.status === 'skipped' ? '（跳过）' : '';
    const line = `${step.tool}${hint ? ` ${hint}` : ''}${outcome}`;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const lines = [...counts].map(([line, n]) => (n > 1 ? `${line} ×${String(n)}` : line));
  if (lines.length === 0) return [];
  const shown = lines.slice(0, cap);
  const rest = lines.length - shown.length;
  return rest > 0 ? [...shown, `…另有 ${String(rest)} 条没列出`] : shown;
}
