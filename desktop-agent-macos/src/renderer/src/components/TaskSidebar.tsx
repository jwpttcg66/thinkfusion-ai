import React from 'react';
import type { AgentTask } from '../../../shared/contracts';

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  return `${Math.floor(days / 30)} 个月`;
}

function workspaceLabel(task: AgentTask): string {
  if (!task.workspaceRoot) return '未指定工作区';
  const parts = task.workspaceRoot.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? task.workspaceRoot;
}

export function TaskSidebar(props: {
  tasks: AgentTask[];
  activeId: string | null;
  onSelect: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  onNew: () => void;
}) {
  const groups = React.useMemo(() => {
    const map = new Map<string, AgentTask[]>();
    for (const task of props.tasks) {
      const key = workspaceLabel(task);
      const list = map.get(key) ?? [];
      list.push(task);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [props.tasks]);

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <span className="brand-mark">◈</span>
        <span className="brand-name">ThinkFusion</span>
        <span className="brand-tag">v0.6</span>
      </div>

      <button className="new-task" onClick={props.onNew}>
        <span>＋</span>
        新任务
      </button>

      <div className="task-scroll">
        {groups.length === 0 && <p className="empty">还没有任务。在右侧输入目标，Agent 会自动发送给 DeepSeek 规划。</p>}

        {groups.map(([workspace, tasks]) => (
          <div key={workspace}>
            <div className="group-label">
              <span className="folder">▤</span>
              <span>{workspace}</span>
            </div>
            {tasks.map(task => (
              <div
                key={task.taskId}
                className={`task-item ${props.activeId === task.taskId ? 'active' : ''}`}
                onClick={() => props.onSelect(task.taskId)}
                title={task.title}
              >
                <span className={`task-dot s-${task.status}`} />
                <span className="task-title">{task.title}</span>
                <span className="task-time">{relTime(task.updatedAt)}</span>
                <button
                  className="task-delete"
                  title="删除本地任务记录（不会删除工作区文件）"
                  onClick={event => {
                    event.stopPropagation();
                    props.onDelete(task.taskId);
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="side-foot">
        <span className="avatar" />
        <span className="side-foot-name">本地工作区</span>
        <span className="muted">···</span>
      </div>
    </aside>
  );
}
