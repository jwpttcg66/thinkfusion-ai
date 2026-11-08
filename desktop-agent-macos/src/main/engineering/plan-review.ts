import type { AgentPlan } from '../../shared/contracts';

/**
 * 方案评审辩论的判据（V2.1 D-03 / 任务书 Phase F）。
 *
 * 这一层只有纯函数，因为它要回答的是产品问题而不是执行问题：
 * 「这份计划值不值得先辩一场」「辩什么」「辩出来的东西怎么给审批的人看」。
 *
 * 一条底线：辩论不改变执行语义。辩完仍然要人点确认，权限也不会因为辩出
 * 「应该改 3 个文件」而扩大到能改 3 个文件。
 */

/** 计划里值得辩的风险点，最多三条，按严重程度排序。 */
export function planDebateTopics(plan: AgentPlan): string[] {
  const steps = plan.steps ?? [];
  const tools = steps.map(step => step.tool);
  const writes = steps.filter(step =>
    step.tool === 'fs.writeFile' || step.tool === 'fs.mkdir' || step.tool === 'fs.edit' ||
    step.tool === 'fs.remove' || step.tool === 'fs.move' || step.tool === 'fs.copy'
  );
  const overwrites = steps.filter(step => {
    if (step.tool !== 'fs.writeFile') return false;
    const args = step.args as { overwrite?: boolean };
    return args.overwrite === true;
  });
  const runsTests = tools.includes('test.run');
  const runsShell = steps.filter(step => step.tool === 'shell.run');
  const systemSteps = steps.filter(step =>
    step.tool === 'shell.run' || step.tool === 'screen.capture' || step.tool === 'app.open' ||
    step.tool === 'code.run'
  );
  const topics: string[] = [];

  if (overwrites.length > 0) {
    topics.push(
      `覆盖已有文件是否必要：计划里有 ${overwrites.length} 处 overwrite，` +
        '逐条说明为什么不能只追加或新建，以及回退办法。'
    );
  }
  if (writes.length > 0 && !runsTests) {
    topics.push(
      `改完之后怎么证明没改坏：这份计划有 ${writes.length} 处写入但没有 test.run，` +
        '是漏了验证步骤，还是这个工程确实没有可跑的命令？'
    );
  }
  if (steps.length >= 4) {
    topics.push(
      `步骤拆分是否合理：${steps.length} 步里哪些可以合并、哪些顺序可调整，` +
        '哪一步失败会让后面全部作废。'
    );
  }
  if (runsShell.length > 0 && !runsTests) {
    topics.push(
      `这 ${runsShell.length} 条 shell 命令凭什么安全：逐条说明它会读还是写、` +
        '作用范围是否只在工作区内、失败时会不会留下半成品。'
    );
  } else if (systemSteps.length > 0) {
    topics.push(
      `这 ${systemSteps.length} 个系统动作（命令/截屏/启动应用/跑代码）有没有更小的影响面：` +
        '是否真的需要，以及失败了怎么收尾。'
    );
  }
  if (topics.length === 0) {
    topics.push(`这份计划的验收条件「${plan.completion?.condition ?? '未写明'}」是否足够，有没有更容易出错的地方。`);
  }
  return topics.slice(0, 3);
}

/**
 * 要不要辩。
 *
 * `auto` 只在计划足够大或带风险动作时才辩——任务书要求 Auto 不得无声扩大
 * 模型调用与成本，一次两步的只读计划不值得开一场辩论。
 */
export function shouldDebatePlan(
  mode: 'auto' | 'on' | 'off' | undefined,
  plan: AgentPlan
): { debate: boolean; reason?: string } {
  const effective = mode ?? 'auto';
  if (effective === 'off') {
    return { debate: false, reason: '这一轮按设置关闭了辩论' };
  }
  if (effective === 'on') return { debate: true };
  const steps = plan.steps ?? [];
  const risky = steps.some(step =>
    step.tool === 'fs.writeFile' || step.tool === 'fs.mkdir' || step.tool === 'test.run' ||
    // shell / 截屏 / 启动应用的影响面在工作区之外，auto 下同样值得先辩一轮。
    step.tool === 'shell.run' || step.tool === 'screen.capture' || step.tool === 'app.open' ||
    // 删除、结束进程、抓网页会改变磁盘或把内容发到外网，不能按"小计划"跳过评审。
    step.tool === 'fs.remove' || step.tool === 'fs.move' || step.tool === 'fs.copy' ||
    step.tool === 'process.kill' || step.tool === 'job.kill' || step.tool === 'web.fetch' ||
    // 跑一段代码等于跑一段任意逻辑（能读能写能联网），风险不低于 shell。
    step.tool === 'code.run'
  );
  if (steps.length >= 3 || risky) return { debate: true };
  return { debate: false, reason: `计划只有 ${steps.length} 步且都是只读操作，按 auto 不单独开辩` };
}

/**
 * 交给辩论引擎的问题。
 *
 * 写成一条可以直接被辩手回答的问题，而不是「请评审这份 JSON」：辩手是模型，
 * 它需要知道要判断什么，也需要看到计划本身。
 */
export function planReviewQuestion(plan: AgentPlan): string {
  const steps = (plan.steps ?? [])
    .map((step, index) => `${index + 1}. [${step.tool}] ${step.description ?? ''} ${JSON.stringify(step.args)}`)
    .join('\n');
  return [
    `【待评审的工程计划】${plan.title}`,
    plan.description,
    '',
    '【步骤】',
    steps,
    '',
    `【完成条件】${plan.completion?.condition ?? '未写明'}`,
    '',
    '请判断：这份计划能不能真正完成上面这件事？哪些步骤会失败、缺了什么验证、' +
      '有没有更稳妥的顺序。结论要指明具体步骤编号。'
  ].join('\n');
}

/**
 * 把一场辩论收成审批前能读的一段话。
 *
 * 只取每人最后一轮的立场和失败记录：审批的人要判断「要不要按这个计划动手」，
 * 不需要读完整交锋过程。失败成员必须点名，否则「三个模型都同意」可能是
 * 只有一个人真的说过话。
 */
export function summarizePlanDebate(input: {
  rounds: Array<{
    index: number;
    messages: Array<{ author: string; kind: string; text: string }>;
    failures?: Array<{ agentId: string; detail: string }>;
  }>;
  topics: string[];
}): string {
  const { rounds, topics } = input;
  if (rounds.length === 0) return '辩论没有产生任何发言，不能据此判断计划是否可行。';
  const last = rounds[rounds.length - 1];
  const failures = rounds.flatMap(round => round.failures ?? []);
  const lines: string[] = [];
  if (topics.length > 0) lines.push(`辩题：${topics.join('；')}`);
  const stances = last.messages
    .filter(message => message.text.trim())
    .map(message => `【${message.author}】${message.text.trim().slice(0, 400)}`);
  if (stances.length === 0) lines.push('最后一轮没有留下发言。');
  else lines.push(...stances);
  if (failures.length > 0) {
    const names = [...new Set(failures.map(item => `${item.agentId}（${item.detail}）`))];
    lines.push(`未参与或中途失败的成员：${names.join('、')}；上面的结论不代表他们。`);
  }
  return lines.join('\n');
}
