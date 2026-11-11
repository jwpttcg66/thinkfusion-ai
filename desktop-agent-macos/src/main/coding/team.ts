/**
 * 多 Agent 编码：两阶段真实交接，最后仍然只回方案、不改工作区。
 *
 * 旧实现把四个角色 `Promise.all` 一起发出去：每个人拿到的都是同一段任务
 * 描述，Verify / Review 根本没看到 Code 的补丁，所谓「交叉评审」只是四份
 * 互不相干的意见。V1.2 改成两阶段：
 *
 *   阶段一（并行）：Explore 只读探索  +  Code 出 unified diff
 *   阶段二（并行）：Verify 检查补丁  +  Review 独立审查补丁
 *
 * 阶段二的提示词里带着 Explore 的事实和 Code 的真实 diff；补丁在交出去
 * 之前先做路径 / 版本 / hunk dry-run，通过后把当前文件的 sha256 作为
 * expectedHash 一并返回。真正落盘仍走现有 fs.applyPatch + expectedHash。
 *
 * 这里没有第二套执行器，也不写工作区。
 */

import type { SubAgentAnswer, SubAgentTask } from '../agents/types';
import {
  detectPatchConflicts,
  extractPatchBlocks,
  validatePatches,
  type PatchRead,
  type ValidatedPatch
} from './patch';

export type CodingRole = 'explore' | 'code' | 'verify' | 'review';

export interface CodingTeamInput {
  task: string;
  /** 只读上下文：相关文件列表（相对路径）。 */
  files?: string[];
  /** 指定成员 id；不给就由调用方按可用性挑。 */
  members?: string[];
  maxParallel?: number;
  /** 工作区根目录；给了才会做路径与 expectedHash 校验。 */
  root?: string;
}

export interface CodingProposal {
  agentId: string;
  role: CodingRole;
  text: string;
  /** Code 角色解析并校验后的补丁；其他角色为空。 */
  patches: ValidatedPatch[];
  durationMs: number;
  failure?: string;
  /** 这次回答之前实际交给它的上游结果（角色:成员）。 */
  context: string[];
}

export interface CodingStage {
  name: string;
  roles: CodingRole[];
  agents: string[];
  status: 'completed' | 'partial';
}

export interface CodingTeamResult {
  task: string;
  proposals: CodingProposal[];
  /** 被两个以上方案改到的文件（当前只有一个 Code 角色，通常是空）。 */
  conflicts: Array<{ path: string; agents: string[] }>;
  /** Code 角色产出的全部补丁，含 valid / expectedHash。 */
  patches: ValidatedPatch[];
  /** 只有全部补丁都通过路径、版本与 dry-run 才为 true。 */
  applyable: boolean;
  stages: CodingStage[];
  /** 提示：方案未经落盘验证，apply 后仍要走写后诊断与测试。 */
  note: string;
}

export interface CodingTeamDeps {
  ask(agentId: string, task: SubAgentTask): Promise<SubAgentAnswer>;
  /** 读当前工作区文件；不给就只按补丁文本解析，不做路径/版本校验。 */
  readFile?: (absolutePath: string) => Promise<PatchRead | null>;
  now?: () => number;
  onProgress?: (info: { agentId: string; role: CodingRole; status: 'start' | 'done' | 'failed' }) => void;
}

/** 兼容旧调用方：从回答里抽补丁。 */
export const extractPatches = extractPatchBlocks;

function roleInstruction(
  role: CodingRole,
  task: string,
  files: string[],
  upstream: string[]
): { question: string; system: string } {
  const context = files.length > 0 ? `\n只读这些文件（相对工作区）：\n- ${files.join('\n- ')}` : '';
  const handoff = upstream.length > 0 ? `\n\n上游结果（由前一步真实产生，不是猜测）：\n${upstream.join('\n\n')}` : '';
  switch (role) {
    case 'explore':
      return {
        question: `工程任务：${task}${context}\n\n只做只读分析：相关文件、关键符号、调用关系、风险与不确定处。不要给补丁。`,
        system: '你是探索 Agent：只读、只给事实与位置（路径:行号），不要改任何文件。'
      };
    case 'code':
      return {
        question: `工程任务：${task}${context}\n\n给出可以直接应用的 unified diff（每个文件一个 diff 代码块，带 ---/+++ 与 @@ hunk）。只改必要的地方，不要重构无关代码。`,
        system: '你是编码 Agent：输出 unified diff；不确定的地方在 diff 外用一句话说明，不要臆造文件内容。'
      };
    case 'verify':
      return {
        question: `工程任务：${task}${context}${handoff}\n\n请只针对上面的补丁做验证：逐条指出 hunk 是否与当前代码一致、要跑哪些命令、预期退出码、容易漏掉的边界。不要重复探索，不要改文件。`,
        system: '你是验证 Agent：只根据代码与命令事实说话，列出要执行的命令与预期退出码。'
      };
    default:
      return {
        question: `工程任务：${task}${context}${handoff}\n\n请独立审查上面的补丁：接口兼容、边界条件、测试缺口、可回退性。发现阻断问题就明说，并指出具体文件与代码位置。`,
        system: '你是评审 Agent：至少指出一个具体输入下的错误行为，或明确「未发现阻断问题」。'
      };
  }
}

function patchHandoff(patches: readonly ValidatedPatch[]): string {
  if (patches.length === 0) return 'Code 没有产出可解析的 unified diff。';
  return patches
    .map((patch, index) => {
      const state = patch.valid
        ? `已通过路径/版本/dry-run，expectedHash=${patch.expectedHash ?? '未计算'}`
        : `未通过：${patch.reason ?? '原因未知'}`;
      return [
        `补丁 ${String(index + 1)}：${patch.path}（+${String(patch.additions)} / -${String(patch.deletions)}）`,
        state,
        '```diff',
        patch.patch.slice(0, 12_000),
        '```'
      ].join('\n');
    })
    .join('\n\n');
}

async function runRole(
  agentId: string,
  role: CodingRole,
  task: string,
  files: string[],
  upstream: string[],
  deps: CodingTeamDeps,
  now: () => number
): Promise<CodingProposal> {
  const instruction = roleInstruction(role, task, files, upstream);
  deps.onProgress?.({ agentId, role, status: 'start' });
  const startedAt = now();
  try {
    const answer = await deps.ask(agentId, {
      question: instruction.question,
      stage: role === 'explore' || role === 'code' ? 'initial' : 'followup',
      system: [instruction.system],
      timeoutMs: 150_000
    });
    const durationMs = now() - startedAt;
    deps.onProgress?.({ agentId, role, status: 'done' });
    return {
      agentId,
      role,
      text: answer.text.trim(),
      patches: role === 'code'
        ? extractPatchBlocks(answer.text).map(patch => ({
            ...patch,
            additions: 0,
            deletions: 0,
            valid: false,
            reason: '未做路径/版本校验'
          }))
        : [],
      durationMs,
      context: upstream.map(item => item.split('\n')[0])
    };
  } catch (error) {
    const durationMs = now() - startedAt;
    deps.onProgress?.({ agentId, role, status: 'failed' });
    return {
      agentId,
      role,
      text: '',
      patches: [],
      durationMs,
      failure: error instanceof Error ? error.message : String(error),
      context: upstream.map(item => item.split('\n')[0])
    };
  }
}

export async function runCodingTeam(input: CodingTeamInput, deps: CodingTeamDeps): Promise<CodingTeamResult> {
  const now = deps.now ?? Date.now;
  const members = (input.members ?? []).slice(0, Math.min(Math.max(input.maxParallel ?? 4, 1), 4));
  if (members.length === 0) throw new Error('coding team 至少需要一个成员');
  const files = (input.files ?? []).slice(0, 20);

  const exploreAgent = members[0];
  const codeAgent = members[1] ?? members[0];
  const verifyAgent = members[2] ?? members[0];
  const reviewAgent = members[3] ?? members[0];
  const sameAgentFirstStage = exploreAgent === codeAgent;
  const sameAgentSecondStage = verifyAgent === reviewAgent;

  // 阶段一：探索与编码并行。只有成员数不足、两个角色落到同一个人时才
  // 串行，避免同一个 Agent 会话被并发占用。
  let explore: CodingProposal;
  let code: CodingProposal;
  if (sameAgentFirstStage) {
    explore = await runRole(exploreAgent, 'explore', input.task, files, [], deps, now);
    code = await runRole(codeAgent, 'code', input.task, files, [], deps, now);
  } else {
    [explore, code] = await Promise.all([
      runRole(exploreAgent, 'explore', input.task, files, [], deps, now),
      runRole(codeAgent, 'code', input.task, files, [], deps, now)
    ]);
  }

  // 补丁先做安全校验；校验通过才有 expectedHash 交给后续落盘。
  let patches: ValidatedPatch[] = code.patches.map(patch => ({
    ...patch,
    additions: 0,
    deletions: 0,
    valid: false,
    reason: '未做路径/版本校验'
  }));
  if (input.root) {
    patches = await validatePatches(code.patches, { root: input.root, ...(deps.readFile ? { readFile: deps.readFile } : {}) });
  } else if (code.patches.length > 0) {
    patches = code.patches.map(patch => ({
      ...patch,
      additions: 0,
      deletions: 0,
      valid: false,
      reason: '调用方没有提供工作区根目录，无法做路径/版本校验'
    }));
  }
  code = { ...code, patches };

  const upstream = [
    `探索结果（${explore.agentId}）\n${explore.failure ? `失败：${explore.failure}` : explore.text || '没有内容'}`,
    `编码结果（${code.agentId}）\n${code.failure ? `失败：${code.failure}` : code.text || '没有内容'}`,
    `补丁校验\n${patchHandoff(patches)}`
  ];

  let verify: CodingProposal | null = null;
  let review: CodingProposal | null = null;
  if (!code.failure) {
    if (sameAgentSecondStage) {
      verify = await runRole(verifyAgent, 'verify', input.task, files, upstream, deps, now);
      review = await runRole(reviewAgent, 'review', input.task, files, upstream, deps, now);
    } else {
      [verify, review] = await Promise.all([
        runRole(verifyAgent, 'verify', input.task, files, upstream, deps, now),
        runRole(reviewAgent, 'review', input.task, files, upstream, deps, now)
      ]);
    }
  }

  const proposals = [explore, code, ...(verify ? [verify] : []), ...(review ? [review] : [])];
  const firstStageFailed = Boolean(explore.failure || code.failure);
  const secondStageFailed = Boolean(verify?.failure || review?.failure);
  const stages: CodingStage[] = [
    {
      name: '探索 + 编码',
      roles: ['explore', 'code'],
      agents: [exploreAgent, codeAgent],
      status: firstStageFailed ? 'partial' : 'completed'
    }
  ];
  if (verify && review) {
    stages.push({
      name: '验证 + 评审',
      roles: ['verify', 'review'],
      agents: [verifyAgent, reviewAgent],
      status: secondStageFailed ? 'partial' : 'completed'
    });
  }

  const conflicts = detectPatchConflicts([{ agentId: code.agentId, patches }]);
  const applyable = patches.length > 0 && patches.every(patch => patch.valid);

  return {
    task: input.task,
    proposals,
    conflicts,
    patches,
    applyable,
    stages,
    note: applyable
      ? '这些方案没有写进工作区：应用时仍要走 fs.applyPatch + 返回的 expectedHash，并在写后跑诊断/测试。'
      : '方案没有写进工作区，且至少一个补丁未通过路径/版本/dry-run；先修正补丁，再走 fs.applyPatch + expectedHash。'
  };
}
