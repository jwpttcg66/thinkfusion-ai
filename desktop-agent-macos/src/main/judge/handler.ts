import type { SubAgentAnswer, SubAgentTask } from '../agents/types';
import type { DebateState } from '../debate/types';
import { adjudicateDebate } from './adjudicate';
import type { JudgeCandidateInfo } from './resolve';
import type { JudgeVerdict } from './types';

/**
 * `judge:adjudicate` 的实现体（Gate 0B）。
 *
 * 单独成函数、而不是继续内联在 `ipcMain.handle` 里，是为了能在 Node 里跑
 * 「IPC 层」的测试：入参仍按 IPC 的样子给（`unknown`），校验、选裁判、换人、
 * 裁决、落盘一条链都不跳过。`index.ts` 只留一句 handle 和一个可信发送方检查。
 *
 * 之前这段内联在 `index.ts`，24 题回归脚本自己又写了一版（还绕过了
 * `resolveJudge`），于是「回归全绿」证明不了产品路径是通的。
 */
export interface JudgeAdjudicateDeps {
  getDebate: (debateId: string) => DebateState | null | undefined;
  saveVerdict: (verdict: JudgeVerdict) => void;
  candidates: () => Promise<readonly JudgeCandidateInfo[]>;
  ask: (agentId: string, task: SubAgentTask) => Promise<SubAgentAnswer>;
  /** 让会话维度能立刻读到这份裁决（内存索引，不是第二份存盘）。 */
  onVerdict?: (conversationId: string, verdict: JudgeVerdict) => void;
  /** 模型裁判写回了 pack 证据关联；有就落盘，否则状态只留在内存。 */
  saveDebate?: (state: DebateState) => void;
  preferredJudgeId?: string;
  maxReselections?: number;
}

export async function handleJudgeAdjudicate(
  debateId: unknown,
  deps: JudgeAdjudicateDeps
): Promise<JudgeVerdict> {
  if (typeof debateId !== 'string' || debateId.trim().length === 0) throw new Error('无效输入');
  const state = deps.getDebate(debateId);
  if (!state) throw new Error('找不到这场辩论');

  const verdict = await adjudicateDebate(state, {
    candidates: deps.candidates,
    ask: deps.ask,
    ...(deps.preferredJudgeId ? { preferredJudgeId: deps.preferredJudgeId } : {}),
    ...(typeof deps.maxReselections === 'number' ? { maxReselections: deps.maxReselections } : {})
  });

  deps.saveVerdict(verdict);
  deps.saveDebate?.(state);
  if (state.conversationId) deps.onVerdict?.(state.conversationId, verdict);
  return verdict;
}
