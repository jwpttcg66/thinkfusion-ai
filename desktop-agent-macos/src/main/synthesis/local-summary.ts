import type { ModelProvider } from '../providers/types';

/**
 * 汇总阶段：把各来源的回答交给**本地模型**出一份结论。
 *
 * 为什么是本地模型：它在这一层不是「来源」，不参与被提问的名单。它读的是
 * 已经回来的回答文本，做的是归纳——和网页通道的职责完全不同。用本地模型
 * 还有一个实际理由：汇总要把几位候选的全文一起塞进去，走云端 API 会是
 * 这一轮里最贵的一次调用。
 *
 * 失败一律返回 null，由调用方保留规则版综合。理由是同一件事：宁可给一份
 * 按句子比出来的保守结论，也不要因为 7B 模型超时就让用户看不到任何综合。
 */

export interface SummaryAnswer {
  /** 来源 id，用来在提示词里标号；不参与排序。 */
  channelId: string;
  label: string;
  text: string;
}

export interface LocalSummary {
  text: string;
  modelId: string;
  latencyMs: number;
}

/**
 * 提示词只做结构约束，不替用户改写问题。
 *
 * 这里可以有 system 轮次，因为收件方是本地 API 而不是网页：网页通道会原样
 * 忽略 system，页面上永远只有用户原话。这条边界不能因为「汇总」而松动。
 */
export const SUMMARY_SYSTEM: string[] = [
  '你在做多模型回答的汇总。你读到的每一段回答都标了来源编号，它们彼此独立，可能互相矛盾。',
  '只依据这些回答做事，不要补充它们没说过的事实，也不要替它们编造依据。',
  '按下面四段输出，每段一句话到几句话，不要复述整篇回答：',
  '【结论】直接回答问题；如果回答之间没有形成可用的结论，就写「这轮没有形成结论」并说明卡在哪。',
  '【一致】各来源都说到的点；没有就写「没有」。',
  '【分歧】彼此矛盾的地方，写清各自立场，标注来源编号；没有就写「没有」。',
  '【存疑】证据薄弱、只有一处在说、答非所问的地方；某个来源的回答明显残缺（只有几个字、像是被截断），也要写在这里并指出是哪个来源。'
];

/** 汇总请求的默认超时。7B 读几千字再写四段，一分半够用；再久就是卡住了。 */
export const SUMMARY_TIMEOUT_MS = 90_000;

export function buildSummaryQuestion(question: string, answers: readonly SummaryAnswer[]): string {
  const body = answers
    .map((answer, index) => `【来源${index + 1}】${answer.label}\n${answer.text.trim()}`)
    .join('\n\n');
  return `【用户的问题】\n${question.trim()}\n\n【各来源的回答】\n${body}`;
}

/**
 * 用本地模型汇总。`provider` 为 null（Ollama 没装好/没启动）时直接放弃，
 * 不做任何重试——汇总失败不该让一轮问答变成失败。
 */
export async function summarizeLocally(
  provider: ModelProvider | null,
  question: string,
  answers: readonly SummaryAnswer[],
  options: { modelId?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<LocalSummary | null> {
  if (!provider || answers.length < 2) return null;
  const started = Date.now();
  try {
    const response = await provider.generate(
      {
        question: buildSummaryQuestion(question, answers),
        modelId: options.modelId,
        system: SUMMARY_SYSTEM,
        timeoutMs: options.timeoutMs ?? SUMMARY_TIMEOUT_MS
      },
      options.signal
    );
    const text = response.text.trim();
    if (!text) return null;
    return { text, modelId: response.modelId, latencyMs: Date.now() - started };
  } catch {
    // 超时、排队等不到、模型被卸载：都退回规则版，界面会标出用的是哪种。
    return null;
  }
}
