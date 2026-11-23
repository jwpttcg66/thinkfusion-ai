import React, { useEffect, useState } from 'react';
import type { AgentEvent, AgentTask, PlanPreview } from '../../../../shared/contracts';
import type { TaskMemberStream } from '../../../../shared/task-stream';

/**
 * 主任务进度容器（V2.1 §16.2）。
 *
 * 它必须能独立回答问题：「现在到哪一步、在等谁、下一步是什么、最近发生了什么」。
 * 不用百分比：没有可信总量时（计划还没生成、步骤数未知）算出来的百分比只会骗人，
 * 所以这里只在有真实计划时显示 `已完成/总数`，其余写文字。
 */

const STAGE_LABEL: Record<AgentTask['status'], string> = {
  created: '已创建',
  planning: '理解与规划',
  awaiting_clarification: '等待你补充',
  plan_ready: '计划已生成',
  awaiting_approval: '等待你确认计划',
  executing: '执行本机步骤',
  verifying: '验证结果',
  report_pending: '等待确认交付',
  awaiting_next_round: '等待下一轮',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

const NEXT_STEP: Record<AgentTask['status'], string> = {
  created: '提交问题',
  planning: '等待模型返回计划',
  awaiting_clarification: '回答模型的问题',
  plan_ready: '审阅计划',
  awaiting_approval: '审阅计划并确认执行',
  executing: '等待当前步骤完成',
  verifying: '等待验证结果',
  report_pending: '补测试/诊断，或明确接受未验证',
  awaiting_next_round: '可以继续追问',
  completed: '查看最终交付',
  failed: '查看失败原因后重新提问',
  cancelled: '重新提问'
};

/**
 * 事件名说人话。
 *
 * 「最近活动 · round.peer」这种写法只有写代码的人看得懂；这里给的是同一时刻
 * 用户需要的那句话。认不出来的类型原样留着，比编一个更好。
 */
const EVENT_LABEL: Record<string, string> = {
  'round.started': '开始这一轮提问',
  'round.peer': '并行成员作答',
  'round.delta': '模型正在输出',
  'round.answer': '收到本轮回答',
  'plan.ready': '执行计划已生成',
  'plan.invalid': '计划不合规，准备重出',
  'plan.review.progress': '方案评审进行中',
  'plan.debated': '计划评审完成',
  'clarification.required': '需要你补充信息',
  'step.preparing': '准备执行步骤',
  'step.started': '开始执行步骤',
  'step.approval': '等待你批准这一步',
  'step.question': '执行中向你提问',
  'step.completed': '一步执行完成',
  'step.failed': '一步执行失败',
  'report.ready': '执行报告已生成',
  'report.sent': '报告已发回模型',
  'review.ready': '独立评审完成',
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'task.cancelled': '任务已取消',
  'send.failed': '发送失败'
};

function durationText(ms: number): string {
  if (ms < 1000) return '刚刚开始';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${String(minutes)} 分钟` : `${String(minutes)} 分 ${String(rest)} 秒`;
}

export function TaskProgressCard(props: {
  task: AgentTask;
  plan: PlanPreview | null;
  events: readonly AgentEvent[];
  members: readonly TaskMemberStream[];
  pendingStep: { tool: string; index: number; total: number } | null;
  pendingQuestion: { question: string } | null;
  awaitingAnswer: boolean;
  /** 这一问下方确实有「最终交付」卡：没有就不能让「下一步」指向一块不存在的区域。 */
  hasDelivery: boolean;
}) {
  const { task, plan, events, members } = props;
  const [now, setNow] = useState(Date.now());
  const active = !['completed', 'failed', 'cancelled'].includes(task.status);
  /**
   * 已结束的任务用结束时间算总耗时。
   *
   * 用 `now` 会让「刷新后打开一条三天前的任务」显示成「3 天」，读起来像还在跑。
   */
  const endAt = active ? now : Math.max(task.createdAt, task.updatedAt ?? task.createdAt);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  // 只数「当前这份计划」已完成的步骤：任务会多轮重规划，跨轮把 stepId 去重合起来
  // 会出现「6 / 2 步」这种分子大于分母的怪值（旧轮 6 个 + 新轮 2 个计划）。
  // 优先按 roundId 精确匹配；老事件没有 roundId 时退回「当前计划的 stepId 集合」。
  const completedSteps = events.filter(event => event.type === 'step.completed') as Array<
    { stepId: string; roundId?: string }
  >;
  const planStepIds = new Set((plan?.steps ?? []).map(step => step.id));
  const currentRoundDone = plan
    ? completedSteps.filter(event =>
        event.roundId === plan.roundId ||
        (event.roundId === undefined && planStepIds.has(event.stepId)))
    : completedSteps;
  const doneSteps = new Set(currentRoundDone.map(event => event.stepId)).size;
  const totalSteps = plan?.steps.length ?? null;
  const working = members.filter(item => item.status === 'preparing' || item.status === 'streaming');
  // 「最近活动」跳过 log：它每几秒一条，会把真正的节点（计划、步骤、评审）淹掉。
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const lastEvent = [...ordered]
    .reverse()
    .find(event => event.type !== 'log' && event.type !== 'task.updated') ?? ordered.at(-1) ?? null;
  /**
   * 方案评审是最长的一段静默等待（主进程最多等 3 分钟）。任务状态在辩论
   * 结束前仍是 plan_ready，光看状态会被误读成「等用户审批、界面卡住了」。
   * 心跳事件没到 done 且任务还没进审批，就明确写「评审中」并单独计时。
   */
  const reviewProgress = [...ordered].reverse().find(
    (event): event is Extract<AgentEvent, { type: 'plan.review.progress' }> =>
      event.type === 'plan.review.progress'
  ) ?? null;
  const inReview = Boolean(
    reviewProgress && reviewProgress.state !== 'done' &&
      (task.status === 'plan_ready' || task.status === 'planning')
  );
  const stageLabel = inReview ? '方案评审中' : STAGE_LABEL[task.status];

  // 「在等谁」：阻塞态优先（用户/审批），其次是还在跑/还没回的模型。
  const waitingOn = props.awaitingAnswer || task.status === 'awaiting_clarification'
    ? '你在补充信息'
    : props.pendingStep
      ? `你确认第 ${String(props.pendingStep.index)}/${String(props.pendingStep.total)} 步（${props.pendingStep.tool}）`
      : props.pendingQuestion
        ? '你对执行中提问的答复'
        : inReview
          ? `成员评审方案（${String(reviewProgress?.topics ?? 0)} 个议题）${
              working.length > 0 ? ` · 正在写：${working.map(item => item.label).join('、')}` : ''
            }`
          : task.status === 'awaiting_approval'
            ? '你审批计划'
            : working.length > 0
              ? working.map(item => item.label).join('、')
              : null;

  /**
   * 「下一步」不能指路指空。
   *
   * 完成态原先一律写「查看最终交付」，但交付卡只在真有改动 / 验证 / 评审时才渲染；
   * 只新建了一个文件、没跑测试的任务就变成「让你去看一个不存在的东西」。
   */
  const nextStep = inReview
    ? '等待评审结束后确认计划'
    : task.status === 'completed' && !props.hasDelivery
      ? '查看输出页的执行记录'
      : NEXT_STEP[task.status];

  return (
    <section className={`card task-progress${active ? ' is-active' : ''}`}>
      <div className="card-head">
        <h2>{task.title}</h2>
        <span className={`pill s-${task.status}`}>{stageLabel}</span>
      </div>
      <div className="task-progress-grid">
        <div>
          <span className="task-progress-key">阶段</span>
          <b>{stageLabel}</b>
        </div>
        <div>
          <span className="task-progress-key">步骤</span>
          <b>
            {totalSteps === null ? `已执行 ${String(doneSteps)} 步` : `${String(doneSteps)} / ${String(totalSteps)} 步`}
          </b>
        </div>
        <div>
          <span className="task-progress-key">持续</span>
          <b>{durationText(Math.max(0, endAt - task.createdAt))}</b>
        </div>
        <div>
          <span className="task-progress-key">下一步</span>
          <b>{nextStep}</b>
        </div>
      </div>
      <p className="task-progress-line">
        <span className="task-progress-key">最近活动</span>
        {lastEvent
          ? `${new Date(lastEvent.at).toLocaleTimeString()} · ${EVENT_LABEL[lastEvent.type] ?? lastEvent.type}`
          : '任务刚创建，还没有事件'}
      </p>
      {waitingOn && (
        <p className="task-progress-line is-waiting">
          <span className="task-progress-key">正在等待</span>
          {waitingOn}
          {active
            ? ` · 已等 ${durationText(Math.max(0, now - (inReview && reviewProgress ? reviewProgress.at : task.createdAt)))}`
            : ''}
        </p>
      )}
      {task.error && <p className="task-progress-error">失败原因：{task.error}</p>}
    </section>
  );
}
