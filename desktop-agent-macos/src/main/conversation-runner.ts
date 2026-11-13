import { randomUUID } from 'node:crypto';
import { buildAttachmentMaterial, describeAttachments, composeQuestionWithAttachments, dedupeAttachments, type AttachmentText, type ConversationAttachment } from '../shared/attachments';
import type { AgentTask } from '../shared/contracts';
import type { Conversation, ConversationDeleteOutcome, ConversationEvent, ConversationExecutionConfig, ConversationMessage, ExecutionMode, Synthesis } from '../shared/conversation';
import { normalizeExecutionConfig } from '../shared/conversation';
import { classifyIntent } from '../shared/intent';
import { toRouteTaskKind, type ModelRoute, type RouteTaskKind } from '../shared/model-route';
import {
  needsProjectEvidence,
  normalizeDebateMode,
  normalizeWorkspaceMode,
  routingLabel,
  routeTask,
  type EngineeringTaskKind,
  type TaskRouting,
  type WorkspaceMode
} from '../shared/workspace';
import { engineeringMaterial, type ProjectScan } from './engineering/project';
import { mainCapabilities } from './capabilities';
import type { AgentStore } from './store';
import type { SubAgentRegistry } from './agents/registry';
import type { SubAgentAnswer, SubAgentPool, SubAgentTask } from './agents/types';
import { notToolRequest } from '../shared/partial-stream';
import { MasterAgent, type ChannelOutcome, type ResearchOutcome, type ResearchRequest, type ResearchSink } from './master-agent';
import { CollaborationResearch, type CollaborationRecord } from './collaboration/runner';
import { synthesizeWithFusion } from './synthesis/engine';
import {
  buildLeadSummaryQuestion,
  buildVerdictQuestion,
  formatDebateTranscript,
  inlineLeadInstructions,
  LEAD_SUMMARY_SYSTEM,
  LEAD_SUMMARY_TIMEOUT_MS,
  LEAD_VERDICT_SYSTEM,
  leadSummarySystem,
  parseTopics,
  rewriteSourceRefs,
  sourceTags,
  type LeadTaskKind
} from './synthesis/lead-stage';
import { extractMaterial, fetchPageText } from './knowledge/page-extract';
import {
  buildFollowUpQuestion,
  buildFollowUpSummaryQuestion,
  decideFollowUp,
  FOLLOW_UP_ROUND_BUDGET_MS,
  followUpBudget,
  followUpKey,
  followUpNote,
  parseFollowUps
} from './research/follow-up';
import { heuristicPick } from './synthesis/lead-selector';
import {
  buildEngineeringAnswerQuestion,
  buildToolFollowupQuestion,
  engineeringAnswerSystem,
  engineeringToolSystem,
  type ModelMemberView
} from './research/engineering-round';
import { MAX_TOOL_ROUNDS, parseToolRequest } from './research/project-tools';
import { SECOND_OPINION_BUDGET_MS } from './research/second-opinion';
import {
  buildWebOrchestrationQuestion,
  planEngineeringOrchestration,
  type EngineeringOrchestrationPlan
} from './research/engineering-orchestration';
import type { JudgeVerdict } from './judge/types';
import { applyRoutingVerdict, type RoutingVerdict } from './research/routing-classifier';
import type { TraceRecorder } from './trace/trace-recorder';
import { errorCodeOf, type TraceMeta, type TraceSource, type TraceStatus } from '../shared/trace';

/**
 * 归属规则（2026-11-06 用户裁决）：本地主导只用本地模型、网页主导只用网页、
 * 云端主导只用远程 API；混合先综合决定采用哪一种，再严格只用那一类。
 *
 * 返回的是**实际**归属方式，不是界面上选的那一档。理由要落进主导人说明，
 * 用户能回答「这一轮到底用了谁」。
 */
function ownershipOf(
  config: ConversationExecutionConfig,
  answers: ReadonlyArray<{ channelId: string }>,
  executorIds: ReadonlySet<string>,
  sourceOf: (agentId: string) => 'web' | 'local' | 'cloud' | undefined
): { mode: 'web' | 'local' | 'cloud'; reason: string } {
  const explicit = config.leadAgentId;
  if (explicit) {
    if (answers.some(answer => answer.channelId === explicit)) {
      return { mode: 'web', reason: '你指定了网页通道主导' };
    }
    const source = sourceOf(explicit);
    if (source === 'local') return { mode: 'local', reason: '你指定了本地模型主导' };
    if (source === 'cloud') return { mode: 'cloud', reason: '你指定了云端模型主导' };
  }
  if (config.executionMode !== 'hybrid') {
    return { mode: config.executionMode, reason: `执行模式指定${config.executionMode}` };
  }
  const ids = [...executorIds];
  if (ids.some(id => sourceOf(id) === 'cloud')) {
    return { mode: 'cloud', reason: '混合：检测到可用远程 API 成员，优先用云端，不占本机算力' };
  }
  if (ids.some(id => sourceOf(id) === 'local')) {
    return { mode: 'local', reason: '混合：没有可用云端，但有本地模型' };
  }
  return { mode: 'web', reason: '混合：没有可用的本地/云端模型，由网页通道全程执行' };
}

/** 归属方式对应的辩手名单。网页方式直接用回答者，其余按成员来源过滤。 */
function debatersFor(
  mode: 'web' | 'local' | 'cloud',
  answers: ReadonlyArray<{ channelId: string }>,
  executorIds: ReadonlySet<string>,
  sourceOf: (agentId: string) => 'web' | 'local' | 'cloud' | undefined
): string[] {
  if (mode === 'web') return answers.map(answer => answer.channelId);
  return [...executorIds].filter(id => sourceOf(id) === mode);
}

/**
 * 工程空间这一轮拿到的东西：多 agent 的回答，以及这一场的编排计划。
 *
 * 之所以要包一层而不是直接返回 `ResearchOutcome`：执行阶段得知道主导人是谁、
 * 哪些成员同场。工程编排按执行模式归属（云端主导只用云端；混合档才加网页），
 * 这些不能从 `executionMode` 反推。
 */
interface EngineeringRound {
  outcome: ResearchOutcome;
  orchestration: EngineeringOrchestrationPlan;
}

export interface ConversationDeps {
  store: AgentStore;
  registry: SubAgentRegistry;
  emit: (event: ConversationEvent) => void;
  /**
   * Hand-off for the one intent that touches disk. Injected rather than
   * imported so this file cannot reach the runtime by accident — the whole
   * point of the split is that the conversation path has no execution in it.
   */
  submitWorkspace: (input: {
    prompt: string;
    permissionPreset: string;
    workspaceRoot?: string;
    /** V2.1 D-03：会话里的辩论开关，决定计划要不要先辩一场。 */
    planDebate?: 'auto' | 'on' | 'off';
  }) => Promise<AgentTask>;
  /**
   * V2.1 Model Router（产品定义第 8 节）：这一轮用哪些模型、为什么。
   *
   * 交给外面实现，因为「此刻有哪个成员可用」是运行时信息；runner 只负责在
   * 提问之前把它记下来，供界面显示与事后回溯。不传就不记录，行为不变。
   */
  modelRoute?: (input: {
    config: ConversationExecutionConfig;
    taskKind: RouteTaskKind;
  }) => ModelRoute;
  /**
   * 工程空间的路由判定：模型主导时交给模型，网页主导按规则。
   *
   * 注入而不 import 实现：挑哪家模型、此刻有没有 Key、本地推理槽空不空，
   * 都是运行时信息。返回 null 表示「判不了」，runner 退回规则。
   * 不传 = 只有规则（现有全部老测试行为不变）。
   */
  routeWithModel?: (input: {
    text: string;
    attachmentNames: readonly string[];
    /** 附件开头（判定用）。有它时分类器看得到「文件里到底是什么」。 */
    attachmentExcerpts?: ReadonlyArray<{ name: string; text: string }>;
    hasProject: boolean;
    /** 执行模式：云端主导时跳过本地，直连用户点名的云端模型。 */
    executionMode: ConversationExecutionConfig['executionMode'];
    leadAgentId?: string;
    selectedCloudModels?: string[];
  }) => Promise<RoutingVerdict | null>;
  /**
   * Test seam for the turn budget. Five minutes is a product number, not a
   * behaviour — a test that has to wait five minutes to see what happens when
   * the budget runs out is a test nobody runs.
   */
  budgetMs?: number;
  /**
   * 把「这一轮问谁」交给外面组装，runner 自己不认识执行模式。
   *
   * 不传就是老行为（整份网页注册表），所以现有测试和没有接线的环境都不受影响。
   */
  poolFor?: (config: ConversationExecutionConfig, base: SubAgentPool) => SubAgentPool;
  /**
   * 执行阶段成员（本地 + 云端模型）：它们不参与第一轮回答，但可以当主导人，
   * 也可以当辩手。不传表示没有执行阶段成员。
   */
  executorIdsFor?: (config: ConversationExecutionConfig) => ReadonlySet<string>;
  /**
   * 工程空间「模型直答」的候选名单，带此刻的可用性。
   *
   * 2026-11-08 用户裁决：工程模式不优先问网页，读取本地由模型做。所以工程空间
   * 的第一手回答要在这里挑人（本地优先），而不是走 `pool.available()`——那里
   * 只有网页通道。不传 = 没有模型，工程空间退回网页并说明原因。
   */
  modelMembers?: (config: ConversationExecutionConfig) => Promise<readonly ModelMemberView[]>;
  /**
   * 工程空间第一意见要附加的专家 / 技能 system 段。
   *
   * 注入而不 import：加载 .md、判场景、读开关都是主进程的事，runner 只拿到
   * 拼好的几行字。不传就是老行为（只有工程证据那三条纪律），现有测试不受影响。
   * 这些字只进本地/云端 API 的 system，question 保持用户原话 + 证据，一字不改。
   */
  expertiseFor?: (input: { workspaceMode: WorkspaceMode | undefined; question: string }) => {
    system: string[];
    note: string;
    loaded: string[];
  };
  /**
   * 「＋ · 添加文件」挑中的路径 → 这一刻的正文。
   *
   * 注入而不 import：读盘、体积上限、二进制判定都是主进程的事（还挂着
   * `file.attach` 这个能力插件的开关），runner 只拿到可以拼进问题的那几段。
   * 不传 = 这一轮没有附件，老调用与全部老测试行为不变。
   */
  readAttachments?: (paths: readonly string[]) => Promise<AttachmentText[]>;
  /**
   * 跑一场「会话内辩论」：主导人指定辩题后，由本地/云端模型多轮交锋。
   *
   * 辩论是独立子系统（`debate/`），runner 不认识它的调度；这里只拿回一份
   * 可读的轮次记录，交给主导人写最终意见。不传表示这一轮不跑辩论（只汇总）。
   */
  runDebate?: (input: {
    conversationId: string;
    question: string;
    topics: string[];
    /** 网页通道的第一轮回答，作为辩论的基准观点（带通道 id 才能原样落到发言者名下）。 */
    seeds: Array<{ agentId: string; label: string; text: string }>;
    debaters: string[];
    lead: { agentId: string; label: string; kind: 'web' | 'local' | 'cloud' };
    /** 请求的执行模式，以及归属规则收敛后实际使用哪一类成员。 */
    mode: ConversationExecutionConfig['executionMode'];
    effectiveMode: 'web' | 'local' | 'cloud';
    /** 这一场用哪种协作策略；不传由调用方按默认（真理发现）处理。 */
    debateStrategy?: ConversationExecutionConfig['debateStrategy'];
    /** 辩论进行中的轮次进度；用来把「汇总中 4:00」变成看得懂的说明。 */
    onProgress?: (info: {
      rounds: number;
      status: string;
      stopReason?: string;
      debateId?: string;
      snapshot?: Array<{
        index: number;
        phase: string;
        messages: Array<{ author: string; kind: string; text: string; reasoning?: string }>;
      }>;
    }) => void;
    /**
     * 工程空间多 agent 编排：主进程据此直接组 LeadPlan，跳过 planLead 的归属
     * 收敛（那会把本地/云端模型按 executionMode 剔成一类）。不传 = 知识空间，
     * 完全按原有的归属规则走。
     */
    orchestration?: { reason: string; warnings: string[] };
  }) => Promise<{
    debateId: string;
    rounds: Array<{
      index: number;
      messages: Array<{
        author: string;
        kind: string;
        text: string;
        reasoning?: string;
        agentId?: string;
        createdAt?: number;
        startedAt?: number;
        endedAt?: number;
      }>;
      failures?: Array<{ agentId: string; detail: string }>;
      startedAt?: number;
      endedAt?: number;
    }>;
    status: string;
  } | null>;
  /** 删除会话时连带删掉这一轮的辩论记录；不传表示辩论记录不归会话管。 */
  deleteDebatesFor?: (conversationId: string) => void;
  /**
   * 哪些成员有「网页里那一份会话」。本地/云端没有站点侧栏，删除时不该
   * 提示用户去手动删网页记录，也不该去重置一个不存在的页面。
   */
  isPageChannel?: (agentId: string) => boolean;
  /**
   * 这个成员是什么来源。网页主导和云端主导在产物上要分开标注，所以要能问
   * 出来。不传就当网页（老行为）。
   */
  agentSource?: (agentId: string) => 'web' | 'local' | 'cloud' | undefined;
  /** Phase F：每个子任务状态变化时的旁路通知，给界面和记录用。 */
  onCollaborationRecord?: (record: CollaborationRecord) => void;
  /** Phase I：打开融合引擎。不传时继续用规则版 synthesize，老行为不变。 */
  fusionEnabled?: boolean;
  /** 这一轮的独立裁决（如果有），给综合报告的 finalDecision 用。 */
  verdictFor?: (conversationId: string) => JudgeVerdict | null;
  /**
   * 追问前把各网页视图带回这条会话记录的会话地址。
   *
   * 只「不重置」是不够的：应用重启、页面刷新或用户手动点过别处之后，页面
   * 可能停在首页或另一个会话上，这时追问会自然地在站点侧新建一条会话。
   * 返回成功回到原地址的通道，runner 会把它们算作 continuing，避免随后
   * 的提问流程又把刚恢复的页面重置掉。
   */
  restoreThreads?: (threads: Readonly<Record<string, string>>) => Promise<{
    restored: string[];
    failed: Array<{ agentId: string; detail: string }>;
  }>;
  /**
   * 提问前把已启用、但启动时没打开的网页视图建起来。
   *
   * 「启动时打开网页源」关掉后，冷启动一个视图都没有；不先建，
   * `registry.available()` 会把所有通道判成不可用，等于开关把提问一起关了。
   */
  prepareWebViews?: () => Promise<void>;
  /**
   * 各通道此刻的健康状态。追问恢复刚把页面导航回原会话，就绪探测要几秒
   * 才能通过；提问名单是一次性筛的，不等就会静默少问几家。有了它 runner
   * 才能在筛名单前把刚恢复的通道等到可用。
   */
  channelStatuses?: () => Promise<Array<{ id: string; available: boolean; generating?: boolean; pageReady?: boolean }>>;
  /**
   * 轨迹旁路。不传时整条链路行为不变（测试、旧装配都适用）。
   *
   * `recorder` 每会话一个；`remove` 在删除会话时清文件；`closeOpenTurns`
   * 在启动对账时把崩溃留下的轮收尾为 interrupted。
   */
  trace?: {
    recorder: (conversationId: string) => TraceRecorder;
    remove: (conversationId: string) => void;
    closeOpenTurns: (conversationId: string) => number;
  };
}

/** MasterAgent 与协作执行器共有的接口，conduct 只认这一个方法。 */
export interface ResearchRunner {
  research(request: ResearchRequest, sink: ResearchSink): Promise<ResearchOutcome>;
}

/** 执行阶段（汇总 → 定辩题 → 读辩论）的产物。追加研究要在这份产物上续写汇总。 */
export interface ExecutionStageResult {
  lead: { agentId: string; label: string; kind: 'web' | 'local' | 'cloud'; auto: boolean; reason: string | null };
  summaryText: string | null;
  topics: string[];
  debate: {
    debateId: string;
    rounds: Array<{
      index: number;
      messages: Array<{ author: string; kind: string; text: string; reasoning?: string }>;
      failures?: Array<{ agentId: string; detail: string }>;
    }>;
    status: string;
  } | null;
  verdictText: string | null;
  /** 主导人写汇总时的推理内容；有就落盘，界面折叠显示，不能只活在流式预览里。 */
  reasoning: string | null;
}

const TITLE_CHARS = 42;

/**
 * How long one turn may take before the runner stops waiting on it.
 *
 * A channel has its own three-minute deadline for the answer itself, and that
 * deadline is only reachable if every call underneath it returns. When something
 * in that chain never returns — a page call that hangs on a stuck renderer, a
 * navigation that never finishes — the per-answer deadline is never even
 * consulted, and the turn sits at 「思考中」 forever. This is the outer bound:
 * past it the turn ends as a failure that names what was still being waited on,
 * because 「等了五分钟，ChatGPT 没有回应」 is a usable thing to read and
 * 「思考中」 is not.
 */
const TURN_BUDGET_MS = 5 * 60_000;

/** Statuses that mean a turn is running — i.e. the ones a crash can strand. */
const IN_FLIGHT_STATUSES = new Set<Conversation['status']>([
  'thinking',
  'collecting',
  'comparing',
  'synthesizing'
]);

/**
 * Runs one conversation: route it, hand it to the Master Agent, record what came back.
 *
 * This file used to contain the whole research loop. It no longer does, and the
 * split is the point: who participates, how many rounds there are and when a
 * dispute gets put back to the agents is a *research* decision, and it now lives
 * in `master-agent.ts` where it can be tested without a store or an event bus.
 *
 * What is left here is bookkeeping: the conversation row, the messages, the
 * events the renderer listens to. There is still no plan, no approval and no
 * runtime in this file — a question that needs none of those should not pass
 * through any of them.
 */
export interface RunOptions {
  followup: boolean;
  /**
   * 不含附件正文的用户原话。
   *
   * 第一手提问必须是含附件的完整问题（用户挑的文件要发给网页/模型），但执行
   * 阶段不能再用它：附件正文混在【用户的问题】里会被汇总纪律当成「用户的附注」
   * 而不是可引用材料——真机 2026-11-09 因此把日志里写明的总行数判成「无法确定」。
   * 执行阶段用原话提问，附件正文改走材料。
   */
  plainQuestion?: string;
  /** 附件正文材料，只进执行阶段（汇总 / 交锋 / 最终意见）。 */
  attachmentMaterial?: string | null;
}

export class ConversationRunner {
  /** Conversations the user pressed stop on. The Master checks this between steps. */
  private readonly cancelled = new Set<string>();

  /**
   * Turns that are still in flight, with their budget timer.
   *
   * The set is not only bookkeeping: it is what keeps a second question from
   * being started on top of a running one. That happened, and it does not look
   * like an error — the pane simply gained a second identical user bubble while
   * the page was asked nothing new, because only one ask per page can be in
   * flight. Two bubbles and one stuck channel is a worse outcome than a refusal.
   */
  private readonly running = new Map<string, NodeJS.Timeout>();
  /**
   * 最后一次「有进展」的时间。
   *
   * 看门狗按**无进展**计时，而不是总时长：辩论本身可以跑 4 分钟、之后还有
   * 最终意见，按总时长一刀切会在正常长任务上误杀（真机 5 分钟整失败），
   * 而真正卡死的页面又必须被收掉。只有连续 5 分钟一点动静都没有才判超时。
   */
  private readonly lastActivity = new Map<string, number>();

  private touch(conversationId: string): void {
    this.lastActivity.set(conversationId, Date.now());
  }

  /** 每会话一个记录器；没有注入 trace 时为空，所有调用都是 no-op。 */
  private readonly traces = new Map<string, TraceRecorder>();

  constructor(private readonly deps: ConversationDeps) {}

  private traceFor(conversationId: string): TraceRecorder | null {
    if (!this.deps.trace) return null;
    const existing = this.traces.get(conversationId);
    if (existing) return existing;
    const created = this.deps.trace.recorder(conversationId);
    this.traces.set(conversationId, created);
    return created;
  }

  private traceSourceOf(agentId: string): TraceSource {
    return this.deps.agentSource?.(agentId) ?? (this.deps.registry.get(agentId) ? 'web' : 'system');
  }

  private traceLabelOf(agentId: string): string {
    return this.deps.registry.get(agentId)?.label ?? agentId;
  }

  private traceMetaFor(conversation: Conversation): TraceMeta {
    const config = normalizeExecutionConfig(conversation.executionConfig);
    const route = conversation.modelRoute;
    return {
      executionMode: config.executionMode,
      selectedCloudModels: config.selectedCloudModels?.length ?? 0,
      selectedWebChannels: config.selectedWebChannels?.length ?? 0,
      ...(config.leadAgentId ? { leadAgentId: config.leadAgentId } : {}),
      ...(route
        ? {
            answerers: route.answerers.length,
            synthesizers: route.synthesizers.length,
            estimatedCalls: route.estimatedCalls,
            ...(route.degraded ? { degradedReason: route.degraded } : {})
          }
        : {})
    };
  }

  private get budgetMs(): number {
    return this.deps.budgetMs ?? TURN_BUDGET_MS;
  }

  list(): Conversation[] {
    return this.deps.store.listConversations();
  }

  get(conversationId: string): Conversation | null {
    return this.deps.store.getConversation(conversationId);
  }

  messages(conversationId: string): ConversationMessage[] {
    return this.deps.store.listMessages(conversationId);
  }

  /**
   * Delete a conversation, and the copies of it the sites are holding.
   *
   * The local row goes first and unconditionally: the user asked for it to
   * disappear, and a web page that cannot be cleaned is not a reason to keep
   * showing it. What happens to the pages afterwards is reported back, because
   * "已删除" over a ChatGPT sidebar that still lists the thread is a lie the
   * user only discovers later.
   *
   * Three states, and each site gets the same treatment regardless of which one
   * it is in — that is the point of this pass:
   *
   * - answered with an address: the thread is removed from the site's sidebar;
   * - answered with no address: it may still be in the account, so the user is
   *   told plainly instead of being told a deletion succeeded;
   * - asked but never answered: nothing was created, so nothing is reported.
   *   This used to be lumped in with the second case, and the "please delete it
   *   by hand" it produced sent people looking for a row that never existed.
   *
   * Whichever of the three, the page is then moved to a new chat. A page left
   * sitting on a deleted conversation silently continues it on the next
   * question, which is the failure that makes a delete look like it did
   * nothing.
   */
  async delete(conversationId: string): Promise<ConversationDeleteOutcome> {
    const conversation = this.deps.store.getConversation(conversationId);
    const threads = conversation?.threads ?? {};
    // `channels` 只保留「这一轮」提问条；删会话时要清的是整段对话碰过的
    // 网页线程，所以并上 threads / answered，避免早几轮的网页残留在侧栏。
    const asked = [
      ...new Set([
        ...(conversation?.channels ?? []),
        ...(conversation?.answered ?? []),
        ...Object.keys(threads)
      ])
    ];
    // Conversations written before `answered` existed only carry evidence of
    // the answers that left an address behind. That is enough: every channel
    // with a thread is one this conversation definitely talked to.
    const answered = new Set(conversation?.answered ?? Object.keys(threads));

    // A running turn would keep typing into a page whose row is being removed.
    this.cancelled.add(conversationId);
    this.release(conversationId);
    for (const agentId of asked) this.deps.registry.cancelAll(agentId);

    this.deps.store.deleteConversation(conversationId);
    // 会话内辩论的产物随会话一起消失，否则辩论面板会留下一场没有归属的记录。
    this.deps.deleteDebatesFor?.(conversationId);
    // 先把还开着的轮收尾，再删文件：晚到的 phase / note 会被 recorder 的
    // closed 标记挡住，不会把刚删掉的轨迹又建回来。
    this.traces.get(conversationId)?.endTurn({ status: 'cancelled', reason: '会话已删除' });
    this.traces.delete(conversationId);
    this.deps.trace?.remove(conversationId);

    const cleaned: string[] = [];
    const reset: string[] = [];
    const failed: ConversationDeleteOutcome['failed'] = [];

    await Promise.all(
      asked.map(async agentId => {
        const isPage = this.deps.isPageChannel
          ? this.deps.isPageChannel(agentId)
          : this.deps.registry.get(agentId) !== undefined;
        // 真机回归抓到的：本地模型回答完也在 `answered` 里，但没有网页地址。
        // 走原来的分支会报「网页里的那份请手动删除」，让用户去一个不存在
        // 的侧栏找记录。非网页来源没有需要清理的副本，直接跳过。
        if (!isPage) return;

        const label = this.deps.registry.get(agentId)?.label ?? agentId;
        const threadUrl = threads[agentId];

        if (threadUrl) {
          const result = await this.deps.registry.deleteConversation(agentId, threadUrl);
          if (result.ok) cleaned.push(agentId);
          else failed.push({ channelId: agentId, label, detail: result.detail ?? '删除失败' });
        } else if (answered.has(agentId)) {
          // It answered, so the site almost certainly saved something, and the
          // app has no address to find it by. Saying so is the only actionable
          // thing left.
          failed.push({ channelId: agentId, label, detail: '这条会话没有记录网页地址，网页里的那份请手动删除' });
        }

        // Leaving the page on the deleted thread used to be the fallback after
        // a failed delete, and a no-op after a successful one. Both are wrong
        // for the next question, so all of them move on.
        const moved = await this.deps.registry.newConversation(agentId);
        if (moved.ok) reset.push(agentId);
      })
    );

    return { cleaned, reset, failed };
  }

  async start(input: {
    text: string;
    workspaceRoot?: string;
    permissionPreset?: string;
    executionConfig?: Partial<ConversationExecutionConfig>;
    /** V2.1：不给就是知识空间，旧调用（含全部老测试）行为完全不变。 */
    workspaceMode?: WorkspaceMode;
    /** 侧栏工作区分组。只影响归属与展示，不改变工程读取哪个目录。 */
    workspaceId?: string;
    taskKindOverride?: EngineeringTaskKind;
    /** 「＋ · 添加文件」挑中的文件路径；不传就是纯文字提问。 */
    attachments?: string[];
  }): Promise<Conversation> {
    const text = input.text.trim();
    if (!text) throw new Error('先写一句你想研究或完成的事情。');

    // 附件读盘放在最前面：读不出来就不建会话、不发问。建完再失败会留下一个
    // 「有提问、没回答」的空壳，用户只能自己删。
    const attachments = await this.attachmentTexts(input.attachments);
    const outgoing = composeQuestionWithAttachments(text, attachments);

    const intent = classifyIntent(text);
    const workspaceMode = normalizeWorkspaceMode(input.workspaceMode);
    const executionConfig = normalizeExecutionConfig(input.executionConfig);
    const routing: TaskRouting | undefined =
      workspaceMode === 'engineering'
        ? await this.engineeringRouting({
            text,
            attachments,
            override: input.taskKindOverride,
            hasProject: !!input.workspaceRoot,
            executionMode: executionConfig.executionMode,
            ...(executionConfig.leadAgentId ? { leadAgentId: executionConfig.leadAgentId } : {}),
            ...(executionConfig.selectedCloudModels
              ? { selectedCloudModels: executionConfig.selectedCloudModels }
              : {})
          })
        : undefined;
    const now = Date.now();
    const conversation: Conversation = {
      conversationId: randomUUID(),
      title: text.slice(0, TITLE_CHARS),
      intent: intent.kind,
      intentReason: intent.reason,
      status: 'thinking',
      channels: [],
      createdAt: now,
      updatedAt: now,
      executionConfig,
      // 用户点名的那个地址：追问时不会再给一遍，而「这条会话读的是哪一页」
      // 必须能回答，所以随会话存下来。
      ...(intent.kind === 'extract' && intent.url ? { extractUrl: intent.url } : {}),
      // 工作区归属对两个空间都成立：知识会话也挂在工作区下，只是不读目录。
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(workspaceMode === 'engineering'
        ? { workspaceMode, workspaceRoot: input.workspaceRoot, routing }
        : {})
    };

    // V2.1 Model Router：在提问之前就把「这一轮用哪些模型、为什么」定下来并
    // 写进会话。事后统计做不到这件事——事后只能说「问了谁」，说不出「本来
    // 打算问谁、为什么是他」。
    this.applyModelRoute(conversation, toRouteTaskKind(routing?.taskKind ?? intent.kind));

    const trace = this.traceFor(conversation.conversationId);
    trace?.beginTurn({
      inputPreview: text,
      reason: intent.reason,
      meta: this.traceMetaFor(conversation)
    });
    if (routing) {
      trace?.event({
        stage: 'route',
        group: 'prepare',
        status: 'ok',
        reason: routing.reason,
        meta: { code: routing.taskKind, ...(routing.readsProject === undefined ? {} : { readsProject: routing.readsProject }) }
      });
    }
    if (conversation.modelRoute) {
      trace?.event({
        stage: 'route',
        group: 'prepare',
        status: conversation.modelRoute.degraded ? 'skipped' : 'ok',
        reason: conversation.modelRoute.degraded,
        meta: {
          answerers: conversation.modelRoute.answerers.length,
          synthesizers: conversation.modelRoute.synthesizers.length,
          estimatedCalls: conversation.modelRoute.estimatedCalls,
          ...(conversation.modelRoute.degraded
            ? { degradedReason: conversation.modelRoute.degraded }
            : {})
        }
      });
    }

    this.rememberAttachments(conversation, attachments);
    this.save(conversation);
    this.deps.emit({ type: 'conversation.created', at: now, conversation });
    this.addMessage(conversation, { role: 'user', text });
    // 附件正文不写进提问气泡（那是一屏文件），但「这一问带了哪些文件」必须
    // 看得见——否则用户以为附件没送到，或者以为模型读过一份它其实没读到的文件。
    if (attachments.length > 0) {
      this.addMessage(conversation, { role: 'system', text: describeAttachments(attachments) });
    }

    const handoff = async (label: string): Promise<Conversation> => {
      try {
        const task = await this.deps.submitWorkspace({
          prompt: outgoing,
          permissionPreset: input.permissionPreset ?? 'workspace-write',
          workspaceRoot: input.workspaceRoot,
          // 方案评审辩论跟着这条会话的辩论开关走：用户关掉时不能因为「进入执行
          // 链路」就自己开一场，那正是「不得无声扩大模型调用」要防的事。
          planDebate: normalizeExecutionConfig(conversation.executionConfig).debateMode ?? 'auto'
        });
        conversation.taskId = task.taskId;
        conversation.status = 'answered';
        conversation.updatedAt = Date.now();
        this.save(conversation);
        this.addMessage(conversation, {
          role: 'system',
          text: `${label}，已转交执行计划（任务 ${task.taskId.slice(0, 8)}）。左侧会显示计划与审批；未审批前不会改动任何文件。`
        });
        trace?.event({
          stage: 'execute',
          group: 'execute',
          status: 'ok',
          reason: label,
          refs: [{ kind: 'message', id: task.taskId, label: '执行计划' }],
          meta: { code: 'handoff' }
        });
      } catch (error) {
        this.fail(conversation, error);
      }
      trace?.endTurn({
        status: conversation.status === 'answered' ? 'ok' : 'failed',
        reason: label,
        ...(conversation.error
          ? { error: { code: 'unknown', detail: conversation.error } }
          : {})
      });
      return this.deps.store.getConversation(conversation.conversationId)!;
    };

    // The one branch that leaves this file. Everything about it — approval,
    // grants, the runtime — is the executor's business, and the conversation
    // just records that it happened.
    if (intent.kind === 'workspace' && workspaceMode === 'knowledge') {
      return handoff('这是一次工作区操作');
    }

    if (routing) {
      if (routing.needsProject) {
        return this.awaitUser(conversation, '工程工作空间还没有选择项目目录。先点输入框上的「选择项目」，再重新问一次。');
      }
      if (routing.taskKind === 'clarify') {
        return this.awaitUser(
          conversation,
          `这次没有直接执行：${routing.reason}。可以在输入框上明确选「本次按分析」或「本次按实施」再发一次。`
        );
      }
      if (routing.taskKind === 'engineering_execution') {
        return handoff(`已识别为${routingLabel(routing)}（${routing.reason}）`);
      }

      // 工程分析：先真实读工程，然后把回答交给能拿到证据的成员——
      // 工程空间的第一手回答由本地/云端模型直接读证据给出（2026-11-08 用户
      // 裁决：工程模式不优先问网页）；网页读不到本机文件，只在没有可用模型
      // 时兜底。证据只进模型的那条问题，不改变用户的提问原话。
      //
      // 但**只在需要时读**（2026-11-09 用户裁决）：只附了一份文件问它有多少行，
      // 没必要把整个工程目录翻一遍。
      const read = needsProjectEvidence({
        text,
        attachmentCount: attachments.length,
        modelReadsProject: routing.readsProject
      });
      if (!read.read) {
        // 旧证据必须清掉：材料里写着「本轮真实读取」，拿上一轮的文件冒充这一轮
        // 是最坏的谎。这一问的附件正文仍会作为材料进执行阶段。
        conversation.engineeringEvidence = [];
        conversation.engineeringAnalysis = undefined;
        conversation.engineeringFileStats = [];
        conversation.updatedAt = Date.now();
        this.save(conversation);
        // 决定本身已经进轨迹事件行；对话里不再每轮贴一句「没有读取工程目录」。
        trace?.event({
          stage: 'route',
          group: 'prepare',
          status: 'skipped',
          reason: read.reason,
          meta: { code: 'no-project-read', readsProject: false }
        });
      } else {
        const scanStep = trace?.beginStep({
          stage: 'tool',
          group: 'prepare',
          actorId: 'system',
          actorLabel: '工程扫描',
          sourceType: 'system',
          reason: 'project.scan',
          inputPreview: text
        });
        try {
          const scan = await mainCapabilities.execute<ProjectScan>(
            'project.scan',
            { root: input.workspaceRoot!, question: text },
            {}
          );
          conversation.engineeringEvidence = scan.evidence;
          conversation.engineeringAnalysis = scan.analysis;
          conversation.engineeringFileStats = scan.fileStats ?? [];
          conversation.updatedAt = Date.now();
          this.save(conversation);
          // 证据卡本身由 engineeringEvidence 渲染；不再在对话里贴一段扫描摘要。
          trace?.endStep(scanStep, {
            status: 'ok',
            outputPreview: scan.summary,
            ...(scan.warnings.length > 0 ? { reason: scan.warnings.join('；') } : {}),
            refs: scan.evidence.map(item => ({
              kind: 'file',
              id: item.path,
              line: item.line,
              sha256: item.sha256
            })),
            meta: { evidence: scan.evidence.length, outputChars: scan.summary.length }
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          trace?.endStep(scanStep, {
            status: 'failed',
            error: { code: 'unknown', detail }
          });
          return this.awaitUser(conversation, `没能读取工程目录（${detail}）。没有真实证据时不会让模型猜架构，请重新选择项目。`);
        }
      }
    }

    // Returned immediately: a web answer can take a minute, and an IPC call
    // that blocks for a minute is indistinguishable from a hung app. Progress
    // arrives as events.
    void this.run(conversation, outgoing, {
      followup: false,
      // 只有工程空间需要把附件从「问题」挪到「材料」：那里执行阶段的汇总按
      // 工程证据的口径读材料，附件留在问题里就会被判成用户附注。知识空间的
      // 第一手直接把附件随问题发出去，不重复塞第二份。
      ...(workspaceMode === 'engineering'
        ? { plainQuestion: text, attachmentMaterial: buildAttachmentMaterial(attachments) }
        : {})
    }).catch(error =>
      this.fail(conversation, error)
    );
    return conversation;
  }

  /**
   * 工程空间的路由：模型主导时交给模型判，其余按规则。
   *
   * 2026-11-09 用户裁决：「模型的时候模型判定，混合模式模型自己判断」。所以
   * 本地 / 云端 / 混合三档都先问模型；网页主导不问——网页通道读不到别人的
   * 回答，把分类问题发进去还会在用户账号里留下一条无意义会话。
   *
   * 四道闸门，按顺序：
   * 1. 用户明确选了「本次按分析/实施」→ 直接用，不问模型；
   * 2. 还没选工程目录 → 先让用户选，判了也跑不了；
   * 3. 网页主导或没接线 → 规则；
   * 4. 模型超时 / 报错 / 回不合法的 JSON → 规则（`routeTask` 的结论）。
   *
   * 规则在这里不是「主判」，而是**兜底**：模型永远不给 null 之外的惊喜。
   */
  private async engineeringRouting(input: {
    text: string;
    attachments: readonly AttachmentText[];
    override?: EngineeringTaskKind;
    hasProject: boolean;
    executionMode: ExecutionMode;
    leadAgentId?: string;
    selectedCloudModels?: string[];
  }): Promise<TaskRouting> {
    const rule = routeTask({
      text: input.text,
      workspaceMode: 'engineering',
      override: input.override,
      hasProject: input.hasProject,
      attachmentCount: input.attachments.length
    });
    if (input.override || rule.needsProject) return rule;
    if (input.executionMode === 'web' || !this.deps.routeWithModel) return rule;
    try {
      const verdict = await this.deps.routeWithModel({
        text: input.text,
        attachmentNames: input.attachments.map(item => item.name),
        // 附上开头，否则「按这个文件执行」和「这个方案」在判定时没有区别，
        // 模型只能凭句子里的词猜，又回到补动词表那条路。
        attachmentExcerpts: input.attachments.map(item => ({ name: item.name, text: item.text })),
        hasProject: input.hasProject,
        executionMode: input.executionMode,
        ...(input.leadAgentId ? { leadAgentId: input.leadAgentId } : {}),
        ...(input.selectedCloudModels ? { selectedCloudModels: input.selectedCloudModels } : {})
      });
      return verdict ? applyRoutingVerdict(rule, verdict) : rule;
    } catch {
      // 判定失败不能把提问拦下来：退回规则，用户顶多看到「待确认」。
      return rule;
    }
  }

  /**
   * 问一个本地/云端成员，并允许它**自己读一次文件**。
   *
   * 2026-11-09 用户裁决：「读取文件，模型不是应该调用本地能力，没看到调用本地
   * 能力，输出也是糟糕的。」原来第一手只是一次 `generate()`：程序把证据切成 8
   * 个片段，模型没有读整份文件的能力，问「这个文件有多少行」只能答无法确定。
   *
   * 现在：模型照常回答；如果它回的是一行读文件请求（`parseToolRequest` 认得出），
   * 宿主调 `project.read` 真去读（只读、范围限工程目录与这一问的附件），把结果
   * 递回去再问一次。最多额外一轮（`MAX_TOOL_ROUNDS`）：
   *
   * - 认不出请求 → 就是普通回答，一点额外开销都没有；
   * - 读失败 → 把原因当结果递回去，让模型改口或如实说读不到；
   * - 第二轮仍回请求 → 用它的原文，不再循环（预算用完必须给东西）。
   */
  private async askWithReadTool(
    target: { agentId: string; label: string },
    input: {
      pool: SubAgentPool;
      question: string;
      system: string[];
      scope: { root: string; extraFiles: readonly string[] };
      sink: ResearchSink;
      conversation: Conversation;
      trace?: TraceRecorder;
      /** 真的调了本机能力时要让用户在对话里看到；普通流水账仍只进轨迹。 */
      announce?: (text: string) => void;
    }
  ): Promise<SubAgentAnswer> {
    const ask = (question: string): Promise<SubAgentAnswer> =>
      this.askGuarded(input.pool, target.agentId, {
        question,
        stage: 'initial',
        // 证据可能有几万字，本地模型逐段读完再写；读文件那一轮同理。
        timeoutMs: 180_000,
        // 只对本地/云端 API 生效；网页成员不走这里。
        // 证据纪律在前，专家/技能在后，且只追加 system，不动 question。
        system: input.system
      }, input.conversation);

    let answer = await ask(input.question);
    let toolHistory = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (input.sink.cancelled()) break;
      const request = parseToolRequest(answer.text);
      if (!request) break;
      input.sink.phase(target.agentId, 'asking', `读文件：${request.tool}`);
      const toolStep = input.trace?.beginStep({
        stage: 'tool',
        group: 'first',
        actorId: target.agentId,
        actorLabel: target.label,
        sourceType: this.traceSourceOf(target.agentId),
        reason: `读文件：${request.tool}`,
        inputPreview: JSON.stringify(request.args)
      });
      try {
        const result = await mainCapabilities.execute<{
          ok: boolean;
          text: string;
          summary: string;
        }>(
          'project.read',
          {
            tool: request.tool,
            toolArgs: request.args,
            root: input.scope.root,
            extraFiles: input.scope.extraFiles
          },
          {}
        );
        input.trace?.endStep(toolStep, {
          status: result.ok ? 'ok' : 'failed',
          outputPreview: result.summary,
          meta: { outputChars: result.text.length }
        });
        // 真的调了本地能力要让用户看得到：这是唯一保留的逐次工具提示，
        // 因为它证明「文件确实被读了」，不是又一段流水账。
        input.trace?.note(`${target.label} 调用了本机能力：${result.summary}`);
        input.announce?.(`${target.label} 调用了本机能力：${result.summary}`);
        const prior = toolHistory;
        toolHistory = `${toolHistory}\n\n【${result.summary}】\n${result.text}`.slice(-12_000);
        answer = await ask(buildToolFollowupQuestion(input.question, result.summary, result.text, prior));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        input.trace?.endStep(toolStep, {
          status: 'failed',
          error: { code: errorCodeOf(detail), detail }
        });
        throw error;
      }
    }
    return answer;
  }

  /**
   * 把会话里已经落盘的工程证据拼成主导人材料。
   *
   * 刻意不在这里重扫目录：证据是提问那一刻读到的版本，带 sha256；到执行
   * 阶段再读一次，文件可能已经变了，汇总里就会混进两个版本的行号。
   */
  private engineeringMaterialFor(conversation: Conversation): string | null {
    if (conversation.workspaceMode !== 'engineering') return null;
    const evidence = conversation.engineeringEvidence;
    if (!evidence || evidence.length === 0) return null;
    return engineeringMaterial({
      root: conversation.workspaceRoot ?? '',
      summary: `本轮真实读取 ${evidence.length} 个文件片段：${evidence.map(item => `${item.path}:${item.line}`).join('、')}`,
      // 结构关系必须一起递过去，否则 Phase E 的符号索引/调用点算完就丢了：
      // 真机第一轮就踩到了——材料里只有文件片段，主导人只能看到零散几行。
      ...(conversation.engineeringAnalysis ? { analysis: conversation.engineeringAnalysis } : {}),
      // 行数/字节也必须带过去：材料是这里现拼的，扫描结果里的统计不落盘就会
      // 在汇总阶段消失——真机 2026-11-09 因此「第一手答 213 行、汇总写无法确定」。
      ...(conversation.engineeringFileStats ? { fileStats: conversation.engineeringFileStats } : {}),
      evidence,
      filesScanned: evidence.length,
      truncated: false,
      warnings: []
    });
  }

  /**
   * V2.1 Model Router：把「这一轮用哪些模型、为什么」记到会话上。
   *
   * 只记录，不改选人——真正问谁仍由 `poolFor` / `executorIdsFor` 决定。这样
   * 路由算错时不会连带把提问链路改坏，而界面与复盘仍然看得见决定依据。
   */
  private applyModelRoute(
    conversation: Conversation,
    taskKind: RouteTaskKind
  ): void {
    if (!this.deps.modelRoute) return;
    try {
      conversation.modelRoute = this.deps.modelRoute({
        config: normalizeExecutionConfig(conversation.executionConfig),
        taskKind
      });
    } catch {
      // 路由只是解释层：算不出来也不能把这一轮问题拦下来。
    }
  }

  /**
   * 把抓回来的网页正文拼成主导人材料。
   *
   * 和工程证据同一条原则：材料只进汇总，不进第一手提问。抓取失败时这里是
   * 空的，汇总里就不该出现「据网页内容……」这种没有依据的话。
   */
  private pageMaterialFor(conversation: Conversation): string | null {
    if (conversation.intent !== 'extract') return null;
    const page = conversation.pageEvidence;
    if (!page) return null;
    return extractMaterial(page);
  }

  /** 需要用户补信息/改判的一轮：留一行说明，不触发任何模型调用。 */
  private awaitUser(conversation: Conversation, text: string): Conversation {
    conversation.status = 'awaiting_user';
    conversation.updatedAt = Date.now();
    this.save(conversation);
    this.addMessage(conversation, { role: 'system', text });
    this.traceFor(conversation.conversationId)?.endTurn({ status: 'ok', reason: text });
    return conversation;
  }

  /**
   * 这一问挑中的文件，读成正文。
   *
   * 失败就整条提问不发：读不出来还发一句「详见附件」，用户会以为附件送到了。
   * 没有附件时返回空数组，随后拼出来的问题与原来逐字相同。
   */
  private async attachmentTexts(paths: readonly string[] | undefined): Promise<AttachmentText[]> {
    if (!paths || paths.length === 0) return [];
    if (!this.deps.readAttachments) {
      throw new Error('附件读取没有接线：这一问带了文件，但主进程没有注入读取实现。');
    }
    return this.deps.readAttachments(paths);
  }

  /**
   * 把这一轮带过的文件记到会话上（只记引用，不记正文）。
   *
   * 「＋ · 引用对话中的文件」要靠它列出来；正文在每次发送时重新读盘。
   */
  private rememberAttachments(conversation: Conversation, attachments: readonly AttachmentText[]): void {
    if (attachments.length === 0) return;
    const refs: ConversationAttachment[] = attachments.map(item => ({
      id: item.id,
      name: item.name,
      path: item.path,
      bytes: item.bytes,
      addedAt: item.addedAt
    }));
    conversation.attachments = dedupeAttachments([...(conversation.attachments ?? []), ...refs]);
    conversation.updatedAt = Date.now();
  }

  /**
   * 在已有会话里再问一句。
   *
   * `executionConfig` 是**这一次**用的研究设置，不是那个会话创建时的存档。
   * 执行模式以前只在 `start()` 时写进会话，之后改「研究设置」对追问完全无效：
   * 界面上的胶囊已经写着「本地主导」，跑起来还是按创建时的「网页主导」由 Kimi
   * 汇总、交锋、给最终意见。设置是给下一条提问用的，那一条可能是追问，所以
   * 这里要把当前设置收进来、落到会话上，再交给执行阶段。
   */
  async followup(
    conversationId: string,
    text: string,
    executionConfig?: Partial<ConversationExecutionConfig>,
    taskKindOverride?: EngineeringTaskKind,
    attachmentPaths?: readonly string[]
  ): Promise<Conversation> {
    const conversation = this.deps.store.getConversation(conversationId);
    if (!conversation) throw new Error('对话不存在');
    if (conversation.taskId) throw new Error('这是一次工作区任务，请到左侧任务里继续');

    const question = text.trim();
    if (!question) throw new Error('先写一句你想追问的内容。');

    // Refused before the message is written, not after: a second bubble for the
    // same question is a lie about what was asked, and it is the part that
    // survives in the history.
    if (this.running.has(conversationId)) {
      throw new Error('上一轮还在等回答。等它结束，或先点「停止等待」，再发下一句。');
    }

    // 附件同样在写消息之前读：读不出来就不该留下一个「问过了」的气泡。
    const attachments = await this.attachmentTexts(attachmentPaths);
    const outgoing = composeQuestionWithAttachments(question, attachments);

    if (executionConfig) {
      // 整份替换，不做合并：界面里的「研究设置」本身就是完整的一份，合并会把
      // 用户刚清掉的选项（比如从 Kimi 改回「自动」）从旧配置里悄悄带回来。
      conversation.executionConfig = normalizeExecutionConfig(executionConfig);
      // 立刻落盘：这一轮如果被拒（页面不可用、超时）也该保住用户刚改的设置，
      // 否则界面写着本地主导、会话里仍是网页主导，下一次还得再猜一遍。
      this.save(conversation);
    }

    this.cancelled.delete(conversationId);
    this.addMessage(conversation, { role: 'user', text: question });
    if (attachments.length > 0) {
      this.rememberAttachments(conversation, attachments);
      this.addMessage(conversation, { role: 'system', text: describeAttachments(attachments) });
    }

    const trace = this.traceFor(conversationId);
    trace?.beginTurn({
      inputPreview: question,
      reason: '追问',
      meta: this.traceMetaFor(conversation)
    });

    // V2.1：工程会话的追问沿用创建时的空间与项目，不允许临时换目录。
    // 「先分析再修改」的第二阶段靠这里：用户在输入框明确选「本次按实施」，
    // 才把这一句交去生成计划；没有明确指令绝不自动进入执行。
    if (conversation.workspaceMode === 'engineering') {
      const followConfig = normalizeExecutionConfig(conversation.executionConfig);
      const routing = await this.engineeringRouting({
        text: question,
        attachments,
        override: taskKindOverride,
        hasProject: !!conversation.workspaceRoot,
        executionMode: followConfig.executionMode,
        ...(followConfig.leadAgentId ? { leadAgentId: followConfig.leadAgentId } : {}),
        ...(followConfig.selectedCloudModels
          ? { selectedCloudModels: followConfig.selectedCloudModels }
          : {})
      });
      conversation.routing = routing;
      conversation.updatedAt = Date.now();
      this.save(conversation);
      trace?.event({
        stage: 'route',
        group: 'prepare',
        status: 'ok',
        reason: routing.reason,
        meta: { code: routing.taskKind, ...(routing.readsProject === undefined ? {} : { readsProject: routing.readsProject }) }
      });
      if (taskKindOverride === 'execution' && conversation.workspaceRoot) {
        try {
          const task = await this.deps.submitWorkspace({
            prompt: outgoing,
            permissionPreset: 'workspace-write',
            workspaceRoot: conversation.workspaceRoot,
            planDebate: normalizeExecutionConfig(conversation.executionConfig).debateMode ?? 'auto'
          });
          conversation.taskId = task.taskId;
          conversation.status = 'answered';
          this.save(conversation);
          this.addMessage(conversation, {
            role: 'system',
            text: `已转交执行计划（任务 ${task.taskId.slice(0, 8)}）。左侧会显示计划与审批；未审批前不会改动任何文件。`
          });
          trace?.event({
            stage: 'execute',
            group: 'execute',
            status: 'ok',
            reason: '追问转交执行计划',
            refs: [{ kind: 'message', id: task.taskId, label: '执行计划' }],
            meta: { code: 'handoff' }
          });
        } catch (error) {
          this.fail(conversation, error);
        }
        trace?.endTurn({
          status: conversation.status === 'answered' ? 'ok' : 'failed',
          reason: '追问转交执行计划',
          ...(conversation.error
            ? { error: { code: 'unknown' as const, detail: conversation.error } }
            : {})
        });
        return this.deps.store.getConversation(conversationId)!;
      }
      if (routing.taskKind === 'clarify') {
        return this.awaitUser(conversation, `这次没有直接执行：${routing.reason}。可明确选「本次按分析」或「本次按实施」再发一次。`);
      }
      if (routing.taskKind === 'engineering_analysis' && conversation.workspaceRoot) {
        // 和第一问同一条规矩：不需要看工程时不翻目录。
        const read = needsProjectEvidence({
          text: question,
          attachmentCount: attachments.length,
          modelReadsProject: routing.readsProject
        });
        if (!read.read) {
          conversation.engineeringEvidence = [];
          conversation.engineeringAnalysis = undefined;
          conversation.engineeringFileStats = [];
          this.save(conversation);
          trace?.event({
            stage: 'route',
            group: 'prepare',
            status: 'skipped',
            reason: read.reason,
            meta: { code: 'no-project-read', readsProject: false }
          });
        } else {
          const scanStep = trace?.beginStep({
            stage: 'tool',
            group: 'prepare',
            actorId: 'system',
            actorLabel: '工程扫描',
            sourceType: 'system',
            reason: 'project.scan',
            inputPreview: question
          });
          try {
            const scan = await mainCapabilities.execute<ProjectScan>(
              'project.scan',
              { root: conversation.workspaceRoot, question },
              {}
            );
            conversation.engineeringEvidence = scan.evidence;
            conversation.engineeringAnalysis = scan.analysis;
            conversation.engineeringFileStats = scan.fileStats ?? [];
            this.save(conversation);
            trace?.endStep(scanStep, {
              status: 'ok',
              outputPreview: scan.summary,
              ...(scan.warnings.length > 0 ? { reason: scan.warnings.join('；') } : {}),
              refs: scan.evidence.map(item => ({
                kind: 'file',
                id: item.path,
                line: item.line,
                sha256: item.sha256
              })),
              meta: { evidence: scan.evidence.length, outputChars: scan.summary.length }
            });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            trace?.endStep(scanStep, { status: 'failed', error: { code: 'unknown', detail } });
            return this.awaitUser(conversation, `没能读取工程目录（${detail}），这一轮不凭猜测回答。`);
          }
        }
      }
    }

    // 追问同样要重算路由：用户可能刚把研究设置从网页主导改成「本地主导」，
    // 路由记录停在上一轮就是错的。
    this.applyModelRoute(
      conversation,
      toRouteTaskKind(conversation.routing?.taskKind ?? conversation.intent)
    );
    this.save(conversation);
    if (conversation.modelRoute) {
      trace?.event({
        stage: 'route',
        group: 'prepare',
        status: conversation.modelRoute.degraded ? 'skipped' : 'ok',
        reason: conversation.modelRoute.degraded,
        meta: {
          answerers: conversation.modelRoute.answerers.length,
          synthesizers: conversation.modelRoute.synthesizers.length,
          estimatedCalls: conversation.modelRoute.estimatedCalls,
          ...(conversation.modelRoute.degraded
            ? { degradedReason: conversation.modelRoute.degraded }
            : {})
        }
      });
    }

    void this.run(conversation, outgoing, {
      followup: true,
      ...(conversation.workspaceMode === 'engineering'
        ? { plainQuestion: question, attachmentMaterial: buildAttachmentMaterial(attachments) }
        : {})
    }).catch(error =>
      this.fail(conversation, error)
    );
    return conversation;
  }

  /**
   * 把界面上这份研究设置存到这个会话上，不等下一句提问。
   *
   * 追问已经会把设置带进来，但设置本身还是会丢：打开别的会话再回来、或者重开
   * 应用，面板退回默认的「网页主导」，下一条追问就照着默认跑——用户看到的是
   * 「设了没生效」，而且没有任何地方说明为什么。所以面板每改一次就落一次盘，
   * 打开会话时再读回来，界面显示的、追问用的、会话里存的是同一份。
   *
   * 正在跑的时候也可以改：`run()` / `conduct()` 在开头就把配置取成局部变量，
   * 这一轮用的是取到的那一份，不会被半路改掉。
   */
  updateExecutionConfig(
    conversationId: string,
    executionConfig: Partial<ConversationExecutionConfig>
  ): Conversation {
    const conversation = this.deps.store.getConversation(conversationId);
    if (!conversation) throw new Error('对话不存在');
    // 整份替换，理由同 followup：合并会把用户刚清掉的选项从旧配置里带回来。
    conversation.executionConfig = normalizeExecutionConfig(executionConfig);
    conversation.updatedAt = Date.now();
    this.save(conversation);
    return conversation;
  }

  /**
   * Stop waiting.
   *
   * Two things have to happen and they are not the same: the conversation stops
   * (this flag, which the Master checks between steps), and the page stops being
   * waited on. The second one used to be a no-op — the request id was only known
   * *after* the answer arrived, so cancelling mid-flight passed an empty string.
   * Now the adapter is asked to drop every pending wait it has for that agent.
   */
  cancel(conversationId: string): void {
    this.cancelled.add(conversationId);
    this.release(conversationId);
    const conversation = this.deps.store.getConversation(conversationId);
    for (const agentId of conversation?.channels ?? []) {
      this.deps.registry.cancelAll(agentId);
    }
    if (!conversation) return;
    conversation.status = 'cancelled';
    conversation.updatedAt = Date.now();
    this.save(conversation);
    this.traceFor(conversationId)?.endTurn({ status: 'cancelled', reason: '用户停止等待' });
  }

  // -------------------------------------------------------------------------

  /**
   * Turns a previous process left mid-flight.
   *
   * They are loaded from disk as 「思考中」 and nothing will ever move them: the
   * promise that would have finished the turn died with the process that owned
   * it. Left alone they read as work still in progress — a spinner over a
   * conversation nobody is working on, which is indistinguishable from a hang
   * and therefore worse than an honest interruption.
   */
  reconcile(): number {
    let changed = 0;
    for (const conversation of this.deps.store.listConversations()) {
      if (!IN_FLIGHT_STATUSES.has(conversation.status)) continue;
      conversation.status = 'failed';
      conversation.error = '上一轮在应用退出前没有结束，已标记为中断。重新发一次即可。';
      conversation.updatedAt = Date.now();
      this.save(conversation);
      this.deps.trace?.closeOpenTurns(conversation.conversationId);
      this.traces.delete(conversation.conversationId);
      changed += 1;
    }
    return changed;
  }

  private release(conversationId: string): void {
    const timer = this.running.get(conversationId);
    if (timer) clearInterval(timer);
    this.running.delete(conversationId);
    this.lastActivity.delete(conversationId);
  }

  /**
   * The turn ran out of budget.
   *
   * Shaped like a user pressing stop, for the same two reasons: the flag is what
   * the Master checks between steps, and cancelling the pages is what stops a
   * late answer from being written into a turn that has already been declared
   * over. Without the second part the failure card would grow an answer minutes
   * after the fact.
   */
  private abandon(conversation: Conversation, budget = this.budgetMs, hard = false): void {
    const conversationId = conversation.conversationId;
    if (!this.running.has(conversationId)) return;

    this.cancelled.add(conversationId);
    this.release(conversationId);
    for (const agentId of conversation.channels) {
      this.deps.registry.cancelAll(agentId);
    }

    const waiting = conversation.channels
      .map(id => this.deps.registry.get(id)?.label ?? id)
      .join('、');
    const spent = budget >= 60_000
      ? `${String(Math.round(budget / 60_000))} 分钟`
      : `${String(Math.max(1, Math.round(budget / 1000)))} 秒`;
    this.fail(
      conversation,
      new Error(
        `${hard ? `整轮超过 ${spent}还没有结束` : `超过 ${spent}没有任何进展`}${waiting ? `（${waiting}）` : ''}。` +
          '页面可能卡住了：点「停止等待」后重新加载那一页再问。'
      )
    );
  }

  private async run(
    conversation: Conversation,
    question: string,
    options: RunOptions
  ): Promise<void> {
    const conversationId = conversation.conversationId;
    const config = normalizeExecutionConfig(conversation.executionConfig);
    const pool = this.deps.poolFor ? this.deps.poolFor(config, this.deps.registry) : this.deps.registry;
    const executorIds = this.deps.executorIdsFor?.(config) ?? new Set<string>();
    // 默认（含 parallel）仍走原来的 MasterAgent，老路径零风险。只有显式选了
    // sequential / all-selected / smart 才换协作执行器。
    const master: ResearchRunner =
      config.strategy && config.strategy !== 'parallel'
        ? new CollaborationResearch(pool, config.strategy, question, undefined, this.deps.onCollaborationRecord)
        : new MasterAgent(pool);

    // 追加研究要再问一遍网页、再让主导人写一次汇总，五分钟挡不住：预算按轮数
    // 顺延，否则「开了深挖」的结果是被外层预算砍掉，用户拿到的比单轮还少。
    //
    // 工程空间混合档的网页编排成员同样要顺延：页面要加载、键入整段、等它
    // 写完。判定在开跑后才做，预算却要提前定，所以只要「可能会问网页」就
    // 给足——被预算砍掉的网页意见比不问更糟：用户等了几分钟拿到「超时」。
    const possibleWebOrchestration =
      conversation.workspaceMode === 'engineering' &&
      config.executionMode === 'hybrid' &&
      (config.webSecondOpinion ?? 'auto') !== 'off';
    const budget =
      this.budgetMs +
      followUpBudget(config) * FOLLOW_UP_ROUND_BUDGET_MS +
      (possibleWebOrchestration ? SECOND_OPINION_BUDGET_MS : 0);

    // 每 15 秒检查一次「是否已经连续 budget 没有进展」。
    this.touch(conversationId);
    const startedAt = Date.now();
    // 两道闸：没有进展就停（正常卡死），以及整轮绝对上限（辩论自己每 3 秒
    // 报一次进度，会把「无进展」计时一直刷新，必须有一个不依赖活跃度的上限）。
    const hardLimit = Math.max(budget * 2, 10 * 60_000);
    const hardDeadline = startedAt + hardLimit;
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now >= hardDeadline) {
        this.abandon(conversation, hardLimit, true);
        return;
      }
      const last = this.lastActivity.get(conversationId) ?? startedAt;
      if (now - last >= budget) this.abandon(conversation, budget);
    }, Math.min(15_000, Math.max(1000, Math.floor(budget / 4))));
    this.running.set(conversationId, watchdog);
    try {
      await this.conduct(conversation, master, question, options, pool, executorIds);
    } finally {
      const status: TraceStatus | null =
        conversation.status === 'answered'
          ? 'ok'
          : conversation.status === 'failed'
            ? 'failed'
            : conversation.status === 'cancelled'
              ? 'cancelled'
              : conversation.status === 'awaiting_user'
                ? 'ok'
                : null;
      // 终态在这里兜底收尾；还停在 thinking/collecting 说明 conduct 抛了，
      // 交给外层 fail() 写 failed，不抢先把轮标成 interrupted。
      if (status) {
        this.traceFor(conversationId)?.endTurn({
          status,
          ...(conversation.error
            ? { error: { code: 'unknown' as const, detail: conversation.error } }
            : {})
        });
      }
      this.release(conversationId);
    }
  }

  /**
   * 工程空间的第一轮：多 agent 编排（2026-11-08 用户裁决）。
   *
   * 原话：「工程默认改成多agent编排，优先本地和远程模型，除非采用混合模式，
   * 才可以进行网页编排。」这条覆盖了同一天更早的「只问一个模型的第一意见 +
   * 决策类问题追加一个网页第二意见」。
   *
 * - 按执行模式归属挑人：local 只用本地、cloud 只用云端；web / hybrid 才是
 *   本地 + 云端同场。网页默认一个都不问。
 *   本地模型按名单**逐个问**（同一台机器的推理闸门只让一个生成跑，一起发会让
 *   第二个排队超时）；云端与网页没有这个闸门，与本地那条链并行发；
 * - 只有 executionMode === 'hybrid' 才把网页通道作为**并列的编排成员**一起问，
 *   开关沿用 webSecondOpinion（auto 用决策判定 / always / off）；
 * - 问题永远是「用户原话 + 本机真实读到的证据」，没有角色开场。网页成员
 *   收到的是同一形状、证据按 6000 字摘录，不发 system；
 * - 没有工程证据时仍问模型（本问可能故意不读目录），不再拿「没材料」当借口退回网页；
 * - 本地 / 云端主导下没有可用模型或模型全失败：如实失败，**不**退回网页；
 *   只有网页主导 / 混合档才允许退回网页链路（返回 null）。
 *
 * 编排计划随 outcome 一起返回：执行阶段按计划里的 debaters / lead 走。
 */
  private async researchEngineering(
    conversation: Conversation,
    question: string,
    pool: SubAgentPool,
    sink: ResearchSink
  ): Promise<EngineeringRound | null> {
    const config = normalizeExecutionConfig(conversation.executionConfig);
    const trace = this.traceFor(conversation.conversationId);
    const material = this.engineeringMaterialFor(conversation);
    const models = (await this.deps.modelMembers?.(config)) ?? [];
    // 本地 / 云端主导 = 用户明确不要网页。缺模型时失败，不许偷偷改问页面。
    const allowWebFallback =
      config.executionMode === 'web' || config.executionMode === 'hybrid';

    // 网页可用性只在混合档探测：非混合档根本不该碰页面（真机探活本身就会
    // 给每个页面发一次请求），这也是「网页默认不进场」的实现保障。
    let webChannels: Array<{ agentId: string; label: string; available: boolean }> = [];
    if (config.executionMode === 'hybrid') {
      try {
        // 启动时没打开的视图，这里先建；否则 available 会把通道全判掉。
        await this.deps.prepareWebViews?.();
        webChannels = (await this.deps.registry.available()).map(agent => ({
          agentId: agent.id,
          label: agent.label,
          available: true
        }));
      } catch {
        webChannels = [];
      }
    }

    const orchestration = planEngineeringOrchestration({
      mode: config.executionMode,
      leadAgentId: config.leadAgentId,
      models,
      webChannels,
      question,
      webSecondOpinion: config.webSecondOpinion,
      selectedWebChannels: config.selectedWebChannels
    });

    const attachmentCount = conversation.attachments?.length ?? 0;
    if (!material) {
      trace?.note(
        attachmentCount > 0
          ? '这一轮没有工程证据，只依据随附文件与问题原话问模型；不改问网页。'
          : '这一轮没有工程证据（未读目录、本问不需要，或扫描为空），按问题原话直接问模型，不开放读文件工具、不改问网页。'
      );
    }
    if (orchestration.fallback) {
      if (allowWebFallback) {
        sink.note(
          `${orchestration.reason}。工程空间退回网页通道：网页读不到本机文件，回答多半是「请上传文件」。`
        );
        return null;
      }
      sink.note(`${orchestration.reason}。本地/云端主导不退回网页，这一轮没有可问的模型。`);
      const outcome: ResearchOutcome = {
        answers: [],
        synthesis: null,
        failures: [orchestration.reason],
        channels: [],
        messageIds: new Map()
      };
      return { outcome, orchestration };
    }

    trace?.note(orchestration.reason);
    sink.status(orchestration.members.length > 1 ? 'collecting' : 'thinking');

    // 没读工程、也没附件：常识/选型题。不要塞证据纪律、专家人设、读文件工具——
    // 否则常驻「高级开发工程师」仍写着「证据不足就无法确定、不凭常识补」，
    // 真机 2026-11-10 hy4 就会把 java vs go 答成「针对你的游戏服务器无法确定」。
    const needsLocalRead = !!material || attachmentCount > 0;
    const expertise = needsLocalRead
      ? this.deps.expertiseFor?.({
          workspaceMode: conversation.workspaceMode,
          question
        }) ?? { system: [], note: '', loaded: [] }
      : { system: [], note: '', loaded: [] };
    if (expertise.note) trace?.note(expertise.note);

    const engineered = needsLocalRead
      ? buildEngineeringAnswerQuestion(question, material ?? '')
      : question.trim();
    const webQuestion = orchestration.webIncluded
      ? buildWebOrchestrationQuestion(question, material ?? '')
      : null;
    // 模型自己读文件的范围：工程目录 + 这一问的附件（附件可能在工程目录之外）。
    const scope = {
      root: conversation.workspaceRoot ?? '',
      extraFiles: (conversation.attachments ?? []).map(item => item.path)
    };
    const summarySystem = needsLocalRead
      ? [...engineeringAnswerSystem({ attachments: attachmentCount }), ...expertise.system]
      : [];
    const toolSystem = needsLocalRead
      ? [...summarySystem, ...engineeringToolSystem()]
      : summarySystem;
    const answers: SubAgentAnswer[] = [];
    const channels: ChannelOutcome[] = [];
    const failures: string[] = [];
    const messageIds = new Map<string, string>();

    // 条上要一开始就看到全部成员。本地模型只能逐个问，若等到轮到 hy4 才
    // join，前面几十秒的通道条上就没有它——真机 2026-11-10「第一轮没有 hy4」。
    for (const member of orchestration.members) sink.join(member.agentId);

    const askMember = async (target: (typeof orchestration.members)[number]): Promise<void> => {
      if (sink.cancelled()) return;
      const isWeb = target.kind === 'web';
      sink.phase(target.agentId, 'asking', needsLocalRead ? '读工程证据后回答' : '回答');
      try {
        const answer = isWeb
          ? await this.askStreaming(this.deps.registry, target.agentId, {
              question: webQuestion ?? engineered,
              stage: 'initial',
              // 网页要重新加载、键入整段、等它写完，和网页主导的汇总同一量级。
              timeoutMs: SECOND_OPINION_BUDGET_MS
            }, conversation)
          : needsLocalRead
            ? await this.askWithReadTool(target, {
                pool,
                question: engineered,
                system: toolSystem,
                scope,
                sink,
                conversation,
                announce: text => this.addMessage(conversation, { role: 'system', text }),
                ...(this.traceFor(conversation.conversationId)
                  ? { trace: this.traceFor(conversation.conversationId)! }
                  : {})
              })
            : await this.askStreaming(pool, target.agentId, {
                question: engineered,
                stage: 'initial',
                timeoutMs: 180_000,
                ...(summarySystem.length > 0 ? { system: summarySystem } : {})
              }, conversation);
        if (sink.cancelled()) return;
        messageIds.set(target.agentId, sink.record(answer));
        sink.phase(target.agentId, 'answered', needsLocalRead ? '读完证据后回答' : '已回答');
        answers.push(answer);
        channels.push({ kind: 'answered', agentId: target.agentId, label: target.label, answer });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sink.phase(target.agentId, 'failed', detail);
        failures.push(`${target.label}：${detail}`);
        channels.push({
          kind: 'unanswered',
          agentId: target.agentId,
          label: target.label,
          phase: 'failed',
          detail
        });
      }
    };

    // 本地模型要**逐个问**，不能一起发。真机 2026-11-08 抓到：两个 Ollama
    // 模型同时请求时，`LocalAdmission`（24GB 统一内存只让一个推理跑）会让
    // 第二个在 30 秒排队上限里超时，编排于是只剩一份回答、还多一条失败。
    // 云端 API 与网页通道没有这个闸门，和本地那条链并行发，不必陪着等。
    const localMembers = orchestration.members.filter(member => member.kind === 'local');
    const concurrentMembers = orchestration.members.filter(member => member.kind !== 'local');
    await Promise.all([
      ...concurrentMembers.map(target => askMember(target)),
      (async () => {
        for (const target of localMembers) {
          if (sink.cancelled()) return;
          await askMember(target);
        }
      })()
    ]);

    // 一个都没答：网页/混合档才退回网页；本地/云端主导如实失败。
    if (answers.length === 0) {
      if (allowWebFallback) {
        sink.note(`本机模型没有给出回答（${failures.join('；')}），这一轮改问网页通道。`);
        return null;
      }
      sink.note(
        `模型没有给出回答（${failures.join('；') || '没有可用成员'}）。本地/云端主导不退回网页。`
      );
      const outcome: ResearchOutcome = { answers, synthesis: null, failures, channels, messageIds };
      return { outcome, orchestration };
    }

    const outcome: ResearchOutcome = { answers, synthesis: null, failures, channels, messageIds };
    return { outcome, orchestration };
  }

  private async conduct(
    conversation: Conversation,
    master: ResearchRunner,
    question: string,
    options: RunOptions,
    pool: SubAgentPool,
    executorIds: ReadonlySet<string>
  ): Promise<void> {
    const conversationId = conversation.conversationId;
    const config = normalizeExecutionConfig(conversation.executionConfig);
    const trace = this.traceFor(conversationId);
    trace?.beginGroup('prepare', question);

    // 每一轮自己的提问条。`channels` 若跨轮累积，关掉的模型还会挂在条上
    // （上一轮的失败状态跟着回来），看起来像「保存后还在问」。网页侧栏清理
    // 靠 `threads` / `answered`，不靠这一轮的条。
    conversation.channels = [];
    this.save(conversation);

    const sink: ResearchSink = {
      join: (agentId: string) => {
        trace?.join({
          agentId,
          label: this.traceLabelOf(agentId),
          sourceType: this.traceSourceOf(agentId)
        });
        // Recorded before the ask, not after the answer: the strip above the
        // pane is how the user sees what is happening, and an agent being waited
        // on is the single most important thing to see. Recording it only on
        // success made a slow page look exactly like a hang.
        if (conversation.channels.includes(agentId)) return;
        conversation.channels.push(agentId);
        this.save(conversation);
      },
      record: (answer: SubAgentAnswer) => {
        this.touch(conversationId);
        // The address is what makes the web-side copy findable later. Recorded
        // with the message so a delete does not depend on the page still being
        // open on that thread — it usually is not.
        if (answer.threadUrl) {
          conversation.threads = { ...(conversation.threads ?? {}), [answer.agentId]: answer.threadUrl };
        }
        // Answered, which is not the same as asked: a channel that timed out
        // was still in `channels`, and pretending it produced something is what
        // made a delete warn about rows that were never created.
        if (!conversation.answered?.includes(answer.agentId)) {
          conversation.answered = [...(conversation.answered ?? []), answer.agentId];
        }
        const message = this.addMessage(conversation, {
          role: 'channel',
          channelId: answer.agentId,
          text: answer.text,
          ...(answer.reasoning ? { reasoning: answer.reasoning } : {})
        });
        this.save(conversation);
        trace?.record(answer, message.messageId);
        return message.messageId;
      },
      phase: (agentId, phase, detail) => {
        this.touch(conversationId);
        trace?.phase(agentId, phase, detail);
        this.deps.emit({
          type: 'channel.phase',
          at: Date.now(),
          conversationId,
          channelId: agentId,
          phase,
          detail
        });
      },
      delta: (agentId, chunk) => {
        this.touch(conversationId);
        this.deps.emit({
          type: 'answer.delta',
          at: Date.now(),
          conversationId,
          channelId: agentId,
          ...chunk
        });
      },
      // 进度流水账（编排理由、技能加载等）调用方已改走 trace.note；
      // sink.note 保留给失败/漂移这类需要用户看见的提示。
      note: text => {
        trace?.note(text);
        this.addMessage(conversation, { role: 'system', text });
      },
      status: status => {
        this.touch(conversationId);
        trace?.status(status);
        this.setStatus(conversation, status);
      },
      cancelled: () => this.cancelled.has(conversationId)
    };

    // 网页主导 / 混合档（以及非工程空间的默认网页链路）在提问前把视图建齐：
    // 「启动时打开」关掉后冷启动没有 WebContentsView，不建就问等于静默零通道。
    const needsWebViews =
      conversation.workspaceMode !== 'engineering' ||
      config.executionMode === 'web' ||
      config.executionMode === 'hybrid';
    if (needsWebViews) {
      const prepareStep = trace?.beginStep({
        stage: 'prepare',
        group: 'prepare',
        actorId: 'system',
        actorLabel: '网页视图',
        sourceType: 'system',
        reason: 'prepare-web-views'
      });
      try {
        await this.deps.prepareWebViews?.();
        trace?.endStep(prepareStep, { status: 'ok' });
      } catch (error) {
        /* 建失败的通道在 available / ask 里各自报，不在这里吞掉整轮 */
        trace?.endStep(prepareStep, {
          status: 'failed',
          error: {
            code: 'unknown',
            detail: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }

    // 追问要落在原来的网页会话里。光有 continuing（不重置）不够：应用重启、
    // 页面刷新或手动点过别处之后，页面可能停在首页，追问就会在站点侧新建
    // 一条会话。先按这条会话记下的 threadUrl 把页面带回去。
    const continuing = new Set(conversation.answered ?? []);
    const threads = conversation.threads ?? {};
    if (options.followup && Object.keys(threads).length > 0) {
      try {
        const result = await this.deps.restoreThreads?.(threads);
        for (const agentId of result?.restored ?? []) continuing.add(agentId);
        for (const item of result?.failed ?? []) {
          this.addMessage(conversation, {
            role: 'system',
            text: `没能回到 ${item.agentId} 上一次的网页会话（${item.detail}）；这一轮可能在新会话里继续。`
          });
        }
        // 刚导航回原会话的页面，就绪探测要几秒才通过；上一轮的回答有时也
        // 还没落定（generating 未回落）。提问名单是一次性筛的，这里不等，
        // 那些通道就会被静默排除，状态条永远「待命」——2026-11-06 真机
        // 复现过：三家只问了一家，另外两家连失败记录都没有。
        const restored = result?.restored ?? [];
        if (restored.length > 0 && this.deps.channelStatuses) {
          const deadline = Date.now() + 12_000;
          while (Date.now() < deadline) {
            const statuses = await this.deps.channelStatuses();
            const pending = restored.filter(id => !statuses.find(item => item.id === id)?.available);
            if (pending.length === 0) break;
            await new Promise(resolve => setTimeout(resolve, 700));
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.addMessage(conversation, {
          role: 'system',
          text: `恢复原来的网页会话失败：${detail}；这一轮可能在新会话里继续。`
        });
      }
    }

    // V2.1 extract：先把用户点名的网页正文抓回来。
    //
    // 不做这件事时，extract 只是给网页通道贴了个标签——它们各自决定要不要打开
    // 那个链接，打不开就回一句「我无法访问」，所谓「提取」根本没有发生。
    // 抓不到也继续：网页通道自己的回答仍有价值，但要如实说没有正文可依。
    if (conversation.intent === 'extract' && conversation.extractUrl && !conversation.pageEvidence) {
      const extractStep = trace?.beginStep({
        stage: 'extract',
        group: 'prepare',
        actorId: 'system',
        actorLabel: '网页正文',
        sourceType: 'system',
        reason: conversation.extractUrl,
        refs: [{ kind: 'url', id: conversation.extractUrl }]
      });
      try {
        const page = await fetchPageText(conversation.extractUrl);
        conversation.pageEvidence = page;
        conversation.updatedAt = Date.now();
        this.save(conversation);
        trace?.endStep(extractStep, {
          status: 'ok',
          outputPreview: page.title,
          refs: [{ kind: 'url', id: page.url, label: page.title }],
          meta: { outputChars: page.chars, code: 'page-extract' }
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        trace?.endStep(extractStep, {
          status: 'failed',
          error: { code: 'unknown', detail }
        });
        this.addMessage(conversation, {
          role: 'system',
          text: `没能抓取网页正文（${detail}）；这一轮只依据各网页回答整理，没有页面正文作为依据。`
        });
      }
    }

    // 工程空间：多 agent 编排（本地+云端模型，混合档再加网页）读证据。
    // 2026-11-08 用户裁决，覆盖了同一天更早的「一个模型第一意见 + 一个网页
    // 第二意见、两份并列不汇总」。没有可用模型时返回 null，下面照旧走网页
    // 链路并已写过原因。
    trace?.beginGroup('first', question);
    const engineeringRound =
      conversation.workspaceMode === 'engineering'
        ? await this.researchEngineering(conversation, question, pool, sink)
        : null;
    if (this.cancelled.has(conversationId)) return;

    const outcome =
      engineeringRound?.outcome ??
      (await master.research(
        {
          question,
          followup: options.followup,
          // Continuity is per answered channel, not per asked one. A channel that
          // failed last turn is not holding this conversation's thread, so a
          // follow-up has to start it clean — otherwise its answer arrives with
          // whatever unrelated history the page was left on.
          continuing
        },
        sink
      ));

    if (this.cancelled.has(conversationId)) return;

    // 执行阶段（回答之后）：主导人做三件事——
    //   1. 汇总全部回答，写【结论/一致/分歧/存疑】；
    //   2. 从分歧里指定辩题（没有实质分歧就不辩）；
    //   3. 读辩论记录，给最终意见。
    //
    // 工程空间现在也走这一步：2026-11-08 裁决把工程默认改成多 agent 编排，
    // 编排的产物就是「汇总 → 交锋 → 最终意见」，不再让两份意见并列了事。
    // 工程编排的成员名单不按归属过滤，随编排计划一起传下去。
    let execution: ExecutionStageResult | null = null;
    execution = await this.runExecutionStage(
      pool,
      conversation,
      // 执行阶段用不含附件正文的原话：附件正文以材料身份出现，避免它被当成
      // 「用户的问题」里的一段附注，被汇总纪律排除在可用依据之外。
      options.plainQuestion ?? question,
      outcome,
      sink,
      executorIds,
      this.engineeringMaterialFor(conversation),
      this.pageMaterialFor(conversation),
      followUpBudget(config) > 0,
      engineeringRound?.orchestration ?? null,
      options.attachmentMaterial ?? null
    );
    if (this.cancelled.has(conversationId)) return;

    // P6 多轮自主研究：主导人指出「还缺什么」之后，把缺口再问一遍所有网页
    // 通道，然后让它更新汇总。默认 0 轮，所以默认行为与以前完全一致。
    const deepened = await this.deepenResearch(pool, master, conversation, question, outcome, execution, sink);
    if (this.cancelled.has(conversationId)) return;
    if (execution && deepened.summaryText) execution.summaryText = deepened.summaryText;

    // A channel that stayed silent is a fact the user needs. It used to be
    // dropped on the floor: two answers arrived out of three, the pane showed
    // two bubbles and no explanation, and the only way to learn that Gemini had
    // timed out was to reconstruct the round by hand.
    if (outcome.failures.length > 0) {
      this.addMessage(conversation, {
        role: 'system',
        text: `以下通道没有给出回答：${outcome.failures.join('；')}`
      });
    }

    // 融合引擎失败时保留原来的规则版综合，不抛错（ARCHITECTURE 11.9）。
    // 规则版本身已经是各通道回答的合成，降级后界面仍有东西可看。
    //
    // 工程编排也走融合：主导人的汇总要盖过规则版综合才落得进综合卡，所以
    // 这里需要一份 synthesis 作为容器（哪怕只有一位成员，也要有这个容器）。
    // 主导产物会把共识/分歧/缺口全部清空，规则版那套统计不会并列显示。
    trace?.beginGroup('synthesis');
    const synthesisStep = trace?.beginStep({
      stage: 'synthesis',
      group: 'synthesis',
      actorId: 'system',
      actorLabel: '综合',
      sourceType: 'system',
      reason: execution ? '主导产物 / 融合' : '规则版综合'
    });
    let synthesis = outcome.synthesis;
    const fusionFloor = engineeringRound?.orchestration ? 1 : 2;
    if (this.deps.fusionEnabled && outcome.answers.length >= fusionFloor) {
      try {
        const fused = synthesizeWithFusion(
          outcome.answers.map(answer => ({
            channelId: answer.agentId,
            messageId: outcome.messageIds?.get(answer.agentId) ?? '',
            text: answer.text
          })),
          { verdict: this.deps.verdictFor?.(conversationId) ?? undefined }
        );
        synthesis = fused.synthesis;
      } catch {
        // 故意不记日志刷屏：降级是正常路径，原来的 synthesis 还在。
      }
    }

    // 工程编排只有一位成员、或融合引擎没开时，上面不会产出 synthesis。但
    // 主导人照样写了汇总/最终意见——总不能因为缺个容器就把它的产物丢掉。
    // 造一个空壳，下面的主导产物会把内容填进去、把规则版结构清空。
    if (execution && !synthesis && engineeringRound?.orchestration) {
      synthesis = {
        consensus: [],
        disputed: [],
        unique: [],
        gaps: [],
        overlap: [],
        recommendation: '',
        degraded: false
      };
    }

    // 主导人的产物盖过默认综合：结论、以及「哪些一致、哪里有分歧」这套结构，
    // 都由读过全部回答的主导人来说，规则版那套不再并列展示。
    if (execution && synthesis) {
      const { lead, summaryText, topics, debate, verdictText, reasoning } = execution;

      const backend: NonNullable<Synthesis['fusion']>['backend'] =
        lead.kind === 'web' ? 'web' : lead.kind === 'local' ? 'local-model' : 'remote';
      const sourceLabel = engineeringRound?.orchestration ? '份编排成员的回答' : '份网页回答';
      const parts: string[] = [];
      parts.push(
        lead.auto
          ? `系统按「问题 + 答案质量」自动选 ${lead.label} 当主导人（${lead.reason ?? '本地模型判定'}）：它汇总了 ${outcome.answers.length} ${sourceLabel}`
          : `由主导人 ${lead.label} 汇总了 ${outcome.answers.length} ${sourceLabel}`
      );
      if (topics.length > 0) {
        parts.push(`它指定了 ${topics.length} 个辩题（${topics.join('；')}）`);
      } else {
        parts.push('回答之间没有需要辩的实质分歧，没有发起辩论');
      }
      if (debate) {
        parts.push(`辩论跑了 ${debate.rounds.length} 轮（${debate.status}）`);
      } else if (topics.length > 0) {
        parts.push('但辩论没有跑起来（归属成员不可用、引擎未就绪或等待超时），这一轮只给了汇总');
      }
      if (verdictText) parts.push('它读完辩论记录后给出最终意见');
      if (deepened.rounds > 0) {
        parts.push(
          `追加研究了 ${deepened.rounds} 轮：把主导人指出的 ${deepened.items.length} 个缺口重新问了一遍所有网页通道，并据此更新了汇总`
        );
      }

      // 汇总（辩前）与最终意见（辩后）各存一份。
      //
      // 以前这里是 `verdictText ?? summaryText`：辩论一跑成功，五段汇总就
      // 被最终意见整段顶掉，界面只剩最后那段话——用户看到的「分歧、辩论、
      // 总结都没了」就是这么来的。汇总里有【一致】【分歧】【存疑】【辩题】，
      // 最终意见里有对质疑的裁定，两者不是同一件东西，不能互相替代。
      const summary = summaryText?.trim() || null;
      const verdict = verdictText?.trim() || null;
      const text = summary ?? verdict;
      if (text) {
        synthesis = {
          ...synthesis,
          recommendation: text,
          ...(summary && verdict && verdict !== summary ? { finalOpinion: verdict } : {}),
          // 五段结构由主导人写，规则版那套不再并列。界面按五段分段显示。
          leadSummary: true,
          // 主导人给了结论，这一轮的结构也归它：五段里就有【一致】和【分歧】。
          // 规则版那套「共同提到 / 分歧 / 覆盖缺口 / 只有一个通道提到的」是按
          // 句子比对算出来的另一份判断，两者并存时界面就成了两张互相矛盾的
          // 结论——真机同一张卡片里，上面写着「没有实质性结论冲突」，下面却列
          // 着「分歧（3）」，而那三条是拿同一家的两句半截话凑的。一次只留一套。
          consensus: [],
          disputed: [],
          unique: [],
          gaps: [],
          overlap: [],
          // 「没有形成共识」说的是规则没能把句子对上，不适用于主导人读完全文
          // 之后写下的结论。
          degraded: false,
          fusion: synthesis.fusion
            ? {
                ...synthesis.fusion,
                backend,
                leadAgentId: lead.agentId,
                leadReason: lead.reason ?? undefined,
                leadAuto: lead.auto,
                debateId: debate?.debateId,
                debateTopics: topics.length > 0 ? topics : undefined,
                confidence: {
                  ...synthesis.fusion.confidence,
                  why: `${synthesis.fusion.confidence.why}；${parts.join('；')}`
                }
              }
            : synthesis.fusion
        };
      }
    }

    trace?.endStep(synthesisStep, {
      status: synthesis ? 'ok' : 'skipped',
      ...(synthesis
        ? {
            outputPreview: synthesis.recommendation,
            meta: {
              claims: synthesis.consensus.length + synthesis.disputed.length + synthesis.unique.length,
              disputes: synthesis.disputed.length,
              unique: synthesis.unique.length,
              gaps: synthesis.gaps.length,
              degraded: synthesis.degraded === true,
              ...(synthesis.leadSummary ? { leadSummary: true } : {}),
              ...(conversation.engineeringEvidence
                ? { evidence: conversation.engineeringEvidence.length }
                : {}),
              citations: outcome.answers.reduce((sum, answer) => sum + (answer.citations?.length ?? 0), 0),
              outputChars: synthesis.recommendation.length
            }
          }
        : { meta: { code: 'no-synthesis' } })
    });
    const debateForMessage = execution?.debate
      ? {
          status: execution.debate.status,
          rounds: execution.debate.rounds.map(round => ({
            index: round.index,
            phase: String((round as { phase?: unknown }).phase ?? ''),
            ...((round as { pending?: string[] }).pending ? { pending: (round as { pending?: string[] }).pending } : {}),
            messages: round.messages.map(message => ({
              author: message.author,
              kind: message.kind,
              text: message.text,
              ...(message.reasoning ? { reasoning: message.reasoning } : {})
            }))
          }))
        }
      : null;
    if (synthesis) {
      const message = this.addMessage(conversation, {
        role: 'synthesis',
        synthesis,
        text: synthesis.recommendation,
        ...(execution?.reasoning ? { reasoning: execution.reasoning } : {}),
        ...(debateForMessage ? { debate: debateForMessage } : {})
      });
      this.deps.emit({ type: 'synthesis.ready', at: Date.now(), conversationId, synthesis });
      void message;
    }

    this.setStatus(conversation, 'answered');
  }

  /**
   * 执行阶段：主导人的三步。
   *
   * 1. 汇总——读完全部网页回答，写【结论/一致/分歧/存疑】，并点出【辩题】；
   * 2. 指定辩论——辩题非空、且有两位以上本地/云端辩手时，交由辩论子系统交锋；
   * 3. 获取辩论——主导人读辩论记录，给最终意见。
   *
   * 网页通道也能当主导：它读不到别人的页面，只能由我们把各家答案拼成一条
   * 消息发进去（页面上表现为用户说的第二段话）。所以网页主导会多花两次生成。
   *
   * 失败不抛：任何一步没成，都退回「有回答、有规则版综合」的状态，原因写进
   * 系统消息，用户能看到是谁没说话、卡在哪。
   */
  private async runExecutionStage(
    pool: SubAgentPool,
    conversation: Conversation,
    question: string,
    outcome: ResearchOutcome,
    sink: ResearchSink,
    executorIds: ReadonlySet<string>,
    /** 只在工程分析链路有值；第一手网页提问不受影响，见 start()。 */
    engineering: string | null = null,
    /** V2.1：extract 真正抓回来的网页正文；同样只进汇总，不进第一手提问。 */
    page: string | null = null,
    /** P6：要不要在汇总里多要一段【待补】。默认 false，单轮提示词不变。 */
    followUp = false,
    /** 工程空间的多 agent 编排计划：绕开知识空间的归属过滤。 */
    orchestration: EngineeringOrchestrationPlan | null = null,
    /**
     * 附件正文材料。和工程证据同级：用户亲手挑的文件原文，不是模型推测。
     * 只有这一问带了附件时才非空；空串按「没有」处理。
     */
    attachments: string | null = null
  ): Promise<ExecutionStageResult | null> {
    const config = normalizeExecutionConfig(conversation.executionConfig);
    const trace = this.traceFor(conversation.conversationId);
    trace?.beginGroup('lead', question);
    const labels = new Map(outcome.channels.map(item => [item.agentId, item.label] as const));
    const answers = outcome.answers.map(answer => ({
      channelId: answer.agentId,
      label: labels.get(answer.agentId) ?? answer.agentId,
      text: answer.text
    }));
    // 知识空间：一份回答没有可汇总的分歧，也没有可辩的对象，跳过执行阶段。
    // 工程编排：哪怕只有一个可用成员也照常开（同一模型自辩），不再因
    // 「不足两位」跳过——这是归属规则里明确要求过的。
    if (answers.length < (orchestration ? 1 : 2)) return null;

    const lead = orchestration?.lead
      ? {
          agentId: orchestration.lead.agentId,
          label: orchestration.lead.label,
          kind: orchestration.lead.kind,
          auto: false,
          reason: orchestration.reason
        }
      : await this.resolveLead(config, question, answers, executorIds);
    if (!lead) {
      const ownership = ownershipOf(config, answers, executorIds, id => this.deps.agentSource?.(id));
      this.addMessage(conversation, {
        role: 'system',
        text: `${ownership.mode} 归属方式下没有可用成员；按归属规则不借用其他类型的成员，这一轮只保留网页回答与规则版综合。`
      });
      return null;
    }
    const isPage = lead.kind === 'web';
    const label = lead.label;

    // 第一轮答完才进入主导汇总；不再在对话里贴一段进度公告，
    // 通道条的第二轮 + leading 相位已经说明了这件事。
    trace?.note(
      lead.auto
        ? `第一轮回答已齐。系统选 ${label} 当主导人。`
        : `第一轮回答已齐。由主导人 ${label} 汇总。`
    );
    // 主导人第一轮往往已经答过；再问一次是汇总，不是「还没答上」。
    // 标成 leading，条上写「汇总中」，避免和第一轮的「提问中」混成一件事。
    // 主导汇总只允许这一人：先把其他人可能残留的 leading 清掉，免得第二轮
    // 条上同时出现好几个「汇总中」。
    // 相位必须先于 synthesizing：否则界面先看到空的「第二轮」卡，第一轮像被顶掉。
    for (const answer of answers) {
      if (answer.channelId === lead.agentId) continue;
      sink.phase(answer.channelId, 'answered', '第一轮已回答');
    }
    sink.phase(
      lead.agentId,
      'leading',
      lead.auto ? `自动选 ${label} 当主导人：汇总各家回答并指定辩题` : `${label} 当主导人：汇总各家回答并指定辩题`
    );
    this.setStatus(conversation, 'synthesizing');

    // —— 第一步：汇总 + 指定辩题 ————————————————————————————
    let summaryText: string | null = null;
    let summaryReasoning: string | null = null;
    let verdictReasoning: string | null = null;
    let leadStep: { turn: number; step: number } | undefined;
    try {
      // 附件、工程证据与网页正文都只在这里（执行阶段的汇总）追加，绝不进第
      // 一手网页问题。网页主导时同样拼进那一条用户消息，走既有的「把材料递
      // 进页面」机制，页面上第一段用户发言仍然只有原话。
      //
      // 附件排在最前：它是用户这一问亲手递过来的原文，优先级不低于程序扫描
      // 到的工程证据。真机 2026-11-09 的教训——附件排在问题里时，汇总会用
      // 工程证据把它否掉，用户看到的结论跟文件内容相反。
      const material = [attachments, engineering, page].filter(Boolean).join('\n\n') || null;
      // 任务类型决定汇总写法：比较要有对比，提取只依据正文。
      const taskKind: LeadTaskKind | undefined =
        conversation.intent === 'workspace' ? undefined : (conversation.intent as LeadTaskKind);
      // 附件与工程证据都是真实材料，必须明确写进纪律里。否则「只依据这些回答」
      // 会被理解为「不能引用用户给的文件」，出现真机那种「文件里明明写着，
      // 结论却说无法确定」。API 主导时这些句子进 system，网页主导时（页面不认
      // system）拼进同一条用户消息，两边口径一致。
      const materialInstructions = [
        ...(attachments
          ? ['【用户随这一问附上的文件】是用户亲手挑的本机文件原文，和各家回答一样是可引用的依据；文件里写明的事实（数字、行数、命令、清单）优先于任何人的推测。']
          : []),
        ...(engineering
          ? ['工程证据是本机真实读取到的文件片段，比网页回答里的推测更可靠；引用它时写明路径:行号。']
          : []),
        ...(attachments && engineering
          ? ['附件与工程证据冲突时，指出冲突本身（各自写了什么），不要默默采用其中一份。']
          : [])
      ];
      const baseQuestion = isPage
        ? inlineLeadInstructions(question, answers, { taskKind, material, followUp, extraInstructions: materialInstructions })
        : buildLeadSummaryQuestion(question, answers, { taskKind, material, followUp });
      leadStep = trace?.beginStep({
        stage: 'lead',
        group: 'lead',
        actorId: lead.agentId,
        actorLabel: label,
        sourceType: this.traceSourceOf(lead.agentId),
        reason: followUp ? '追加轮更新汇总' : '汇总',
        inputPreview: baseQuestion
      });
      const leadTask = {
        question: baseQuestion,
        stage: 'challenge' as const,
        // 网页主导要把一整段重新键入并等它写完，和第一次回答一样慢，给足时间。
        timeoutMs: isPage ? 180_000 : LEAD_SUMMARY_TIMEOUT_MS,
        // 只有 API 主导用得上 system；网页通道会忽略它。
        system: isPage ? undefined : [...leadSummarySystem(taskKind, followUp), ...materialInstructions]
      };
      const answer = isPage
        ? await pool.ask(lead.agentId, leadTask)
        : await this.askStreaming(pool, lead.agentId, leadTask, conversation);
      const text = rewriteSourceRefs(answer.text.trim(), answers);
      summaryText = text || null;
      if (answer.reasoning) summaryReasoning = answer.reasoning;
      trace?.endStep(leadStep, {
        status: summaryText ? 'ok' : 'skipped',
        usage: answer.usage ?? null,
        ...(answer.reasoning ? { reasoning: answer.reasoning } : {}),
        ...(typeof answer.firstTokenAt === 'number' ? { firstTokenAt: answer.firstTokenAt } : {}),
        ...(text ? { outputPreview: text } : {}),
        meta: text ? { outputChars: text.length } : { code: 'empty-summary' }
      });
      if (!summaryText) {
        sink.phase(lead.agentId, 'answered', '汇总未写出内容');
      } else {
        // 整段执行阶段都保持 leading：中途改成 answered，第二轮通道条会空掉，
        // 真机上看起来像「第二轮没有通道条」。细节文字区分进度即可。
        sink.phase(lead.agentId, 'leading', '汇总完成，继续执行阶段');
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      trace?.endStep(leadStep, {
        status: 'failed',
        error: { code: errorCodeOf(detail), detail }
      });
      sink.phase(lead.agentId, 'failed', detail);
      this.addMessage(conversation, { role: 'system', text: `主导人 ${label} 没能完成汇总：${detail}` });
    }
    if (!summaryText) {
      return { lead, summaryText: null, topics: [], debate: null, verdictText: null, reasoning: summaryReasoning };
    }

    // —— 第二步：指定辩论 ————————————————————————————————
    // V2.1：辩论开关。auto 与老行为完全一致；off 连辩题都不生成；
    // on 在主导人没找到分歧时拿原问题兜一个辩题，保证「开启」真的开了。
    const debateMode = normalizeDebateMode(config.debateMode);
    let topics = debateMode === 'off' ? [] : parseTopics(summaryText);
    if (debateMode === 'on' && topics.length === 0) topics = [question.trim().slice(0, 120)];
    // 归属规则：辩手与主导人同属一类，网页主导绝不把本地/云端模型拉进来。
    // 只有一个成员也照样开（自辩），不再用「不足两位」跳过整场。
    const sourceOf = (id: string) => this.deps.agentSource?.(id);
    // 知识空间：归属规则限定主导人与辩手同类。工程编排：名单直接来自编排
    // 计划（本地 + 云端模型全进场），不按 executionMode 收敛成一类。
    const ownership = orchestration
      ? { mode: lead.kind, reason: orchestration.reason }
      : ownershipOf(config, answers, executorIds, sourceOf);
    const debaters = orchestration
      ? orchestration.debaters
      : debatersFor(ownership.mode, answers, executorIds, sourceOf);
    let debate: Awaited<ReturnType<NonNullable<typeof this.deps.runDebate>>> = null;
    if (debateMode === 'off') {
      trace?.note('这一轮按设置关闭了辩论：只汇总，不交锋、不出最终意见。');
    } else if (topics.length === 0) {
      trace?.note(`${label} 判断回答之间没有需要辩的实质分歧，这一轮只汇总。`);
    } else if (debaters.length === 0) {
      trace?.note(
        `${label} 列出了 ${topics.length} 个辩题（${topics.join('；')}），但${ownership.mode}归属方式下没有可用成员，这一轮只汇总。`
      );
    } else if (this.deps.runDebate) {
      trace?.note(`${label} 指定了 ${topics.length} 个辩题：${topics.join('；')}`);
      const debateStep = trace?.beginStep({
        stage: 'debate',
        group: 'debate',
        actorId: lead.agentId,
        actorLabel: label,
        sourceType: this.traceSourceOf(lead.agentId),
        reason: topics.join('；'),
        inputPreview: topics.join('；')
      });
      try {
        debate = await this.deps.runDebate({
          conversationId: conversation.conversationId,
          question,
          topics,
          seeds: answers.map(answer => ({ agentId: answer.channelId, label: answer.label, text: answer.text })),
          debaters,
          lead: { agentId: lead.agentId, label, kind: lead.kind },
          onProgress: info => {
            const suffix = info.stopReason ? `（${info.stopReason}）` : '';
            sink.phase(lead.agentId, 'leading', `辩论进行中：第 ${info.rounds + 1} 轮 · ${info.status}${suffix}`);
            if (info.snapshot) {
              this.deps.emit({
                type: 'debate.progress',
                at: Date.now(),
                conversationId: conversation.conversationId,
                debateId: info.debateId ?? '',
                status: info.status,
                rounds: info.snapshot,
                ...(info.stopReason ? { stopReason: info.stopReason } : {})
              });
            }
          },
          mode: config.executionMode,
          effectiveMode: ownership.mode,
          debateStrategy: config.debateStrategy,
          // 工程编排：主进程直接用这份名单组 LeadPlan，不再过 planLead 的
          // 归属收敛（那会把云端模型或本地模型按 executionMode 剔掉）。
          ...(orchestration
            ? { orchestration: { reason: orchestration.reason, warnings: [] as string[] } }
            : {})
        });
        trace?.endStep(debateStep, {
          status: debate ? (debate.status === 'completed' ? 'ok' : 'interrupted') : 'skipped',
          ...(debate ? { meta: { rounds: debate.rounds.length } } : {})
        });
        // 逐条发言也记成步：整场用时看不出「谁在第几轮慢」。
        if (debate) {
          for (const round of debate.rounds) {
            for (const message of round.messages) {
              const agentId = message.agentId ?? message.author;
              const messageStep = trace?.beginStep({
                stage: 'debate',
                group: 'debate',
                actorId: agentId,
                actorLabel: message.author,
                sourceType: this.traceSourceOf(agentId),
                reason: `第 ${round.index + 1} 轮 · ${message.kind}`,
                inputPreview: topics.join('；'),
                ...(debateStep ? { parentStep: debateStep.step } : {}),
                ...(typeof message.startedAt === 'number'
                  ? { startedAt: message.startedAt }
                  : typeof message.createdAt === 'number'
                    ? { startedAt: message.createdAt }
                    : {})
              });
              trace?.endStep(messageStep, {
                status: 'ok',
                ...(message.reasoning ? { reasoning: message.reasoning } : {}),
                ...(typeof message.endedAt === 'number'
                  ? { endedAt: message.endedAt }
                  : typeof message.createdAt === 'number'
                    ? { endedAt: message.createdAt }
                    : {}),
                outputPreview: message.text,
                meta: { rounds: round.index + 1, outputChars: message.text.length }
              });
            }
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        trace?.endStep(debateStep, {
          status: 'failed',
          error: { code: errorCodeOf(detail), detail }
        });
        this.addMessage(conversation, { role: 'system', text: `辩论没能跑起来：${detail}` });
      }
    }

    // —— 第三步：获取辩论结果，给最终意见 ————————————————————
    let verdictText: string | null = null;
    if (debate && debate.rounds.length > 0) {
      const transcript = formatDebateTranscript(debate.rounds);
      sink.phase(lead.agentId, 'leading', '读辩论记录，给最终意见');
      const verdictStep = trace?.beginStep({
        stage: 'lead',
        group: 'lead',
        actorId: lead.agentId,
        actorLabel: label,
        sourceType: this.traceSourceOf(lead.agentId),
        reason: '读辩论记录'
      });
      try {
        const verdictTask = {
          question: buildVerdictQuestion(question, summaryText, transcript),
          stage: 'challenge' as const,
          timeoutMs: isPage ? 180_000 : LEAD_SUMMARY_TIMEOUT_MS,
          system: isPage ? undefined : LEAD_VERDICT_SYSTEM
        };
        // 最终意见也要流式：辩论结束后这一段同样可能写很久，整段等会让界面
        // 看起来又卡住了。
        const answer = isPage
          ? await pool.ask(lead.agentId, verdictTask)
          : await this.askStreaming(pool, lead.agentId, verdictTask, conversation);
        const text = rewriteSourceRefs(answer.text.trim(), answers);
        verdictText = text || null;
        if (answer.reasoning) verdictReasoning = answer.reasoning;
        trace?.endStep(verdictStep, {
          status: verdictText ? 'ok' : 'skipped',
          usage: answer.usage ?? null,
          ...(answer.reasoning ? { reasoning: answer.reasoning } : {}),
          ...(typeof answer.firstTokenAt === 'number' ? { firstTokenAt: answer.firstTokenAt } : {}),
          ...(text ? { outputPreview: text } : {}),
          meta: text ? { outputChars: text.length } : { code: 'empty-verdict' }
        });
        sink.phase(
          lead.agentId,
          'answered',
          verdictText ? '最终意见完成' : '最终意见未写出内容'
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        trace?.endStep(verdictStep, {
          status: 'failed',
          error: { code: errorCodeOf(detail), detail }
        });
        sink.phase(lead.agentId, 'failed', detail);
        this.addMessage(conversation, { role: 'system', text: `${label} 读辩论记录时没给出最终意见：${detail}` });
      }
    } else {
      // 没有辩论 / 最终意见：执行阶段到此结束，这才离开 leading。
      // 汇总刚写完就标 answered，第二轮条会空掉，辩论还没开。
      sink.phase(lead.agentId, 'answered', '汇总完成');
    }

    return {
      lead,
      summaryText,
      topics,
      debate,
      verdictText,
      reasoning: [summaryReasoning, verdictReasoning].filter(Boolean).join('\n\n') || null
    };
  }

  /**
   * P6：追加研究。
   *
   * 主导人在【待补】里指出「还缺哪个事实」，这里把它变成一条发给**所有**
   * 网页通道的普通问题，拿回新回答，再让主导人把新回答并进汇总。最多跑
   * `followUpRounds` 轮，默认 0 轮（完全等于老行为）。
   *
   * 几条刻意的边界：
   * - 只补充事实，不重开辩论。辩论已经在第一轮跑过，为「补了一个数字」再辩
   *   一场是把成本翻倍而结论不变；需要辩的分歧第一轮就会列出来。
   * - 缺口只能来自主导人的【待补】。程序不按关键词猜「可能还想知道什么」——
   *   那是替用户定研究方向。
   * - 用户停手、没有新回答、汇总更新失败，都就地停下并写明原因，不把上一轮
   *   的结论当成「补充后」的结论。
   */
  private async deepenResearch(
    pool: SubAgentPool,
    master: ResearchRunner,
    conversation: Conversation,
    question: string,
    outcome: ResearchOutcome,
    execution: ExecutionStageResult | null,
    sink: ResearchSink
  ): Promise<{ rounds: number; items: string[]; budget: number; summaryText: string | null }> {
    const trace = this.traceFor(conversation.conversationId);
    const budget = followUpBudget(normalizeExecutionConfig(conversation.executionConfig));
    const stop = { rounds: 0, items: [], budget, summaryText: null };
    // 没有执行阶段就没有【待补】：单通道回答没有主导人，这一轮到此为止。
    if (budget <= 0 || !execution || !execution.summaryText) return stop;
    if (sink.cancelled()) return stop;

    const asked = new Set<string>();
    const items: string[] = [];
    let rounds = 0;
    let current = execution.summaryText;
    const isPage = execution.lead.kind === 'web';

    for (let round = 1; round <= budget; round += 1) {
      const found = parseFollowUps(current);
      const decision = decideFollowUp({
        round,
        budget,
        items: found,
        asked,
        cancelled: sink.cancelled()
      });
      if (!decision.go) {
        trace?.note(`追加研究在这里停下：${decision.reason}。`);
        break;
      }

      const fresh = found.filter(item => !asked.has(followUpKey(item)));
      for (const item of fresh) asked.add(followUpKey(item));
      items.push(...fresh);

      // 发出去的是普通问题：没有角色行，没有协议标记。页面上看到的应该是
      // 用户自己会问的那种句子。
      const followQuestion = buildFollowUpQuestion(question, fresh, round);
      trace?.note(followUpNote(round, budget, fresh));
      this.setStatus(conversation, 'collecting');

      trace?.beginGroup('followup', followQuestion);
      const followStep = trace?.beginStep({
        stage: 'followup',
        group: 'followup',
        actorId: 'system',
        actorLabel: '追加研究',
        sourceType: 'system',
        reason: `第 ${round} 轮追加研究`,
        inputPreview: followQuestion,
        meta: { rounds: round }
      });
      let roundOutcome: ResearchOutcome;
      try {
        roundOutcome = await master.research(
          {
            question: followQuestion,
            followup: true,
            // 第一轮答过的通道，页面里正拿着这条会话；不重置才能接着上一轮说。
            continuing: new Set(outcome.answers.map(answer => answer.agentId))
          },
          sink
        );
        trace?.endStep(followStep, {
          status: roundOutcome.answers.length > 0 ? 'ok' : 'skipped',
          meta: { rounds: round }
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        trace?.endStep(followStep, {
          status: 'failed',
          error: { code: errorCodeOf(detail), detail }
        });
        this.addMessage(conversation, {
          role: 'system',
          text: `第 ${round} 轮追加研究没有拿到回答：${detail}。下面的结论仍然是上一轮的汇总。`
        });
        break;
      }
      if (sink.cancelled()) return { rounds, items, budget, summaryText: rounds > 0 ? current : null };
      if (roundOutcome.answers.length === 0) {
        this.addMessage(conversation, {
          role: 'system',
          text: `第 ${round} 轮追加研究没有通道回答，结论停在上一轮的汇总上。`
        });
        break;
      }

      // 合并进这一轮的答案集合：同一通道以最新回答为准，旧回答仍然留在消息里。
      for (const answer of roundOutcome.answers) {
        const index = outcome.answers.findIndex(item => item.agentId === answer.agentId);
        if (index >= 0) outcome.answers[index] = answer;
        else outcome.answers.push(answer);
      }
      // 失败行去重：一直掉登录的通道每一轮都会被记一次「本轮未参与提问」，
      // 真机上一句 DeepSeek 未登录在会话里出现了两次。同一句话只留一次。
      const knownFailure = new Set(outcome.failures);
      for (const failure of roundOutcome.failures) {
        if (knownFailure.has(failure)) continue;
        knownFailure.add(failure);
        outcome.failures.push(failure);
      }

      // 更新汇总：交给同一个主导人。标签沿用「观点A/B」，与第一轮一致。
      const tags = sourceTags(
        roundOutcome.answers.map(answer => ({ channelId: answer.agentId, label: answer.agentId, text: answer.text }))
      );
      const roundAnswers = roundOutcome.answers.map((answer, index) => ({
        channelId: answer.agentId,
        label: tags[index] ?? `观点${String(index + 1)}`,
        text: answer.text
      }));

      this.setStatus(conversation, 'synthesizing');
      trace?.beginGroup('lead', question);
      // 追加轮也只让这一位主导人进 leading，不能把第一轮其他人再标成汇总。
      sink.phase(execution.lead.agentId, 'leading', `第 ${round} 轮补充后更新汇总`);
      const updateStep = trace?.beginStep({
        stage: 'lead',
        group: 'lead',
        actorId: execution.lead.agentId,
        actorLabel: execution.lead.label,
        sourceType: this.traceSourceOf(execution.lead.agentId),
        reason: `第 ${round} 轮更新汇总`,
        meta: { rounds: round }
      });
      try {
        const followUpTask = {
          stage: 'challenge' as const,
          question: buildFollowUpSummaryQuestion({
            question,
            previousSummary: current,
            round,
            answers: roundAnswers,
            // 还有下一轮时继续要【待补】，最后一轮就不必再要了。
            followUp: round < budget
          }),
          timeoutMs: isPage ? 180_000 : LEAD_SUMMARY_TIMEOUT_MS,
          system: isPage
            ? undefined
            : [
                ...leadSummarySystem(undefined, round < budget),
                '这是追加研究之后的汇总更新：把新回答并进去，已经成立的部分不要重写；新回答推翻了什么，要明说。'
              ]
        };
        const answer = isPage
          ? await pool.ask(execution.lead.agentId, followUpTask)
          : await this.askStreaming(pool, execution.lead.agentId, followUpTask, conversation);
        const text = rewriteSourceRefs(answer.text.trim(), roundAnswers);
        trace?.endStep(updateStep, {
          status: text ? 'ok' : 'skipped',
          usage: answer.usage ?? null,
          ...(typeof answer.firstTokenAt === 'number' ? { firstTokenAt: answer.firstTokenAt } : {}),
          ...(text ? { outputPreview: text } : {}),
          meta: text ? { rounds: round, outputChars: text.length } : { code: 'empty-summary' }
        });
        if (text) {
          current = text;
          rounds += 1;
          sink.phase(execution.lead.agentId, 'answered', '汇总已更新');
        } else {
          sink.phase(execution.lead.agentId, 'answered', '汇总未写出内容');
          this.addMessage(conversation, {
            role: 'system',
            text: `${execution.lead.label} 这一轮没有给出更新后的汇总，结论停在上一版。`
          });
          break;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        trace?.endStep(updateStep, {
          status: 'failed',
          error: { code: errorCodeOf(detail), detail }
        });
        sink.phase(execution.lead.agentId, 'failed', detail);
        this.addMessage(conversation, {
          role: 'system',
          text: `${execution.lead.label} 没能更新汇总：${detail}。下面仍然是上一轮的结论。`
        });
        break;
      }
    }

    return { rounds, items, budget, summaryText: rounds > 0 ? current : null };
  }

  /**
   * 谁当主导人。
   *
   * - 手动指定且名额合法：就用它；
   * - 网页/本地/云端：取该类型第一个可用成员；
   * - 混合：交给本地模型按「问题 + 答案质量」挑（挑不出来按回答完整度兜底）。
   *
   * 该模式没有可用成员时如实退回网页回答者，并在系统消息里说明，不假装
   * 「本地主导」成功了。
   */
  private async resolveLead(
    config: ConversationExecutionConfig,
    question: string,
    answers: ReadonlyArray<{ channelId: string; label: string; text: string }>,
    executorIds: ReadonlySet<string>
  ): Promise<{
    agentId: string;
    label: string;
    kind: 'web' | 'local' | 'cloud';
    auto: boolean;
    reason: string | null;
  } | null> {
    const sourceOf = (id: string) => this.deps.agentSource?.(id);
    const ownership = ownershipOf(config, answers, executorIds, sourceOf);
    // 归属规则：只在这一类成员里挑。这一类没人就如实不做执行阶段，不再
    // 偷偷退回网页回答者冒充「本地主导」。
    const pool = debatersFor(ownership.mode, answers, executorIds, sourceOf);
    if (pool.length === 0) return null;

    const labelOf = (agentId: string) =>
      answers.find(answer => answer.channelId === agentId)?.label ?? agentId;
    const fixed = config.leadAgentId;
    let agentId = fixed && pool.includes(fixed) ? fixed : pool[0];
    let reason: string | null = ownership.reason;

    // 混合且最终采用网页方式：不调模型，用答案完整度挑一位网页主辩。
    if ((!fixed || !pool.includes(fixed)) && config.executionMode === 'hybrid' && ownership.mode === 'web') {
      const picked = heuristicPick(answers.map(answer => ({
        agentId: answer.channelId, label: answer.label, text: answer.text
      })));
      if (picked && pool.includes(picked.agentId)) {
        agentId = picked.agentId;
        reason = `${ownership.reason}；${picked.reason}`;
      }
    }

    return {
      agentId,
      label: labelOf(agentId),
      kind: ownership.mode,
      auto: config.executionMode === 'hybrid',
      reason
    };
  }

  private setStatus(conversation: Conversation, status: Conversation['status']): void {
    // 用户已经点了停止：此后到达的状态更新一律不写回去。
    // 原来是反过来的——cancel() 把状态改成已停止，可还在飞的那一轮随后又
    // 按自己的节奏写「收集中」，界面上就变成「点了停止，卡片又转起来」。
    if (this.cancelled.has(conversation.conversationId) && status !== 'cancelled') return;
    conversation.status = status;
    conversation.updatedAt = Date.now();
    this.save(conversation);
  }

  private save(conversation: Conversation): void {
    this.deps.store.upsertConversation(conversation);
    this.deps.emit({ type: 'conversation.updated', at: Date.now(), conversation });
  }

  /**
   * 有流式能力就用流式，没有就整段问。
   *
   * 增量按 50ms 合批再发：按 token 逐条 postMessage 会把 IPC 打成洪水，而界面
   * 需要的只是「看起来在动」。合批只影响显示，不影响最终消息与用量。
   */
  /**
   * 工程模式第一轮的流式：先按住工具请求。
   *
   * 模型可能只回一行 `{"tool":"fs.stat",…}`。在缓冲区出现第一个非 `{` 的字符
   * 之前，不发任何正文；一旦确认不是 JSON，再把攒下的整段一次放出去。这样既
   * 有流式，也不会让用户先看到一段 JSON 再看到回答。
   */
  private async askGuarded(
    pool: SubAgentPool,
    agentId: string,
    task: SubAgentTask,
    conversation: Conversation
  ): Promise<SubAgentAnswer> {
    if (!pool.askStream) return pool.ask(agentId, task);

    const conversationId = conversation.conversationId;
    let buffer = '';
    let released = false;
    const emit = (text: string, reasoning?: string) => {
      if (!text && !reasoning) return;
      this.deps.emit({
        type: 'answer.delta',
        at: Date.now(),
        conversationId,
        channelId: agentId,
        ...(text ? { text } : {}),
        ...(reasoning ? { reasoning } : {})
      });
    };

    try {
      const answer = await pool.askStream(agentId, task, chunk => {
        if (chunk.reasoning) emit('', chunk.reasoning);
        if (!chunk.text) return;
        if (released) {
          emit(chunk.text);
          return;
        }
        buffer += chunk.text;
        // 第一个非空字符不是 `{`，就可以确认这是正文，不是工具请求。
        if (notToolRequest(buffer)) {
          released = true;
          emit(buffer);
          buffer = '';
        }
      });
      if (!released && buffer && notToolRequest(buffer)) emit(buffer);
      this.deps.emit({ type: 'answer.delta', at: Date.now(), conversationId, channelId: agentId, done: true });
      return answer;
    } catch (error) {
      if (!released && buffer && notToolRequest(buffer)) emit(buffer);
      this.deps.emit({ type: 'answer.delta', at: Date.now(), conversationId, channelId: agentId, done: true });
      throw error;
    }
  }

  private async askStreaming(
    pool: SubAgentPool,
    agentId: string,
    task: SubAgentTask,
    conversation: Conversation
  ): Promise<SubAgentAnswer> {
    if (!pool.askStream) return pool.ask(agentId, task);

    const conversationId = conversation.conversationId;
    let pendingText = '';
    let pendingReasoning = '';
    let timer: NodeJS.Timeout | null = null;

    const flush = () => {
      if (!pendingText && !pendingReasoning) return;
      this.deps.emit({
        type: 'answer.delta',
        at: Date.now(),
        conversationId,
        channelId: agentId,
        ...(pendingText ? { text: pendingText } : {}),
        ...(pendingReasoning ? { reasoning: pendingReasoning } : {})
      });
      pendingText = '';
      pendingReasoning = '';
    };

    try {
      const answer = await pool.askStream(agentId, task, chunk => {
        if (chunk.reset) {
          flush();
          this.deps.emit({
            type: 'answer.delta',
            at: Date.now(),
            conversationId,
            channelId: agentId,
            text: chunk.text ?? '',
            reset: true
          });
          return;
        }
        pendingText += chunk.text ?? '';
        pendingReasoning += chunk.reasoning ?? '';
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, 50);
      });
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
      this.deps.emit({ type: 'answer.delta', at: Date.now(), conversationId, channelId: agentId, done: true });
      return answer;
    } catch (error) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
      this.deps.emit({ type: 'answer.delta', at: Date.now(), conversationId, channelId: agentId, done: true });
      throw error;
    }
  }

  private addMessage(
    conversation: Conversation,
    input: Pick<ConversationMessage, 'role' | 'text'> & Partial<Pick<ConversationMessage, 'channelId' | 'synthesis' | 'reasoning' | 'debate'>>
  ): ConversationMessage {
    const message: ConversationMessage = {
      messageId: randomUUID(),
      conversationId: conversation.conversationId,
      role: input.role,
      channelId: input.channelId,
      synthesis: input.synthesis,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      ...(input.debate ? { debate: input.debate } : {}),
      text: input.text,
      at: Date.now()
    };
    this.deps.store.appendMessage(message);
    this.deps.emit({ type: 'message.added', at: message.at, message });
    return message;
  }

  private fail(conversation: Conversation, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    conversation.status = 'failed';
    conversation.error = message;
    conversation.updatedAt = Date.now();
    this.save(conversation);
    this.traceFor(conversation.conversationId)?.endTurn({
      status: 'failed',
      reason: message,
      error: { code: errorCodeOf(message), detail: message }
    });
    this.deps.emit({ type: 'conversation.failed', at: Date.now(), conversationId: conversation.conversationId, error: message });
  }
}
