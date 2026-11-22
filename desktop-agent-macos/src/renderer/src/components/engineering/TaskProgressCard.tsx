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
}) {
  const { task, plan, events, members } = props;
  const [now, setNow] = useState(Date.now());
  const active = !['completed', 'failed', 'cancelled'].includes(task.status);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const doneSteps = new Set(
    events.filter(event => event.type === 'step.completed').map(event => (event as { stepId: string }).stepId)
  ).size;
  const totalSteps = plan?.steps.length ?? null;
  const working = members.filter(item => item.status === 'preparing' || item.status === 'streaming');
  const lastEvent = [...events].sort((a, b) => a.at - b.at).at(-1) ?? null;

  // 「在等谁」：阻塞态优先（用户/审批），其次是还在跑/还没回的模型。
  const waitingOn = props.awaitingAnswer || task.status === 'awaiting_clarification'
    ? '你在补充信息'
    : props.pendingStep
      ? `你确认第 ${String(props.pendingStep.index)}/${String(props.pendingStep.total)} 步（${props.pendingStep.tool}）`
      : props.pendingQuestion
        ? '你对执行中提问的答复'
        : task.status === 'awaiting_approval'
          ? '你审批计划'
          : working.length > 0
            ? working.map(item => item.label).join('、')
            : null;

  return (
    <section className={`card task-progress${active ? ' is-active' : ''}`}>
      <div className="card-head">
        <h2>{task.title}</h2>
        <span className={`pill s-${task.status}`}>{STAGE_LABEL[task.status]}</span>
      </div>
      <div className="task-progress-grid">
        <div>
          <span className="task-progress-key">阶段</span>
          <b>{STAGE_LABEL[task.status]}</b>
        </div>
        <div>
          <span className="task-progress-key">步骤</span>
          <b>
            {totalSteps === null ? `已执行 ${String(doneSteps)} 步（计划未生成）` : `${String(doneSteps)} / ${String(totalSteps)} 步`}
          </b>
        </div>
        <div>
          <span className="task-progress-key">持续</span>
          <b>{durationText(Math.max(0, now - task.createdAt))}</b>
        </div>
        <div>
          <span className="task-progress-key">下一步</span>
          <b>{NEXT_STEP[task.status]}</b>
        </div>
      </div>
      <p className="task-progress-line">
        <span className="task-progress-key">最近活动</span>
        {lastEvent
          ? `${new Date(lastEvent.at).toLocaleTimeString()} · ${lastEvent.type}`
          : '任务刚创建，还没有事件'}
      </p>
      {waitingOn && (
        <p className="task-progress-line is-waiting">
          <span className="task-progress-key">正在等待</span>
          {waitingOn}
          {active ? ` · 已等 ${durationText(Math.max(0, now - task.createdAt))}` : ''}
        </p>
      )}
      {task.error && <p className="task-progress-error">失败原因：{task.error}</p>}
    </section>
  );
}
