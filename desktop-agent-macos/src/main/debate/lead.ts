/**
 * 辩论的「谁主导」。
 *
 * 这里说的主导不是「哪个模型主持流程」——流程永远由 DebateOrchestrator
 * 这段代码驱动，不是一个模型在发号施令（项目书 8.1 / 架构第 130 行）。
 * 主导回答的是另一个问题：**这一场的基准观点由谁给，其他成员围绕谁展开**。
 *
 * 三种模式对应三种来源组合，也对应三种隐私边界：
 *
 * - local   基准观点与质疑都由本地/云端 API 给出，网页通道完全不参与。
 * - web     网页通道各自独立回答用户原话，它们的观点是基准；本地/云端
 *           成员读取全部观点做交叉质疑与修正。
 * - hybrid  网页与本地/云端都在第一轮独立发言，不设单一主辩，由能读
 *           上下文的成员做交锋。
 *
 * 网页成员只能在第一轮发言，不是偷懒：页面收到的永远是用户原话，它看不到
 * 别人的回答（context/system 都不会发到页面），让它每轮发言只会得到一遍又
 * 一遍对同一问题的独立回答，看着像辩论其实没有交锋。把这件事写在 plan 里，
 * 而不是藏在 orchestrator 的某个 if 中，界面才能照实显示。
 */
import type { DebateMessageKind, DebateRole, DebateStrategy } from './types';

export type DebateLeadMode = 'local' | 'web' | 'hybrid';

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

export interface LeadPlan {
  lead: DebateLead;
  /** 第一轮发言者，有序。 */
  openingSpeakers: string[];
  /** 后续轮次的发言者：能读 context/system 的本地/云端成员。 */
  debaters: string[];
  /** 全部参与成员，有序。 */
  participants: string[];
  /** 只在第一轮出现的网页成员。 */
  webOnly: string[];
  reason: string;
  /** 如实写出的限制，例如同一模型兼任多角色。 */
  warnings: string[];
  /** 被剔除的成员与原因（不可用不能悄悄丢掉）。 */
  excluded: Array<{ id: string; reason: string }>;
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
  hybrid: '混合'
};

export function normalizeLeadMode(value: unknown): DebateLeadMode {
  return value === 'local' || value === 'web' || value === 'hybrid' ? value : 'hybrid';
}

/**
 * 生成主导计划。纯函数：候选可用性由主进程用 health() 算好传进来，这里
 * 不做任何 I/O，也不猜模型在不在线。
 */
export function planLead(input: LeadInput): LeadPlan {
  const mode = normalizeLeadMode(input.mode);
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
  // 只有本地/云端能读 context 与 system 指令，交锋只能由它们完成。
  const api = [...local, ...cloud];
  const all = [...web, ...api];

  const warnings: string[] = [];
  if (excluded.length > 0) {
    warnings.push(`${excluded.length} 个成员当前不可用，已排除：${excluded.map(item => item.id).join('、')}`);
  }

  let lead: DebateLead;
  let openingSpeakers: string[];
  let debaters: string[];
  let participants: string[];
  let webOnly: string[];
  let reason: string;

  if (mode === 'local') {
    if (api.length === 0) {
      throw new Error('本地主导需要至少一个可用的本地或云端模型');
    }
    openingSpeakers = api.map(item => item.id);
    debaters = openingSpeakers;
    participants = [...openingSpeakers];
    webOnly = [];
    // 网页成员即便被勾选也不进这一场：本地主导的定义就是内容不往网页发。
    for (const item of web) excluded.push({ id: item.id, reason: '本地主导不向网页通道发送内容' });
    const pick = api.find(item => item.id === input.leadAgentId) ?? local[0] ?? api[0];
    lead = {
      mode,
      agentId: pick.id,
      label: pick.label,
      reason: input.leadAgentId === pick.id
        ? '由你指定为这一场的主辩'
        : `本地主导取第一个可用的${pick.type === 'local' ? '本地模型' : '云端模型'}（${pick.label}）作为主辩`,
      drivenBy: 'orchestrator'
    };
    if (api.length < 2) {
      warnings.push('只有一个可交锋的模型：后续轮次由同一模型分饰质疑与修正角色，不是两个独立模型的意见');
    }
    const hasLocal = local.length > 0;
    reason = `本地主导：${api.length} 个${hasLocal ? '本地/云端' : '云端'}模型给出基准观点并做交叉质疑${hasLocal ? '' : '（本地模型只做裁判，不参与辩论）'}，网页通道不参与，提问内容不发送到网页。`;
  } else if (mode === 'web') {
    if (web.length === 0) throw new Error('网页主导需要至少一个可用的网页通道');
    if (api.length === 0) throw new Error('网页主导还需要至少一个可用的本地或云端模型来做交叉质疑（网页通道看不到其他回答）');
    openingSpeakers = web.map(item => item.id);
    debaters = api.map(item => item.id);
    participants = [...openingSpeakers, ...debaters];
    webOnly = [...openingSpeakers];
    const pick = web.find(item => item.id === input.leadAgentId) ?? web[0];
    lead = {
      mode,
      agentId: pick.id,
      label: pick.label,
      reason: input.leadAgentId === pick.id
        ? '由你指定为这一场的主辩'
        : `网页主导取第一个可用的网页通道（${pick.label}）作为主辩`,
      drivenBy: 'orchestrator'
    };
    reason = `网页主导：${web.length} 个网页通道各自独立回答用户原话，它们构成基准观点；${api.length} 个本地/云端模型读取全部观点后交叉质疑与修正。网页成员只收到用户原话，不看别人的回答，也不接收任何指令。`;
    warnings.push('网页通道只在第一轮发言：页面收到的一直是用户原话，无法针对他人观点回应');
  } else {
    if (api.length === 0) throw new Error('混合模式需要至少一个可用的本地或云端模型来做交叉质疑');
    if (all.length < 2) throw new Error('混合模式至少需要两个可用成员');
    openingSpeakers = all.map(item => item.id);
    debaters = api.map(item => item.id);
    participants = [...openingSpeakers];
    webOnly = web.map(item => item.id);
    lead = {
      mode,
      agentId: null,
      label: '不设主辩',
      reason: '混合模式让所有成员在第一轮平等地独立发言，不把任何一方定为主辩',
      drivenBy: 'orchestrator'
    };
    reason = `混合：${all.length} 个成员（网页 ${web.length}、本地/云端 ${api.length}）都在第一轮独立给出观点，之后由能读上下文的 ${api.length} 个成员交叉质疑。没有单一主导方。`;
    warnings.push('网页通道只在第一轮发言：页面收到的一直是用户原话，无法针对他人观点回应');
  }

  return { lead, openingSpeakers, debaters, participants, webOnly, reason, warnings, excluded };
}

/** 第几轮谁发言。第一轮是基准观点，之后只有能交锋的成员。 */
export function speakersFor(plan: LeadPlan, roundIndex: number): string[] {
  return roundIndex === 0 ? plan.openingSpeakers : plan.debaters;
}

/** 这一轮的性质：第一轮建立观点，第二轮质疑，之后回应与修正。 */
export function kindFor(roundIndex: number): DebateMessageKind {
  return roundIndex === 0 ? 'position' : roundIndex === 1 ? 'question' : 'revision';
}

/**
 * 角色按「主辩是谁」决定，不再靠数组下标隐式指定。
 * 只有 adversarial 才给正反方；standard/deep 一律 peer，避免假装分了工。
 */
export function roleFor(
  plan: LeadPlan,
  agentId: string,
  roundIndex: number,
  strategy: DebateStrategy
): DebateRole {
  if (plan.lead.agentId === agentId) return 'proposer';
  if (strategy !== 'adversarial') return 'peer';
  const debaters = roundIndex === 0 ? plan.openingSpeakers : plan.debaters;
  const first = debaters[0];
  return agentId === first ? 'proposer' : 'critic';
}

export function leadModeLabel(mode: DebateLeadMode): string {
  return MODE_LABEL[mode];
}
