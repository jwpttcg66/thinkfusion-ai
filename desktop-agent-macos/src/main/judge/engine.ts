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
  now?: () => number;
  similarThreshold?: number;
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
      return { ...base, backend: 'rules', judgeAgentId: null };
    }

    const system: string[] = [
      '你是独立裁判。先读完所有发言，再判断哪些主张有依据、哪些只是断言。',
      '不要把「多数模型都这么说」当成正确的理由，也不要为了达成一致删掉少数派。',
      '如果证据不足或分歧无法裁决，明确说无法确定，并说明为什么。',
      '只输出一个 JSON 对象：{"conclusion": string|null, "undetermined": boolean, "reason": string, "disagreement": string, "unresolved": string[]}'
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
          judgeAttempts: attempts,
          fallbackReason: `裁判模型连续 ${String(attempts)} 次输出不是可解析的 JSON，已退回规则版`
        };
      }
      return {
        ...base,
        backend: 'model',
        judgeAgentId: this.options.judgeAgentId,
        judgeAttempts: attempts,
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
        }
      };
    } catch (error) {
      return {
        ...base,
        backend: 'rules',
        judgeAgentId: null,
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
  conclusion: string | null;
  undetermined: boolean;
  reason: string;
  disagreement: string;
  unresolved: string[];
} | null {
  const blocks = extractJsonBlocks(text);
  for (const block of blocks.reverse()) {
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>;
      if (typeof parsed.reason !== 'string' || typeof parsed.undetermined !== 'boolean') continue;
      return {
        conclusion: typeof parsed.conclusion === 'string' ? parsed.conclusion : null,
        undetermined: parsed.undetermined,
        reason: parsed.reason,
        disagreement: typeof parsed.disagreement === 'string' ? parsed.disagreement : '',
        unresolved: Array.isArray(parsed.unresolved)
          ? parsed.unresolved.filter((item): item is string => typeof item === 'string')
          : []
      };
    } catch {
      // 换下一块。
    }
  }
  return null;
}

