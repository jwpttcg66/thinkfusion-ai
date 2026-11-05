/**
 * 辩论 Prompt 模板清单（任务书 §12）。
 *
 * 这一版只做三件任务书明确要求、且不会改变行为的事：
 *
 * 1. **独立**：发给模型的指令从 `orchestrator.ts` 搬到本文件，编排器只负责
 *    决定「这一轮问谁、给谁」，不再持有文案。
 * 2. **版本化**：`PROMPT_VERSION` 是唯一版本号，每场辩论开场时写进
 *    `DebateState.promptVersion`。历史会话保留它当时用的版本，之后升级模板
 *    也不会把老记录说成是用新模板跑的。
 * 3. **可测试**：七个模板都登记输入 / 输出 / 禁止事项 / 引用要求 / 失败处理，
 *    `check-debate-prompts.mjs` 逐项断言，并锁住渲染结果逐字不变。
 *
 * 两条边界，别越线：
 *
 * - **网页通道只收用户原话。** 下面所有 `system` 模板都只发给能读 system 的
 *   本地 / 云端成员；网页成员的 task 里没有 `system`，也没有 `context`。
 *   `renderInstructions` 不知道网页通道的存在，编排器负责不给它。
 * - **不凭空造模板。** 任务书列了七个文件，其中四个在本仓库是**本地规则**，
 *   根本没有发给模型的文案（切句、争议检测、裁判、综合）。它们照样登记，
 *   但 `kind: 'rule'`、`text: null`，并写清实现文件。编一段「看起来像 prompt」
 *   的文字挂上去，只会让人误以为模型参与了那一步。
 */
import type { DebateMessageKind, DebateRole } from './types';
import type { DebateLead } from './lead';
import { strategyFocus } from './strategies';
import type { DebateStrategy } from './types';

/**
 * 模板版本。改动任何一条 `system` 文案、或改动任一规则模板的输入 / 输出约束，
 * 都必须同时把这个值往前推，并在 `docs/implementation/DEBATE_RUNBOOK.md`
 * 的「模板版本历史」里写清改了什么。老辩论文件里的数字不动。
 */
export const PROMPT_VERSION = '1.0.0';

export type PromptTemplateKind = 'system' | 'rule';

export interface PromptTemplate {
  /** 任务书 §12 里的文件名（不含 .md）。 */
  id: string;
  version: string;
  kind: PromptTemplateKind;
  /** 输入 schema：字段名与来源，不是自然语言描述。 */
  inputs: string[];
  /** 输出 schema：产出什么、谁解析。 */
  outputs: string[];
  /** 禁止事项。 */
  prohibitions: string[];
  /** 引用要求：发言要不要带出处、出处怎么落盘。 */
  citation: string;
  /** 失败处理：解析不出来 / 调用失败时怎么办。 */
  onFailure: string;
  /** 实现所在文件；`text` 为 null 的规则模板必须给。 */
  source: string;
  /** 实际发给模型的文案。规则模板为 null。 */
  text: string[] | null;
}

/**
 * 七个模板。`system` 三项的文本由 `renderInstructions` 按轮次生成，这里的
 * `text` 是三种轮次下的骨架（供文档与用例读取），动态部分（策略侧重、具体
 * 挑战、角色职责）在渲染时追加，见 `renderInstructions` 的注释。
 */
export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'independent-analysis',
    version: PROMPT_VERSION,
    kind: 'system',
    inputs: ['question: string（用户原话）', 'stage: initial | followup', 'context?: string（前序发言）', 'system: string[]'],
    outputs: ['SubAgentAnswer.text: string（发言原文）', 'SubAgentAnswer.citations?: PageCitation[]'],
    prohibitions: [
      '不套角色扮演话术，不改用户问题',
      '不把 system 指令拼进 question',
      '不为了与他人一致而放弃有依据的不同意见'
    ],
    citation: '发言里自称的出处由 claim-extractor 抽成 evidenceDrafts；页面上的 a[href] 由页面驱动单独采集',
    onFailure: '调用超时或抛错记进 round.failures，不阻塞其他成员；缺失成员在该轮如实留空',
    source: 'src/main/debate/prompts.ts（renderInstructions）/ src/main/debate/orchestrator.ts（task 组装）',
    text: [
      '独立给出你对这个问题的观点，并说明成立的条件。',
      '网页通道的回答已经在上下文里。不要复述它们，直接指出其中站不住的那一条，并给出你的判断和条件。'
    ]
  },
  {
    id: 'claim-extraction',
    version: PROMPT_VERSION,
    kind: 'rule',
    inputs: ['DebateMessage[]（每轮最终文本）'],
    outputs: ['DebateClaim[]（text / kind / kindCue / assumptions / span）'],
    prohibitions: ['不改动发言原文', '不把没说过的出处补成事实', '不按模型票数给主张加权'],
    citation: 'evidenceDrafts 只记录「发言里自称的出处」，不视为已核验',
    onFailure: '切不出句子就得到空数组，不伪造一条「分析过但没抽到」',
    source: 'src/main/debate/claims.ts + src/main/synthesis/claim-extractor.ts',
    text: null
  },
  {
    id: 'dispute-detection',
    version: PROMPT_VERSION,
    kind: 'rule',
    inputs: ['DebateClaim[]（同一轮）', 'DetectedRelation[]'],
    outputs: ['DebateDispute[]（factual / logical / scope / evidence_conflict / definitional）'],
    prohibitions: ['只认跨参与者冲突', '同一来源的两句半截话不算分歧', '定义差异不连 contradicts'],
    citation: '争议 reason 里带上两句原话，不给来源编号',
    onFailure: '判不出来就不产生争议，不硬塞一条 low-priority',
    source: 'src/main/debate/claims.ts + src/main/synthesis/relations.ts',
    text: null
  },
  {
    id: 'challenge',
    version: PROMPT_VERSION,
    kind: 'system',
    inputs: ['DebateDispute[]（上一轮）', 'DebateClaim[]（上一轮）', 'challenges: string[]（最多 3 条）'],
    outputs: ['SubAgentAnswer.text: string（质疑与理由）'],
    prohibitions: ['不泛泛要求「再想一想」', '挑战必须指向具体两句原话', '最多三条'],
    citation: '要求指出「哪一句的出处撑不住它」，但不允许系统替来源编地址',
    onFailure: '没有争议时 challenges 为空，这一轮仍按独立质疑走',
    source: 'src/main/debate/prompts.ts（renderInstructions）/ src/main/debate/claims.ts（challengesFor）',
    text: ['逐条质疑上一轮发言里证据不足或推理跳跃的地方；指出具体是哪一句。']
  },
  {
    id: 'revision',
    version: PROMPT_VERSION,
    kind: 'system',
    inputs: ['question: string', 'context: string（前序发言）', 'challenges: string[]'],
    outputs: ['SubAgentAnswer.text（第一行必须为「决策：accept / defend / revise / withdraw / inconclusive」）', 'DebateRevision（before / after / decision）'],
    prohibitions: ['系统不替模型选决策', '解析不出来记 null，不猜', '原话不被覆盖：before / after 都留原文'],
    citation: '修订理由来自发言本身，不额外注入来源',
    onFailure: '决策行缺失或写了别的值 → decision: null 且标 inferred，不擅自归到 defend',
    source: 'src/main/debate/prompts.ts（renderInstructions）+ src/main/debate/revision.ts',
    text: [
      '针对质疑逐条回应；可以修正观点，也可以说明为什么坚持，并给出条件。',
      '回答的第一行只写决策，从这五个里选一个：决策：accept / defend / revise / withdraw / inconclusive（依次是 接受质疑 / 有依据地坚持 / 部分修正 / 撤回这条说法 / 现有信息判断不了）。'
    ]
  },
  {
    id: 'judgment',
    version: PROMPT_VERSION,
    kind: 'rule',
    inputs: ['DebateClaim[]', 'DebateDispute[]', 'DebateEvidence[]', 'DebateRevision[]', 'DebateMessage[]（少数派）'],
    outputs: ['ClaimJudgment[]（逻辑 / 证据 / 反例三维独立）', 'DebateVerdict（五档）'],
    prohibitions: ['不按多数投票判真伪', '不把三维平均成一个分数', 'insufficient_evidence 不等于 unsupported', '不伪造置信度'],
    citation: '只有页面给了地址的证据算 page-link；自称出处只算 reported',
    onFailure: '证据拿不到 → insufficient_evidence，不硬给结论；分母为 0 的指标返回 null',
    source: 'src/main/debate/judges.ts + src/main/debate/evidence.ts',
    text: null
  },
  {
    id: 'synthesis',
    version: PROMPT_VERSION,
    kind: 'rule',
    inputs: ['DebateVerdict', 'DebateView（judgments / evidence / disputes / revisions / metrics）'],
    outputs: ['界面结论条（五档 + 三维 + 可追溯率）', '完整报告（九块）'],
    prohibitions: ['不把规则版结论与主导人五段并排显示成两套结论', '不显示票数', '不把没有的数据写成 0%'],
    citation: '参考来源来自 evidence 里的页面链接，可点击；没有链接就写「无页面来源」',
    onFailure: '读不到辩论记录就整块不显示，不影响综合卡本身',
    source: 'src/renderer/src/components/ConversationView.tsx + ResearchPanel.tsx',
    text: null
  }
];

/** 按 id 取模板；取不到返回 undefined，调用方自己决定怎么报错。 */
export function promptTemplate(id: string): PromptTemplate | undefined {
  return PROMPT_TEMPLATES.find(template => template.id === id);
}

/** 这一场用的是哪个版本，供落盘与界面显示。 */
export function promptVersion(): string {
  return PROMPT_VERSION;
}

/**
 * 渲染某一轮、某个成员会收到的 system 指令。
 *
 * 文案是 0.1.0~0.1.1 逐字搬过来的，`check-debate-prompts.mjs` 有快照用例
 * 锁着：改任何一个字，那条用例就会红——这是有意的，模板升级应当是一次
 * 看得见的决定，顺手改文案不该混在重构里。
 *
 * 只发给能读 system 的本地 / 云端成员；网页成员的 task 里不应出现它。
 */
export function renderInstructions(
  strategy: DebateStrategy,
  kind: DebateMessageKind,
  role: DebateRole,
  lead: DebateLead,
  options: { seeded?: boolean; challenges?: string[] } = {}
): string[] {
  const lines: string[] = [];
  if (kind === 'position' && options.seeded) {
    // 网页回答已经在上下文里：不要再重复一遍它们，直接站到异议那一侧。
    lines.push('网页通道的回答已经在上下文里。不要复述它们，直接指出其中站不住的那一条，并给出你的判断和条件。');
  } else if (kind === 'position') lines.push('独立给出你对这个问题的观点，并说明成立的条件。');
  else if (kind === 'question') lines.push('逐条质疑上一轮发言里证据不足或推理跳跃的地方；指出具体是哪一句。');
  else {
    lines.push('针对质疑逐条回应；可以修正观点，也可以说明为什么坚持，并给出条件。');
    // 决策写在哪一行、用哪个词，是全流程唯一能被机器确定读到的信号。
    // 写不清楚就只能靠规则去猜，猜出来的会标成 inferred。
    lines.push(
      '回答的第一行只写决策，从这五个里选一个：决策：accept / defend / revise / withdraw / inconclusive' +
        '（依次是 接受质疑 / 有依据地坚持 / 部分修正 / 撤回这条说法 / 现有信息判断不了）。'
    );
  }
  // 策略在这一轮额外要求做的事：先列前提、给候选方案、找反例……都写在
  // `strategies.ts` 里，这里只负责拼进去。没有策略差异的轮次它返回空数组。
  lines.push(...strategyFocus(strategy, kind));
  // 具体冲突排在通用指令后面：模型先知道这一轮要做什么，再看到具体问哪几句。
  if (options.challenges && options.challenges.length > 0 && kind !== 'position') {
    lines.push('这一轮先处理下面几处具体冲突，它们都是上一轮里彼此对不上的两句：');
    lines.push(...options.challenges);
  }
  const duty = ROLE_DUTY[role];
  if (duty) lines.push(duty);
  if (lead.mode === 'web' && kind !== 'position') {
    lines.push('这一场以网页通道的独立观点为基准，重点检验它的证据和推理，但不要忽略其他回答里的问题。');
  }
  lines.push('保留有依据的不同意见，不要为了达成一致而放弃它。');
  return lines;
}

/** 角色说明。`peer` 不写：平等发言时不该硬塞一个立场。 */
const ROLE_DUTY: Partial<Record<DebateRole, string>> = {
  proposer: '你的职责是提出并维护主张。',
  critic: '你的职责是检验主张的漏洞。',
  domain_expert: '以你所在领域的证据标准发言，并说明这个标准是什么。',
  evidence_reviewer: '你的职责是核对前提与证据，而不是另起一个结论。'
};
