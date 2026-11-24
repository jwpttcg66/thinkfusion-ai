import type { ContextHistoryItem, ContextManager, ContextOwner } from '../../shared/context';
import type { ChannelStatus } from '../../shared/conversation';
import type { AdapterAnswer, AskStage, DeleteThreadResult, NewSessionResult } from '../adapters/browser/types';
import type { ModelUsage } from '../providers/types';

/**
 * A participant in the research, as opposed to the thing that types into a page.
 *
 * Two kinds are planned. Only the first exists today:
 *
 * - `provider` — one AI site (DeepSeek, ChatGPT, …). It speaks for that model
 *   and nothing else. Implemented by `ProviderSubAgent`.
 * - `specialist` — a role rather than a source: researcher, critic, reviewer.
 *   Not implemented, and deliberately so: a specialist would have to run on some
 *   provider anyway, and "the same model with a different role prompt" is not a
 *   second opinion. Shipping the type before the honesty would invite exactly
 *   that mistake, so the field is here and the implementations are not.
 *
 * What an agent owns: identity, its page session, its health record, and the
 * job it was given. What it does *not* own: who else is in the round, whether
 * the round happens at all, or how many rounds there are — that is the Master
 * Agent's budget to spend, and a participant that could spawn participants
 * would spend it forever.
 */

export type SubAgentKind = 'provider' | 'specialist';

export interface SubAgentIdentity {
  /** Stable id, shared with the source store and the message records. */
  id: string;
  label: string;
  kind: SubAgentKind;
  /** One line: what this agent is for, shown when a round is explained. */
  role: string;
}

/**
 * 这一问属于哪次会话 / 哪个项目，供记忆子系统召回与记录。
 *
 * 刻意挂在 task 上而不是让 registry 去查会话：registry 只认识 agent，
 * 不认识会话存储；把它做成依赖会把选人逻辑和状态存储绑死。
 * 四个入口（Master / Collaboration / Engineering / Debate）各自知道自己
 * 在问谁、属于哪个会话，填上即可。
 */
export interface MemoryTaskScope {
  conversationId: string;
  workspaceId?: string;
  projectId?: string;
  /** 工程/辩论：追加"记忆不是证据"的覆盖句。 */
  overrideLine?: boolean;
  /** 已冻结的请求 id；不填由记忆子系统按 `req_<turn>_<agentId>_<seq>` 生成。 */
  requestId?: string;
  /** 会话里第几轮，用于 requestId。 */
  turn?: number;
  taskId?: string;
  /** 注入点名字，落库用：master-agent / collaboration / engineering / debate。 */
  injectionPoint?: string;
  /** 工程当前 HEAD；决策类记忆据此判 stale。 */
  headCommit?: string;
}

export interface SubAgentTask {
  /** The exact text this agent should be sent. Composed by the caller. */
  question: string;
  stage: AskStage;
  /**
   * 请求身份。与 `SubAgentAnswer.requestId`、`TraceEntry.callId`、
   * `MemoryUsageEvent.requestId` 同值（P1 冻结，P4 接线）。
   */
  requestId?: string;
  /** 记忆召回与注入的作用域；不填则这一问不参与记忆（老调用方零影响）。 */
  memory?: MemoryTaskScope;
  /**
   * Set only for a challenge: the disagreement being adjudicated and the side
   * this agent is being asked to defend or drop. Kept on the task rather than
   * baked into the prompt so a later round can explain itself without parsing
   * the text it sent.
   */
  dispute?: { topic: string; stance: string; counter: string };
  timeoutMs?: number;
  /** 取消流式请求；超时/删除任务时必须真正停掉 Provider 流。 */
  signal?: AbortSignal;
  /**
   * LT-P4：可选的上下文准备状态。没有它时完全走现有路径。
   * manager 只处理模型输入，不调度任务。
   */
  contextState?: {
    manager: ContextManager;
    owner: ContextOwner;
    runId: string;
    history?: ContextHistoryItem[];
    evidenceRefs?: string[];
  };
  /**
   * 前序成员的回答（Sequential 策略用）。这是**结构化的上下文**，不是包装
   * 话术：网页通道会原样忽略它，用户的问题一个字不变地发到页面；
   * 只有本地/云端 Provider 会把它放进 messages 的 assistant 轮次。
   */
  context?: string[];
  /**
   * 辩论/裁判等子系统的结构化指令，只给本地与云端 API 的 system 轮次用。
   * 网页通道忽略它：发到页面的仍然只有 `question` 原话。
   */
  system?: string[];
}

export interface SubAgentAnswer extends AdapterAnswer {
  stage: AskStage;
  /** 与 `SubAgentTask.requestId` 同值；网页通道也回填，便于按请求串轨迹。 */
  requestId?: string;
  /**
   * L3 送达指纹：Provider 从**自己拼好的 messages** 反抽 system 段算出的
   * sha256。只有本地/云端 Provider 有；网页/CLI 没有这个概念。
   */
  systemHash?: string;
  /** Provider 是否声明能从 assembled messages 反抽 system（判据输入）。 */
  supportsSystemHash?: boolean;
  /** 推理内容；只有明确返回过的 Provider 才有，网页通道没有。 */
  reasoning?: string;
  /**
   * 这次调用的 token 用量。网页通道拿不到，固定是 `{ inputTokens: null,
   * outputTokens: null }`；本地/云端由 Provider 回填。`null` 不是 0。
   */
  usage?: ModelUsage | null;
  /** Provider / 实际模型；网页通道不填。 */
  providerId?: string;
  modelId?: string;
  /** 从发问到收到完整回答；网页也能测。 */
  latencyMs?: number;
  /**
   * 第一次看到非空输出片段的时间。只有能观察流的通道才有；没有就不填，
   * 统计显示 `—`，不拿总耗时冒充 TTFT。
   */
  firstTokenAt?: number;
}

export interface SubAgent {
  readonly identity: SubAgentIdentity;
  readonly id: string;
  readonly label: string;
  /**
   * 这个成员是什么来源。网页通道不实现它（缺省即网页），
   * `ProviderBackedSubAgent` 返回 local / cloud，`CliAnswerAgent` 返回 cli。
   *
   * 选人策略本来就能自己判断，但「没有可用成员」这句报错也要用：对着云端
   * 模型说「去右侧页面登录」是纯误导，用户会去翻一个根本不存在的页面。
   */
  readonly sourceType?: 'web' | 'local' | 'cloud' | 'cli';
  /** Usable right now, from the adapter plus this agent's own failure record. */
  health(): Promise<ChannelStatus>;
  ask(task: SubAgentTask): Promise<SubAgentAnswer>;
  /**
   * 流式问一次。只有能观察输出的通道实现；网页通道没有流，不实现。
   * 返回值和 `ask` 一样，`text` 是完整回答，不是最后一块。
   */
  askStream?(
    task: SubAgentTask,
    onDelta: (chunk: { text?: string; reasoning?: string; reset?: boolean }) => void
  ): Promise<SubAgentAnswer>;
  /** Give this agent's page a fresh thread. Called once per conversation. */
  newConversation?(): Promise<NewSessionResult>;
  /**
   * Delete this agent's copy of a conversation on its own site.
   *
   * Optional: an agent whose page has no sidebar cannot do it, and that is a
   * fact to report rather than a reason to fail the local delete.
   */
  deleteConversation?(threadUrl: string): Promise<DeleteThreadResult>;
  cancel(requestId: string): void;
  /** Give up on whatever this agent is waiting for. See `BrowserAdapter.cancelAll`. */
  cancelAll?(): void;
}

/**
 * The narrow view the Master Agent needs.
 *
 * Declared here rather than importing the registry so the Master can be tested
 * against a hand-written object with four methods.
 */
export interface SubAgentPool {
  /** Configured and switched on, whether or not their page is usable right now. */
  all(): Promise<SubAgent[]>;
  available(): Promise<SubAgent[]>;
  ask(agentId: string, task: SubAgentTask): Promise<SubAgentAnswer>;
  /** 流式问；Pool 没实现就不调用（调用方退回 ask）。 */
  askStream?(
    agentId: string,
    task: SubAgentTask,
    onDelta: (chunk: { text?: string; reasoning?: string; reset?: boolean }) => void
  ): Promise<SubAgentAnswer>;
  newConversation(agentId: string): Promise<NewSessionResult>;
  /** Delete one agent's copy of a conversation. Resolves, never throws. */
  deleteConversation(agentId: string, threadUrl: string): Promise<DeleteThreadResult>;
  cancel(agentId: string, requestId: string): void;
}
