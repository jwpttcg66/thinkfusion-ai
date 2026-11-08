/**
 * 工程空间的「多 agent 编排」计划（2026-11-08 用户裁决）。
 *
 * 原话：「工程默认改成多agent编排，优先本地和远程模型，除非采用混合模式，
 * 才可以进行网页编排。」
 *
 * 这条裁决覆盖了同一天更早的两条工程空间规则（只问一个模型的第一意见、
 * 网页只在决策类问题做并列的第二意见）。新的分工是：
 *
 * - **默认多 agent**：可用的本地模型 + 云端模型**全部**读同一份工程证据，
 *   本地优先、云端补充。local / web / cloud 三档在工程空间不再按归属挑人——
 *   它们原本描述的是「回答之后由谁汇总」，不该决定谁读得动本机文件。
 *   「全部」不等于「同时」：本地模型共用机器上的单名额推理闸门，调用方按名单
 *   逐个问，云端 / 网页则并发；否则第二个本地模型会在排队超时里被丢掉。
 * - **网页默认不进场**：网页通道读不到本机文件（真机 s20/s21），非混合档一个
 *   都不问，连原来那个「决策类问题的单独第二意见」也不再发。
 * - **只有混合模式才允许网页编排**：`executionMode === 'hybrid'` 时，网页通道
 *   作为**并列的编排成员**跟模型一起进场（不是事后追加的第二意见）。
 *   `webSecondOpinion` 设置保留，但只在混合档决定网页要不要加入：
 *   auto 用决策判定、always 每次都加、off 不加。
 *
 * 这个模块只出计划，不发问、不调模型。归属过滤（`planLead`）是知识空间会话内
 * 辩论的默认行为；工程编排要的是本地+云端+（混合档）网页同场，所以调用方拿着
 * `debaters` / `webOnly` 直接交给辩论编排器，不再走 `planLead` 那一层收敛。
 *
 * 知识空间不受这里任何一行影响。
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
  /** 主导人：本地优先、云端补充；用户点名且在名单里时用它。 */
  lead: OrchestrationMember | null;
  /**
   * 交锋与最终意见的成员 = 本地 + 云端模型，不按归属过滤。
   *
   * 网页成员不进这个名单：它们已经在第一轮贡献了并列意见，意见会作为
   * seed 交给模型读；再让每个页面各写三轮质疑，只是把等待翻三倍。
   * 这正是「优先本地和远程模型」的落点。
   */
  debaters: string[];
  /** 这一轮真的把网页编进来了。 */
  webIncluded: boolean;
  /** 为什么是这批人 / 为什么网页没进。写进系统消息，用户能核对。 */
  reason: string;
  /** 一个可用模型都没有：调用方如实退回网页链路。 */
  fallback: boolean;
}

type ExecutionMode = ConversationExecutionConfig['executionMode'];
type SecondOpinionMode = NonNullable<ConversationExecutionConfig['webSecondOpinion']>;

export function planEngineeringOrchestration(input: {
  mode: ExecutionMode;
  leadAgentId?: string;
  models: readonly ModelMemberView[];
  webChannels: readonly WebChannelView[];
  question: string;
  webSecondOpinion?: SecondOpinionMode;
  selectedWebChannels?: readonly string[];
}): EngineeringOrchestrationPlan {
  const available = input.models.filter(member => member.available);
  // 本地优先、云端补充。稳定排序：同类里保持注册顺序，不重排用户的模型列表。
  const models: OrchestrationMember[] = [
    ...available.filter(member => member.kind === 'local'),
    ...available.filter(member => member.kind === 'cloud')
  ].map(member => ({ agentId: member.agentId, label: member.label, kind: member.kind }));

  if (models.length === 0) {
    return {
      members: [],
      lead: null,
      debaters: [],
      webIncluded: false,
      reason: '本机没有可用的本地/云端模型（Ollama 未启动，或没有配 API Key）',
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
    // 复用决策判定口径（读数/查事实不加网页），但编排要的是「所有已开启且
    // 可用的网页通道」，不是旧的「只挑一个通道做第二意见」。
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
  // 点名的主导人只在模型里找：网页成员连本机文件都读不到，让它写汇总会把
  // 证据纪律交出去；而且执行阶段用 pool.ask 找模型，网页 id 在那里根本不存在。
  const pinned = input.leadAgentId
    ? models.find(member => member.agentId === input.leadAgentId)
    : undefined;
  const pinnedWeb =
    input.leadAgentId && !pinned && web.some(member => member.agentId === input.leadAgentId);
  // 主导人优先本地模型，其次云端；网页成员永不主导。
  const lead = pinned ?? models[0];

  const parts = [
    `工程空间多 agent 编排：${models.filter(item => item.kind === 'local').length} 位本地模型 + ${models.filter(item => item.kind === 'cloud').length} 位云端模型读工程证据`,
    webNote,
    ...(pinnedWeb ? ['你点名的网页通道不能主导工程汇总（读不到本机文件），仍由本地/云端模型主导'] : []),
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
