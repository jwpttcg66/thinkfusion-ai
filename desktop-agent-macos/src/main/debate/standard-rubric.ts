/**
 * V1 标准答案评分器。
 *
 * 它不是另一个“模型自评”：输入是人工复核过的标准答案（标准事实、必答主张、
 * 允许表达、错误主张），模型只负责把候选回答和这些条目对齐。评分规则由代码
 * 再收紧：缺 must 主张、出现 major 错误、CONTEXTUAL 没给边界，都会封顶。
 *
 * 所有结果都标 `backend: 'model'` 或 `'unavailable'`，不会把模型评分说成
 * 事实核验。
 */
import { extractJsonBlocks } from '../../shared/protocol';
import type { SubAgentAnswer, SubAgentTask } from '../agents/types';

export type StandardClassification = 'FACT' | 'CONTEXTUAL' | 'INSUFFICIENT';

export interface StandardClaim {
  id: string;
  text: string;
  severity: 'must' | 'should';
}

export interface StandardWrongClaim {
  text: string;
  reason: string;
  severity: 'major' | 'minor';
}

export interface StandardRubricItem {
  id: string;
  question: string;
  classification: StandardClassification;
  standardFacts: string[];
  requiredClaims: StandardClaim[];
  allowedExpressions: string[];
  wrongClaims: StandardWrongClaim[];
  judging: { mustPass: string[]; notes: string };
}

export interface StandardAssessment {
  backend: 'model' | 'unavailable';
  /** 代码按 missing/wrong/boundary/classification 算出的门槛分。 */
  score: number | null;
  /** 评分模型原始给分；只用于审计，不直接作为门槛分。 */
  modelScore: number | null;
  questionType: StandardClassification | null;
  classificationMatch: boolean;
  matchedClaims: string[];
  missingClaims: string[];
  wrongClaims: string[];
  boundaryCovered: boolean;
  passed: boolean;
  reason: string;
  fallbackReason?: string;
  usage: SubAgentAnswer['usage'] | null;
  latencyMs: number | null;
  /** 实际向评分模型问了几次；解析失败会重试一次。 */
  attempts: number;
}

export interface StandardRubricInput {
  item: StandardRubricItem;
  /** 候选回答：优先用裁判结论，没有再退回发言原文。 */
  answerText: string;
  ask: (agentId: string, task: SubAgentTask) => Promise<SubAgentAnswer>;
  agentId: string;
  /** 防止超长上下文；超出时截断并在提示词里说明。 */
  maxAnswerChars?: number;
}

interface ParsedAssessment {
  questionType: StandardClassification | null;
  matchedClaims: string[];
  missingClaims: string[];
  wrongClaims: string[];
  boundaryCovered: boolean;
  score: number;
  reason: string;
}

const CLASSIFICATIONS: StandardClassification[] = ['FACT', 'CONTEXTUAL', 'INSUFFICIENT'];

function isClassification(value: unknown): value is StandardClassification {
  return typeof value === 'string' && CLASSIFICATIONS.includes(value as StandardClassification);
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function parseAssessment(text: string): ParsedAssessment | null {
  for (const block of extractJsonBlocks(text).reverse()) {
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>;
      if (typeof parsed.score !== 'number' || !Number.isFinite(parsed.score)) continue;
      if (parsed.score < 0 || parsed.score > 100) continue;
      if (typeof parsed.boundaryCovered !== 'boolean') continue;
      if (typeof parsed.reason !== 'string') continue;
      return {
        questionType: isClassification(parsed.questionType) ? parsed.questionType : null,
        matchedClaims: stringsOf(parsed.matchedClaims),
        missingClaims: stringsOf(parsed.missingClaims),
        wrongClaims: stringsOf(parsed.wrongClaims),
        boundaryCovered: parsed.boundaryCovered,
        score: parsed.score,
        reason: parsed.reason
      };
    } catch {
      // 换下一块。
    }
  }
  return null;
}

function systemPrompt(item: StandardRubricItem): string[] {
  const must = item.requiredClaims.map(claim =>
    `- ${claim.id} [${claim.severity === 'must' ? '必须' : '建议'}] ${claim.text}`
  );
  const wrong = item.wrongClaims.map(claim =>
    `- [${claim.severity === 'major' ? '重大' : '轻微'}] ${claim.text}（${claim.reason}）`
  );
  return [
    '你是技术事实回归裁判。按给定标准评分，不要补充标准之外的事实。',
    `题目类型：${item.classification}`,
    '标准事实：',
    ...item.standardFacts.map(fact => `- ${fact}`),
    '必答主张：',
    ...must,
    `允许的不同表达：${item.allowedExpressions.join('、')}`,
    '错误主张：',
    ...wrong,
    '判断规则：FACT 必须给明确结论；CONTEXTUAL 必须给条件、边界和推荐方案；INSUFFICIENT 才表示缺少必要信息且没有成熟默认框架。',
    'CONTEXTUAL 不等于 INSUFFICIENT：没有普遍最优答案，不代表不能给条件性结论。',
    '候选回答会放在问题文本里；请评分候选回答，不要评分题目本身。',
    '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释：',
    '{"questionType":"FACT"|"CONTEXTUAL"|"INSUFFICIENT","matchedClaims":["c1"],"missingClaims":["c2"],"wrongClaims":["错误主张原文"],"boundaryCovered":true,"score":0,"reason":"为什么给这个分"}'
  ];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 把模型给出的 matched/missing 与标准里的 mustPass 对齐，并按固定规则封顶。
 * 模型说 matched 但标准必须项没出现，仍然算缺失；不能让模型一句话抹过去。
 */
export async function assessStandardAnswer(input: StandardRubricInput): Promise<StandardAssessment> {
  const maxChars = input.maxAnswerChars ?? 12_000;
  const answer = input.answerText.length > maxChars
    ? `${input.answerText.slice(0, maxChars)}\n（候选回答已截断）`
    : input.answerText;
  const baseTask: SubAgentTask = {
    // 候选回答必须和题目放在同一段任务文本里。只放 context 时，评分模型
    // 可能把 question 当成待评回答，直接给 0 分。
    question: `题目：${input.item.question}\n\n候选回答：\n${answer}`,
    stage: 'initial',
    system: systemPrompt(input.item)
  };

  let attempts = 1;
  let answerResult: SubAgentAnswer;
  let parsed: ParsedAssessment | null = null;
  try {
    answerResult = await input.ask(input.agentId, baseTask);
    parsed = parseAssessment(answerResult.text);
    if (!parsed) {
      // 评分模型偶尔先写分析、忘了 JSON。只对解析失败重试一次；
      // 仍然失败就标 unavailable，不伪造分数。
      attempts = 2;
      answerResult = await input.ask(input.agentId, {
        ...baseTask,
        system: [
          ...(baseTask.system ?? []),
          '上一次输出不是可解析的 JSON。不要写 Markdown 代码块，不要解释，只输出一个 JSON 对象。'
        ]
      });
      parsed = parseAssessment(answerResult.text);
    }
  } catch (error) {
    return {
      backend: 'unavailable',
      score: null,
      modelScore: null,
      questionType: null,
      classificationMatch: false,
      matchedClaims: [],
      missingClaims: [],
      wrongClaims: [],
      boundaryCovered: false,
      passed: false,
      reason: '',
      fallbackReason: error instanceof Error ? error.message : String(error),
      usage: null,
      latencyMs: null,
      attempts
    };
  }

  if (!parsed) {
    return {
      backend: 'unavailable',
      score: null,
      modelScore: null,
      questionType: null,
      classificationMatch: false,
      matchedClaims: [],
      missingClaims: [],
      wrongClaims: [],
      boundaryCovered: false,
      passed: false,
      reason: '',
      fallbackReason: `评分模型连续 ${String(attempts)} 次输出不是可解析的 JSON`,
      usage: answerResult.usage ?? null,
      latencyMs: answerResult.latencyMs ?? null,
      attempts
    };
  }

  const matched = new Set(parsed.matchedClaims.map(normalize));
  const explicitlyMissing = new Set(parsed.missingClaims.map(normalize));
  const mustIds = input.item.judging.mustPass.length > 0
    ? input.item.judging.mustPass
    : input.item.requiredClaims.filter(claim => claim.severity === 'must').map(claim => claim.id);
  const missing = mustIds.filter(id =>
    !matched.has(normalize(id)) || explicitlyMissing.has(normalize(id))
  );

  const wrong = parsed.wrongClaims.map(text => {
    const known = input.item.wrongClaims.find(item =>
      normalize(text).includes(normalize(item.text)) ||
      normalize(item.text).includes(normalize(text))
    );
    // 标准里没有列出的“错误”默认按 minor 处理：模型可能过度解读，
    // 不能让它用一个标准外句子把分数封顶到 39。标准内的 major 仍然生效。
    return { text, severity: known?.severity ?? 'minor' as const };
  });
  const majorWrong = wrong.filter(item => item.severity === 'major');
  const boundaryCovered = input.item.classification === 'CONTEXTUAL'
    ? parsed.boundaryCovered
    : true;
  const classificationMatch = parsed.questionType === input.item.classification;

  // 门槛分由代码算，不直接信模型给的数字：模型只负责把回答和标准条目对齐。
  // 这样不会出现“理由写得很好、却给了 1 分”的异常分数。
  const minorWrong = wrong.filter(item => item.severity === 'minor');
  let score = Math.max(0, 100 - missing.length * 20 - minorWrong.length * 5);
  if (missing.length > 0) score = Math.min(score, 69);
  if (majorWrong.length > 0) score = Math.min(score, 39);
  if (input.item.classification === 'CONTEXTUAL' && !boundaryCovered) score = Math.min(score, 65);
  if (!classificationMatch) score = Math.min(score, 60);
  const passed = missing.length === 0 &&
    majorWrong.length === 0 &&
    boundaryCovered &&
    classificationMatch &&
    score >= 70;

  return {
    backend: 'model',
    score,
    modelScore: parsed.score,
    questionType: parsed.questionType,
    classificationMatch,
    matchedClaims: parsed.matchedClaims,
    missingClaims: missing,
    wrongClaims: wrong.map(item => item.text),
    boundaryCovered,
    passed,
    reason: parsed.reason,
    usage: answerResult.usage ?? null,
    latencyMs: answerResult.latencyMs ?? null,
    attempts
  };
}
