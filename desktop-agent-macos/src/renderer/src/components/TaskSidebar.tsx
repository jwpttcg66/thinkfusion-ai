import React from 'react';
import type { AgentTask } from '../../../shared/contracts';
import type { Conversation } from '../../../shared/conversation';

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
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
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
        新对话
      </button>

      <div className="task-scroll">
        {/* Conversations first: they are the common case. Tasks are what a
            conversation turns into when the answer needs files changed, so they
            read as a subset rather than a separate product. */}
        {props.conversations.length > 0 && (
          <div className="conv-group">
            <div className="group-label">
              <span className="folder">◈</span>
              <span>对话</span>
            </div>
            {props.conversations.map(conversation => (
              <div
                key={conversation.conversationId}
                className={`task-item ${props.activeConversationId === conversation.conversationId ? 'active' : ''}`}
                onClick={() => props.onSelectConversation(conversation.conversationId)}
                title={conversation.title}
              >
                <span className={`task-dot s-${conversation.status}`} />
                <span className="task-title">{conversation.title}</span>
                <span className="task-time">{relTime(conversation.updatedAt)}</span>
                <button
                  className="task-delete"
                  title="删除这条对话记录"
                  onClick={event => {
                    event.stopPropagation();
                    props.onDeleteConversation(conversation.conversationId);
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}

        {groups.length === 0 && props.conversations.length === 0 && (
          <p className="empty">还没有内容。直接提问即可，需要改文件时才会走执行计划。</p>
        )}

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
