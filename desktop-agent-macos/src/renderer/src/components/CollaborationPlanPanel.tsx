import React, { useEffect, useState } from 'react';
import type { CollaborationPlanView, CollaborationTaskView } from '../../../shared/contracts';

const STATUS_LABEL: Record<CollaborationTaskView['status'], string> = {
  pending: '等待',
  assigned: '已分配',
  running: '进行中',
  retrying: '重试中',
  done: '完成',
  failed: '失败',
  blocked: '受阻',
  skipped: '跳过',
  cancelled: '已取消'
};

const BEHAVIOR_LABEL: Record<NonNullable<CollaborationPlanView['behavior']>, string> = {
  independent: '单人分析',
  parallel: '多路并行',
  progressive: '分步推进',
  crosscheck: '交叉复核'
};

/** B-01：协作计划/任务视图。只读 main 进程的真实状态。 */
export function CollaborationPlanPanel(props: { conversationId: string }) {
  const [view, setView] = useState<CollaborationPlanView | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await window.agentAPI.getCollaborationPlanView(props.conversationId);
        if (!cancelled) setView(next);
      } catch {
        if (!cancelled) setView(null);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (view?.stopReason) return;
      void load();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [props.conversationId, view?.stopReason]);

  if (!view) return null;
  return (
    <section className="collab-plan" aria-label="协作计划">
      <header className="collab-plan-head">
        <span className="collab-plan-title">协作计划</span>
        {view.behavior && <span className="collab-plan-behavior">{BEHAVIOR_LABEL[view.behavior]}</span>}
        {view.stopReason && <span className="collab-plan-stop">已结束：{view.stopReason}</span>}
      </header>
      {view.behaviorReason && <p className="collab-plan-reason">{view.behaviorReason}</p>}
      <ol className="collab-plan-tasks">
        {view.tasks.map(task => (
          <li key={task.taskId} className={`collab-task is-${task.status}`}>
            <span className="collab-task-kind">{task.kind}</span>
            <span className="collab-task-status">{STATUS_LABEL[task.status]}</span>
            {task.participantId && <span className="collab-task-who">{task.participantId}</span>}
            {task.attempts > 0 && <span className="collab-task-attempts">{task.attempts} 次</span>}
            {task.reason && <span className="collab-task-reason">{task.reason}</span>}
          </li>
        ))}
      </ol>
      <details className="collab-plan-people">
        <summary>参与者 {view.participants.length} 人</summary>
        <ul>
          {view.participants.map(item => (
            <li key={item.participantId}>
              <strong>{item.participantId}</strong> — {item.reason}
            </li>
          ))}
          {view.skipped.map(item => (
            <li key={`skip-${item.participantId}`} className="is-skipped">
              <strong>{item.participantId}</strong> — 跳过：{item.reason}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
