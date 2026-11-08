import { randomUUID } from 'node:crypto';
import type { AgentTask } from '../shared/contracts';
import type { Conversation, ConversationDeleteOutcome, ConversationEvent, ConversationExecutionConfig, ConversationMessage, Synthesis } from '../shared/conversation';
import { normalizeExecutionConfig } from '../shared/conversation';
import { classifyIntent } from '../shared/intent';
import { toRouteTaskKind, type ModelRoute, type RouteTaskKind } from '../shared/model-route';
import {
  normalizeDebateMode,
  normalizeWorkspaceMode,
  routingLabel,
  routeTask,
  type EngineeringTaskKind,
  type TaskRouting,
  type WorkspaceMode
} from '../shared/workspace';
import { scanProject, engineeringMaterial } from './engineering/project';
import type { AgentStore } from './store';
import type { SubAgentRegistry } from './agents/registry';
import type { SubAgentAnswer, SubAgentPool } from './agents/types';
import { MasterAgent, type ResearchOutcome, type ResearchRequest, type ResearchSink } from './master-agent';
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
import type { JudgeVerdict } from './judge/types';

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
  }) => Promise<{
    debateId: string;
    rounds: Array<{
      index: number;
      messages: Array<{ author: string; kind: string; text: string }>;
      failures?: Array<{ agentId: string; detail: string }>;
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
   * 各通道此刻的健康状态。追问恢复刚把页面导航回原会话，就绪探测要几秒
   * 才能通过；提问名单是一次性筛的，不等就会静默少问几家。有了它 runner
   * 才能在筛名单前把刚恢复的通道等到可用。
   */
  channelStatuses?: () => Promise<Array<{ id: string; available: boolean; generating?: boolean; pageReady?: boolean }>>;
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
      messages: Array<{ author: string; kind: string; text: string }>;
      failures?: Array<{ agentId: string; detail: string }>;
    }>;
    status: string;
  } | null;
  verdictText: string | null;
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

  constructor(private readonly deps: ConversationDeps) {}

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
    const asked = conversation?.channels ?? [];
    const threads = conversation?.threads ?? {};
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
    taskKindOverride?: EngineeringTaskKind;
  }): Promise<Conversation> {
    const text = input.text.trim();
    if (!text) throw new Error('先写一句你想研究或完成的事情。');

    const intent = classifyIntent(text);
    const workspaceMode = normalizeWorkspaceMode(input.workspaceMode);
    const routing: TaskRouting | undefined =
      workspaceMode === 'engineering'
        ? routeTask({
            text,
            workspaceMode,
            override: input.taskKindOverride,
            hasProject: !!input.workspaceRoot
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
      executionConfig: normalizeExecutionConfig(input.executionConfig),
      // 用户点名的那个地址：追问时不会再给一遍，而「这条会话读的是哪一页」
      // 必须能回答，所以随会话存下来。
      ...(intent.kind === 'extract' && intent.url ? { extractUrl: intent.url } : {}),
      ...(workspaceMode === 'engineering'
        ? { workspaceMode, workspaceRoot: input.workspaceRoot, routing }
        : {})
    };

    // V2.1 Model Router：在提问之前就把「这一轮用哪些模型、为什么」定下来并
    // 写进会话。事后统计做不到这件事——事后只能说「问了谁」，说不出「本来
    // 打算问谁、为什么是他」。
    this.applyModelRoute(conversation, toRouteTaskKind(routing?.taskKind ?? intent.kind));

    this.save(conversation);
    this.deps.emit({ type: 'conversation.created', at: now, conversation });
    this.addMessage(conversation, { role: 'user', text });

    const handoff = async (label: string): Promise<Conversation> => {
      try {
        const task = await this.deps.submitWorkspace({
          prompt: text,
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
      } catch (error) {
        this.fail(conversation, error);
      }
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

      // 工程分析：先真实读工程，再走和知识空间**完全相同**的提问链路。
      // 用户原话仍原样发给所有已开启的网页通道；证据不进第一轮问题，
      // 只在执行阶段作为主导人的附加材料出现。
      try {
        const scan = await scanProject(input.workspaceRoot!, text);
        conversation.engineeringEvidence = scan.evidence;
        conversation.engineeringAnalysis = scan.analysis;
        conversation.updatedAt = Date.now();
        this.save(conversation);
        this.addMessage(conversation, {
          role: 'system',
          text: [
            `已读取工程目录，${routingLabel(routing)}依据来自真实文件：`,
            scan.summary,
            ...(scan.warnings.length > 0 ? [`注意：${scan.warnings.join('；')}`] : [])
          ].join('\n')
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return this.awaitUser(conversation, `没能读取工程目录（${detail}）。没有真实证据时不会让模型猜架构，请重新选择项目。`);
      }
    }

    // Returned immediately: a web answer can take a minute, and an IPC call
    // that blocks for a minute is indistinguishable from a hung app. Progress
    // arrives as events.
    void this.run(conversation, text, { followup: false }).catch(error =>
      this.fail(conversation, error)
    );
    return conversation;
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
    return conversation;
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
    taskKindOverride?: EngineeringTaskKind
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

    // V2.1：工程会话的追问沿用创建时的空间与项目，不允许临时换目录。
    // 「先分析再修改」的第二阶段靠这里：用户在输入框明确选「本次按实施」，
    // 才把这一句交去生成计划；没有明确指令绝不自动进入执行。
    if (conversation.workspaceMode === 'engineering') {
      const routing = routeTask({
        text: question,
        workspaceMode: 'engineering',
        override: taskKindOverride,
        hasProject: !!conversation.workspaceRoot
      });
      conversation.routing = routing;
      conversation.updatedAt = Date.now();
      this.save(conversation);
      if (taskKindOverride === 'execution' && conversation.workspaceRoot) {
        try {
          const task = await this.deps.submitWorkspace({
            prompt: question,
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
        } catch (error) {
          this.fail(conversation, error);
        }
        return this.deps.store.getConversation(conversationId)!;
      }
      if (routing.taskKind === 'clarify') {
        return this.awaitUser(conversation, `这次没有直接执行：${routing.reason}。可明确选「本次按分析」或「本次按实施」再发一次。`);
      }
      if (routing.taskKind === 'engineering_analysis' && conversation.workspaceRoot) {
        try {
          const scan = await scanProject(conversation.workspaceRoot, question);
          conversation.engineeringEvidence = scan.evidence;
          conversation.engineeringAnalysis = scan.analysis;
          this.save(conversation);
          this.addMessage(conversation, { role: 'system', text: `已重新读取工程目录：\n${scan.summary}` });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return this.awaitUser(conversation, `没能读取工程目录（${detail}），这一轮不凭猜测回答。`);
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

    void this.run(conversation, question, { followup: true }).catch(error =>
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
      changed += 1;
    }
    return changed;
  }

  private release(conversationId: string): void {
    const timer = this.running.get(conversationId);
    if (timer) clearTimeout(timer);
    this.running.delete(conversationId);
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
  private abandon(conversation: Conversation, budget = this.budgetMs): void {
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
    const spent = budget >= 60_000 ? `${String(Math.round(budget / 60_000))} 分钟` : `${String(Math.round(budget / 1000))} 秒`;
    this.fail(
      conversation,
      new Error(
        `等了 ${spent}还没有结果${waiting ? `（${waiting}）` : ''}。` +
          '页面可能卡住了：点「停止等待」后重新加载那一页再问。'
      )
    );
  }

  private async run(
    conversation: Conversation,
    question: string,
    options: { followup: boolean }
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
    const budget = this.budgetMs + followUpBudget(config) * FOLLOW_UP_ROUND_BUDGET_MS;

    this.running.set(
      conversationId,
      setTimeout(() => this.abandon(conversation, budget), budget)
    );
    try {
      await this.conduct(conversation, master, question, options, pool, executorIds);
    } finally {
      this.release(conversationId);
    }
  }

  private async conduct(
    conversation: Conversation,
    master: ResearchRunner,
    question: string,
    options: { followup: boolean },
    pool: SubAgentPool,
    executorIds: ReadonlySet<string>
  ): Promise<void> {
    const conversationId = conversation.conversationId;
    const config = normalizeExecutionConfig(conversation.executionConfig);

    const sink: ResearchSink = {
      join: (agentId: string) => {
        // Recorded before the ask, not after the answer: the strip above the
        // pane is how the user sees what is happening, and an agent being waited
        // on is the single most important thing to see. Recording it only on
        // success made a slow page look exactly like a hang.
        if (conversation.channels.includes(agentId)) return;
        conversation.channels.push(agentId);
        this.save(conversation);
      },
      record: (answer: SubAgentAnswer) => {
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
          text: answer.text
        });
        this.save(conversation);
        return message.messageId;
      },
      phase: (agentId, phase, detail) =>
        this.deps.emit({
          type: 'channel.phase',
          at: Date.now(),
          conversationId,
          channelId: agentId,
          phase,
          detail
        }),
      note: text => this.addMessage(conversation, { role: 'system', text }),
      status: status => this.setStatus(conversation, status),
      cancelled: () => this.cancelled.has(conversationId)
    };

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
      try {
        const page = await fetchPageText(conversation.extractUrl);
        conversation.pageEvidence = page;
        conversation.updatedAt = Date.now();
        this.save(conversation);
        this.addMessage(conversation, {
          role: 'system',
          text: [
            `已抓取网页正文：${page.title}（${page.chars} 字，HTTP ${page.status}，sha256 ${page.sha256.slice(0, 12)}）`,
            ...(page.notes.length > 0 ? [`说明：${page.notes.join('；')}`] : [])
          ].join('\n')
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.addMessage(conversation, {
          role: 'system',
          text: `没能抓取网页正文（${detail}）；这一轮只依据各网页回答整理，没有页面正文作为依据。`
        });
      }
    }

    const outcome = await master.research(
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
    );

    if (this.cancelled.has(conversationId)) return;

    // 执行阶段（回答之后）：执行模式 = 谁当主导人，不决定谁回答——
    // 第一手回答永远来自网页通道（上面那轮）。主导人做三件事：
    //   1. 汇总全部回答，写【结论/一致/分歧/存疑】；
    //   2. 从分歧里指定辩题（没有实质分歧就不辩）；
    //   3. 读辩论记录，给最终意见。
    const execution = await this.runExecutionStage(
      pool,
      conversation,
      question,
      outcome,
      sink,
      executorIds,
      this.engineeringMaterialFor(conversation),
      this.pageMaterialFor(conversation),
      followUpBudget(config) > 0
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
    let synthesis = outcome.synthesis;
    if (this.deps.fusionEnabled && outcome.answers.length >= 2) {
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

    // 主导人的产物盖过默认综合：结论、以及「哪些一致、哪里有分歧」这套结构，
    // 都由读过全部回答的主导人来说，规则版那套不再并列展示。
    if (execution && synthesis) {
      const { lead, summaryText, topics, debate, verdictText } = execution;
      const backend: NonNullable<Synthesis['fusion']>['backend'] =
        lead.kind === 'web' ? 'web' : lead.kind === 'local' ? 'local-model' : 'remote';
      const parts: string[] = [];
      parts.push(
        lead.auto
          ? `系统按「问题 + 答案质量」自动选 ${lead.label} 当主导人（${lead.reason ?? '本地模型判定'}）：它汇总了 ${outcome.answers.length} 份网页回答`
          : `由主导人 ${lead.label} 汇总了 ${outcome.answers.length} 份网页回答`
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

    if (synthesis) {
      const message = this.addMessage(conversation, {
        role: 'synthesis',
        synthesis,
        text: synthesis.recommendation
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
    followUp = false
  ): Promise<ExecutionStageResult | null> {
    const config = normalizeExecutionConfig(conversation.executionConfig);
    const labels = new Map(outcome.channels.map(item => [item.agentId, item.label] as const));
    const answers = outcome.answers.map(answer => ({
      channelId: answer.agentId,
      label: labels.get(answer.agentId) ?? answer.agentId,
      text: answer.text
    }));
    // 一份回答没有可汇总的分歧，也没有可辩的对象：执行阶段直接跳过，
    // 保留规则版综合。只有多个来源时才需要主导人。
    if (answers.length < 2) return null;

    const lead = await this.resolveLead(config, question, answers, executorIds);
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

    this.setStatus(conversation, 'synthesizing');
    sink.phase(
      lead.agentId,
      'asking',
      lead.auto ? `自动选 ${label} 当主导人：汇总各家回答并指定辩题` : `${label} 当主导人：汇总各家回答并指定辩题`
    );

    // —— 第一步：汇总 + 指定辩题 ————————————————————————————
    let summaryText: string | null = null;
    try {
      // 工程证据与网页正文都只在这里（执行阶段的汇总）追加，绝不进第一手
      // 网页问题。网页主导时同样拼进那一条用户消息，走既有的「把材料递进
      // 页面」机制，页面上第一段用户发言仍然只有原话。
      const material = [engineering, page].filter(Boolean).join('\n\n') || null;
      // 任务类型决定汇总写法：比较要有对比，提取只依据正文。
      const taskKind: LeadTaskKind | undefined =
        conversation.intent === 'workspace' ? undefined : (conversation.intent as LeadTaskKind);
      const baseQuestion = isPage
        ? inlineLeadInstructions(question, answers, { taskKind, material, followUp })
        : buildLeadSummaryQuestion(question, answers, { taskKind, material, followUp });
      const answer = await pool.ask(lead.agentId, {
        question: baseQuestion,
        stage: 'challenge',
        // 网页主导要把一整段重新键入并等它写完，和第一次回答一样慢，给足时间。
        timeoutMs: isPage ? 180_000 : LEAD_SUMMARY_TIMEOUT_MS,
        // 只有 API 主导用得上 system；网页通道会忽略它。
        system: isPage
          ? undefined
          : engineering
            ? [...leadSummarySystem(taskKind, followUp), '工程证据是本机真实读取到的文件片段，比网页回答里的推测更可靠；引用它时写明路径:行号。']
            : leadSummarySystem(taskKind, followUp)
      });
      const text = rewriteSourceRefs(answer.text.trim(), answers);
      summaryText = text || null;
      if (summaryText) sink.phase(lead.agentId, 'answered', '汇总完成');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      sink.phase(lead.agentId, 'failed', detail);
      this.addMessage(conversation, { role: 'system', text: `主导人 ${label} 没能完成汇总：${detail}` });
    }
    if (!summaryText) {
      return { lead, summaryText: null, topics: [], debate: null, verdictText: null };
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
    const ownership = ownershipOf(config, answers, executorIds, sourceOf);
    const debaters = debatersFor(ownership.mode, answers, executorIds, sourceOf);
    let debate: Awaited<ReturnType<NonNullable<typeof this.deps.runDebate>>> = null;
    if (debateMode === 'off') {
      this.addMessage(conversation, {
        role: 'system',
        text: '这一轮按设置关闭了辩论：只汇总，不交锋、不出最终意见。'
      });
    } else if (topics.length === 0) {
      this.addMessage(conversation, {
        role: 'system',
        text: `${label} 判断回答之间没有需要辩的实质分歧，这一轮只汇总、不发起辩论。`
      });
    } else if (debaters.length === 0) {
      this.addMessage(conversation, {
        role: 'system',
        text: `${label} 列出了 ${topics.length} 个辩题（${topics.join('；')}），但${ownership.mode}归属方式下没有可用成员，这一轮只汇总、不发起辩论。`
      });
    } else if (this.deps.runDebate) {
      this.addMessage(conversation, {
        role: 'system',
        text: `${label} 指定了 ${topics.length} 个辩题：${topics.join('；')}`
      });
      try {
        debate = await this.deps.runDebate({
          conversationId: conversation.conversationId,
          question,
          topics,
          seeds: answers.map(answer => ({ agentId: answer.channelId, label: answer.label, text: answer.text })),
          debaters,
          lead: { agentId: lead.agentId, label, kind: lead.kind },
          mode: config.executionMode,
          effectiveMode: ownership.mode,
          debateStrategy: config.debateStrategy
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.addMessage(conversation, { role: 'system', text: `辩论没能跑起来：${detail}` });
      }
    }

    // —— 第三步：获取辩论结果，给最终意见 ————————————————————
    let verdictText: string | null = null;
    if (debate && debate.rounds.length > 0) {
      const transcript = formatDebateTranscript(debate.rounds);
      sink.phase(lead.agentId, 'asking', '读辩论记录，给最终意见');
      try {
        const answer = await pool.ask(lead.agentId, {
          question: buildVerdictQuestion(question, summaryText, transcript),
          stage: 'challenge',
          timeoutMs: isPage ? 180_000 : LEAD_SUMMARY_TIMEOUT_MS,
          system: isPage ? undefined : LEAD_VERDICT_SYSTEM
        });
        const text = rewriteSourceRefs(answer.text.trim(), answers);
        verdictText = text || null;
        if (verdictText) sink.phase(lead.agentId, 'answered', '最终意见完成');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sink.phase(lead.agentId, 'failed', detail);
        this.addMessage(conversation, { role: 'system', text: `${label} 读辩论记录时没给出最终意见：${detail}` });
      }
    }

    return { lead, summaryText, topics, debate, verdictText };
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
        this.addMessage(conversation, { role: 'system', text: `追加研究在这里停下：${decision.reason}。` });
        break;
      }

      const fresh = found.filter(item => !asked.has(followUpKey(item)));
      for (const item of fresh) asked.add(followUpKey(item));
      items.push(...fresh);

      // 发出去的是普通问题：没有角色行，没有协议标记。页面上看到的应该是
      // 用户自己会问的那种句子。
      const followQuestion = buildFollowUpQuestion(question, fresh, round);
      this.addMessage(conversation, { role: 'system', text: followUpNote(round, budget, fresh) });
      this.setStatus(conversation, 'collecting');

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
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
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
      outcome.failures.push(...roundOutcome.failures);

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
      sink.phase(execution.lead.agentId, 'asking', `第 ${round} 轮补充后更新汇总`);
      try {
        const answer = await pool.ask(execution.lead.agentId, {
          question: buildFollowUpSummaryQuestion({
            question,
            previousSummary: current,
            round,
            answers: roundAnswers,
            // 还有下一轮时继续要【待补】，最后一轮就不必再要了。
            followUp: round < budget
          }),
          stage: 'challenge',
          timeoutMs: isPage ? 180_000 : LEAD_SUMMARY_TIMEOUT_MS,
          system: isPage
            ? undefined
            : [
                ...leadSummarySystem(undefined, round < budget),
                '这是追加研究之后的汇总更新：把新回答并进去，已经成立的部分不要重写；新回答推翻了什么，要明说。'
              ]
        });
        const text = rewriteSourceRefs(answer.text.trim(), roundAnswers);
        if (text) {
          current = text;
          rounds += 1;
          sink.phase(execution.lead.agentId, 'answered', '汇总已更新');
        } else {
          this.addMessage(conversation, {
            role: 'system',
            text: `${execution.lead.label} 这一轮没有给出更新后的汇总，结论停在上一版。`
          });
          break;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
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

  private addMessage(
    conversation: Conversation,
    input: Pick<ConversationMessage, 'role' | 'text'> & Partial<Pick<ConversationMessage, 'channelId' | 'synthesis'>>
  ): ConversationMessage {
    const message: ConversationMessage = {
      messageId: randomUUID(),
      conversationId: conversation.conversationId,
      role: input.role,
      channelId: input.channelId,
      synthesis: input.synthesis,
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
    this.deps.emit({ type: 'conversation.failed', at: Date.now(), conversationId: conversation.conversationId, error: message });
  }
}
