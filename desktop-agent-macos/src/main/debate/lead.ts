/**
 * 辩论的「谁主导」——2026-11-06 起按**归属规则**执行。
 *
 * 这里说的主导不是「哪个模型主持流程」——流程永远由 DebateOrchestrator
 * 这段代码驱动，不是一个模型在发号施令（项目书 8.1 / 架构第 130 行）。
 * 主导回答的是：**这一场由哪一类成员执行**，汇总、交锋、最终意见全归它：
 *
 * - local   只用本地模型（Ollama），不调云端、不用网页当辩手。
 * - web     只用网页通道，**不引入本地 / 云端模型**。
 * - cloud   只用远程 API 模型。
 * - hybrid  先综合决定采用上面哪一种方式，再严格只用那一类，不混用。
 *
 * 只有一个可用成员时也照常开，由它分饰质疑与修正（自辩），如实写进
 * warnings，不再拿「辩手不足两位」当理由跳过整场。
 *
 * 网页通道之间互相看不到，且提问链路硬规则不变（用户原话原样发页面、不套
 * 角色行与引导语）。所以 web 方式的交锋由 orchestrator 把材料**拼进一条用户
 * 消息**递进页面；`webOnly` 标记的是「材料只能走 question，不发 context /
 * system」，不再是「只在第一轮发言」。
 *
 * 详见 docs/implementation/DEBATE_LEAD_MODES.md 开头「归属规则」节。
 */
import type { DebateMessageKind, DebateRole, DebateStrategy } from './types';
import { strategyProfile } from './strategies';

export type DebateLeadMode = 'local' | 'web' | 'cloud' | 'hybrid';
/** 归属方式：真正决定「用哪一类成员」的那三种，hybrid 会先收敛到这里。 */
export type OwnershipMode = Exclude<DebateLeadMode, 'hybrid'>;

/** 一个可以参加辩论的成员，以及它此刻到底能不能用。 */
export interface DebateCandidate {
  id: string;
  label: string;
  type: 'web' | 'local' | 'cloud';
  available: boolean;
  detail?: string;
}

export interface DebateLead {
  mode: DebateLeadMode;
  /** hybrid 没有主辩，这里是 null——不是「没算出来」。 */
  agentId: string | null;
  label: string;
  reason: string;
  /** 流程由代码编排，不是模型主持。写出来，免得被读成「某模型在主持」。 */
  drivenBy: 'orchestrator';
}

export type CollaborationShape =
  | 'single_model'
  | 'pair_debate'
  | 'expert_panel'
  | 'multi_model_panel';

/**
 * 协作组织方式（P0-03）。它只描述「这一场怎么组织」，不改变编排器行为：
 * 轮内并发提问，轮间递进；两位以上才存在交叉质疑；裁判优先独立。
 * 老辩论文件没有这个字段，读回时按 undefined 处理。
 */
export interface DebateCollaborationPlan {
  shape: CollaborationShape;
  participantCount: number;
  withinRound: 'parallel';
  acrossRounds: 'progressive';
  crossReview: boolean;
  judge: { required: true; independentPreferred: true };
  summary: string;
}

export interface LeadPlan {
  lead: DebateLead;
  /** 第一轮发言者，有序。 */
  openingSpeakers: string[];
  /** 后续轮次的发言者：归属方式与 openingSpeakers 同源，不换人。 */
  debaters: string[];
  /** 全部参与成员，有序。 */
  participants: string[];
  /** 材料只能拼进 question 的网页成员：不发 context / system。 */
  webOnly: string[];
  reason: string;
  /** 如实写出的限制，例如同一模型兼任多角色。 */
  warnings: string[];
  /** 被剔除的成员与原因（不可用不能悄悄丢掉）。 */
  excluded: Array<{ id: string; reason: string }>;
  /** P0-03 协作组织方式；老记录没有。 */
  collaboration?: DebateCollaborationPlan;
}

export interface LeadInput {
  mode: DebateLeadMode;
  strategy: DebateStrategy;
  candidates: readonly DebateCandidate[];
  /** 用户勾选的成员；不传表示全部候选。 */
  selected?: readonly string[];
  /** 用户指定的主辩；不合法时按模式默认规则挑，并写明理由。 */
  leadAgentId?: string;
}

const MODE_LABEL: Record<DebateLeadMode, string> = {
  local: '本地主导',
  web: '网页主导',
  cloud: '云端主导',
  hybrid: '混合'
};

/** 归属方式对应的成员类别，报错与理由都用它，别再拼中文。 */
const OWNER_LABEL: Record<OwnershipMode, string> = {
  local: '本地模型',
  web: '网页通道',
  cloud: '远程 API 模型'
};

export function normalizeLeadMode(value: unknown): DebateLeadMode {
  return value === 'local' || value === 'web' || value === 'cloud' || value === 'hybrid'
    ? value
    : 'hybrid';
}

/**
 * 混合：综合决定采用哪一种归属方式。
 *
 * 纯函数，候选可用性由主进程 health() 算好。依据依次是：用户点名的主辩、
 * 可用的远程 API、可用的本地模型、最后才轮到网页。理由原样落进
 * `plan.reason` / `warnings`，界面能回答「为什么是这种方式」。
 */
export function decideHybridMode(
  candidates: readonly DebateCandidate[],
  leadAgentId?: string
): { mode: OwnershipMode; reason: string } {
  const named = leadAgentId ? candidates.find(item => item.id === leadAgentId) : undefined;
  if (named) {
    return { mode: named.type, reason: `你指定了 ${named.label}（${OWNER_LABEL[named.type]}）` };
  }
  const cloud = candidates.filter(item => item.type === 'cloud');
  const local = candidates.filter(item => item.type === 'local');
  const web = candidates.filter(item => item.type === 'web');
  if (cloud.length > 0) {
    return { mode: 'cloud', reason: `检测到 ${cloud.length} 个可用远程 API 成员，优先用云端，不占本机算力` };
  }
  if (local.length > 0) {
    return { mode: 'local', reason: `没有可用云端，但有 ${local.length} 个可用本地模型` };
  }
  return { mode: 'web', reason: `没有可用的本地/云端模型（网页 ${web.length} 个），由网页通道全程执行` };
}

/**
 * 生成主导计划。纯函数：候选可用性由主进程用 health() 算好传进来，这里
 * 不做任何 I/O，也不猜模型在不在线。
 *
 * 归属规则：一种方式只用一类成员；混合先择一；单成员照常开。
 */
export function planLead(input: LeadInput): LeadPlan {
  const requested = normalizeLeadMode(input.mode);
  const selected = input.selected ? new Set(input.selected) : null;
  const excluded: LeadPlan['excluded'] = [];
  const usable = input.candidates.filter(candidate => {
    if (selected && !selected.has(candidate.id)) return false;
    if (!candidate.available) {
      excluded.push({ id: candidate.id, reason: candidate.detail || '当前不可用' });
      return false;
    }
    return true;
  });

  const web = usable.filter(item => item.type === 'web');
  const local = usable.filter(item => item.type === 'local');
  const cloud = usable.filter(item => item.type === 'cloud');

  const warnings: string[] = [];
  if (excluded.length > 0) {
    warnings.push(`${excluded.length} 个成员当前不可用，已排除：${excluded.map(item => item.id).join('、')}`);
  }

  // 混合先综合决定采用哪一种方式，之后就当那种方式执行，不再混用成员。
  const decision = requested === 'hybrid' ? decideHybridMode(usable, input.leadAgentId) : null;
  const effective: OwnershipMode = decision?.mode ?? (requested === 'hybrid' ? 'web' : requested);
  const owned = effective === 'local' ? local : effective === 'cloud' ? cloud : web;
  const ownedIds = new Set(owned.map(item => item.id));

  // 不属于这一类的成员一律不进场，原因写清楚，不静默丢掉。
  for (const item of usable) {
    if (!ownedIds.has(item.id)) {
      excluded.push({ id: item.id, reason: `${MODE_LABEL[effective]}只使用${OWNER_LABEL[effective]}成员` });
    }
  }
  if (owned.length === 0) {
    throw new Error(`${MODE_LABEL[effective]}需要至少一个可用的${OWNER_LABEL[effective]}成员`);
  }

  const pick = owned.find(item => item.id === input.leadAgentId) ?? owned[0];
  const ids = owned.map(item => item.id);
  const lead: DebateLead = {
    mode: requested,
    agentId: pick.id,
    label: pick.label,
    reason: decision
      ? `混合先采用${MODE_LABEL[effective]}（${decision.reason}），由 ${pick.label} 主导`
      : input.leadAgentId === pick.id
        ? '由你指定为这一场的主辩'
        : `${MODE_LABEL[effective]}取第一个可用的${OWNER_LABEL[effective]}（${pick.label}）作为主辩`,
    drivenBy: 'orchestrator'
  };

  if (owned.length === 1) {
    warnings.push('只有一个可用成员：后续轮次由同一成员分饰质疑与修正角色，不是独立的多方意见');
  }
  if (effective === 'web') {
    warnings.push('网页通道只收到用户消息：交锋材料拼在消息里，不发送 system / context 指令');
  }
  if (decision) warnings.push(`混合综合决定：${decision.reason}`);

  const reason = decision
    ? `混合先综合决定采用${MODE_LABEL[effective]}（${decision.reason}），本场只用${OWNER_LABEL[effective]} ${ids.length} 位，不混用其他类型。`
    : `${MODE_LABEL[effective]}：本场只用${OWNER_LABEL[effective]} ${ids.length} 位，汇总、交锋与最终意见都由这一类完成。`;

  const shape: CollaborationShape =
    ids.length === 1 ? 'single_model'
      : input.strategy === 'expert' ? 'expert_panel'
        : ids.length === 2 ? 'pair_debate'
          : 'multi_model_panel';
  const shapeLabel: Record<CollaborationShape, string> = {
    single_model: '单模型自辩',
    pair_debate: '双模型交锋',
    expert_panel: '专家角色评审',
    multi_model_panel: '多模型协作'
  };
  const crossReview = ids.length >= 2;
  const collaboration: DebateCollaborationPlan = {
    shape,
    participantCount: ids.length,
    withinRound: 'parallel',
    acrossRounds: 'progressive',
    crossReview,
    judge: { required: true, independentPreferred: true },
    summary: [
      `${shapeLabel[shape]}：${String(ids.length)} 位参与`,
      '轮内并行、轮间递进',
      crossReview ? '允许交叉质疑' : '单模型分饰质疑与修正',
      '裁判优先独立'
    ].join('；')
  };

  return {
    lead,
    openingSpeakers: [...ids],
    debaters: [...ids],
    participants: [...ids],
    webOnly: effective === 'web' ? [...ids] : [],
    reason,
    warnings,
    excluded,
    collaboration
  };
}

/** 第几轮谁发言。归属方式与第一轮同源，后续不换人。 */
export function speakersFor(plan: LeadPlan, roundIndex: number): string[] {
  return roundIndex === 0 ? plan.openingSpeakers : plan.debaters;
}

/** 这一轮的性质：第一轮建立观点，第二轮质疑，之后回应与修正。 */
export function kindFor(roundIndex: number): DebateMessageKind {
  return roundIndex === 0 ? 'position' : roundIndex === 1 ? 'question' : 'revision';
}

/**
 * 角色由策略决定（见 `strategies.ts` 的 `roles`），不再靠数组下标隐式指定。
 *
 * 只有需要正反分工的策略（对抗、方案竞争）才在没有主辩时把第一位发言者
 * 记成主张方；其余策略一律按 profile 给，宁可不分工，也不假装分了工。
 */
export function roleFor(
  plan: LeadPlan,
  agentId: string,
  roundIndex: number,
  strategy: DebateStrategy
): DebateRole {
  const profile = strategyProfile(strategy);
  if (plan.lead.agentId === agentId) return profile.roles.lead;
  if (profile.roles.other === 'critic') {
    const speakers = roundIndex === 0 ? plan.openingSpeakers : plan.debaters;
    return agentId === speakers[0] ? profile.roles.lead : 'critic';
  }
  return profile.roles.other;
}

export function leadModeLabel(mode: DebateLeadMode): string {
  return MODE_LABEL[mode];
}
