import { randomUUID } from 'node:crypto';
import { features, figuresIn, jaccard } from '../../shared/synthesizer';
import { extractJsonBlocks } from '../../shared/protocol';
import type { SubAgentAnswer, SubAgentTask } from '../agents/types';
import type { DebateMessage, DebateState } from '../debate/types';
import {
  messagesOfVerdict,
  type ArgumentQuality,
  type EvidenceAssessment,
  type JudgeVerdict,
  type MinorityView,
  type PackEvidenceAssessment,
  type UnresolvedQuestion
} from './types';

/**
 * 独立裁判（项目书 8.7 / Phase H）。
 *
 * 决策 5：优先用独立模型；资源不足时允许某个参辩模型兼任，但必须标记
 * `sharedWith`。没有可用裁判模型时用规则版，并明写 `backend: 'rules'`，
 * 不把本地规则说成「模型裁决」。
 *
 * 规则版只评估**文本里有没有可核查的线索**，不判世界真伪。它不会读
 * `supportCount` 来决定谁对：那个数字只是描述「多少人这么说」，写进结果
 * 是为了让人看见分歧的形状，不是当票数用。
 */

export interface JudgeEngineOptions {
  ask?: (agentId: string, task: SubAgentTask) => Promise<SubAgentAnswer>;
  judgeAgentId?: string;
  /** 兼任时填参与辩论的 agentId，会在结果里明确标出来。 */
  sharedWith?: string;
  /** 实际辩论参与者；用于派生 self/participant/independent。 */
  participants?: string[];
  /** 实际参与者的 modelId；用于判断模型身份是否独立。 */
  participantModelIds?: string[];
  judgeProviderId?: string;
  judgeModelId?: string;
  now?: () => number;
  similarThreshold?: number;
}

function judgeIndependence(options: JudgeEngineOptions, judgeAgentId: string): {
  judgeMode: 'self-review' | 'participant-review' | 'independent-judge';
  judgeIndependent: boolean;
  modelIndependence: boolean;
  reason: string;
} {
  const participants = options.participants ?? [];
  const participantModelIds = options.participantModelIds ?? participants;
  const judgeModelId = options.judgeModelId ?? judgeAgentId;
  const judgeIsParticipant = participants.includes(judgeAgentId);
  const modelIsParticipant = participantModelIds.includes(judgeModelId) || participants.includes(judgeModelId);
  if (judgeIsParticipant && participants.length <= 1) {
    return { judgeMode: 'self-review', judgeIndependent: false, modelIndependence: false, reason: 'Judge 与唯一参与者是同一个模型，属于自我评估' };
  }
  if (judgeIsParticipant || modelIsParticipant) {
    return { judgeMode: 'participant-review', judgeIndependent: false, modelIndependence: false, reason: 'Judge 参与了前序辩论，或与参辩模型身份相同，不是独立第三方' };
  }
  return { judgeMode: 'independent-judge', judgeIndependent: true, modelIndependence: true, reason: 'Judge 未参与前序辩论，且模型身份与参辩成员不同' };
}

interface PackContextItem {
  claimId: string;
  evidenceId: string;
  packId: string;
  commit: string;
  path: string;
  excerpt: string;
  /** Claim 创建方给出的层级；缺失时裁判不得自行推断。 */
  scope?: 'code' | 'runtime';
  /** Claim 级执行断言；普通命令退出码不算。 */
  executionStatus?: 'passed' | 'failed';
  /** 这条执行证据是否明确验证了当前 Claim。 */
  verifiesClaim: boolean;
  roundIndex?: number;
}

/** 从 packEvidenceLinks 收集可被裁判引用的证据；只接受显式 context 关联。 */
function packContextOf(state: DebateState): PackContextItem[] {
  const evidenceById = new Map((state.packEvidence ?? []).map(item => [item.evidenceId, item]));
  const claims = new Map(state.rounds.flatMap(round => round.claims ?? []).map(claim => [claim.claimId, claim]));
  const items: PackContextItem[] = [];
  const seen = new Set<string>();
  for (const link of state.packEvidenceLinks ?? []) {
    if (link.source !== 'pack' || link.relation !== 'context') continue;
    if (!claims.has(link.claimId)) continue;
    const evidence = evidenceById.get(link.evidenceId);
    if (!evidence) continue;
    const key = `${link.claimId}\0${link.evidenceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const claim = claims.get(link.claimId)!;
    const packId = link.evidenceId.split(':')[1] ?? '';
    const url = evidence.url ?? '';
    const match = /^repo:\/\/[^/]+\/(.+?)#L(\d+)-L(\d+)$/.exec(url);
    items.push({
      claimId: link.claimId,
      evidenceId: link.evidenceId,
      packId,
      commit: state.repository?.commit ?? '',
      path: match?.[1] ?? 'unknown',
      excerpt: evidence.excerpt.slice(0, 240),
      ...(claim.claimScope ? { scope: claim.claimScope } : {}),
      ...(evidence.execution?.assertion ? { executionStatus: evidence.execution.assertion } : {}),
      verifiesClaim: Boolean(evidence.execution?.verifiesClaimIds?.includes(link.claimId))
    });
  }
  return items;
}

function packPrompt(context: readonly PackContextItem[]): string[] {
  if (context.length === 0) return [];
  return [
    '本轮有冻结的工程证据。你只能引用下面列出的 claimId + evidenceId 组合，不得编造或改写 ID：',
    ...context.map(item => `- claim ${item.claimId} · scope=${item.scope ?? 'missing'} · execution=${item.executionStatus ?? 'none'} · verifiesClaim=${item.verifiesClaim ? 'yes' : 'no'} ← ${item.evidenceId} · ${item.path} · ${item.excerpt}`),
    'relation 是这段证据相对于原 Claim 的方向；如果证据表明 Claim 不成立，必须写 contradicts。不要因为「证据支持你认为 Claim 错了」就写 supports。',
    '源码片段只能证明代码存在/结构。涉及运行时行为（命中率、一定发生、实际调用、所有异常都被处理等）时，除非有成功执行结果，否则只能是 context。',
    'absence of evidence ≠ evidence of absence：片段没有展示某行为，不等于它证明该行为不存在；覆盖不足只能是 context。',
    '只有片段直接展示与 Claim 相反的代码路径/条件时，才用 contradicts；并在 reason 里说明反向证据与覆盖范围。',
    'TODO / FIXME / XXX 或纯注释表达的是设计意图或未完成状态，不能作为 supports/contradicts，只能是 context。',
    'scope 由 Claim 创建方提供，不是你要猜的：scope=code 可由完整方法/分支的代码结构支持或反驳；scope=runtime 只有静态片段时只能是 context，且执行证据必须明确 verifiesClaim=yes 并与方向一致（passed→supports，failed→contradicts）。普通命令 exitCode=0 不算。scope=missing 时只能给 context。',
    'evidenceId 必须逐字复制上面列出的完整字符串（包含 pack: 前缀）；不允许省略前缀或只写 item id。',
    '如果 Claim 只声称代码包含某结构/循环/分支（不声称运行时一定发生），直接结构匹配即可 supports，不需要失败条件或执行结果。',
    '对上面列出的每条证据都要给出一个判断；证据不足时用 context，不要省略。',
    '输出 JSON 增加 packEvidence 数组：{"claimId":string,"evidenceId":string,"relation":"supports"|"contradicts"|"context","reason":string,"confidence":"low"|"medium"|"high","limitations":string[]}'
  ];
}

function isCommentOnly(text: string): boolean {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every(line =>
    line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || line.startsWith('#')
  );
}

function validatePackAssessments(
  raw: unknown,
  context: readonly PackContextItem[],
  commit: string
): { accepted: PackEvidenceAssessment[]; rejected: string[] } {
  const accepted: PackEvidenceAssessment[] = [];
  const rejected: string[] = [];
  if (!Array.isArray(raw)) return { accepted, rejected };
  const allowed = new Map(context.map(item => [`${item.claimId}\0${item.evidenceId}`, item]));
  for (const value of raw) {
    if (!value || typeof value !== 'object') {
      rejected.push('packEvidence 项不是对象');
      continue;
    }
    const item = value as Record<string, unknown>;
    const claimId = typeof item.claimId === 'string' ? item.claimId : '';
    const rawEvidenceId = typeof item.evidenceId === 'string' ? item.evidenceId : '';
    let evidenceId = rawEvidenceId;
    let normalized = false;
    let normalizationRule: 'add-pack-prefix' | undefined;
    let key = `${claimId}\0${evidenceId}`;
    if (!allowed.has(key) && !rawEvidenceId.startsWith('pack:')) {
      const prefixed = `pack:${rawEvidenceId}`;
      const candidate = `${claimId}\0${prefixed}`;
      if (allowed.has(candidate)) {
        evidenceId = prefixed;
        key = candidate;
        normalized = true;
        normalizationRule = 'add-pack-prefix';
      }
    }
    if (!allowed.has(key)) {
      rejected.push(`未提供的 claim/evidence 组合：${claimId} / ${rawEvidenceId}`);
      continue;
    }
    const relation = item.relation;
    if (relation !== 'supports' && relation !== 'contradicts' && relation !== 'context') {
      rejected.push(`非法 relation：${String(relation)}`);
      continue;
    }
    const confidence = item.confidence;
    if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') {
      rejected.push(`非法 confidence：${String(confidence)}`);
      continue;
    }
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    if (!reason) {
      rejected.push(`缺少 reason：${claimId} / ${evidenceId}`);
      continue;
    }
    const limitations = Array.isArray(item.limitations)
      ? item.limitations.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const source = allowed.get(key)!;
    if (relation !== 'context' && !source.scope) {
      rejected.push(`Claim 缺少 claimScope，不能判 ${relation}：${claimId} / ${evidenceId}`);
      continue;
    }
    if (relation !== 'context' && source.scope === 'runtime') {
      if (!source.verifiesClaim || !source.executionStatus) {
        rejected.push(`runtime Claim 缺少 Claim 级执行断言，不能判 ${relation}：${claimId} / ${evidenceId}`);
        continue;
      }
      if (relation === 'supports' && source.executionStatus !== 'passed') {
        rejected.push(`runtime supports 需要 passed 断言：${claimId} / ${evidenceId}`);
        continue;
      }
      if (relation === 'contradicts' && source.executionStatus !== 'failed') {
        rejected.push(`runtime contradicts 需要 failed 断言：${claimId} / ${evidenceId}`);
        continue;
      }
    }
    const unfinished = /\b(?:TODO|FIXME|XXX)\b/i.test(source.excerpt) || isCommentOnly(source.excerpt);
    if (relation !== 'context' && unfinished) {
      rejected.push(`证据是 TODO/注释/设计意图，不能判 ${relation}：${claimId} / ${evidenceId}`);
      continue;
    }
    accepted.push({
      claimId,
      evidenceId,
      rawEvidenceId,
      canonicalEvidenceId: evidenceId,
      normalized,
      ...(normalizationRule ? { normalizationRule } : {}),
      relation,
      reason,
      confidence,
      limitations,
      sourceSnapshot: {
        packId: source.packId,
        commit: commit || source.commit,
        ...(source.roundIndex !== undefined ? { roundIndex: source.roundIndex } : {})
      }
    });
  }
  return { accepted, rejected };
}

const EVIDENCE_HINTS = /(根据|文档|来源|出处|链接|引用|实验|数据|报告|官方|测试|统计|版本)/;
const CONDITION_HINTS = /(如果|若|当|仅当|只有在|在.{0,8}条件下|前提是|假设)/;
const REASONING_HINTS = /(因为|所以|因此|由于|导致|说明|意味着|推导出|由此可见)/;
const ABSOLUTE_HINTS = /(一定|必然|绝对|肯定|毫无疑问|显然)/;

export class JudgeEngine {
  private readonly now: () => number;
  private readonly similarThreshold: number;

  constructor(private readonly options: JudgeEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.similarThreshold = options.similarThreshold ?? 0.34;
  }

  async judge(state: DebateState): Promise<JudgeVerdict> {
    const messages = messagesOfVerdict(state);
    const base = this.ruleVerdict(state, messages);

    if (!this.options.ask || !this.options.judgeAgentId) {
      return {
        ...base,
        backend: 'rules',
        judgeAgentId: null,
        judgeMode: 'rules-fallback',
        judgeIndependent: false,
        modelIndependence: false,
        independenceReason: '没有可用模型裁判，退回规则版；不是独立模型评估'
      };
    }

    const packContext = packContextOf(state);
    const system: string[] = [
      '你是独立裁判。先读完所有发言，再判断哪些主张有依据、哪些只是断言。',
      ...packPrompt(packContext),
      '不要把「多数模型都这么说」当成正确的理由，也不要为了达成一致删掉少数派。',
      '先判断题目类型：FACT 是可验证的客观事实，必须给明确结论；CONTEXTUAL 依赖场景，必须给条件、边界和推荐方案；INSUFFICIENT 才表示缺少必要信息且没有成熟默认框架。',
      'CONTEXTUAL 不等于 INSUFFICIENT：没有普遍最优答案，不代表不能给条件性结论。',
      '如果确实证据不足或分歧无法裁决，明确说无法确定，并说明为什么。',
      '只输出一个 JSON 对象：{"questionType":"FACT"|"CONTEXTUAL"|"INSUFFICIENT","conclusion": string|null, "undetermined": boolean, "reason": string, "disagreement": string, "unresolved": string[]}'
    ];
    const askOnce = async (extra: string[] = []): Promise<SubAgentAnswer> =>
      this.options.ask!(this.options.judgeAgentId!, {
        question: state.question,
        stage: 'initial',
        context: messages.map(message => message.text),
        system: [...system, ...extra]
      });

    try {
      let attempts = 1;
      let answer = await askOnce();
      let parsed = parseVerdictJson(answer.text);
      // 模型偶尔会先写分析、再忘了 JSON。给它一次「只输出 JSON」的机会，
      // 不是把 prose 当 JSON 硬解析；两次都失败才退回规则版。
      if (!parsed) {
        attempts += 1;
        answer = await askOnce([
          '上一次输出不是可解析的 JSON。不要写 Markdown 代码块，不要解释，只输出一个 JSON 对象。'
        ]);
        parsed = parseVerdictJson(answer.text);
      }
      if (!parsed) {
        return {
          ...base,
          backend: 'rules',
          judgeAgentId: null,
          judgeMode: 'rules-fallback',
          judgeIndependent: false,
          modelIndependence: false,
          independenceReason: '裁判模型连续输出不可解析，退回规则版',
          judgeAttempts: attempts,
          fallbackReason: `裁判模型连续 ${String(attempts)} 次输出不是可解析的 JSON，已退回规则版`
        };
      }
      const independence = judgeIndependence(this.options, this.options.judgeAgentId);
      const validated = validatePackAssessments(
        parsed.packEvidence,
        packContext,
        state.repository?.commit ?? ''
      );
      return {
        ...base,
        backend: 'model',
        judgeAgentId: this.options.judgeAgentId,
        judgeMode: independence.judgeMode,
        judgeIndependent: independence.judgeIndependent,
        modelIndependence: independence.modelIndependence,
        judgeProviderId: this.options.judgeProviderId,
        judgeModelId: this.options.judgeModelId ?? this.options.judgeAgentId,
        independenceReason: independence.reason,
        judgeAttempts: attempts,
        ...(parsed.questionType ? { questionType: parsed.questionType } : {}),
        sharedWith: this.options.sharedWith,
        conclusion: parsed.undetermined ? null : parsed.conclusion,
        undetermined: parsed.undetermined,
        reason: parsed.reason,
        disagreement: parsed.disagreement,
        unresolved: [
          ...base.unresolved,
          ...parsed.unresolved.map(question => ({
            question,
            why: '裁判认为这个问题仍然悬而未决',
            sourceMessageIds: []
          }))
        ],
        confidence: {
          level: parsed.undetermined ? 'low' : 'medium',
          why: '由独立裁判模型给出，但仍未经过外部事实验证；不等于世界真伪'
        },
        ...(validated.accepted.length > 0 ? { packEvidence: validated.accepted } : {}),
        ...(validated.rejected.length > 0 ? { packEvidenceRejected: validated.rejected } : {})
      };
    } catch (error) {
      return {
        ...base,
        backend: 'rules',
        judgeAgentId: null,
        judgeMode: 'rules-fallback',
        judgeIndependent: false,
        modelIndependence: false,
        independenceReason: '裁判模型调用失败，退回规则版',
        judgeAttempts: 1,
        fallbackReason: `裁判模型调用失败（${error instanceof Error ? error.message : String(error)}），已退回规则版`
      };
    }
  }

  // -------------------------------------------------------------------------

  private ruleVerdict(state: DebateState, messages: DebateMessage[]): JudgeVerdict {
    const positions = messages.filter(message => message.kind === 'position');
    const groups = this.group(positions);
    const supportCount: Record<string, number> = {};
    for (const group of groups) supportCount[group[0].messageId] = group.length;

    const evidence = positions.map(message => this.assessEvidence(message));
    const argumentQuality = this.assessArguments(messages);
    const minorities: MinorityView[] = state.minorities.map(message => ({
      messageId: message.messageId,
      agentId: message.agentId,
      text: message.text,
      why: '与其他成员的立场差异明显，且没有被后续轮次消解'
    }));
    const unresolved = collectUnresolved(messages);

    const disagreement = groups.length >= 2
      ? groups.map(group => `「${group[0].text.slice(0, 60)}」`).join(' / ')
      : '没有检测到明确对立的立场';

    // 只有一个立场、文本里有可核查线索、且没有悬而未决的问题，才给结论。
    // 注意这里读的是证据分和未解决问题，不是 supportCount。
    const bestGroup = groups[0] ?? [];
    const bestScores = evidence.filter(item => bestGroup.some(message => message.messageId === item.messageId));
    const meanEvidence = bestScores.length > 0
      ? bestScores.reduce((sum, item) => sum + item.score, 0) / bestScores.length
      : 0;
    const canConclude = groups.length === 1 && meanEvidence >= 0.5 && unresolved.length === 0 && bestGroup.length > 0;

    return {
      verdictId: randomUUID(),
      debateId: state.debateId,
      createdAt: this.now(),
      judgeAgentId: null,
      backend: 'rules',
      conclusion: canConclude ? bestGroup[0].text : null,
      undetermined: !canConclude,
      reason: canConclude
        ? '只有一个立场，且文本里带有可核查的线索、没有未解决的问题'
        : groups.length >= 2
          ? '存在多个未消解的立场，规则版不判定谁对谁错'
          : '证据线索不足或仍有未解决的问题，无法确定',
      disagreement,
      evidence,
      argumentQuality,
      minorities,
      unresolved,
      confidence: {
        level: 'low',
        why: '本地规则只评估文本线索，不验证外部事实；规则版一律不给高置信度'
      },
      sourceMessageIds: messages.map(message => message.messageId),
      supportCount
    };
  }

  /** 同一件事的说法聚成一组。同通道的重复发言不额外算一票。 */
  private group(positions: DebateMessage[]): DebateMessage[][] {
    const groups: DebateMessage[][] = [];
    const seenAgents = new Set<string>();
    for (const message of positions) {
      if (seenAgents.has(message.agentId)) continue;
      seenAgents.add(message.agentId);
      const target = groups.find(group =>
        jaccard(features(group[0].text), features(message.text)) >= this.similarThreshold
      );
      if (target) target.push(message);
      else groups.push([message]);
    }
    return groups;
  }

  private assessEvidence(message: DebateMessage): EvidenceAssessment {
    const signals: string[] = [];
    let score = 0;
    const text = message.text;
    if (figuresIn(text).length > 0) { score += 0.3; signals.push('带具体数字或单位'); }
    if (EVIDENCE_HINTS.test(text)) { score += 0.3; signals.push('提到了出处/数据/实验'); }
    if (CONDITION_HINTS.test(text)) { score += 0.2; signals.push('写明了成立条件'); }
    if (REASONING_HINTS.test(text)) { score += 0.2; signals.push('有推理连接词'); }
    if (ABSOLUTE_HINTS.test(text)) { score -= 0.1; signals.push('绝对化措辞（减分）'); }
    score = Math.max(0, Math.min(1, score));
    return {
      messageId: message.messageId,
      agentId: message.agentId,
      score,
      signals,
      why: signals.length > 0
        ? `文本线索：${signals.join('、')}`
        : '只有断言，没有可核查的线索'
    };
  }

  private assessArguments(messages: DebateMessage[]): ArgumentQuality[] {
    const byAgent = new Map<string, DebateMessage[]>();
    for (const message of messages) {
      const list = byAgent.get(message.agentId) ?? [];
      list.push(message);
      byAgent.set(message.agentId, list);
    }
    return [...byAgent].map(([agentId, list]) => {
      const position = list.find(message => message.kind === 'position');
      const responded = list.some(message => message.kind === 'revision' || message.kind === 'rebuttal');
      let score = 0;
      if (position && REASONING_HINTS.test(position.text)) score += 0.3;
      if (responded) score += 0.3;
      if (position && position.text.length >= 40) score += 0.2;
      if (position && CONDITION_HINTS.test(position.text)) score += 0.2;
      return {
        agentId,
        score: Math.min(1, score),
        responded,
        why: `${responded ? '回应过质疑' : '没有回应质疑'}；${position ? '观点 ' + position.text.length + ' 字' : '没有独立观点'}`
      };
    });
  }
}

function collectUnresolved(messages: DebateMessage[]): UnresolvedQuestion[] {
  const found: UnresolvedQuestion[] = [];
  for (const message of messages) {
    const sentences = message.text.split(/(?<=[。！？!?；;])|\n+/);
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed || !/[?？]/.test(trimmed)) continue;
      found.push({
        question: trimmed,
        why: '辩论发言里提出的问题，记录中没有看到明确回应',
        sourceMessageIds: [message.messageId]
      });
    }
  }
  // 同一个问题被反复问，只留一条，但把出处都带上。
  const merged = new Map<string, UnresolvedQuestion>();
  for (const item of found) {
    const existing = merged.get(item.question);
    if (existing) existing.sourceMessageIds.push(...item.sourceMessageIds);
    else merged.set(item.question, item);
  }
  return [...merged.values()];
}

function parseVerdictJson(text: string): {
  questionType?: 'FACT' | 'CONTEXTUAL' | 'INSUFFICIENT';
  conclusion: string | null;
  undetermined: boolean;
  reason: string;
  disagreement: string;
  unresolved: string[];
  packEvidence: unknown[];
} | null {
  const blocks = extractJsonBlocks(text);
  for (const block of blocks.reverse()) {
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>;
      if (typeof parsed.reason !== 'string' || typeof parsed.undetermined !== 'boolean') continue;
      const questionType = parsed.questionType === 'FACT' ||
        parsed.questionType === 'CONTEXTUAL' ||
        parsed.questionType === 'INSUFFICIENT'
        ? parsed.questionType
        : undefined;
      return {
        ...(questionType ? { questionType } : {}),
        conclusion: typeof parsed.conclusion === 'string' ? parsed.conclusion : null,
        undetermined: parsed.undetermined,
        reason: parsed.reason,
        disagreement: typeof parsed.disagreement === 'string' ? parsed.disagreement : '',
        unresolved: Array.isArray(parsed.unresolved)
          ? parsed.unresolved.filter((item): item is string => typeof item === 'string')
          : [],
        packEvidence: Array.isArray(parsed.packEvidence) ? parsed.packEvidence : []
      };
    } catch {
      // 换下一块。
    }
  }
  return null;
}

