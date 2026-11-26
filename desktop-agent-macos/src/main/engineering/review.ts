/**
 * V2.1 Phase F：执行之后的独立 Review。
 *
 * 「独立」指的是不复用做规划的那个网页通道：规划者自己评自己的计划，
 * 只会把刚才的推理再复述一遍。没有可用模型时退回规则版，并如实标
 * `backend: 'rules'`，不把规则说成模型裁决（沿用 JudgeEngine 的口径）。
 *
 * 规则版只检查**能从报告里读到的事实**：有没有失败步骤、检查有没有退出码、
 * 写操作有没有跟着一次能观察结果的动作。它不判断代码好不好——那需要模型。
 *
 * 交给评审模型的材料必须带**每一步的真实输出**。2026-11-22 真机：材料里只写
 * 「shell.run: completed」，评审于是说「报告没有展示 stdout，无法确认输出了
 * hello everybody」——stdout 其实就在报告里，只是没递过去。用户看到结论是
 * 「无法验证」，而实际早就验证过了。评审看不到的东西，它只能判成没有。
 *
 * 修复不在这里自动执行：Review 只产出「问题 + 是否需要修复」。下一步
 * 要么由用户确认后重新生成计划，要么明确结束，权限始终在用户手里。
 */

import type { AgentPlan, ExecutionReport, ReviewIssueDetail, StepResult } from '../../shared/contracts';
import type { EvidenceRef } from '../../shared/engineering-evidence';
import { planHasObservableEvidence, stepEvidenceKinds } from '../../shared/verification-evidence';
import { assessCollaborationRisk } from './plan-review';

type CommandRef = Extract<EvidenceRef, { kind: 'command' }>;

export interface ReviewVerdict {
  reviewer: string;
  backend: 'model' | 'rules';
  /** 给人读的短结论；完整原文在 rawVerdict。 */
  verdict: string;
  /** 模型/规则给出的完整原文，结构化问题不足时仍可展开。 */
  rawVerdict?: string;
  issues: string[];
  issueDetails?: ReviewIssueDetail[];
  needsFix: boolean;
  at: number;
}

function severityOf(text: string): ReviewIssueDetail['severity'] {
  if (/高风险|严重|致命|崩溃|数据丢失|安全/.test(text)) return 'high';
  if (/中风险|应补|缺少|未覆盖|失败|不一致/.test(text)) return 'medium';
  if (/低风险|建议|可选|轻微/.test(text)) return 'low';
  return 'unknown';
}

/** 把字符串问题列表变成可跟踪的 issueDetails；disposition 一律 pending。 */
export function structureReviewIssues(issues: readonly string[], reviewKey: string): ReviewIssueDetail[] {
  return issues.map((text, index) => {
    const description = text.trim();
    const title = description.slice(0, 80) || `问题 ${String(index + 1)}`;
    const severity = severityOf(description);
    // 关键词分级只是降级兼容：明确写进 rationale，避免被当成完整评审语义。
    const rationale = severity === 'unknown'
      ? '风险等级未从原文识别；完整依据见本条问题描述与评审原文。'
      : `风险等级由原文关键词降级推断为「${severity}」；完整理由与影响仍以问题描述与评审原文为准。`;
    const recommendationMatch = description.match(/(?:建议|应|需要)([^。；;]+[。；;]?)/);
    return {
      issueId: `${reviewKey}:issue:${String(index)}:${title}`,
      title,
      description,
      severity,
      rationale,
      ...(recommendationMatch ? { recommendation: recommendationMatch[0].trim() } : {}),
      disposition: 'pending' as const
    };
  });
}

export interface ReviewOptions {
  /** 独立评审模型的调用口；不给就用规则版。 */
  ask?: (material: string) => Promise<string>;
  reviewer?: string;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * 评审原文里的最终结论。
 *
 * 不能只拿正则扫「需要修复」三个字：`不需要修复` / `无需修复` 都会被扫中，
 * 于是评审写着「通过」，系统判成需修复，再开一轮——真机 2026-11-26 那场
 * 134 秒该结束的任务跑了 421 秒，就是从这里开始的。所以先把否定说法抹掉，
 * 再看【结论】那一段到底写了什么；没有明确结论就返回 unclear。
 */
export function reviewConclusion(text: string): 'pass' | 'fix' | 'unclear' {
  // 替换文本本身不能再含「需要修复」，否则等于换了个地方继续误判。
  const cleaned = text.replace(
    /(?:不需要修复|不需要再修复|不需再修复|无需再修复|无需修复|不须修复|不必修复|不用修复|不要修复|不需修复)/g,
    '无须改动'
  );
  const markers = [...cleaned.matchAll(/【结论】[^\n]*/g)].map(match => match[0]);
  const last = markers.at(-1)?.replace('【结论】', '').trim() ?? '';
  const tail = cleaned.split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '';
  const body = last || tail;
  // 「不通过 / 未通过」必须先于「通过」判断，否则「不通过」会被读成通过。
  if (/不通过|未通过|需修复|需要修复|需修改|需重做/.test(body)) return 'fix';
  if (/通过|可交付|可以交付|可以收尾/.test(body)) return 'pass';
  return 'unclear';
}

/**
 * 「没有问题」的句子长得像问题：带这些说法的行不进待修列表。
 *
 * 真机两次都栽在这里：评审写「缺少独立诊断不影响本次结论」「未发现明显问题，
 * 说明无功能缺陷」，被当成两条待修项，任务因此多跑了两轮。
 */
const NOT_AN_ISSUE =
  /(无明显|没有问题|未发现|不存在|无潜在|没有发现|未引入明显|不构成|不影响|无需|不必|可以接受|足以|不是错误|并非错误|不算错误|不视为|符合预期|说明无|未产生|没有引入)/;

const WRITE_TOOLS = new Set(['fs.writeFile', 'fs.edit', 'fs.applyPatch', 'fs.remove', 'fs.move', 'fs.copy']);
const OBSERVING_TOOLS = new Set(['code.diagnostics', 'screen.capture']);

/** 只从执行报告里抽事实，不评价代码质量。 */
export function ruleReview(report: ExecutionReport, plan: AgentPlan): { issues: string[]; summary: string } {
  const issues: string[] = [];
  const failed = report.results.filter(item => item.status === 'failed');
  for (const step of failed) {
    issues.push(`${step.tool} 执行失败：${step.error ?? '未知原因'}`);
  }

  const writes = report.results.filter(item => WRITE_TOOLS.has(item.tool));
  const checks = report.results.filter(
    item => OBSERVING_TOOLS.has(item.tool) || stepEvidenceKinds({ tool: item.tool, args: item.args }).length > 0
  );

  const verification = report.verification;
  if (verification) {
    // 验证结论已经按统一口径算好了（编译 / 测试 / 运行断言 / 诊断都算检查），
    // 这里只把它读出来。「本轮没有写操作，无需验证」不是问题，别写进待修列表。
    if (!verification.verified) {
      const reasons = verification.reasons.filter(reason => !reason.includes('无需验证'));
      if (reasons.length > 0) issues.push(...reasons);
      else issues.push('本轮未通过验证，但没有给出原因');
    }
  } else if (writes.length > 0 && !planHasObservableEvidence(plan.steps)) {
    // 老报告没有 verification 字段时才走这条路。判据仍是「有没有能观察结果的
    // 动作」，不是「有没有 test.run」——模型真跑 javac、真比对输出同样算验证。
    issues.push(
      '这轮改了文件，但计划里没有任何能观察结果的动作（编译、测试、运行断言、诊断都算）：无法证明改动没破坏原有行为'
    );
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
  const summary =
    `报告 ${report.status}；完成 ${completed} 步，失败 ${failed.length} 步；` +
    `能观察结果的检查 ${checks.length} 次；计划写入 ${plan.steps.filter(step => step.tool === 'fs.writeFile').length} 处；` +
    `证据 ${evidenceCount} 条。`;
  return { issues: [...new Set(issues)], summary };
}

// ---------------------------------------------------------------------------
// 交给评审模型看到的材料
// ---------------------------------------------------------------------------

const STEP_OUTPUT_LIMIT = 1200;
const TOTAL_OUTPUT_LIMIT = 12_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 保留尾部：报错与最终输出都在后面，截前面等于把证据丢掉。 */
function clipTail(text: string, limit: number): string {
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed.length <= limit) return trimmed;
  return `…（前 ${String(trimmed.length - limit)} 字已省略）\n${trimmed.slice(-limit)}`;
}

function commandOf(step: StepResult): string | null {
  const fromArgs = asRecord(step.args)?.command;
  if (typeof fromArgs === 'string' && fromArgs.trim()) return fromArgs.trim();
  const fromResult = asRecord(step.result)?.command;
  return typeof fromResult === 'string' && fromResult.trim() ? fromResult.trim() : null;
}

function fenced(text: string): string[] {
  return ['   ```', ...text.split('\n').map(line => `   ${line}`), '   ```'];
}

/** 步骤上的说明 + 验收条件；都不是执行参数，但评审要看到。 */
function stepNoteOf(step: AgentPlan['steps'][number]): string {
  const asText = (value: unknown): string =>
    Array.isArray(value) ? value.map(item => String(item)).join('；') : typeof value === 'string' ? value : '';
  const parts = [
    typeof step.description === 'string' ? step.description.trim() : '',
    asText(step.acceptance).trim(),
    asText(step.acceptanceCriteria).trim()
  ].filter(Boolean);
  return parts.join('；');
}

/**
 * 评审材料：计划 + 每一步的真实命令、退出码与输出。
 *
 * 这是纯函数，测试直接断言材料里有没有 stdout——材料是评审唯一的输入，
 * 这里缺什么，评审就只能说「看不出」。
 */
export function buildReviewMaterial(report: ExecutionReport, plan: AgentPlan, summary?: string): string {
  const lines: string[] = [];
  const completed = report.results.filter(item => item.status === 'completed').length;
  const failed = report.results.filter(item => item.status === 'failed').length;

  lines.push('【任务】', plan.title, plan.description ?? '', '');
  lines.push('【计划步骤】');
  plan.steps.forEach((step, index) => {
    lines.push(`${String(index + 1)}. ${step.tool} ${JSON.stringify(step.args)}`);
    // 模型自己写的「这一步怎么算做到」要递过去：否则评审只能凭 args 猜意图，
    // 再把「看不出验收标准」写成一条待修项。
    const note = stepNoteOf(step);
    if (note) lines.push(`   说明：${note}`);
  });
  if (plan.completion?.condition) lines.push('', `完成条件：${plan.completion.condition}`);

  lines.push('', '【真实执行结果】');
  lines.push(`报告状态 ${report.status}；完成 ${completed} 步，失败 ${failed} 步。`);
  let budget = TOTAL_OUTPUT_LIMIT;
  report.results.forEach((item, index) => {
    lines.push(
      `${String(index + 1)}. ${item.tool} ${item.status}${item.status === 'completed' ? '' : item.error ? ` · ${item.error}` : ''}`
    );
    const command = commandOf(item);
    if (command) lines.push(`   命令：${command}`);
    const result = asRecord(item.result);
    if (result) {
      const exitCode = result.exitCode;
      if (typeof exitCode === 'number' || exitCode === null) {
        lines.push(
          `   退出码：${exitCode === null ? '没有（命令未跑完）' : String(exitCode)}${result.timedOut === true ? '（超时）' : ''}`
        );
      }
      const stdout = typeof result.stdout === 'string' ? result.stdout : '';
      const stderr = typeof result.stderr === 'string' ? result.stderr : '';
      if (stdout.trim()) {
        const take = Math.min(STEP_OUTPUT_LIMIT, Math.max(0, budget));
        if (take > 0) {
          lines.push('   stdout：', ...fenced(clipTail(stdout, take)));
          budget -= Math.min(stdout.length, take);
        } else {
          lines.push('   stdout：（总输出已达上限，这一段省略）');
        }
      } else if (command) {
        lines.push('   stdout：（空）');
      }
      if (stderr.trim()) {
        const take = Math.min(STEP_OUTPUT_LIMIT, Math.max(0, budget));
        if (take > 0) {
          lines.push('   stderr：', ...fenced(clipTail(stderr, take)));
          budget -= Math.min(stderr.length, take);
        }
      }
      // 非命令类结果（写了哪个文件、多少字节）也带上：评审要核对改了哪些东西。
      if (!command && !stdout && !stderr) {
        lines.push(`   结果：${clipTail(JSON.stringify(result), 400)}`);
      }
    }
    if (item.error) lines.push(`   错误：${item.error}`);
  });

  const verification = report.verification;
  if (verification) {
    lines.push('', `【验证判定】${verification.verified ? '已通过' : '未通过'}`);
    const checks = verification.checks;
    if (checks) {
      const rows: Array<[string, { status: string; exitCode?: number; command?: string; output?: string } | undefined]> = [
        ['编译', checks.compile],
        ['运行', checks.run],
        ['测试', checks.tests]
      ];
      for (const [label, check] of rows) {
        if (!check) continue;
        lines.push(
          `- ${label}：${check.status}` +
            `${typeof check.exitCode === 'number' ? `（退出码 ${String(check.exitCode)}）` : ''}` +
            `${check.command ? ` · ${check.command}` : ''}` +
            `${check.output ? ` · 输出「${check.output}」` : ''}`
        );
      }
      lines.push(`- 诊断：${checks.diagnostics.status}（error ${String(checks.diagnostics.errors)} / warning ${String(checks.diagnostics.warnings)}）`);
      if (checks.changedFiles.length > 0) lines.push(`- 改动文件：${checks.changedFiles.join('、')}`);
    }
    for (const reason of verification.reasons) lines.push(`- ${reason}`);
  } else {
    lines.push('', '【验证判定】这份报告没有验证结论（老报告），只能看每一步的退出码与输出。');
  }

  if (summary) lines.push('', '【执行者自述】', summary);

  lines.push(
    '',
    '请做独立 Review：改动是否实现了计划里写的完成条件、有没有引入明显问题、还缺什么验证。',
    '每一步的真实命令与输出已经附在上面；判断以这些输出为准。',
    '只有这一节里确实没有对应输出、也没有退出码时，才可以说「证据不足」；不要因为没看到你认为该有的工具（比如 test.run）就判未验证。',
    '只依据上面的真实结果，不要声称运行过没有出现在报告里的命令。最后一行写【结论】通过 或【结论】需修复。'
  );
  return lines.join('\n');
}

/**
 * 执行后要不要再调模型审核（规则已跑过之后）。
 *
 * **是否审核一定由模型做**：规则只产材料/待修项，不替代模型下结论。
 * L0/验证通过等启发式不得再硬跳模型审。
 */
export function shouldModelReviewExecution(
  report: ExecutionReport,
  plan: AgentPlan,
  _ruleIssues: readonly string[]
): { model: boolean; reason: string } {
  const risk = assessCollaborationRisk(plan);
  const verified = Boolean(report.verification?.verified);
  return {
    model: true,
    reason: verified
      ? `${risk.level} 验证已通过：仍由模型独立审核一次（模型决定是否通过）`
      : `${risk.level} 验证未完全收口：由模型独立审核`
  };
}

export async function reviewExecution(
  report: ExecutionReport,
  plan: AgentPlan,
  options: ReviewOptions = {}
): Promise<ReviewVerdict> {
  const now = options.now ?? Date.now;
  const base = ruleReview(report, plan);
  const ask = options.ask;
  const gate = shouldModelReviewExecution(report, plan, base.issues);
  if (!ask || !gate.model) {
    const skippedModel = Boolean(ask) && !gate.model;
    const verdict = base.issues.length > 0
      ? `执行结果有 ${String(base.issues.length)} 处待处理，建议修复后再验一次。${base.summary}`
      : skippedModel
        ? `规则审核通过，未调用模型（${gate.reason}）。${base.summary}`
        : `执行结果与计划一致，没有发现可核查的问题。${base.summary}`;
    const at = now();
    return {
      reviewer: '本机规则',
      backend: 'rules',
      verdict,
      rawVerdict: verdict,
      issues: base.issues,
      issueDetails: structureReviewIssues(base.issues, `rules:${String(at)}`),
      needsFix: base.issues.length > 0,
      at
    };
  }

  // 这是内部评审调用，不是「把用户的问题发到网页」：第一手提问链路仍然
  // 走 MasterAgent 的原样发问，这里只把执行事实交给一个独立模型读。
  const material = buildReviewMaterial(report, plan);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      ask(material),
      new Promise<string>((_, reject) => {
        // 评审已经回来就撤掉定时器：否则每次成功评审还会挂着 90 秒的空转。
        timeout = setTimeout(() => reject(new Error('评审超时')), options.timeoutMs ?? 90_000);
      })
    ]);
    const verdict = text.trim();
    const conclusion = reviewConclusion(verdict);
    // 只有能指向具体条目的“需修复”才阻塞交付；只有结论、没有问题的评审
    // 无法执行，按“无具体问题”记录，避免下一轮空转或生成非法计划。
    const modelIssues = verdict
      .split('\n')
      .map(line => line.replace(/^\s*(?:[-*]|\d{1,2}[.、)）])\s*/, '').trim())
      .filter(line => line.length >= 4)
      .filter(line => /缺少|未通过|失败|不一致|需要修复|应补|未覆盖|错误|证据不足|无法确认/.test(line))
      .filter(line => !NOT_AN_ISSUE.test(line))
      .filter(line => !/^【?(结论|总评)】?/.test(line))
      .slice(0, 8);
    // 结论优先：评审最后写「通过」，前面那些解释性的句子（「缺少独立诊断
    // 不影响结论」「建议后续补…」）不再算待修项。规则层的事实（失败步骤、
    // 验证缺口）不受结论影响——那是从报告里读出来的，不是模型说的。
    const blockingModelIssues = conclusion === 'pass' ? [] : modelIssues;
    const actionable = [...new Set([...base.issues, ...blockingModelIssues])];
    const at = now();
    const shortVerdict = actionable.length > 0
      ? `需修复：${(actionable[0] ?? '').slice(0, 120)}`
      : conclusion === 'pass'
        ? '通过'
        : conclusion === 'fix'
          ? '结论写需修复，但没有指出可执行的问题（不阻塞交付）'
          : verdict.slice(0, 160);
    return {
      reviewer: options.reviewer ?? '独立模型',
      backend: 'model',
      verdict: shortVerdict,
      rawVerdict: verdict,
      issues: actionable,
      issueDetails: structureReviewIssues(actionable, `model:${String(at)}`),
      needsFix: actionable.length > 0,
      at
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const at = now();
    const verdict = `独立评审没有完成（${detail}），已退回规则版：${base.summary}`;
    return {
      reviewer: '本机规则',
      backend: 'rules',
      verdict,
      rawVerdict: verdict,
      issues: base.issues,
      issueDetails: structureReviewIssues(base.issues, `rules-fallback:${String(at)}`),
      needsFix: base.issues.length > 0,
      at
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
