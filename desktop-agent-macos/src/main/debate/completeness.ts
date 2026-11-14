/**
 * 答案完整性复核与修订（P0-3/P0-4）。
 *
 * 两个角色分开：
 * - Completeness Reviewer：只看题目和候选答案，找遗漏的条件、边界、例外、
 *   失败模式和实施约束；它不拿 24 题标准答案，也不宣布“通过”。
 * - Reviser：只补复核员指出的缺口，保留原结论；修订后仍要重新走标准评分，
 *   不能自己宣布通过。
 *
 * 这里不调用 DebateOrchestrator，也不新建 Runtime；调用方负责给 ask。
 */
import { extractJsonBlocks } from '../../shared/protocol';
import type { SubAgentAnswer, SubAgentTask } from '../agents/types';

export type CompletenessDimension =
  | 'definition'
  | 'condition'
  | 'boundary'
  | 'exception'
  | 'failure_mode'
  | 'constraint';

export interface CompletenessMissing {
  dimension: CompletenessDimension;
  text: string;
  why: string;
}

export interface CompletenessReview {
  backend: 'model' | 'unavailable';
  hasGap: boolean;
  missing: CompletenessMissing[];
  reason: string;
  attempts: number;
  usage: SubAgentAnswer['usage'] | null;
  latencyMs: number | null;
  fallbackReason?: string;
}

export interface AnswerRevision {
  backend: 'model' | 'unavailable';
  revisedAnswer: string | null;
  addressed: string[];
  stillMissing: string[];
  attempts: number;
  usage: SubAgentAnswer['usage'] | null;
  latencyMs: number | null;
  fallbackReason?: string;
}

interface ReviewerInput {
  question: string;
  answer: string;
  ask: (agentId: string, task: SubAgentTask) => Promise<SubAgentAnswer>;
  agentId: string;
  maxAnswerChars?: number;
}

interface ReviserInput extends ReviewerInput {
  missing: CompletenessMissing[];
}

const DIMENSIONS: CompletenessDimension[] = [
  'definition',
  'condition',
  'boundary',
  'exception',
  'failure_mode',
  'constraint'
];

function isDimension(value: unknown): value is CompletenessDimension {
  return typeof value === 'string' && DIMENSIONS.includes(value as CompletenessDimension);
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function parseReview(text: string): { hasGap: boolean; missing: CompletenessMissing[]; reason: string } | null {
  for (const block of extractJsonBlocks(text).reverse()) {
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>;
      if (typeof parsed.hasGap !== 'boolean' || typeof parsed.reason !== 'string') continue;
      const missing = Array.isArray(parsed.missing)
        ? parsed.missing
          .map(item => {
            if (!item || typeof item !== 'object') return null;
            const row = item as Record<string, unknown>;
            if (!isDimension(row.dimension) || typeof row.text !== 'string' || typeof row.why !== 'string') return null;
            return { dimension: row.dimension, text: row.text, why: row.why };
          })
          .filter((item): item is CompletenessMissing => item !== null)
        : [];
      return { hasGap: parsed.hasGap, missing, reason: parsed.reason };
    } catch {
      // 换下一块。
    }
  }
  return null;
}

function parseRevision(text: string): { revisedAnswer: string; addressed: string[]; stillMissing: string[] } | null {
  for (const block of extractJsonBlocks(text).reverse()) {
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>;
      if (typeof parsed.revisedAnswer !== 'string' || parsed.revisedAnswer.trim().length === 0) continue;
      return {
        revisedAnswer: parsed.revisedAnswer,
        addressed: stringsOf(parsed.addressed),
        stillMissing: stringsOf(parsed.stillMissing)
      };
    } catch {
      // 换下一块。
    }
  }
  return null;
}

function reviewSystem(): string[] {
  return [
    '你是答案完整性复核员，不参与辩论裁判。',
    '只看题目和候选回答，检查是否遗漏：关键定义、成立条件、适用边界、例外情况、失败模式、实施约束。',
    '不要引用任何标准答案，不要假设存在唯一正确答案，也不要用“回答不错”代替具体缺口。',
    '如果没有明显缺口，hasGap 为 false，missing 为空数组。',
    '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释：',
    '{"hasGap":true,"missing":[{"dimension":"condition|boundary|exception|failure_mode|constraint|definition","text":"缺什么","why":"为什么重要"}],"reason":"总体说明"}'
  ];
}

function revisionSystem(missing: CompletenessMissing[]): string[] {
  return [
    '你是答案修订员。保留原答案中正确的结论和证据，只补充复核员指出的缺失内容。',
    '不要改变立场，不要编造证据；无法补充的内容写进 stillMissing。',
    '不要声称已经通过任何评分，也不要引用标准答案。',
    `需要补充的缺口：${missing.map(item => `[${item.dimension}] ${item.text}（${item.why}）`).join('；')}`,
    '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释：',
    '{"revisedAnswer":"完整修订后的答案","addressed":["已补充的缺口"],"stillMissing":["仍无法补充的内容"]}'
  ];
}

export async function reviewCompleteness(input: ReviewerInput): Promise<CompletenessReview> {
  const maxChars = input.maxAnswerChars ?? 12_000;
  const answer = input.answer.length > maxChars
    ? `${input.answer.slice(0, maxChars)}\n（候选回答已截断）`
    : input.answer;
  const task: SubAgentTask = {
    question: input.question,
    stage: 'initial',
    context: [answer],
    system: reviewSystem()
  };

  let attempts = 1;
  let answerResult: SubAgentAnswer;
  let parsed: ReturnType<typeof parseReview> = null;
  try {
    answerResult = await input.ask(input.agentId, task);
    parsed = parseReview(answerResult.text);
    if (!parsed) {
      attempts = 2;
      answerResult = await input.ask(input.agentId, {
        ...task,
        system: [...reviewSystem(), '上一次输出不是可解析的 JSON。只输出 JSON，不要解释。']
      });
      parsed = parseReview(answerResult.text);
    }
  } catch (error) {
    return {
      backend: 'unavailable',
      hasGap: false,
      missing: [],
      reason: '',
      attempts,
      usage: null,
      latencyMs: null,
      fallbackReason: error instanceof Error ? error.message : String(error)
    };
  }

  if (!parsed) {
    return {
      backend: 'unavailable',
      hasGap: false,
      missing: [],
      reason: '',
      attempts,
      usage: answerResult.usage ?? null,
      latencyMs: answerResult.latencyMs ?? null,
      fallbackReason: `完整性复核模型连续 ${String(attempts)} 次输出不是可解析的 JSON`
    };
  }
  return {
    backend: 'model',
    hasGap: parsed.hasGap,
    missing: parsed.missing,
    reason: parsed.reason,
    attempts,
    usage: answerResult.usage ?? null,
    latencyMs: answerResult.latencyMs ?? null
  };
}

export async function reviseAnswer(input: ReviserInput): Promise<AnswerRevision> {
  if (input.missing.length === 0) {
    return {
      backend: 'model',
      revisedAnswer: input.answer,
      addressed: [],
      stillMissing: [],
      attempts: 0,
      usage: null,
      latencyMs: null
    };
  }
  const maxChars = input.maxAnswerChars ?? 12_000;
  const answer = input.answer.length > maxChars
    ? `${input.answer.slice(0, maxChars)}\n（候选回答已截断）`
    : input.answer;
  const task: SubAgentTask = {
    question: input.question,
    stage: 'initial',
    context: [answer],
    system: revisionSystem(input.missing)
  };

  let attempts = 1;
  let answerResult: SubAgentAnswer;
  let parsed: ReturnType<typeof parseRevision> = null;
  try {
    answerResult = await input.ask(input.agentId, task);
    parsed = parseRevision(answerResult.text);
    if (!parsed) {
      attempts = 2;
      answerResult = await input.ask(input.agentId, {
        ...task,
        system: [...revisionSystem(input.missing), '上一次输出不是可解析的 JSON。只输出 JSON，不要解释。']
      });
      parsed = parseRevision(answerResult.text);
    }
  } catch (error) {
    return {
      backend: 'unavailable',
      revisedAnswer: null,
      addressed: [],
      stillMissing: input.missing.map(item => item.text),
      attempts,
      usage: null,
      latencyMs: null,
      fallbackReason: error instanceof Error ? error.message : String(error)
    };
  }

  if (!parsed) {
    return {
      backend: 'unavailable',
      revisedAnswer: null,
      addressed: [],
      stillMissing: input.missing.map(item => item.text),
      attempts,
      usage: answerResult.usage ?? null,
      latencyMs: answerResult.latencyMs ?? null,
      fallbackReason: `答案修订模型连续 ${String(attempts)} 次输出不是可解析的 JSON`
    };
  }
  return {
    backend: 'model',
    revisedAnswer: parsed.revisedAnswer,
    addressed: parsed.addressed,
    stillMissing: parsed.stillMissing,
    attempts,
    usage: answerResult.usage ?? null,
    latencyMs: answerResult.latencyMs ?? null
  };
}
