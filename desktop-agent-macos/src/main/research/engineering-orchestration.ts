/**
 * 工程空间的「多 agent 编排」计划（2026-11-09 更新）。
 *
 * 原话：「工程默认改成多agent编排，优先本地和远程模型，除非采用混合模式，
 * 才可以进行网页编排。」
 *
 * 2026-11-10 用户裁决：选了「云端主导」就不能再拉本地模型；「本地主导」同理
 * 不拉云端。归属规则在工程空间同样生效：
 *
 * - **local**：只用可用的本地模型。
 * - **cloud**：只用可用的云端模型。
 * - **web / hybrid**：本地 + 云端都可读本机文件（网页读不到）；网页只在
 *   `hybrid` 且 `webSecondOpinion` 允许时作为并列编排成员进场。
 * - 「全部」不等于「同时」：本地模型共用机器上的单名额推理闸门，调用方按名单
 *   逐个问，云端 / 网页则并发。
 *
 * 这个模块只出计划，不发问、不调模型。
 */
import {
  buildEngineeringAnswerQuestion,
  type ModelMemberView
} from './engineering-round';
import {
  classifyDecision,
  secondOpinionExcerpt,
  type WebChannelView
} from './second-opinion';
import type { ConversationExecutionConfig } from '../../shared/conversation';

export interface OrchestrationMember {
  agentId: string;
  label: string;
  kind: 'local' | 'cloud' | 'web';
}

export interface EngineeringOrchestrationPlan {
  /** 第一轮读证据、各给一份意见的全部成员（混合档含网页）。 */
  members: OrchestrationMember[];
  /** 主导人：归属内优先；用户点名且在名单里时用它。 */
  lead: OrchestrationMember | null;
  /**
   * 交锋与最终意见的成员 = 本轮进场的本地/云端模型（已按执行模式收敛）。
   *
   * 网页成员不进这个名单：它们已经在第一轮贡献了并列意见，意见会作为
   * seed 交给模型读；再让每个页面各写三轮质疑，只是把等待翻三倍。
   */
  debaters: string[];
  /** 这一轮真的把网页编进来了。 */
  webIncluded: boolean;
  /** 为什么是这批人 / 为什么网页没进。写进系统消息，用户能核对。 */
  reason: string;
  /** 一个可用模型都没有：调用方按模式决定是否退回网页。 */
  fallback: boolean;
}

type ExecutionMode = ConversationExecutionConfig['executionMode'];
type SecondOpinionMode = NonNullable<ConversationExecutionConfig['webSecondOpinion']>;

function ownedKinds(mode: ExecutionMode): ReadonlySet<'local' | 'cloud'> {
  if (mode === 'cloud') return new Set(['cloud']);
  if (mode === 'local') return new Set(['local']);
  // web / hybrid：网页读不到本机文件，仍由本地 + 云端读证据。
  return new Set(['local', 'cloud']);
}

export function planEngineeringOrchestration(input: {
  mode: ExecutionMode;
  leadAgentId?: string;
  models: readonly ModelMemberView[];
  webChannels: readonly WebChannelView[];
  question: string;
  webSecondOpinion?: SecondOpinionMode;
  selectedWebChannels?: readonly string[];
}): EngineeringOrchestrationPlan {
  const kinds = ownedKinds(input.mode);
  const available = input.models.filter(
    member => member.available && kinds.has(member.kind)
  );
  // 本地优先、云端补充（仅在模式允许两类同时进场时有意义）。
  const models: OrchestrationMember[] = [
    ...available.filter(member => member.kind === 'local'),
    ...available.filter(member => member.kind === 'cloud')
  ].map(member => ({ agentId: member.agentId, label: member.label, kind: member.kind }));

  if (models.length === 0) {
    const why =
      input.mode === 'cloud'
        ? '云端主导但没有可用的云端模型（没勾选，或没有配 API Key）'
        : input.mode === 'local'
          ? '本地主导但没有可用的本地模型（Ollama 未启动或未启用）'
          : '本机没有可用的本地/云端模型（Ollama 未启动，或没有配 API Key）';
    return {
      members: [],
      lead: null,
      debaters: [],
      webIncluded: false,
      reason: why,
      fallback: true
    };
  }

  const selected = input.selectedWebChannels?.length
    ? new Set(input.selectedWebChannels)
    : null;
  const permittedWeb = input.webChannels.filter(
    channel => channel.available && (selected === null || selected.has(channel.agentId))
  );

  let web: OrchestrationMember[] = [];
  let webNote: string;
  const webMode = input.webSecondOpinion ?? 'auto';
  if (input.mode !== 'hybrid') {
    webNote = '网页编排只在混合模式开放，这一轮不问网页';
  } else if (webMode === 'off') {
    webNote = '混合模式，但设置里关掉了网页编排';
  } else {
    const decision = classifyDecision(input.question);
    if (webMode === 'auto' && !decision.major) {
      webNote = `混合模式，但${decision.reason}，网页不加入编排`;
    } else if (permittedWeb.length === 0) {
      webNote = '混合模式，但没有可用的网页通道（未登录或页面未就绪），网页编排跳过';
    } else {
      web = permittedWeb.map(channel => ({
        agentId: channel.agentId,
        label: channel.label,
        kind: 'web' as const
      }));
      const why = webMode === 'always' ? '设置要求每个工程问题都编排网页' : decision.reason;
      webNote = `混合模式：${web.length} 个网页通道作为编排成员一起进场（${web.map(item => item.label).join('、')}）——${why}`;
    }
  }

  const members = [...models, ...web];
  const pinned = input.leadAgentId
    ? models.find(member => member.agentId === input.leadAgentId)
    : undefined;
  const pinnedWeb =
    input.leadAgentId && !pinned && web.some(member => member.agentId === input.leadAgentId);
  const pinnedWrongKind =
    input.leadAgentId &&
    !pinned &&
    !pinnedWeb &&
    input.models.some(member => member.agentId === input.leadAgentId);
  // 名单内：点名优先；否则本地优先、再云端。网页永不主导。
  const lead = pinned ?? models[0];

  const localCount = models.filter(item => item.kind === 'local').length;
  const cloudCount = models.filter(item => item.kind === 'cloud').length;
  const roster =
    input.mode === 'cloud'
      ? `云端主导：${cloudCount} 位云端模型读工程证据（不用本地）`
      : input.mode === 'local'
        ? `本地主导：${localCount} 位本地模型读工程证据（不用云端）`
        : `工程空间多 agent 编排：${localCount} 位本地模型 + ${cloudCount} 位云端模型读工程证据`;

  const parts = [
    roster,
    webNote,
    ...(pinnedWeb
      ? ['你点名的网页通道不能主导工程汇总（读不到本机文件），仍由本轮模型主导']
      : []),
    ...(pinnedWrongKind
      ? [`你点名的主导人不在本轮归属（${input.mode === 'cloud' ? '云端' : input.mode === 'local' ? '本地' : '可用模型'}）里，改由 ${lead.label} 主导`]
      : []),
    `由 ${lead.label} 汇总、指定辩题并给最终意见`
  ];
  return {
    members,
    lead,
    debaters: models.map(member => member.agentId),
    webIncluded: web.length > 0,
    reason: `${parts.join('；')}。`,
    fallback: false
  };
}

/**
 * 网页编排成员拿到的那条消息：用户原话在前 + 证据摘录在后。
 *
 * 故意和模型侧的 `buildEngineeringAnswerQuestion` 同一个形状：网页是**并列的
 * 编排成员**，不是事后复核的第二意见，所以不带「第一意见」也不写角色行、
 * 不写引导语。证据整段可能几万字，页面读完反而答得更散，按既有口径摘录。
 */
export function buildWebOrchestrationQuestion(question: string, material: string): string {
  return buildEngineeringAnswerQuestion(question, secondOpinionExcerpt(material));
}
