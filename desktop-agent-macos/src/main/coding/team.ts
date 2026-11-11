/**
 * 多 Agent 编码：并行出方案，互相审，不改真实工作区。
 *
 * 边界（照 V1.1）：
 * - 这不是第二套执行器：它只调模型拿方案，落盘仍走现有 fs.edit / fs.applyPatch；
 * - 多 Agent 不直接写工作区：Code 角色的产出是 unified diff 文本，谁改哪个文件
 *   在返回值里列清楚，冲突也列出来；要不要应用由主 Agent/人决定；
 * - 单 Agent 闭环没跑通之前不启用这条路（调用方决定何时用）。
 */

import type { SubAgentAnswer, SubAgentTask } from '../agents/types';

export type CodingRole = 'explore' | 'code' | 'verify' | 'review';

export interface CodingTeamInput {
  task: string;
  /** 只读上下文：相关文件列表（相对路径）。 */
  files?: string[];
  /** 指定成员 id；不给就由调用方按可用性挑。 */
  members?: string[];
  maxParallel?: number;
}

export interface CodingProposal {
  agentId: string;
  role: CodingRole;
  text: string;
  /** Code 角色解析出的补丁；其他角色为空。 */
  patches: Array<{ path: string; patch: string }>;
  durationMs: number;
  failure?: string;
}

export interface CodingTeamResult {
  task: string;
  proposals: CodingProposal[];
  /** 被两个以上方案改到的文件。 */
  conflicts: Array<{ path: string; agents: string[] }>;
  /** 提示：方案未经落盘验证，apply 后仍要走写后诊断与测试。 */
  note: string;
}

export interface CodingTeamDeps {
  ask(agentId: string, task: SubAgentTask): Promise<SubAgentAnswer>;
  now?: () => number;
  onProgress?: (info: { agentId: string; role: CodingRole; status: 'start' | 'done' | 'failed' }) => void;
}

const ROLE_ORDER: CodingRole[] = ['explore', 'code', 'verify', 'review'];

/** 每个角色的任务书；system 只给 API 成员，网页通道只收到 question 原话。 */
function roleInstruction(role: CodingRole, task: string, files: string[]): { question: string; system: string } {
  const context = files.length > 0 ? `\n只读这些文件（相对工作区）：\n- ${files.join('\n- ')}` : '';
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
        question: `工程任务：${task}${context}\n\n指出这类改动要跑哪些检查与测试、容易漏掉什么边界；如果你看到方案，逐条指出可能失败的地方。`,
        system: '你是验证 Agent：只根据代码与命令事实说话，列出要执行的命令与预期退出码。'
      };
    default:
      return {
        question: `工程任务：${task}${context}\n\n做一次独立审查：接口兼容、边界条件、测试缺口、可回退性。发现阻断问题就明说。`,
        system: '你是评审 Agent：至少指出一个具体输入下的错误行为，或明确「未发现阻断问题」。'
      };
  }
}

/** 从回答里的 ```diff/```patch 代码块抽补丁；一个块一个文件。 */
export function extractPatches(text: string): Array<{ path: string; patch: string }> {
  const out: Array<{ path: string; patch: string }> = [];
  const pattern = /```(?:diff|patch)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const patch = match[1].trim();
    const header = /^\+\+\+\s+(?:b\/)?([^\t\n]+)/m.exec(patch) ?? /^---\s+(?:a\/)?([^\t\n]+)/m.exec(patch);
    if (!patch || !header) continue;
    out.push({ path: header[1].trim(), patch });
  }
  return out;
}

export async function runCodingTeam(input: CodingTeamInput, deps: CodingTeamDeps): Promise<CodingTeamResult> {
  const now = deps.now ?? Date.now;
  const members = (input.members ?? []).slice(0, Math.min(Math.max(input.maxParallel ?? 3, 1), 4));
  if (members.length === 0) throw new Error('coding team 至少需要一个成员');
  const files = (input.files ?? []).slice(0, 20);

  const proposals = await Promise.all(
    members.map(async (agentId, index): Promise<CodingProposal> => {
      const role = ROLE_ORDER[index % ROLE_ORDER.length];
      const instruction = roleInstruction(role, input.task, files);
      deps.onProgress?.({ agentId, role, status: 'start' });
      const startedAt = now();
      try {
        const answer = await deps.ask(agentId, {
          question: instruction.question,
          stage: index === 0 ? 'initial' : 'followup',
          system: [instruction.system],
          timeoutMs: 150_000
        });
        const durationMs = now() - startedAt;
        deps.onProgress?.({ agentId, role, status: 'done' });
        return {
          agentId,
          role,
          text: answer.text.trim(),
          patches: role === 'code' ? extractPatches(answer.text) : [],
          durationMs
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
          failure: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );

  const byFile = new Map<string, string[]>();
  for (const proposal of proposals) {
    for (const patch of proposal.patches) {
      const agents = byFile.get(patch.path) ?? [];
      if (!agents.includes(proposal.agentId)) agents.push(proposal.agentId);
      byFile.set(patch.path, agents);
    }
  }
  const conflicts = [...byFile.entries()]
    .filter(([, agents]) => agents.length > 1)
    .map(([path, agents]) => ({ path, agents }));

  return {
    task: input.task,
    proposals,
    conflicts,
    note: '这些方案没有写进工作区：应用时仍要走 fs.applyPatch + expectedHash，并在写后跑诊断/测试。'
  };
}
