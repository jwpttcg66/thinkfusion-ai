/**
 * 工程任务 → 一条按时间推进的对话流（纯投影，无 React、无 DOM）。
 *
 * 为什么需要它：对话页原先只画「当前状态」——最新一轮的成员输出、最新的验证、
 * 最新的评审。于是后面一轮把前面一轮覆盖掉，中间执行过程只在输出页的执行日志里，
 * 最后也没有一句话的结论。对话是主界面，它必须像一次真实的协作记录：
 *
 *   我提了什么 → 谁怎么答的 → 中间真跑了什么 → 每一轮的结论 → 最后的结论
 *
 * 规则：
 * - 成员按 `roundId + memberId` 累积，新一轮**不清空**上一轮的卡片；
 * - 执行步骤直接复用 `buildTimeline`（它已经做到同一 stepId 跨轮不串）；
 * - 协议 JSON（`desktop-agent/v1`）照实保留原文，但单独标出来，不让它冒充结论；
 * - 结论只写真实发生过的事：`task.completed.summary`、执行报告、验证、评审。
 */

import type {
  AgentEvent,
  DiffFileStat,
  ExecutionReport,
  PlanDebate,
  PlanDebateResultSlice,
  PlanPreview,
  ReviewIssueDetail
} from './contracts';
import { buildTimeline, type StepCard } from './execution-timeline';
import { contextEventView } from './context';
import { artifactPaths, diagnosticsOfReport, verificationIsComplete, type TaskView } from './task-view';

export type ConversationTone = 'info' | 'ok' | 'warn' | 'error' | 'muted';

export type ConversationProtocol =
  | 'plan'
  | 'execution_report'
  | 'clarification_required'
  | 'task_complete'
  | null;

export interface ConversationEntryBase {
  key: string;
  at: number;
  roundId: string | null;
  roundNumber: number | null;
}

/**
 * 统一呈现状态（阶段 B1）。
 *
 * **只用于呈现**，不替代业务状态：`member.status` 仍是
 * streaming/completed/failed/cancelled，`debate.status` 仍是
 * running/completed/stopped/skipped——`stopped` 不能因为这里叫 completed 就被吞掉。
 */
export type ConversationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

/** 旁注的类型（阶段 B2）。新代码不许再用 `text.startsWith` 猜类型。 */
export type NoteSubtype =
  | 'round'
  | 'context'
  | 'breakdown'
  | 'context_request'
  | 'context_package'
  | 'participation'
  /** 预算（M3-3）：超限暂停与追加预算两条旁注共用一类。 */
  | 'budget'
  | 'decision'
  | 'goal_fit'
  | 'clarification'
  | 'milestone'
  | 'diff'
  | 'system';

/**
 * 聚合条目的位置与更新（阶段 B3，见规格 §1.3）。
 *
 * `firstAt` 决定时间轴位置且**永不改写**；`updatedAt` 只表示最近一次更新。
 * 投影原地更新同一 `aggregateKey` 的条目，绝不改底层历史事件。
 */
export interface AggregateTrace {
  aggregateKey: string;
  firstEventId: string;
  lastEventId: string;
  firstAt: number;
  updatedAt: number;
}

/** 改动量摘要（阶段 B3）：数字只来自真实 diff，拿不到就 `available:false`。 */
export interface DiffSummary {
  files: number;
  insertions?: number;
  deletions?: number;
  /** `false` 专指「取 diff 失败」。老报告没有统计信息时这里是 `undefined`，只显示文件数。 */
  available?: boolean;
  /** 逐文件明细（阶段 1）；只有报告带 `diffFiles` 且明细完整时才有。 */
  fileStats?: DiffFileStat[];
  /** `false` 表示明细不完整（如未跟踪文件无法采集），界面不得伪造清单。 */
  filesAvailable?: boolean;
}

export type ConversationEntry =
  | (ConversationEntryBase & { kind: 'user'; text: string })
  | (ConversationEntryBase & {
      kind: 'note';
      text: string;
      tone: ConversationTone;
      detail?: string;
      /** 类型化旁注：生成点直接标注，呈现层不必再猜前缀。 */
      subtype: NoteSubtype;
      /** 聚合旁注（如改动量）带的位置与更新痕迹；非聚合条目没有。 */
      aggregate?: AggregateTrace;
      /** 改动量摘要；只有 `subtype:'diff'` 且拿到真实统计时才有。 */
      diff?: DiffSummary;
    })
  | (ConversationEntryBase & {
      kind: 'member';
      memberId: string;
      label: string;
      status: 'streaming' | 'completed' | 'failed' | 'cancelled';
      text: string;
      reasoning: string;
      reasoningSupported: boolean;
      durationMs: number | null;
      error: string | null;
      protocol: ConversationProtocol;
    })
  | (ConversationEntryBase & { kind: 'step'; card: StepCard })
  /**
   * D1 子 Agent：从 `code.team.run` 真实返回的 proposals 抽出，不是把普通
   * step 改名冒充。身份 `agentId`、角色、耗时、输出全部来自那次真实执行。
   */
  | (ConversationEntryBase & {
      kind: 'agent';
      /** 真实执行主体 id（proposal.agentId）；不为展示新造 AgentRun 身份。 */
      agentId: string;
      /** explore / code / verify / review，来自真实 team 结果。 */
      role: string;
      label: string;
      /** 承担的子任务：这次 team.run 的 task。 */
      task: string;
      status: 'completed' | 'failed';
      /** 所属 step 的开始时间；不是每个 agent 各自的独立开始时间，不伪造。 */
      stepStartedAt: number | null;
      /** 真实耗时 proposal.durationMs；没有就不写。 */
      durationMs: number | null;
      /** 真实输出原文。 */
      text: string;
      error: string | null;
      /** 真实补丁数；没有就不写。 */
      patchCount?: number;
      /** 上游交接的真实摘要行。 */
      context: string[];
      /** 关联的真实执行步骤 key，可回溯到原始 step 卡。 */
      stepKey: string;
      /** 对应 WorkTask：只有 agentTaskId / assignedAgent 真实命中才写。 */
      workTask?: { workTaskId: string; title: string };
    })
  | (ConversationEntryBase & {
      kind: 'plan';
      planId: string;
      title: string;
      description: string;
      completion: string;
      steps: PlanPreview['steps'];
      warnings: string[];
    })
  | (ConversationEntryBase & {
      kind: 'debate';
      /** running 只来自心跳；plan.debated 之后变成 completed / stopped / skipped。 */
      status: 'running' | PlanDebate['status'];
      topics: string[];
      /** 与 topics 一一对应；老事件没有。 */
      topicGoals?: string[];
      /** 需要对什么表达立场；老事件没有。 */
      expressTarget?: string;
      /** 表态要产出什么判断；老事件没有。 */
      expressGoal?: string;
      /** 主导模型五段原文；老事件没有。 */
      leadSummary?: string;
      participants: string[];
      summary: string;
      /** 结构化切片；老事件没有。 */
      result?: PlanDebateResultSlice;
      rounds?: number;
      maxRounds?: number;
      roundsReason?: string;
      skippedReason?: string;
      /** 为什么开这场评审。 */
      reason?: string;
      elapsedMs: number;
    })
  | (ConversationEntryBase & {
      kind: 'verification';
      /** 第几次验证：同一任务的每次报告各占一条，不覆盖。 */
      index: number;
      verified: boolean;
      /** 代码改动是否四项检查全部通过；界面的「已通过」用它，不用单项 verified。 */
      fullyVerified: boolean;
      reasons: string[];
      changedFiles: number;
      checks: NonNullable<ExecutionReport['verification']>['checks'];
      diagnostics: TaskView['diagnostics'];
      reportStatus: ExecutionReport['status'];
      completedSteps: number;
      totalSteps: number;
    })
  | (ConversationEntryBase & {
      kind: 'review';
      /** 第几次独立评审；每次 review.ready 各占一条。 */
      index: number;
      reviewer: string;
      backend: 'model' | 'rules';
      verdict: string;
      rawVerdict?: string;
      issues: string[];
      issueDetails?: ReviewIssueDetail[];
      needsFix: boolean;
    })
  /**
   * 轮间 / 执行前桥接：先画出「对什么质疑、对什么回应、将执行哪些步骤」，
   * 再开下一轮或动手。没有这条卡就看不出下一轮从哪来。
   */
  | (ConversationEntryBase & {
      kind: 'bridge';
      bridgeKind: 'review' | 'execution';
      action: 'continue' | 'stop' | 'execute';
      /** 下一轮阶段：质疑 / 回应；执行桥接没有。 */
      nextPhase?: 'challenge' | 'response';
      title: string;
      message: string;
      targets: Array<{ left: string; right: string; reason: string; agents?: [string, string] }>;
      steps?: Array<{ index: number; tool: string; description: string; target?: string }>;
      tone: ConversationTone;
    })
  | (ConversationEntryBase & {
      kind: 'conclusion';
      text: string;
      facts: string[];
      /** 执行目标：计划标题 + 完成条件；老投影没有。 */
      executionGoal?: string;
      /** 逐步执行结果原文摘要；老投影没有。 */
      executionResults?: string[];
      /** 目标物：改动文件与工程产物路径；老投影没有。 */
      deliverables?: string[];
      tone: ConversationTone;
    });

/**
 * 去掉 Markdown 代码围栏。
 *
 * 模型经常把协议写成 ```json … ``` 交回来；直接 JSON.parse 会失败，于是整段
 * 机器 JSON 被当成正文铺满屏幕——真机第一次验证就是这个样子。
 */
function unfence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

/**
 * 认出协议对象。
 *
 * 模型在工程空间里返回的是 `desktop-agent/v1` 的 JSON（计划 / 执行报告 /
 * 澄清请求 / 完成消息）。原文必须留着（它是证据），但它不是「给我的结论」，
 * 界面上要分开写，否则用户读到的最后一句就是一大段机器 JSON。
 */
export function protocolKind(text: string): ConversationProtocol {
  const body = unfence(text);
  if (!body.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(body) as { protocol?: unknown; type?: unknown };
    if (parsed.protocol !== 'desktop-agent/v1') return null;
    // `clarification_required` 才是协议里的真值；旧的 request 写法留着兼容。
    if (parsed.type === 'clarification_required' || parsed.type === 'clarification_request') {
      return 'clarification_required';
    }
    if (parsed.type === 'plan' || parsed.type === 'execution_report' || parsed.type === 'task_complete') {
      return parsed.type;
    }
    return null;
  } catch {
    return null;
  }
}

/** 协议对象里那句给人看的话：`summary` 优先，计划退到标题。 */
export function protocolSummary(text: string): string | null {
  try {
    const parsed = JSON.parse(unfence(text)) as {
      summary?: unknown;
      title?: unknown;
      plan?: { title?: unknown };
    };
    if (typeof parsed.summary === 'string' && parsed.summary.trim()) return parsed.summary.trim();
    // 计划标题有两种落点：顶层 `title`（模型常见写法）与 `plan.title`。
    if (typeof parsed.plan?.title === 'string' && parsed.plan.title.trim()) return parsed.plan.title.trim();
    if (typeof parsed.title === 'string' && parsed.title.trim()) return parsed.title.trim();
    return null;
  } catch {
    return null;
  }
}

/**
 * 协议对象的可读推导（主页面用）：不铺 JSON，只抽出计划步骤 / 完成声明。
 *
 * 工程空间里模型经常整段返回 plan JSON；若主页面只留「见下方 / 见输出页」，
 * 思考与主推导会一起丢掉。这里给人看的推导骨架，原文仍去输出页。
 */
export function protocolDerivation(text: string): string | null {
  try {
    const parsed = JSON.parse(unfence(text)) as {
      type?: unknown;
      summary?: unknown;
      title?: unknown;
      plan?: {
        title?: unknown;
        completion?: { condition?: unknown };
        steps?: Array<{ tool?: unknown; description?: unknown; args?: Record<string, unknown> }>;
      };
      steps?: Array<{ tool?: unknown; description?: unknown }>;
    };
    if (parsed.type === 'plan') {
      const steps = Array.isArray(parsed.plan?.steps)
        ? parsed.plan!.steps!
        : Array.isArray(parsed.steps) ? parsed.steps : [];
      const title = (typeof parsed.plan?.title === 'string' && parsed.plan.title.trim())
        || (typeof parsed.title === 'string' && parsed.title.trim())
        || (typeof parsed.summary === 'string' && parsed.summary.trim())
        || '计划';
      const lines = [`【计划】${title}`];
      const condition = parsed.plan?.completion?.condition;
      if (typeof condition === 'string' && condition.trim()) {
        lines.push(`完成条件：${condition.trim()}`);
      }
      for (const [index, step] of steps.entries()) {
        const tool = typeof step.tool === 'string' ? step.tool : '步骤';
        const desc = typeof step.description === 'string' && step.description.trim()
          ? step.description.trim()
          : '';
        lines.push(`${String(index + 1)}. ${tool}${desc ? ` — ${desc}` : ''}`);
      }
      return lines.join('\n');
    }
    if (parsed.type === 'task_complete') {
      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
      return summary ? `【完成声明】${summary}` : '【完成声明】';
    }
    if (parsed.type === 'execution_report') {
      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
      return summary ? `【执行报告】${summary}` : '【执行报告】已返回';
    }
    if (parsed.type === 'clarification_required' || parsed.type === 'clarification_request') {
      return '【澄清请求】模型需要补充信息后才能继续';
    }
    return protocolSummary(text);
  } catch {
    return null;
  }
}

/** 系统套话，不能单独当「任务完成结论」。 */
function isGenericConclusion(text: string): boolean {
  const trimmed = text.trim();
  return /^(任务完成|执行完成|执行完成[，,]验证通过|完成|完成。|任务完成。)$/.test(trimmed);
}

/** 工具 stdout/文本预览：完整展示，只在极端超长时截断并标明。 */
function textPreview(value: string, max = 4000): string {
  const trimmed = value.replace(/\s+$/u, '');
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…（已截断，原文 ${String(trimmed.length)} 字符）`;
}

function argPath(step: { args?: Record<string, unknown>; result?: unknown }): string {
  const fromArgs = typeof step.args?.path === 'string' ? step.args.path : '';
  if (fromArgs) return fromArgs;
  const result = step.result;
  if (result && typeof result === 'object' && 'path' in result && typeof (result as { path: unknown }).path === 'string') {
    return (result as { path: string }).path;
  }
  return '';
}

/** 子 Agent 角色 → 呈现名。未知角色照实显示 id，不猜一个中文名冒充。 */
const AGENT_ROLE_LABEL: Record<string, string> = {
  explore: '探索',
  code: '编码',
  verify: '验证',
  review: '评审'
};

export function agentRoleLabel(role: string): string {
  return AGENT_ROLE_LABEL[role] ?? role;
}

interface TeamProposalView {
  agentId: string;
  role: string;
  text: string;
  durationMs: number | null;
  failure: string | null;
  patchCount: number | undefined;
  context: string[];
}

/**
 * 从 `code.team.run` 的真实 result 抽 proposals。
 *
 * 只有字段确实存在才出卡；result 结构不对、proposal 没有 agentId/role
 * 时返回空——宁可不出卡，也不伪造一个 AgentRun（不变量 14）。
 */
function teamProposalsOf(result: unknown): { task: string; proposals: TeamProposalView[] } | null {
  if (!result || typeof result !== 'object') return null;
  const data = result as Record<string, unknown>;
  if (!Array.isArray(data.proposals)) return null;
  const task = typeof data.task === 'string' ? data.task : '';
  const proposals: TeamProposalView[] = [];
  for (const item of data.proposals) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.agentId !== 'string' || !row.agentId.trim()) continue;
    if (typeof row.role !== 'string' || !row.role.trim()) continue;
    proposals.push({
      agentId: row.agentId,
      role: row.role,
      text: typeof row.text === 'string' ? row.text : '',
      durationMs: typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) ? row.durationMs : null,
      failure: typeof row.failure === 'string' && row.failure.trim() ? row.failure : null,
      patchCount: Array.isArray(row.patches) ? row.patches.length : undefined,
      context: Array.isArray(row.context)
        ? row.context.filter((line): line is string => typeof line === 'string')
        : []
    });
  }
  return { task, proposals };
}

/**
 * WorkTask ↔ Agent 的真实关联表。
 *
 * 只有 `assignedAgent` / `agentTaskId` 确实等于 team proposal 的 agentId
 * 才算关联；对不上就不写 workTask，不靠猜把两者绑在一起。
 */
function agentWorkTasksOf(
  events: readonly AgentEvent[]
): Map<string, { workTaskId: string; title: string }> {
  const map = new Map<string, { workTaskId: string; title: string }>();
  for (const event of events) {
    if (event.type !== 'work.task.upserted') continue;
    const task = event.task;
    for (const id of [task.assignedAgent, task.agentTaskId]) {
      if (typeof id !== 'string' || !id.trim()) continue;
      if (!map.has(id)) map.set(id, { workTaskId: task.workTaskId, title: task.title });
    }
  }
  return map;
}

/**
 * 从执行报告步骤结果抽出可展示的交付事实（只陈述工具返回值）。
 *
 * 完成与失败都收录：执行结果必须完整可见，不能只留「验证通过」四个字。
 */
export function reportDeliveryFacts(report: ExecutionReport): string[] {
  const facts: string[] = [];
  for (const step of report.results ?? []) {
    const result = step.result as unknown;
    if (step.status === 'failed') {
      const path = argPath(step);
      const err = typeof step.error === 'string' && step.error.trim()
        ? step.error.trim()
        : (result && typeof result === 'object' && 'message' in result
          ? String((result as { message: unknown }).message)
          : '失败');
      facts.push(`${step.tool}${path ? ` ${path}` : ''}：${err}`);
      continue;
    }
    if (step.status === 'skipped') {
      const path = argPath(step);
      // 续跑复用但上轮证据没还原回来时报告里仍是 skipped：这时写「复用自上次执行」，
      // 不能写「已跳过」——那会把「上一轮真做过」说成「这一步没做」。
      facts.push(`${step.tool}${path ? ` ${path}` : ''}：${step.reusedFrom ? '复用自上次执行（本轮未重跑）' : '已跳过'}`);
      continue;
    }
    if (step.status !== 'completed') continue;

    if (step.tool === 'fs.list' && Array.isArray(result)) {
      const names = result
        .map(item => {
          if (item && typeof item === 'object' && 'name' in item && typeof (item as { name: unknown }).name === 'string') {
            return (item as { name: string }).name;
          }
          return null;
        })
        .filter((name): name is string => Boolean(name));
      if (names.length > 0) facts.push(`目录内容：${names.slice(0, 40).join('、')}${names.length > 40 ? '…' : ''}`);
      continue;
    }
    if (step.tool === 'fs.tree' && result && typeof result === 'object') {
      const tree = result as { entries?: unknown; root?: unknown };
      if (Array.isArray(tree.entries)) {
        const names = tree.entries
          .map(item => (item && typeof item === 'object' && 'name' in item
            ? String((item as { name: unknown }).name)
            : null))
          .filter((name): name is string => Boolean(name));
        if (names.length > 0) facts.push(`目录树条目：${names.slice(0, 40).join('、')}`);
      }
      continue;
    }
    if (step.tool === 'fs.readFile' && result && typeof result === 'object') {
      const read = result as { path?: unknown; content?: unknown; totalLines?: unknown };
      const path = typeof read.path === 'string' ? read.path : argPath(step);
      const preview = typeof read.content === 'string' ? textPreview(read.content, 800) : '';
      if (path && preview) facts.push(`已读 ${path}：\n${preview}`);
      else if (path) facts.push(`已读 ${path}`);
      continue;
    }
    if (
      step.tool === 'fs.writeFile' || step.tool === 'fs.edit' || step.tool === 'fs.mkdir' ||
      step.tool === 'fs.remove' || step.tool === 'fs.move' || step.tool === 'fs.copy'
    ) {
      const path = argPath(step);
      const to = typeof step.args?.to === 'string' ? step.args.to
        : typeof step.args?.destination === 'string' ? step.args.destination : '';
      if (path && to) facts.push(`${step.tool}：${path} → ${to}`);
      else if (path) facts.push(`${step.tool}：${path}`);
      else facts.push(`${step.tool}：已完成`);
      continue;
    }
    if ((step.tool === 'shell.run' || step.tool === 'test.run' || step.tool === 'code.run') && result && typeof result === 'object') {
      const run = result as { stdout?: unknown; stderr?: unknown; exitCode?: unknown; command?: unknown };
      const command = typeof run.command === 'string' && run.command.trim()
        ? run.command.trim()
        : (typeof step.args?.command === 'string' ? step.args.command : step.tool);
      const exit = typeof run.exitCode === 'number' ? `退出码 ${String(run.exitCode)}` : '';
      const out = typeof run.stdout === 'string' && run.stdout.trim() ? textPreview(run.stdout.trim()) : '';
      const err = typeof run.stderr === 'string' && run.stderr.trim() ? textPreview(run.stderr.trim(), 1200) : '';
      const parts = [`命令：${command}`, exit, out ? `stdout：\n${out}` : '', err ? `stderr：\n${err}` : '']
        .filter(Boolean);
      facts.push(parts.join('\n'));
      continue;
    }
    if (step.tool === 'screen.capture' || step.tool === 'computer.screenshot') {
      const path = argPath(step);
      const shot = result && typeof result === 'object' && typeof (result as { screenshotRef?: unknown }).screenshotRef === 'string'
        ? (result as { screenshotRef: string }).screenshotRef
        : path;
      facts.push(shot ? `截屏：${shot}` : '截屏：已完成');
      continue;
    }
    if (typeof step.tool === 'string' && step.tool.startsWith('computer.') && result && typeof result === 'object') {
      const computer = result as { summary?: unknown; verified?: unknown; appName?: unknown; screenshotRef?: unknown };
      const summary = typeof computer.summary === 'string' ? computer.summary : step.tool;
      const app = typeof computer.appName === 'string' ? computer.appName : '';
      const verified = computer.verified === true ? '已核对' : '未验证';
      facts.push([app && `应用：${app}`, summary, `验证：${verified}`].filter(Boolean).join('\n'));
      continue;
    }
    if (step.tool === 'app.open') {
      const app = typeof step.args?.app === 'string' ? step.args.app
        : typeof step.args?.name === 'string' ? step.args.name : '';
      facts.push(app ? `启动应用：${app}` : '启动应用：已完成');
      continue;
    }
    const path = argPath(step);
    facts.push(`${step.tool}${path ? `：${path}` : '：已完成'}`);
  }
  return facts;
}

/** 从计划事件抽出执行目标（标题 + 完成条件），供结论与界面原样展示。 */
export function executionGoalFromEvents(events: readonly AgentEvent[]): string {
  const planReady = [...events].reverse().find(event => event.type === 'plan.ready');
  if (planReady?.type !== 'plan.ready') return '';
  const title = planReady.plan.title?.trim() || '';
  const condition = planReady.plan.completion?.trim() || '';
  if (title && condition) return `${title} — ${condition}`;
  return condition || title;
}

/**
 * 成员卡「正文框」与「思考折叠」的展示分工（去重规则）。
 *
 * 真机上出现过同一份 3054 字符思考被画三遍：流式期间正文框铺了 reasoning、
 * 卡片底部又挂一个「思考（N 字符）」折叠、对话页还留着一张旧的「模型思考」
 * 卡。规则只有一条：同一时刻、同一份内容只在一个地方可见。
 *
 * - 流式且正文还没来：正文框铺思考（让用户看到字在长），底部折叠收掉。
 * - 正文到了：正文框切回正文，思考是另一份内容，折叠恢复供查证。
 * - 协议对象：原文铺开，思考折叠照旧（两者不是同一份内容）。
 */
export interface MemberBodyInput {
  status: 'streaming' | 'completed' | 'failed' | 'cancelled';
  text: string;
  reasoning: string;
  reasoningSupported: boolean;
  protocol: ConversationProtocol;
  /** 流式且尚无正文/思考时，用于把「空等」说成已等多少秒。 */
  waitMs?: number | null;
}

export interface MemberBodyView {
  /** 正文框里实际展示的文本；空串表示改显示占位。 */
  bodyText: string;
  /** 正文框展示的其实是思考（正文还没来）。 */
  bodyIsReasoning: boolean;
  /** 是否显示「思考中 · 已写 N 字符」实时标签。 */
  showLiveThinking: boolean;
  /** 是否显示底部可折叠的思考块。 */
  showReasoningDetails: boolean;
  /** 正文框没有内容时的占位文案。 */
  placeholder: string | null;
  /** meta 行该显示的字符数：以当前真正展示的内容为准。 */
  displayLength: number;
}

export function memberBodyView(input: MemberBodyInput): MemberBodyView {
  const live = input.status === 'streaming';
  // 只有「流式 + 非协议 + 正文为空 + 有思考」才把思考临时铺进正文框。
  // 协议对象有原文，不参与这条替换，否则会把那段 JSON 误标成思考。
  const bodyIsReasoning = live && input.protocol === null
    && input.text.length === 0 && input.reasoning.length > 0;
  const bodyText = bodyIsReasoning ? input.reasoning : input.text;
  const waitSec = live && bodyText.length === 0 && input.waitMs != null && input.waitMs >= 3000
    ? Math.max(3, Math.round(input.waitMs / 1000))
    : null;
  return {
    bodyText,
    bodyIsReasoning,
    showLiveThinking: bodyIsReasoning,
    // 正文框正在展示同一份思考时，底部折叠必须收掉；其余情况思考与正文
    // 是两份内容，折叠保留（reasoningSupported 但没内容时仍给出「没返回」）。
    showReasoningDetails: input.reasoningSupported && !bodyIsReasoning,
    placeholder: bodyText.length === 0
      ? (live
        ? (waitSec != null
          ? `模型尚未返回首字，已等 ${String(waitSec)} 秒（可能在内部思考）…`
          : '等待模型输出…')
        : '这次没有输出正文。')
      : null,
    displayLength: bodyText.length
  };
}

/**
 * 只取 `summary` 字段，不拿计划标题凑数。
 *
 * 结论卡写「写文件」这种事毫无意义——那是计划的标题，不是这件事的结果。
 * 成员卡可以用标题当一句话摘要，结论不行。
 */
function protocolConclusionText(text: string): string | null {
  try {
    const parsed = JSON.parse(unfence(text)) as { summary?: unknown };
    return typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : null;
  } catch {
    return null;
  }
}

/** 超时/取消这类没有 summary 的收尾，至少要有一句事实。 */
function statusText(status: string | undefined): string {
  if (status === 'failed') return '任务失败';
  if (status === 'cancelled') return '任务已取消';
  if (status === 'completed') return '任务完成';
  return '任务尚未结束';
}

interface MemberAcc {
  key: string;
  roundId: string;
  memberId: string;
  label: string;
  status: 'streaming' | 'completed' | 'failed' | 'cancelled';
  text: string;
  reasoning: string;
  reasoningSupported: boolean;
  startedAt: number;
  durationMs: number | null;
  error: string | null;
}

function appendText(current: string, incoming: string | undefined, mode: 'snapshot' | 'delta'): string {
  if (!incoming) return current;
  return mode === 'delta' ? current + incoming : incoming;
}

/**
 * 把事件折成对话条目。
 *
 * `prompt` 传任务原话：`round.started` 只带 inputType，不带用户原话，而「我问了
 * 什么」是这条流的第一句。后续轮次不是用户提问（执行报告 / 澄清回答 / 计划修正），
 * 用 `note` 说清楚这一轮为什么开始。
 */
export function buildTaskConversation(
  events: readonly AgentEvent[],
  options: {
    prompt?: string;
    summary?: string;
    status?: string;
    /** 运行中最后一段流式文本：还没有 `round.answer` 时也要能看到字在出。 */
    live?: {
      roundId: string | null;
      text: string;
      reasoning: string;
      providerId: string | null;
      modelId: string | null;
    } | null;
    now?: number;
  } = {}
): ConversationEntryView[] {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const entries: ConversationEntry[] = [];
  const rounds = new Map<string, { number: number; inputType: string; at: number }>();
  const members = new Map<string, MemberAcc>();
  let currentRoundId: string | null = null;
  let firstRound: { roundId: string; at: number } | null = null;
  let seq = 0;
  let lastAt = ordered[0]?.at ?? Date.now();
  let verificationCount = 0;
  let reviewCount = 0;
  /** 方案评审按 planId 原地更新：心跳、等待、辩完是同一条，不能越刷越多。 */
  const debates = new Map<string, { index: number; entry: Extract<ConversationEntry, { kind: 'debate' }> }>();
  /** 聚合旁注按 aggregateKey 原地改写（改动量），位置留在第一次出现处。 */
  const aggregates = new Map<string, { index: number; entry: Extract<ConversationEntry, { kind: 'note' }> }>();
  /** D1：Agent ↔ WorkTask 的真实关联，只有 id 对得上才写。 */
  const agentWorkTasks = agentWorkTasksOf(ordered);

  const upsertDebate = (
    key: string,
    patch: Omit<Extract<ConversationEntry, { kind: 'debate' }>, 'key' | 'kind' | 'at' | 'roundId' | 'roundNumber'>,
    base: { at: number; roundId: string | null; roundNumber: number | null }
  ) => {
    const existing = debates.get(key);
    if (existing) {
      const next = { ...existing.entry, ...patch };
      entries[existing.index] = next;
      debates.set(key, { index: existing.index, entry: next });
      return;
    }
    const entry: Extract<ConversationEntry, { kind: 'debate' }> = {
      kind: 'debate',
      key,
      at: base.at,
      roundId: base.roundId,
      roundNumber: base.roundNumber,
      ...patch
    };
    debates.set(key, { index: entries.length, entry });
    entries.push(entry);
  };

  const push = (entry: ConversationEntry) => {
    entries.push(entry);
    seq += 1;
  };
  const roundOf = (roundId: string | null) => (roundId ? rounds.get(roundId) ?? null : null);
  const roundNumber = (roundId: string | null) => roundOf(roundId)?.number ?? null;

  const memberEntry = (acc: MemberAcc): ConversationEntry => ({
    kind: 'member',
    key: acc.key,
    at: acc.startedAt,
    roundId: acc.roundId,
    roundNumber: roundNumber(acc.roundId),
    memberId: acc.memberId,
    label: acc.label,
    status: acc.status,
    text: acc.text,
    reasoning: acc.reasoning,
    reasoningSupported: acc.reasoningSupported,
    durationMs: acc.durationMs,
    error: acc.error,
    protocol: protocolKind(acc.text)
  });

  const upsertMember = (
    roundId: string,
    memberId: string,
    patch: Partial<Omit<MemberAcc, 'key' | 'roundId' | 'memberId'>>
  ): MemberAcc => {
    const key = `${roundId}::${memberId}`;
    let acc = members.get(key);
    if (!acc) {
      acc = {
        key,
        roundId,
        memberId,
        label: memberId,
        status: 'streaming',
        text: '',
        reasoning: '',
        reasoningSupported: false,
        startedAt: lastAt,
        durationMs: null,
        error: null
      };
      members.set(key, acc);
    }
    Object.assign(acc, patch);
    // 每次都重画这一条：成员卡的正文是逐步长的，条目必须跟着最新状态。
    const index = entries.findIndex(entry => entry.key === key);
    if (index >= 0) entries[index] = memberEntry(acc);
    else entries.push(memberEntry(acc));
    return acc;
  };

  for (const event of ordered) {
    lastAt = event.at;
    if (event.type === 'round.started') {
      currentRoundId = event.roundId;
      if (!firstRound) firstRound = { roundId: event.roundId, at: event.at };
      rounds.set(event.roundId, {
        number: event.roundNumber,
        inputType: event.inputType,
        at: event.at
      });
      push({
        kind: 'note',
        key: `round-${event.roundId}`,
        subtype: 'round',
        at: event.at,
        roundId: event.roundId,
        roundNumber: event.roundNumber,
        tone: 'muted',
        text:
          event.inputType === 'user_prompt'
            ? `第 ${String(event.roundNumber)} 轮 · 提问`
            : event.inputType === 'execution_report'
              ? `第 ${String(event.roundNumber)} 轮 · 执行报告已发回模型`
              : event.inputType === 'plan_repair'
                ? `第 ${String(event.roundNumber)} 轮 · 计划修正`
                : `第 ${String(event.roundNumber)} 轮 · 补充回答已发回模型`
      });
      continue;
    }

    if (event.type === 'round.peer') {
      const roundId = event.roundId ?? currentRoundId;
      if (!roundId) continue;
      const memberId = event.memberId;
      if (event.status === 'started') {
        upsertMember(roundId, memberId, {
          label: event.label || event.modelId || event.providerId || memberId,
          status: 'streaming',
          startedAt: event.at
        });
      } else if (event.status === 'answered') {
        upsertMember(roundId, memberId, {
          label: event.label || event.modelId || event.providerId || memberId,
          status: 'completed',
          text: event.text ?? '',
          // 方案评审成员与第一轮回答共用这张卡：推理也要带过来，否则用户只能
          // 看到结论，看不到它为什么这么评。
          reasoning: event.reasoning ?? '',
          reasoningSupported: Boolean(event.reasoning),
          durationMs: event.durationMs ?? null
        });
      } else {
        upsertMember(roundId, memberId, {
          label: event.label || event.modelId || event.providerId || memberId,
          status: event.status === 'failed' ? 'failed' : 'cancelled',
          error: event.error ?? null,
          durationMs: event.durationMs ?? null
        });
      }
      continue;
    }

    if (event.type === 'round.delta') {
      const roundId = event.roundId ?? currentRoundId;
      if (!roundId) continue;
      // 没有 participantId 的旧事件属于主导这一路：用 `lead` 收，和 round.answer 对齐。
      const memberId = event.participantId ?? 'lead';
      const existing = members.get(`${roundId}::${memberId}`);
      const mode = event.mode ?? 'snapshot';
      upsertMember(roundId, memberId, {
        label: existing?.label ?? event.modelId ?? event.providerId ?? (memberId === 'lead' ? '本轮主导模型' : memberId),
        status: existing?.status === 'completed' ? 'completed' : 'streaming',
        text: event.reset === true ? (event.text ?? '') : appendText(existing?.text ?? '', event.text, mode),
        reasoning: event.reset === true ? (event.reasoning ?? '') : appendText(existing?.reasoning ?? '', event.reasoning, mode),
        reasoningSupported: existing?.reasoningSupported === true || Boolean(event.reasoning),
        startedAt: existing?.startedAt ?? event.at
      });
      continue;
    }

    if (event.type === 'round.answer') {
      const roundId = event.roundId ?? currentRoundId;
      if (!roundId) continue;
      const memberId = event.participantId ?? 'lead';
      const existing = members.get(`${roundId}::${memberId}`);
      upsertMember(roundId, memberId, {
        status: 'completed',
        // `round.answer` 是落盘前最后一份原文，以它为准。
        text: event.text,
        durationMs: existing ? Math.max(0, event.at - existing.startedAt) : null,
        startedAt: existing?.startedAt ?? event.at
      });
      continue;
    }

    if (event.type === 'plan.ready') {
      push({
        kind: 'plan',
        key: `plan-${event.plan.planId}`,
        at: event.at,
        roundId: event.roundId ?? currentRoundId,
        roundNumber: roundNumber(event.roundId ?? currentRoundId),
        planId: event.plan.planId,
        title: event.plan.title,
        description: event.plan.description,
        completion: event.plan.completion,
        steps: event.plan.steps,
        warnings: event.plan.warnings ?? []
      });
      continue;
    }

    if (event.type === 'plan.review.progress') {
      const key = `debate-${event.planId}`;
      const existing = debates.get(key);
      // done 心跳只表示等待结束；若 plan.debated 已把状态写成 completed/skipped，
      // 不能再被冲回 running，否则界面永远停在「方案评审 · 进行中」。
      const terminal = existing?.entry.status === 'completed'
        || existing?.entry.status === 'stopped'
        || existing?.entry.status === 'skipped';
      upsertDebate(key, {
        status: terminal ? existing!.entry.status : (event.state === 'done' && existing?.entry.status
          ? existing.entry.status
          : 'running'),
        topics: event.topicTexts && event.topicTexts.length > 0
          ? event.topicTexts
          : (existing?.entry.topics ?? []),
        participants: existing?.entry.participants ?? [],
        summary: existing?.entry.summary ?? '',
        elapsedMs: event.elapsedMs,
        ...(event.topicGoals && event.topicGoals.length > 0
          ? { topicGoals: event.topicGoals }
          : existing?.entry.topicGoals ? { topicGoals: existing.entry.topicGoals } : {}),
        ...(event.expressTarget
          ? { expressTarget: event.expressTarget }
          : existing?.entry.expressTarget ? { expressTarget: existing.entry.expressTarget } : {}),
        ...(event.expressGoal
          ? { expressGoal: event.expressGoal }
          : existing?.entry.expressGoal ? { expressGoal: existing.entry.expressGoal } : {}),
        // 五段结论一出就要留在卡上；后续「已等 N 秒」心跳若不带此字段，沿用已有原文。
        ...(event.leadSummary
          ? { leadSummary: event.leadSummary }
          : existing?.entry.leadSummary ? { leadSummary: existing.entry.leadSummary } : {}),
        ...(event.rounds !== undefined
          ? { rounds: event.rounds }
          : existing?.entry.rounds !== undefined ? { rounds: existing.entry.rounds } : {}),
        ...(event.maxRounds !== undefined
          ? { maxRounds: event.maxRounds }
          : existing?.entry.maxRounds !== undefined ? { maxRounds: existing.entry.maxRounds } : {}),
        ...(event.roundsReason
          ? { roundsReason: event.roundsReason }
          : existing?.entry.roundsReason ? { roundsReason: existing.entry.roundsReason } : {}),
        ...(existing?.entry.skippedReason ? { skippedReason: existing.entry.skippedReason } : {}),
        ...(event.reason
          ? { reason: event.reason }
          : existing?.entry.reason ? { reason: existing.entry.reason } : {})
      }, {
        at: event.at,
        roundId: event.roundId ?? currentRoundId,
        roundNumber: roundNumber(event.roundId ?? currentRoundId)
      });
      continue;
    }

    if (event.type === 'plan.review.bridge') {
      const nextLabel = event.nextPhaseLabel ?? (event.action === 'continue' ? '下一轮' : '收尾');
      push({
        kind: 'bridge',
        key: `review-bridge-${event.planId}-${String(event.fromRound)}-${event.action}`,
        at: event.at,
        roundId: event.roundId ?? currentRoundId,
        roundNumber: roundNumber(event.roundId ?? currentRoundId),
        bridgeKind: 'review',
        action: event.action,
        ...(event.nextPhase ? { nextPhase: event.nextPhase } : {}),
        title: event.action === 'continue'
          ? `第 ${String(event.fromRound)} 轮${event.fromPhaseLabel}结束 → 先画出依据，再开${nextLabel}`
          : `第 ${String(event.fromRound)} 轮${event.fromPhaseLabel}结束`,
        message: event.message,
        targets: event.targets.map(item => ({
          left: item.left,
          right: item.right,
          reason: item.reason,
          agents: item.agents
        })),
        tone: event.action === 'continue' ? 'warn' : 'muted'
      });
      continue;
    }

    if (event.type === 'execution.bridge') {
      push({
        kind: 'bridge',
        key: `exec-bridge-${event.planId}-${String(event.at)}`,
        at: event.at,
        roundId: event.roundId ?? currentRoundId,
        roundNumber: roundNumber(event.roundId ?? currentRoundId),
        bridgeKind: 'execution',
        action: 'execute',
        title: '执行前依据',
        message: event.message,
        targets: [],
        steps: event.steps,
        tone: 'info'
      });
      continue;
    }

    if (event.type === 'plan.debated') {
      const key = `debate-${event.planId}`;
      const existing = debates.get(key);
      const { debate } = event;
      upsertDebate(key, {
        status: debate.status,
        topics: debate.topics.length > 0 ? debate.topics : (existing?.entry.topics ?? []),
        participants: debate.participants,
        summary: debate.summary,
        elapsedMs: existing?.entry.elapsedMs ?? 0,
        ...(debate.topicGoals && debate.topicGoals.length > 0
          ? { topicGoals: debate.topicGoals }
          : existing?.entry.topicGoals ? { topicGoals: existing.entry.topicGoals } : {}),
        ...(debate.expressTarget
          ? { expressTarget: debate.expressTarget }
          : existing?.entry.expressTarget ? { expressTarget: existing.entry.expressTarget } : {}),
        ...(debate.expressGoal
          ? { expressGoal: debate.expressGoal }
          : existing?.entry.expressGoal ? { expressGoal: existing.entry.expressGoal } : {}),
        ...(debate.leadSummary
          ? { leadSummary: debate.leadSummary }
          : existing?.entry.leadSummary ? { leadSummary: existing.entry.leadSummary } : {}),
        ...(debate.result ? { result: debate.result } : existing?.entry.result ? { result: existing.entry.result } : {}),
        ...(typeof debate.rounds === 'number' ? { rounds: debate.rounds } : {}),
        ...(typeof debate.maxRounds === 'number' ? { maxRounds: debate.maxRounds } : {}),
        ...(debate.roundsReason ? { roundsReason: debate.roundsReason } : {}),
        ...(debate.skippedReason ? { skippedReason: debate.skippedReason } : {}),
        ...(debate.reason ? { reason: debate.reason } : {})
      }, {
        at: event.at,
        roundId: event.roundId ?? currentRoundId,
        roundNumber: roundNumber(event.roundId ?? currentRoundId)
      });
      continue;
    }

    if (event.type === 'context.event') {
      const view = contextEventView(event.event);
      push({
        kind: 'note',
        key: `context-${String(event.at)}-${String(seq)}`,
        subtype: 'context',
        at: event.at,
        roundId: event.taskId ? currentRoundId : null,
        roundNumber: event.taskId ? roundNumber(currentRoundId) : null,
        tone: view.tone,
        text: view.text,
        detail: JSON.stringify(event.context, null, 2)
      });
      continue;
    }

    // 暂停存档这一条与时间线同源：用户看对话流时也要能确认「暂停留下了哪份检查点」。
    if (event.type === 'context.checkpoint.paused') {
      push({
        kind: 'note',
        key: `checkpoint-paused-${String(event.at)}-${String(seq)}`,
        subtype: 'context',
        at: event.at,
        roundId: currentRoundId,
        roundNumber: roundNumber(currentRoundId),
        tone: event.checkpointId ? 'muted' : 'warn',
        text: event.checkpointId
          ? `${event.reason === 'pause' ? '暂停' : '取消'}已提交检查点 ${event.checkpointId}（待核对 ${String(event.needsReconciliation)} 项）`
          : `${event.reason === 'pause' ? '暂停' : '取消'}未提交检查点：${event.unavailableReason ?? '宿主没有检查点能力'}`,
        detail: JSON.stringify(
          {
            reason: event.reason,
            contextId: event.contextId,
            checkpointId: event.checkpointId,
            activeRunId: event.activeRunId,
            needsReconciliation: event.needsReconciliation,
            unavailableReason: event.unavailableReason
          },
          null,
          2
        )
      });
      continue;
    }

    // 时序里程碑：短文案插入对话流，完整结构化收口仍在流末结果面板。
    if (event.type === 'work.breakdown.created') {
      push({
        kind: 'note',
        key: `work-breakdown-${String(event.at)}-${String(seq)}`,
        subtype: 'breakdown',
        at: event.at,
        roundId: currentRoundId,
        roundNumber: roundNumber(currentRoundId),
        tone: 'info',
        text: `任务分解 · ${event.title || event.workId}`,
        detail: `workId ${event.workId}`
      });
      continue;
    }

    if (event.type === 'eco.context.requested') {
      const request = event.request;
      const paths = request.requestedPaths ?? [];
      push({
        kind: 'note',
        key: `eco-req-${request.requestId}-${String(event.at)}`,
        subtype: 'context_request',
        at: event.at,
        roundId: currentRoundId,
        roundNumber: roundNumber(currentRoundId),
        tone: 'warn',
        text: `工程上下文补充请求 · ${String(paths.length)} 个文件`,
        detail: [
          request.reason,
          paths.length > 0 ? `待核验：${paths.slice(0, 6).join('、')}${paths.length > 6 ? ' 等' : ''}` : ''
        ].filter(Boolean).join('\n') || undefined
      });
      continue;
    }

    if (event.type === 'eco.context.prepared') {
      const pkg = event.package;
      push({
        kind: 'note',
        key: `eco-${pkg.contextPackageId}-${String(event.at)}`,
        subtype: 'context_package',
        at: event.at,
        roundId: currentRoundId,
        roundNumber: roundNumber(currentRoundId),
        tone: pkg.sufficiency === 'insufficient' || pkg.sufficiency === 'stale' ? 'warn' : 'muted',
        text: `工程上下文 · ${pkg.sufficiency} · v${String(pkg.contextVersion)}`,
        detail: [
          pkg.architectureSummary,
          pkg.role ? `角色 ${pkg.role}` : '',
          pkg.missingCritical.length > 0 ? `缺失：${pkg.missingCritical.join('；')}` : ''
        ].filter(Boolean).join('\n') || undefined
      });
      continue;
    }

    if (event.type === 'model.participation.selected') {
      const names = event.participants.map(item => `${item.participantId}（${item.roles.join('+')}）`);
      push({
        kind: 'note',
        key: `participation-${String(event.at)}-${String(seq)}`,
        subtype: 'participation',
        at: event.at,
        roundId: currentRoundId,
        roundNumber: roundNumber(currentRoundId),
        tone: 'muted',
        text: `模型参与 · ${event.risk} · 辩论 ${event.debate} · 审核 ${event.modelReview}`,
        detail: [
          names.length > 0 ? `参与：${names.join('；')}` : '无参与者',
          event.excluded.length > 0
            ? `未参与：${event.excluded.slice(0, 4).map(item => `${item.participantId}（${item.reason}）`).join('；')}`
            : '',
          event.reasons.slice(0, 4).join(' · ')
        ].filter(Boolean).join('\n')
      });
      continue;
    }

    if (event.type === 'task.budget.exhausted') {
      // 停手必须能在活动流里读懂「为什么停、下一步要我做什么」：只改状态不发卡，
      // 用户看到的就只是任务不动了（M3-2 真机教训：停下来等人，但没人告诉你怎么回来）。
      push({
        kind: 'note',
        key: `budget-exhausted-${String(event.at)}`,
        subtype: 'budget',
        at: event.at,
        roundId: currentRoundId,
        roundNumber: roundNumber(currentRoundId),
        tone: 'warn',
        text: `预算用尽，任务已暂停 · ${event.reason}`,
        detail: '追加预算后可继续，或直接结束任务。'
      });
      continue;
    }

    if (event.type === 'task.budget.updated') {
      const before = event.previous?.maxRounds;
      const after = event.budget.maxRounds;
      push({
        kind: 'note',
        key: `budget-updated-${String(event.at)}`,
        subtype: 'budget',
        at: event.at,
        roundId: currentRoundId,
        roundNumber: roundNumber(currentRoundId),
        tone: event.gate.ok ? 'ok' : 'warn',
        text: `预算已更新 · 轮数上限 ${String(before ?? '默认')} → ${String(after ?? '默认')}`,
        detail: [
          `来源：${event.source === 'user' ? '用户追加' : event.source === 'model' ? '模型建议' : '恢复时确认'}`,
          event.gate.ok ? `门禁放行：${event.gate.reason}` : `仍未放行：${event.gate.reason}`
        ].join('\n')
      });
      continue;
    }

    if (event.type === 'cycle.snapshot') {
      push({
        kind: 'note',
        key: `cycle-${event.cycleId}-${String(event.at)}-${String(seq)}`,
        subtype: 'decision',
        at: event.at,
        roundId: currentRoundId,
        roundNumber: roundNumber(currentRoundId),
        tone: event.decision === 'repair' || event.decision === 'fail_budget' || event.decision === 'fail_delivery'
          ? 'warn'
          : event.decision === 'complete'
            ? 'ok'
            : 'info',
        text: `循环决策 · ${event.decision} · 阶段 ${event.currentStage} · ${event.conclusionType}`,
        detail: [
          event.nextAction,
          `预算 ${String(event.budget.roundCount)}/${String(event.budget.maxIterations)}`,
          event.debateSkipped ? '方案辩论已跳过' : '方案辩论已发生'
        ].join('\n')
      });
      continue;
    }

    if (event.type === 'goal.fit') {
      const criteria = (event.criteria ?? [])
        .filter(item => item.description)
        .map(item => `${item.priority === 'MUST' ? '必须' : item.priority === 'SHOULD' ? '应当' : '可选'} · ${item.description ?? item.criterionId} · ${item.status}`);
      push({
        kind: 'note',
        key: `goal-fit-${String(event.at)}-${String(seq)}`,
        subtype: 'goal_fit',
        at: event.at,
        roundId: currentRoundId,
        roundNumber: roundNumber(currentRoundId),
        tone: event.gceFit === 'GAP'
          ? 'warn'
          : event.gceFit === 'MET'
            ? 'ok'
            : event.fit === 'gap'
              ? 'warn'
              : event.fit === 'met'
                ? 'ok'
                : 'muted',
        text: `目标符合度 · ${event.gceFit ?? event.fit}`,
        detail: [...event.notes, ...criteria].join('\n') || undefined
      });
      continue;
    }

    if (event.type === 'clarification.required') {
      push({
        kind: 'note',
        key: `clarify-${String(event.at)}-${String(seq)}`,
        subtype: 'clarification',
        at: event.at,
        roundId: event.roundId ?? currentRoundId,
        roundNumber: roundNumber(event.roundId ?? currentRoundId),
        tone: 'warn',
        text: '模型需要你补充信息',
        detail: event.questions.join('\n')
      });
      continue;
    }

    if (event.type === 'report.ready') {
      const verification = event.report.verification;
      if (verification) {
        verificationCount += 1;
        const results = event.report.results ?? [];
        push({
          kind: 'verification',
          key: `verification-${String(event.at)}-${String(seq)}`,
          at: event.at,
          roundId: event.roundId ?? currentRoundId,
          roundNumber: roundNumber(event.roundId ?? currentRoundId),
          index: verificationCount,
          verified: verification.verified,
          fullyVerified: verificationIsComplete(verification),
          reasons: verification.reasons,
          changedFiles: verification.changedFiles,
          checks: verification.checks,
          diagnostics: diagnosticsOfReport(event.report),
          reportStatus: event.report.status,
          completedSteps: results.filter(item => item.status === 'completed').length,
          totalSteps: results.length
        });
        // 改动量：同一任务只有一条，后续报告原地改写数字，位置固定在第一次出现处。
        const diff = diffSummaryOf(verification);
        if (diff) {
          const aggregateKey = 'diff';
          const at = event.at;
          const existing = aggregates.get(aggregateKey);
          const trace: AggregateTrace = {
            aggregateKey,
            firstEventId: existing?.entry.aggregate?.firstEventId ?? `report-${String(at)}`,
            lastEventId: `report-${String(at)}`,
            firstAt: existing?.entry.aggregate?.firstAt ?? at,
            updatedAt: at
          };
          const entry: Extract<ConversationEntry, { kind: 'note' }> = {
            kind: 'note',
            key: `diff-${aggregateKey}`,
            at: trace.firstAt,
            roundId: event.roundId ?? currentRoundId,
            roundNumber: roundNumber(event.roundId ?? currentRoundId),
            tone: 'muted',
            subtype: 'diff',
            text: diffText(diff),
            aggregate: trace,
            diff
          };
          if (existing) entries[existing.index] = entry;
          else entries.push(entry);
          aggregates.set(aggregateKey, { index: existing?.index ?? entries.length - 1, entry });
        }
      }
      continue;
    }

    if (event.type === 'review.ready') {
      reviewCount += 1;
      push({
        kind: 'review',
        key: `review-${String(event.at)}-${String(seq)}`,
        at: event.at,
        roundId: event.roundId ?? currentRoundId,
        roundNumber: roundNumber(event.roundId ?? currentRoundId),
        index: reviewCount,
        reviewer: event.reviewer,
        backend: event.backend,
        verdict: event.verdict,
        ...(event.rawVerdict ? { rawVerdict: event.rawVerdict } : {}),
        issues: event.issues,
        ...(event.issueDetails ? { issueDetails: event.issueDetails } : {}),
        needsFix: event.needsFix
      });
      continue;
    }

    if (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled') {
      continue;
    }
  }

  // 执行步骤与里程碑：复用已经验证过的分轮逻辑，再把它们按时间并进同一条流。
  for (const item of buildTimeline(ordered)) {
    const roundId = item.roundId ?? currentRoundId;
    if (item.kind === 'step') {
      // 计划一就绪就为每一步生成 preparing 卡，评审阶段还没执行，卡片里
      // 没有任何输出——真机上就成了一排「准备工具 / 这一步没有可展示的输出」，
      // 用户以为界面坏了。真正执行时同一个 stepId 会更新成有输出的卡，这里
      // 只跳过尚未开始的占位卡（带参数也不显示：没有输出的一行不叫过程）。
      if (item.card.status === 'preparing' && !item.card.startedAt) continue;
      const stepKey = `step-${item.key}`;
      push({
        kind: 'step',
        key: stepKey,
        at: item.at,
        roundId,
        roundNumber: roundNumber(roundId),
        card: item.card
      });
      // D1：多 Agent 编码的真实 proposals 抽成独立子 Agent 卡，紧跟它的 step。
      // 没有 proposals（老事件、失败、结构不对）就不出卡，不伪造 AgentRun。
      if (item.card.tool === 'code.team.run') {
        const team = teamProposalsOf(item.card.result);
        if (team) {
          for (const proposal of team.proposals) {
            const workTask = agentWorkTasks.get(proposal.agentId);
            push({
              kind: 'agent',
              key: `agent-${stepKey}-${proposal.role}-${proposal.agentId}`,
              at: item.at + 1,
              roundId,
              roundNumber: roundNumber(roundId),
              agentId: proposal.agentId,
              role: proposal.role,
              label: agentRoleLabel(proposal.role),
              task: team.task || (typeof item.card.args?.task === 'string' ? item.card.args.task : ''),
              status: proposal.failure ? 'failed' : 'completed',
              stepStartedAt: item.card.startedAt ?? null,
              durationMs: proposal.durationMs,
              text: proposal.text,
              error: proposal.failure,
              ...(proposal.patchCount !== undefined ? { patchCount: proposal.patchCount } : {}),
              context: proposal.context,
              stepKey,
              ...(workTask ? { workTask } : {})
            });
          }
        }
      }
    } else {
      // 轮次头、评审、验证已经有自己的条目，避免一句话说两遍。
      if (/^第 \d+ 轮/.test(item.text) || item.text.startsWith('独立评审')) continue;
      // 计划树、方案评审已经有自己的卡片，不再留一句只有计数的里程碑。
      if (item.text.startsWith('计划就绪') || item.text.startsWith('方案评审')) continue;
      // 执行报告与验证卡并存：验证卡讲 checks，报告节点讲逐步结果，不得互相顶替。
      // 成员卡的正文就是这条回答：再写一行「模型回答（310 字符）」只是噪音。
      if (/^模型回答（/.test(item.text) || item.text === '模型返回执行计划') continue;
      // 完成摘要留给末尾的结论卡，这里只标时间点。
      const text = item.text.startsWith('任务完成：') ? '任务完成' : item.text;
      push({
        kind: 'note',
        key: `note-${item.key}`,
        subtype: 'milestone',
        at: item.at,
        roundId,
        roundNumber: roundNumber(roundId),
        tone: item.tone,
        text,
        ...(item.detail ? { detail: item.detail } : {})
      });
    }
  }

  // 用户原话排最前：它发生在第一轮之前，但人读对话时它就是第一句。
  const prompt = (options.prompt ?? '').trim();
  if (prompt) {
    push({
      kind: 'user',
      key: 'user-prompt',
      at: (firstRound?.at ?? ordered[0]?.at ?? Date.now()) - 1,
      roundId: firstRound?.roundId ?? null,
      roundNumber: 1,
      text: prompt
    });
  }

  // 还没结算的流式文本：只在最后一路、且这一轮没有 round.answer 时补一条。
  const live = options.live ?? null;
  if (live && live.roundId && (live.text || live.reasoning)) {
    const settled = ordered.some(event => event.type === 'round.answer' && event.roundId === live.roundId);
    if (!settled) {
      // 主导的 participantId 带 provider 前缀（如 `lead:OpenCode Go · deepseek-v4.1-flash`），
      // 不能硬编码 'lead' 另起一张卡——否则同一模型在界面上出现两张「输出中」。
      // 先找这一轮已经由 round.peer/delta 建好的流式成员，把 live 并进那一张。
      const prefix = `${live.roundId}::`;
      const liveAcc = [...members.values()].find(
        acc => acc.roundId === live.roundId && acc.status === 'streaming'
      ) ?? [...members.values()].find(acc => acc.key.startsWith(prefix) && acc.status !== 'completed');
      const memberId = liveAcc?.memberId ?? 'lead';
      upsertMember(live.roundId, memberId, {
        label: liveAcc?.label ?? live.modelId ?? live.providerId ?? '本轮主导模型',
        status: 'streaming',
        // live 是 TaskStreamState 的累积快照（含这一刻已出的全部文本），以它为准；
        // 没有 live 内容时才退回事件卡的文本，避免把更全的快照丢掉。
        text: live.text || liveAcc?.text || '',
        reasoning: live.reasoning || liveAcc?.reasoning || '',
        reasoningSupported: liveAcc?.reasoningSupported === true || Boolean(live.reasoning),
        startedAt: liveAcc?.startedAt ?? lastAt
      });
    }
  }

  const conclusion = buildConclusion(ordered, options);
  if (conclusion) {
    push({
      kind: 'conclusion',
      key: 'conclusion',
      at: lastAt + 1,
      roundId: currentRoundId,
      roundNumber: roundNumber(currentRoundId),
      text: conclusion.text,
      facts: conclusion.facts,
      ...(conclusion.executionGoal ? { executionGoal: conclusion.executionGoal } : {}),
      ...(conclusion.executionResults.length > 0
        ? { executionResults: conclusion.executionResults }
        : {}),
      // 始终带上目标物字段（可为空）：结论卡必须画出「目标物」栏，空也如实写。
      deliverables: conclusion.deliverables,
      tone: conclusion.tone
    });
  }

  return normalizeEntries(entries.sort((a, b) => a.at - b.at || orderWeight(a) - orderWeight(b)));
}

/** 对外条目：在投影条目上补齐稳定身份与统一状态（阶段 B1）。 */
export type ConversationEntryView = ConversationEntry & {
  /** 稳定身份，与 `key` 同源；呈现层不许用数组下标当身份。 */
  id: string;
  conversationStatus: ConversationStatus;
};

/** 业务状态 → 统一呈现状态。业务状态本身一个字都不改。 */
export function conversationStatusOf(entry: ConversationEntry): ConversationStatus {
  switch (entry.kind) {
    case 'member':
      return entry.status === 'streaming' ? 'running' : entry.status;
    case 'step':
      if (entry.card.status === 'running') return 'running';
      if (entry.card.status === 'failed') return 'failed';
      if (entry.card.status === 'completed') return 'completed';
      return 'pending';
    case 'agent':
      return entry.status === 'failed' ? 'failed' : 'completed';
    case 'debate':
      if (entry.status === 'running') return 'running';
      if (entry.status === 'completed') return 'completed';
      if (entry.status === 'skipped') return 'skipped';
      // stopped 是「辩到一半停了」，不是「完成」。
      return 'cancelled';
    case 'plan':
      return 'completed';
    default:
      return 'completed';
  }
}

/**
 * 从报告的验证块取改动量。
 *
 * 只读报告里已经有的数字：`insertions/deletions` 是主进程在报告形成阶段跑
 * `git diff --numstat` 得到的真數；这里**不**读 Git、不现算（不变量 11）。
 */
export function diffSummaryOf(verification: {
  changedFiles?: number;
  insertions?: number;
  deletions?: number;
  diffAvailable?: boolean;
  diffFiles?: DiffFileStat[];
  diffFilesAvailable?: boolean;
} | null | undefined): DiffSummary | null {
  const files = verification?.changedFiles ?? 0;
  if (files <= 0) return null;
  const hasNumbers = typeof verification?.insertions === 'number' && typeof verification?.deletions === 'number';
  return {
    files,
    ...(hasNumbers ? { insertions: verification!.insertions, deletions: verification!.deletions } : {}),
    ...(verification?.diffAvailable === false ? { available: false } : hasNumbers ? { available: true } : {}),
    // 明细只在「有 diffFiles 且完整」时透传；不完整的老报告读不到，界面也就没有假清单。
    ...(Array.isArray(verification?.diffFiles) && verification?.diffFilesAvailable !== false
      ? { fileStats: verification!.diffFiles, filesAvailable: true }
      : { filesAvailable: false })
  };
}

/** 改动量文案：有真数字写数字，取不到就写「统计不可用」，老报告只写文件数。 */
export function diffText(diff: DiffSummary): string {
  if (diff.available !== false && typeof diff.insertions === 'number' && typeof diff.deletions === 'number') {
    return `改动 ${String(diff.files)} 个文件 · +${String(diff.insertions)} / -${String(diff.deletions)}`;
  }
  if (diff.available === false) return `改动 ${String(diff.files)} 个文件 · 统计不可用`;
  return `改动 ${String(diff.files)} 个文件`;
}

/**
 * 补齐 `id` 与 `conversationStatus`。
 *
 * 纯函数、可重复调用：同一份事件重算两次得到同样的 id（`key` 来自事件内容，
 * 不是下标）。重复 key 时按出现次序加后缀，保证 id 唯一且仍然确定。
 */
export function normalizeEntries(entries: readonly ConversationEntry[]): ConversationEntryView[] {
  const used = new Map<string, number>();
  return entries.map(entry => {
    const seen = used.get(entry.key) ?? 0;
    used.set(entry.key, seen + 1);
    return {
      ...entry,
      id: seen === 0 ? entry.key : `${entry.key}#${String(seen + 1)}`,
      conversationStatus: conversationStatusOf(entry)
    };
  });
}

/** 同一毫秒里的稳定次序：提问在最前，结论在最后。 */function orderWeight(entry: ConversationEntry): number {
  if (entry.kind === 'user') return -2;
  if (entry.kind === 'conclusion') return 2;
  return 0;
}

/**
 * 从一份执行报告抽出交付路径（写出的文件 + 编译/运行产物）。
 *
 * 供结论汇总复用：多轮报告必须逐份合并，不能只认最后一轮——
 * 修复/再验证轮常常不再写文件，只看最后一轮会把前面的交付冲没。
 */
export function deliverablesOfReport(report: ExecutionReport): string[] {
  const deliverables: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) return;
    const duplicate = [...seen].some(existing =>
      existing === trimmed || existing.endsWith(`/${trimmed}`) || trimmed.endsWith(`/${existing}`)
    );
    if (duplicate) return;
    seen.add(trimmed);
    deliverables.push(trimmed);
  };
  for (const path of report.verification?.changedPaths ?? []) add(path);
  for (const item of report.results ?? []) {
    const path = argPath(item);
    if (path && (
      item.tool === 'fs.writeFile' || item.tool === 'fs.edit' || item.tool === 'fs.mkdir' ||
      item.tool === 'fs.copy' || item.tool === 'fs.move' || item.tool === 'screen.capture'
    )) {
      add(path);
    }
    const result = item.result as { path?: string; stdout?: string; stderr?: string; cwd?: string } | undefined;
    if (typeof result?.path === 'string') add(result.path);
    if (!result) continue;
    for (const match of artifactPaths(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) {
      add(/^(\/|[A-Za-z]:[\\/])/.test(match)
        ? match
        : result.cwd ? `${result.cwd.replace(/\/$/, '')}/${match}` : match);
    }
  }
  for (const rawCheck of Object.values(report.verification?.checks ?? {})) {
    const check = rawCheck as { output?: string };
    if (typeof check.output === 'string') {
      for (const match of artifactPaths(check.output)) add(match);
    }
  }
  return deliverables;
}

/**
 * 最后那句话。
 *
 * 只认三种来源：任务自己的 `summary`、最后一次 `round.answer` 里协议对象的
 * `summary`、执行报告与评审的事实。一个都没有就写清「没有结论文本」，绝不
 * 拿一段 JSON 或一句「任务完成」冒充结论。
 *
 * 目标物必须合并**全部** `report.ready`：最后一轮常常只是再验证，没有写文件；
 * 只认最后一轮会让最终结论丢掉前面已经交付的路径。
 */
export function buildConclusion(
  events: readonly AgentEvent[],
  options: { summary?: string; status?: string } = {}
): {
  text: string;
  facts: string[];
  executionGoal: string;
  executionResults: string[];
  /** 目标物路径：写出的文件 + 编译/运行产物（全轮次并集）。 */
  deliverables: string[];
  tone: ConversationTone;
} | null {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const completed = [...ordered].reverse().find(event => event.type === 'task.completed');
  const failed = [...ordered].reverse().find(event => event.type === 'task.failed');
  const cancelled = [...ordered].reverse().find(event => event.type === 'task.cancelled');
  const reports = ordered.filter((event): event is Extract<AgentEvent, { type: 'report.ready' }> =>
    event.type === 'report.ready'
  );
  const report = [...reports].reverse()[0];
  const review = [...ordered].reverse().find(event => event.type === 'review.ready');
  const lastAnswer = [...ordered].reverse().find(event => event.type === 'round.answer');

  const status = options.status ?? (failed ? 'failed' : cancelled ? 'cancelled' : completed ? 'completed' : 'running');
  // 只有结算过的任务才有「结论」：进行中写一句结论等于替模型下判断。
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return null;

  const candidates = [
    options.summary,
    completed?.type === 'task.completed' ? completed.summary : undefined,
    lastAnswer?.type === 'round.answer' ? protocolConclusionText(lastAnswer.text) : undefined
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  // 协议 JSON 不是结论。套话 summary（「执行完成，验证通过」）可以作收口标题，
  // 但不得再退回「最近一轮命令 stdout」当核心结论文本——修复轮常是长 shell，会盖住交付语义。
  const richText = candidates.find(item => !protocolKind(item) && !isGenericConclusion(item)) ?? '';
  const completedSummary = completed?.type === 'task.completed' && completed.summary?.trim()
    ? completed.summary.trim()
    : '';
  const optionSummary = typeof options.summary === 'string' && options.summary.trim() && !protocolKind(options.summary)
    ? options.summary.trim()
    : '';
  const text = richText || completedSummary || optionSummary;

  const executionGoal = executionGoalFromEvents(ordered);
  // 执行结果仍取最近一份报告（最近一轮在干什么）；目标物取全轮并集（AGENTS §8.2）。
  const executionResults = report ? reportDeliveryFacts(report.report) : [];
  const deliverables: string[] = [];
  const seenDeliverable = new Set<string>();
  const addDeliverable = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed || seenDeliverable.has(trimmed)) return;
    const duplicate = [...seenDeliverable].some(existing =>
      existing === trimmed || existing.endsWith(`/${trimmed}`) || trimmed.endsWith(`/${existing}`)
    );
    if (duplicate) return;
    seenDeliverable.add(trimmed);
    deliverables.push(trimmed);
  };
  const changedPaths = new Set<string>();
  for (const item of reports) {
    for (const path of deliverablesOfReport(item.report)) addDeliverable(path);
    for (const path of item.report.verification?.changedPaths ?? []) {
      if (path.trim()) changedPaths.add(path.trim());
    }
    for (const step of item.report.results ?? []) {
      if (!(
        step.tool === 'fs.writeFile' || step.tool === 'fs.edit' || step.tool === 'fs.mkdir' ||
        step.tool === 'fs.copy' || step.tool === 'fs.move'
      )) continue;
      const path = argPath(step) || (typeof (step.result as { path?: unknown } | undefined)?.path === 'string'
        ? (step.result as { path: string }).path
        : '');
      if (path.trim()) changedPaths.add(path.trim());
    }
  }

  const facts: string[] = [];
  // facts 仍带上执行结果，兼容旧面板；同时单独字段保证界面能分栏完整展示。
  facts.push(...executionResults);
  if (report) {
    const done = report.report.results.filter(item => item.status === 'completed').length;
    facts.push(`执行 ${String(report.report.results.length)} 步，完成 ${String(done)} 步`);
    if (report.report.verification) {
      const checks = report.report.verification.checks;
      const ran = checks ? [checks.compile, checks.tests, checks.diagnostics].some(item => item.status !== 'skipped') : true;
      facts.push(
        report.report.verification.verified
          ? '验证通过'
          : ran
            ? '验证未通过'
            : '没有跑验证'
      );
    }
    // 「改动文件」优先全轮路径并集；旧报告只有 changedFiles 计数时退回最大计数。
    if (changedPaths.size > 0) {
      facts.push(`改动 ${String(changedPaths.size)} 个文件`);
    } else {
      const counted = reports.reduce(
        (max, item) => Math.max(max, typeof item.report.verification?.changedFiles === 'number'
          ? item.report.verification.changedFiles
          : 0),
        0
      );
      if (counted > 0) facts.push(`改动 ${String(counted)} 个文件`);
    }
    if (deliverables.length > 0) {
      facts.push(`目标物 ${String(deliverables.length)} 个`);
    } else if (reports.length > 0) {
      facts.push('没有记录到交付文件');
    }
  }
  if (review?.type === 'review.ready') {
    facts.push(`独立评审：${review.needsFix ? `需修复（${String(review.issues.length)} 项）` : '通过'}`);
  }

  const tone: ConversationTone = status === 'failed' ? 'error' : status === 'cancelled' ? 'warn' : 'ok';
  // 结论文本不拿修轮/最近命令 stdout 顶替；执行明细进 executionResults，目标物进 deliverables。
  return {
    text: text
      || (status === 'failed'
        ? (failed?.type === 'task.failed' ? failed.error : '任务失败，没有留下结论文本。')
        : status === 'cancelled'
          ? '任务已取消，没有留下结论文本。'
          : deliverables.length > 0
            ? `${statusText(status)}。目标物 ${String(deliverables.length)} 项见下方。`
            : `${statusText(status)}，模型没有给出结论文本；执行结果与目标物见下方。`),
    facts,
    executionGoal,
    executionResults,
    deliverables,
    tone
  };
}

/** 对话流快速定位锚点：只收重点节点，供侧栏时间轴跳转。 */
export type StreamLandmarkKind =
  | 'prompt'
  | 'plan'
  | 'debate'
  | 'debate_peer'
  | 'step'
  | 'bridge'
  | 'review'
  | 'verification'
  | 'conclusion';

export interface StreamLandmark {
  id: string;
  kind: StreamLandmarkKind;
  label: string;
  entryKey: string;
  at: number;
}

const DEBATE_PEER_LABEL = /轮评审\s*·\s*(表态|质疑|回应)/u;

/** 从对话投影抽出可跳转地标；旁注里程碑不进轴，避免噪音。 */
export function buildStreamLandmarks(entries: readonly ConversationEntry[]): StreamLandmark[] {
  const out: StreamLandmark[] = [];
  let stepCount = 0;
  for (const entry of entries) {
    if (entry.kind === 'user') {
      out.push({
        id: `lm-${entry.key}`,
        kind: 'prompt',
        label: '提问',
        entryKey: entry.key,
        at: entry.at
      });
      continue;
    }
    if (entry.kind === 'plan') {
      out.push({
        id: `lm-${entry.key}`,
        kind: 'plan',
        label: entry.title.trim() ? `计划 · ${entry.title.trim().slice(0, 24)}` : '计划',
        entryKey: entry.key,
        at: entry.at
      });
      continue;
    }
    if (entry.kind === 'debate') {
      const multi = [...new Set(entry.participants.map(item => item.trim()).filter(Boolean))].length >= 2;
      out.push({
        id: `lm-${entry.key}`,
        kind: 'debate',
        label: multi ? `评审 · 多模型 ${String(entry.participants.length)}` : '方案评审',
        entryKey: entry.key,
        at: entry.at
      });
      continue;
    }
    if (entry.kind === 'member' && DEBATE_PEER_LABEL.test(entry.label)) {
      const phase = entry.label.match(DEBATE_PEER_LABEL)?.[1] ?? '辩论';
      out.push({
        id: `lm-${entry.key}`,
        kind: 'debate_peer',
        label: phase,
        entryKey: entry.key,
        at: entry.at
      });
      continue;
    }
    if (entry.kind === 'bridge') {
      out.push({
        id: `lm-${entry.key}`,
        kind: 'bridge',
        label: entry.bridgeKind === 'execution' ? '执行前依据' : '轮间依据',
        entryKey: entry.key,
        at: entry.at
      });
      continue;
    }
    if (entry.kind === 'step') {
      stepCount += 1;
      // 步骤很多时只标首尾与失败，避免轴被刷满。
      const failed = entry.card.status === 'failed';
      if (stepCount === 1 || failed) {
        out.push({
          id: `lm-${entry.key}`,
          kind: 'step',
          label: failed ? `步骤失败 · ${entry.card.tool}` : '开始执行',
          entryKey: entry.key,
          at: entry.at
        });
      }
      continue;
    }
    if (entry.kind === 'verification') {
      out.push({
        id: `lm-${entry.key}`,
        kind: 'verification',
        label: entry.fullyVerified ? '验证通过' : entry.verified ? '验证部分通过' : '验证未通过',
        entryKey: entry.key,
        at: entry.at
      });
      continue;
    }
    if (entry.kind === 'review') {
      out.push({
        id: `lm-${entry.key}`,
        kind: 'review',
        label: entry.needsFix ? '独立评审 · 需修复' : '独立评审 · 通过',
        entryKey: entry.key,
        at: entry.at
      });
      continue;
    }
    if (entry.kind === 'conclusion') {
      const n = entry.deliverables?.length ?? 0;
      out.push({
        id: `lm-${entry.key}`,
        kind: 'conclusion',
        label: n > 0 ? `结论 · 目标物 ${String(n)}` : '结论',
        entryKey: entry.key,
        at: entry.at
      });
    }
  }
  return out;
}

/**
 * 把两条流按时间合并成一条（A 方案的接线点）。
 *
 * 对话页要同时看到对话事件（提问/回答/汇总）和任务事件（计划/步骤/评审），
 * 但现在它们由两个构建器分别产出、分屏渲染。合并按 `at` 排序、按 key 去重，
 * 同刻事件保持传入顺序，避免"后出现的跑到前面"。
 */
export function mergeChronological<T extends { at: number; key?: string }>(
  ...streams: ReadonlyArray<readonly T[]>
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const stream of streams) {
    for (const entry of stream) {
      const key = entry.key ?? `${String(entry.at)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged.sort((a, b) => a.at - b.at);
}

/* ------------------------------------------------------------------------- *
 * 渲染层接线的接口（阶段 A）
 *
 * 定位轨跳哪里、色档怎么取、一步「执行中」显示多少秒、什么时候要每秒重画——
 * 这些判断原先散在渲染层甚至根本没写，导致 `buildStreamLandmarks` 与
 * `data-stream-anchor` 各自造好了却没人消费。这里把它们收成纯函数：
 * 渲染层只负责调用与画，口径变了改一处，测试直接打这些函数。
 * ------------------------------------------------------------------------- */

/** 定位轨节点的色档；CSS 只认这几档（.chat-locate-tick.is-*）。 */
export type StreamLandmarkTone = 'prompt' | 'plan' | 'debate' | 'exec' | 'check' | 'done';

const LANDMARK_TONE: Record<StreamLandmarkKind, StreamLandmarkTone> = {
  prompt: 'prompt',
  plan: 'plan',
  debate: 'debate',
  debate_peer: 'debate',
  step: 'exec',
  bridge: 'exec',
  review: 'check',
  verification: 'check',
  conclusion: 'done'
};

/** 地标类型 → 色档。映射只此一处，渲染层不要再写 if/else 挑颜色。 */
export function landmarkTone(kind: StreamLandmarkKind): StreamLandmarkTone {
  return LANDMARK_TONE[kind] ?? 'exec';
}

/**
 * 锚点 id 的唯一来源。
 *
 * `wrapAnchor` 写 `id`、定位轨跳转时取元素，必须用同一个字符串；
 * 分开各写一次就会漂成「点了没反应」。身份只用 `entry.key`，不用数组下标。
 */
export function streamAnchorId(entryKey: string): string {
  return `stream-${entryKey}`;
}

/**
 * 一步的耗时：运行中现算，结束后用真实耗时。
 *
 * 计时只在界面现算，不写回 Journal（不变量 10）。没有 `startedAt` 就如实返回
 * `null`，不拿「现在」当起点编一个数出来。
 */
export function stepElapsedMs(
  card: Pick<StepCard, 'status' | 'startedAt' | 'endedAt' | 'durationMs'>,
  now: number
): number | null {
  if (card.status === 'running') {
    if (typeof card.startedAt !== 'number') return null;
    return Math.max(0, now - card.startedAt);
  }
  if (card.status === 'completed' || card.status === 'failed') {
    if (typeof card.durationMs === 'number') return Math.max(0, card.durationMs);
    if (typeof card.startedAt === 'number' && typeof card.endedAt === 'number') {
      return Math.max(0, card.endedAt - card.startedAt);
    }
    return null;
  }
  return null;
}

/** 运行中的秒数文案：`不到 1 秒` / `8 秒` / `1 分 05 秒`。 */
export function liveElapsedText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return '不到 1 秒';
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${String(total)} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)} 分 ${String(seconds).padStart(2, '0')} 秒`;
}

/**
 * 是否需要每秒重画。
 *
 * 原先只看「有成员在流式输出」，于是步骤跑起来时秒数不动——数据在
 * （`step.startedAt` 已写），界面没算。这里把两种活口都算上。
 */
export function needsLiveTimer(entries: readonly ConversationEntry[]): boolean {
  return entries.some(entry => {
    if (entry.kind === 'member') return entry.status === 'streaming';
    if (entry.kind === 'step') return entry.card.status === 'running';
    return false;
  });
}

/**
 * 当前该高亮的地标：可视锚点里在轨道上最靠后的一个。
 *
 * 可视集合由渲染层用 IntersectionObserver 收集（只是「哪些 entryKey 可见」，
 * 不含任何判断）；排序与取舍在这里做，避免渲染层再写一套滚动逻辑。
 * 都不在轨道上时返回 `null`，界面保留上一次高亮，不闪回顶部。
 */
export function activeLandmarkId(
  landmarks: readonly StreamLandmark[],
  visibleAnchors: readonly string[]
): string | null {
  if (visibleAnchors.length === 0) return null;
  const visible = new Set(visibleAnchors);
  let active: string | null = null;
  for (const landmark of landmarks) {
    if (visible.has(landmark.entryKey)) active = landmark.id;
  }
  return active;
}

/** 只有一个节点时不出轨：一个点占一列既占地方也没有跳转价值。 */
export function shouldShowLandmarkRail(landmarks: readonly StreamLandmark[]): boolean {
  return landmarks.length >= 2;
}

/* -------------------------------------------------------------------------- *
 * 呈现层映射（C1 / C2）：纯函数，渲染层只消费结果，不自己写判断。
 * -------------------------------------------------------------------------- */

/**
 * C1：旁注的呈现层级由 `subtype` 决定，不再靠 `text.startsWith` 猜。
 *
 * 这些是「过程旁注」——上下文、分解、模型参与、循环决策等，压成淡色 aside；
 * 其余（澄清、里程碑、改动量等）保持 focus。旧条目 subtype 可能缺失，
 * 此时回退到 focus，绝不因为读不到类型就把重点内容藏起来。
 */
export function noteEmphasisOf(subtype: NoteSubtype | undefined): 'focus' | 'aside' {
  const aside: readonly NoteSubtype[] = [
    'round', 'context', 'breakdown', 'context_request', 'context_package',
    'participation', 'decision', 'goal_fit', 'system'
  ];
  return subtype && aside.includes(subtype) ? 'aside' : 'focus';
}

/**
 * C2：把时间轴上连续的 step 聚成一组，压成「执行工具 N 次」一行。
 *
 * 聚合只产出**呈现分组**，原始 step 条目一个都不删：渲染层展开分组时仍逐条画，
 * 失败步骤的 stdout / stderr 照旧可展开（不变量 11/12）。
 *
 * 连续条件（全部满足才聚，见规格阶段 3）：
 * - 相邻条目都是 step（中间夹了 user / member / 结论 / 审批就断开）；
 * - 同一轮 roundId；
 * - 相同或兼容的工具类型；
 * - 同一任务——本投影本来就是单任务的条目流，天然满足；
 * - 步骤自身没有需要人工处理的审批（pending / rejected 单独留一条）。
 *
 * 单个 step 不聚合（没意义）。返回的 Map 以组内第一个 step 的 key 为 `key`。
 */
export interface StepCluster {
  key: string;
  /** 组内成员的稳定 key（不是下标），渲染层据此取原始条目。 */
  memberKeys: string[];
  total: number;
  failed: number;
  firstAt: number;
}

/** 工具类型是否兼容：同一 tool 或同属读类 / 写类（读类之间可并，写类不并读类）。 */
function compatibleTool(a: string, b: string): boolean {
  if (a === b) return true;
  const read = (tool: string) => /^(fs\.(list|readFile|tree|search|find|stat|readImage|definition|references)|code\.(definition|references))$/u.test(tool);
  return read(a) && read(b);
}

function stepApprovable(entry: Extract<ConversationEntry, { kind: 'step' }>): boolean {
  return entry.card.approval === 'pending' || entry.card.approval === 'rejected';
}

export function clusterSteps(entries: readonly ConversationEntry[]): {
  clusters: StepCluster[];
  /** 条目 key → 它所属组的 key；非 step 或单条 step 不在表里。 */
  clusterByEntry: Map<string, string>;
} {
  const clusters: StepCluster[] = [];
  const clusterByEntry = new Map<string, string>();
  let run: Extract<ConversationEntry, { kind: 'step' }>[] = [];

  const flush = () => {
    if (run.length >= 2) {
      const cluster: StepCluster = {
        key: `cluster-${run[0].key}`,
        memberKeys: run.map(item => item.key),
        total: run.length,
        failed: run.filter(item => item.card.status === 'failed').length,
        firstAt: run[0].at
      };
      clusters.push(cluster);
      for (const item of run) clusterByEntry.set(item.key, cluster.key);
    }
    run = [];
  };

  for (const entry of entries) {
    if (entry.kind !== 'step' || stepApprovable(entry)) {
      flush();
      continue;
    }
    const prev = run[run.length - 1];
    if (
      prev &&
      (prev.roundId ?? null) === (entry.roundId ?? null) &&
      compatibleTool(prev.card.tool, entry.card.tool)
    ) {
      run.push(entry);
    } else {
      flush();
      run = [entry];
    }
  }
  flush();
  return { clusters, clusterByEntry };
}
