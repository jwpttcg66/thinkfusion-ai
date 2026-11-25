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
  ExecutionReport,
  PlanDebate,
  PlanDebateResultSlice,
  PlanPreview,
  ReviewIssueDetail
} from './contracts';
import { buildTimeline, type StepCard } from './execution-timeline';
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

export type ConversationEntry =
  | (ConversationEntryBase & { kind: 'user'; text: string })
  | (ConversationEntryBase & { kind: 'note'; text: string; tone: ConversationTone; detail?: string })
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
      facts.push(`${step.tool}${path ? ` ${path}` : ''}：已跳过`);
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
    if (step.tool === 'screen.capture') {
      const path = argPath(step);
      facts.push(path ? `截屏：${path}` : '截屏：已完成');
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
): ConversationEntry[] {
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
      const labels: Record<string, string> = {
        'context.prepared': '上下文已准备',
        'context.budget.warning': '上下文接近上限',
        'context.compaction.started': '开始压缩上下文',
        'context.compaction.summary.ready': '摘要已生成',
        'context.compaction.committed': '上下文检查点已提交',
        'context.compaction.failed': '上下文压缩失败',
        'context.compaction.stale': '上下文摘要已过期',
        'context.recovered': '已从检查点恢复上下文'
      };
      push({
        kind: 'note',
        key: `context-${String(event.at)}-${String(seq)}`,
        at: event.at,
        roundId: event.taskId ? currentRoundId : null,
        roundNumber: event.taskId ? roundNumber(currentRoundId) : null,
        tone: event.event === 'context.budget.warning' ? 'warn' : 'muted',
        text: labels[event.event] ?? '上下文事件',
        detail: JSON.stringify(event.context, null, 2)
      });
      continue;
    }

    if (event.type === 'cycle.snapshot') {
      push({
        kind: 'note',
        key: `cycle-${event.cycleId}-${String(event.at)}-${String(seq)}`,
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
      push({
        kind: 'note',
        key: `goal-fit-${String(event.at)}-${String(seq)}`,
        at: event.at,
        roundId: currentRoundId,
        roundNumber: roundNumber(currentRoundId),
        tone: event.fit === 'gap' ? 'warn' : event.fit === 'met' ? 'ok' : 'muted',
        text: `目标符合度 · ${event.fit}`,
        detail: event.notes.join('\n') || undefined
      });
      continue;
    }

    if (event.type === 'clarification.required') {
      push({
        kind: 'note',
        key: `clarify-${String(event.at)}-${String(seq)}`,
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
      push({
        kind: 'step',
        key: `step-${item.key}`,
        at: item.at,
        roundId,
        roundNumber: roundNumber(roundId),
        card: item.card
      });
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

  return entries.sort((a, b) => a.at - b.at || orderWeight(a) - orderWeight(b));
}

/** 同一毫秒里的稳定次序：提问在最前，结论在最后。 */
function orderWeight(entry: ConversationEntry): number {
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
  // 协议 JSON 不是结论；系统套话（「任务完成」）也不能单独冒充结论。
  const text = candidates.find(item => !protocolKind(item) && !isGenericConclusion(item)) ?? '';

  const executionGoal = executionGoalFromEvents(ordered);
  // 执行结果仍取最近一份报告（最近一轮在干什么）；目标物取全轮并集。
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
  // 有真实工具结果时，用第一条交付事实当结论文本，避免主页面只剩「任务完成」。
  const deliveryText = executionResults[0] ?? '';
  return {
    text: text
      || deliveryText
      || (status === 'failed'
        ? (failed?.type === 'task.failed' ? failed.error : '任务失败，没有留下结论文本。')
        : status === 'cancelled'
          ? '任务已取消，没有留下结论文本。'
          : `${statusText(status)}，模型没有给出结论文本；以下是真实执行结果。`),
    facts,
    executionGoal,
    executionResults,
    deliverables,
    tone
  };
}
