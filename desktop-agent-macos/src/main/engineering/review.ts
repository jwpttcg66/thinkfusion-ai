/**
 * V2.1 Phase F：执行之后的独立 Review。
 *
 * 「独立」指的是不复用做规划的那个网页通道：规划者自己评自己的计划，
 * 只会把刚才的推理再复述一遍。没有可用模型时退回规则版，并如实标
 * `backend: 'rules'`，不把规则说成模型裁决（沿用 JudgeEngine 的口径）。
 *
 * 规则版只检查**能从报告里读到的事实**：有没有失败步骤、测试退出码、
 * 写操作有没有跟着一次真实测试。它不判断代码好不好——那需要模型。
 *
 * 修复不在这里自动执行：Review 只产出「问题 + 是否需要修复」。下一步
 * 要么由用户确认后重新生成计划，要么明确结束，权限始终在用户手里。
 */

import type { AgentPlan, ExecutionReport } from '../../shared/contracts';
import type { EvidenceRef } from '../../shared/engineering-evidence';

type CommandRef = Extract<EvidenceRef, { kind: 'command' }>;

export interface ReviewVerdict {
  reviewer: string;
  backend: 'model' | 'rules';
  verdict: string;
  issues: string[];
  needsFix: boolean;
  at: number;
}

export interface ReviewOptions {
  /** 独立评审模型的调用口；不给就用规则版。 */
  ask?: (material: string) => Promise<string>;
  reviewer?: string;
  now?: () => number;
  timeoutMs?: number;
}

/** 只从执行报告里抽事实，不评价代码质量。 */
export function ruleReview(report: ExecutionReport, plan: AgentPlan): { issues: string[]; summary: string } {
  const issues: string[] = [];
  const failed = report.results.filter(item => item.status === 'failed');
  for (const step of failed) {
    issues.push(`${step.tool} 执行失败：${step.error ?? '未知原因'}`);
  }
  const tests = report.results.filter(item => item.tool === 'test.run');
  const writes = plan.steps.filter(step => step.tool === 'fs.writeFile');
  if (writes.length > 0 && tests.length === 0) {
    issues.push('这轮改了文件，但计划里没有 test.run：没有真实执行结果可以证明改动没破坏构建');
  }
  for (const test of tests) {
    const run = test.result as { exitCode?: number | null; command?: string; timedOut?: boolean } | undefined;
    if (run && (run.exitCode === null || run.exitCode !== 0 || run.timedOut)) {
      issues.push(`测试没有通过：${run.command ?? 'test.run'} 退出码 ${String(run.exitCode)}${run.timedOut ? '（超时）' : ''}`);
    }
  }
  // 证据账本：退出码为 null 且不是后台作业，说明命令还没结果就被当成完成了。
  // 这一条只能从账本读，光看 results 分不出来「后台启动」和「没跑完」。
  const pending = (report.evidence?.refs ?? []).filter(
    (ref): ref is CommandRef =>
      ref.kind === 'command' && ref.exitCode === null && ref.background !== true && ref.timedOut !== true
  );
  for (const ref of pending) {
    issues.push(`命令没有退出码：${ref.command}（结果未出，不能算已验证）`);
  }

  const completed = report.results.filter(item => item.status === 'completed').length;
  const evidenceCount = report.evidence?.refs.length ?? 0;
  const summary = `报告 ${report.status}；完成 ${completed} 步，失败 ${failed.length} 步；真实测试 ${tests.length} 次；计划写入 ${writes.length} 处；证据 ${evidenceCount} 条。`;
  return { issues, summary };
}

export async function reviewExecution(
  report: ExecutionReport,
  plan: AgentPlan,
  options: ReviewOptions = {}
): Promise<ReviewVerdict> {
  const now = options.now ?? Date.now;
  const base = ruleReview(report, plan);
  const ask = options.ask;
  if (!ask) {
    return {
      reviewer: '本机规则',
      backend: 'rules',
      verdict: base.issues.length > 0
        ? `执行结果有 ${base.issues.length} 处待处理，建议修复后再验一次。${base.summary}`
        : `执行结果与计划一致，没有发现可核查的问题。${base.summary}`,
      issues: base.issues,
      needsFix: base.issues.length > 0,
      at: now()
    };
  }

  // 这是内部评审调用，不是「把用户的问题发到网页」：第一手提问链路仍然
  // 走 MasterAgent 的原样发问，这里只把执行事实交给一个独立模型读。
  const material = [
    '【执行计划】',
    plan.title,
    plan.description,
    ...plan.steps.map(step => `- ${step.tool}: ${JSON.stringify(step.args)}`),
    '',
    '【真实执行结果】',
    base.summary,
    ...report.results.map(item =>
      `- ${item.tool}: ${item.status}${item.verified ? '（已复验）' : ''}${item.error ? ` · ${item.error}` : ''}`
    ),
    '',
    '请做独立 Review：指出改动是否实现了计划里写的完成条件、有没有引入明显问题、还缺什么验证。',
    '只依据上面的真实结果，不要声称运行过没有出现在报告里的命令。最后一行写【结论】通过 或【结论】需修复。'
  ].join('\n');

  try {
    const text = await Promise.race([
      ask(material),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('评审超时')), options.timeoutMs ?? 90_000)
      )
    ]);
    const verdict = text.trim();
    const needsFix = /【结论】\s*需修复|需要修复|不通过/.test(verdict);
    return {
      reviewer: options.reviewer ?? '独立模型',
      backend: 'model',
      verdict,
      // 规则查出的硬失败永远保留：模型再乐观也不能把非零退出码抹掉。
      issues: [...new Set([...base.issues, ...(needsFix ? ['独立评审认为需要修复'] : [])])],
      needsFix: needsFix || base.issues.length > 0,
      at: now()
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      reviewer: '本机规则',
      backend: 'rules',
      verdict: `独立评审没有完成（${detail}），已退回规则版：${base.summary}`,
      issues: base.issues,
      needsFix: base.issues.length > 0,
      at: now()
    };
  }
}
