import type { ModelProvider } from '../providers/types';

/**
 * 主导的自动选择：混合模式（以及其它多来源模式）下，用户不手动指定主辩时，
 * 由系统按「问题 + 各来源的回答」挑一位来源来主导辩论与裁决。
 *
 * 谁来做这个选择？本地模型。它不承担「来源」职责——不参与被提问的名单，
 * 只在回答都回来之后，读一遍材料、挑出哪一份回答最值得主导。这正好落在它
 * 「汇总/评审」的那一类用途上，而不是去当被评的一方。
 *
 * 候选里永远不会出现本地模型自己：选人阶段已经把 Ollama 排除在来源之外，
 * 这里拿到的 candidates 只是实际回答了的网页/云端通道。
 */

export interface LeadCandidate {
  agentId: string;
  label: string;
  text: string;
}

export interface LeadSelection {
  agentId: string;
  label: string;
  reason: string;
}

/**
 * 给本地模型的选择指令。
 *
 * 本地模型能收 system 轮次，所以评判标准放 system，问题保持原样。要求它第一行
 * 就给结论（「选择：回答N」），方便后面解析——模型再啰嗦，只要开头那句在，
 * 我们就能取回编号；理由只用于展示，不影响选择。
 */
export const PICK_SYSTEM: string[] = [
  '你在帮一个多模型评审系统决定「由哪一份回答来主导后续的辩论与裁决」。',
  '你看不到模型名字，只能依据回答本身：哪一份最正确、推理最严密、证据最充分、最不容易误导人。',
  '只依据给出的回答和公认常识判断，不要编造外部资料，也不要因为某份更长就偏心。',
  '第一行只写「选择：回答N」（N 是编号）；其后再用一两句话说明为什么这份回答最适合主导——它比别的强在哪、别的有什么明显缺陷。'
];

export function buildPickPrompt(question: string, candidates: readonly LeadCandidate[]): string {
  const body = candidates
    .map((candidate, index) => `【回答${index + 1}】${candidate.label}\n${candidate.text.trim()}`)
    .join('\n\n');
  return [
    '【原问题】',
    question.trim(),
    '',
    '【几份不同模型对这个问题的回答】',
    body,
    '',
    '请从中选择一份作为主导：它要负责指出其它回答里的错误、比较优劣、并给出最终答案。',
    '第一行只写「选择：回答N」，下面再写理由。'
  ].join('\n');
}

/** 把本地模型的话解析回一个候选。解析不出编号时返回 null，交给调用方兜底。 */
function parsePick(text: string, candidates: readonly LeadCandidate[]): LeadSelection | null {
  const firstLine = text.split('\n', 1)[0].trim();
  const explicit = firstLine.match(/选择[:：]\s*回答\s*(\d+)/);
  let index = explicit ? Number(explicit[1]) - 1 : -1;
  if (index < 0 || index >= candidates.length) {
    // 模型没把结论放第一行：退一步，找正文里第一个「回答N」。
    const any = text.match(/回答\s*(\d+)/);
    if (any) {
      const i = Number(any[1]) - 1;
      if (i >= 0 && i < candidates.length) index = i;
    }
  }
  if (index < 0 || index >= candidates.length) return null;
  const chosen = candidates[index];
  const reason = text.replace(/选择[:：]\s*回答\s*\d+[。.\s]*/i, '').replace(/^回答\s*\d+\s*/i, '').trim();
  return { agentId: chosen.agentId, label: chosen.label, reason: reason || '由本地模型判定该回答最适合作主导' };
}

/**
 * 用本地模型挑主导。`provider` 为 null（Ollama 没装好/没启动）、候选不足两份、
 * 或模型超时/解析不出编号时一律返回 null——选择失败不应让整轮变成失败，
 * 调用方会退回确定性兜底。
 */
export async function pickLeadLocally(
  provider: ModelProvider | null,
  question: string,
  candidates: readonly LeadCandidate[],
  options: { modelId?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<LeadSelection | null> {
  if (!provider || candidates.length < 2) return null;
  try {
    const response = await provider.generate(
      {
        question: buildPickPrompt(question, candidates),
        modelId: options.modelId,
        system: PICK_SYSTEM,
        timeoutMs: options.timeoutMs ?? 60_000
      },
      options.signal
    );
    const text = response.text.trim();
    if (!text) return null;
    return parsePick(text, candidates);
  } catch {
    // 超时、排队等不到、模型被卸载：都退回兜底，界面会标出用的是哪种。
    return null;
  }
}

/**
 * 本地模型不可用时的确定性兜底：选回答正文最长（去掉空白）的那一份。
 *
 * 不是「最长即最好」，是「在没有智能选择可用时，给一个可复现、不随机的缺省」。
 * 真要不放心质量，应该去把 Ollama 跑起来，而不是指望这个启发式多聪明。
 */
export function heuristicPick(candidates: readonly LeadCandidate[]): LeadSelection | null {
  if (candidates.length < 2) return null;
  let best = candidates[0];
  let bestLen = best.text.replace(/\s+/g, '').length;
  for (const candidate of candidates.slice(1)) {
    const len = candidate.text.replace(/\s+/g, '').length;
    if (len > bestLen) {
      best = candidate;
      bestLen = len;
    }
  }
  return { agentId: best.agentId, label: best.label, reason: '本地模型不可用，按回答完整度挑选主导' };
}
