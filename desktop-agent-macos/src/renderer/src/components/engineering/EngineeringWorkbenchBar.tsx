import React from 'react';
import type { AgentTask } from '../../../../shared/contracts';

/**
 * 工程工作台的四页骨架（V2.1 §16.6）。
 *
 * 为什么页签放在任务页而不复用会话页那三个：会话页的「对话/轨迹/统计」讲的是
 * 一次问答的三面，工程任务还多一面——每个模型各自的输出。四个页签对应四类
 * 问题：现在怎么样（对话）、原始细节是什么（输出）、按什么顺序发生（轨迹）、
 * 花了多少（统计）。切页只切渲染，不重开订阅、不重启执行。
 */

export type WorkbenchTab = 'conversation' | 'output' | 'trajectory' | 'stats';

export const WORKBENCH_TABS: ReadonlyArray<{ id: WorkbenchTab; label: string; hint: string }> = [
  { id: 'conversation', label: '对话', hint: '主任务进度与每个模型的输出' },
  { id: 'output', label: '输出', hint: '完整事件、参数、结果与改动' },
  { id: 'trajectory', label: '轨迹', hint: '阶段与调用的先后关系' },
  { id: 'stats', label: '统计', hint: '模型、工具与耗时' }
];

const STATUS_LABEL: Record<AgentTask['status'], string> = {
  created: '已创建',
  planning: '规划中',
  awaiting_clarification: '等待补充',
  plan_ready: '计划已生成',
  awaiting_approval: '等待审批',
  executing: '执行中',
  verifying: '验证中',
  report_pending: '待确认',
  awaiting_next_round: '可追问',
  paused: '已暂停',
  interrupted: '已中断',
  budget_exhausted: '预算用尽',
  blocked: '受阻',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

const ACTIVE = new Set<AgentTask['status']>(['planning', 'awaiting_clarification', 'awaiting_approval', 'executing', 'verifying', 'report_pending']);
/** 半小时没有更新的「运行中」任务不再算同时在跑：那是上次异常退出留下的。 */
const FRESH_MS = 30 * 60 * 1000;
const TERMINAL = new Set<AgentTask['status']>(['completed', 'failed', 'cancelled']);

export function EngineeringWorkbenchBar(props: {
  task: AgentTask;
  tab: WorkbenchTab;
  onTab: (tab: WorkbenchTab) => void;
  activeTasks: readonly AgentTask[];
  onSelectTask: (taskId: string) => void;
  onExport: () => void;
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const now = Date.now();
  const parallel = props.activeTasks.filter(item =>
    item.taskId !== props.task.taskId && ACTIVE.has(item.status) && now - item.updatedAt < FRESH_MS
  );
  return (
    <div className="wb-bar">
      <div className="wb-bar-task">
        <span className="wb-bar-title" title={props.task.title}>{props.task.title}</span>
        <span className={`pill s-${props.task.status}`}>{STATUS_LABEL[props.task.status]}</span>
        {props.task.workspaceRoot && (
          <span className="muted wb-bar-root" title={props.task.workspaceRoot}>
            {props.task.workspaceRoot}
          </span>
        )}
        <button className="btn ghost" type="button" onClick={props.onExport}>导出诊断</button>
        {/* 取消是整任务的动作，放任务头；审批按钮只在各自卡片上出现一次，
            不再另起一条悬浮栏，避免同一个「确认并执行」出现两遍。 */}
        {['paused', 'interrupted', 'budget_exhausted', 'blocked'].includes(props.task.status) && (
          <button className="btn" type="button" onClick={props.onResume}>继续任务</button>
        )}
        {!TERMINAL.has(props.task.status) && props.task.status !== 'paused' && (
          <button className="btn ghost" type="button" onClick={props.onPause}>暂停</button>
        )}
        {!TERMINAL.has(props.task.status) && (
          <button className="btn ghost" type="button" onClick={props.onCancel}>取消任务</button>
        )}
      </div>
      {parallel.length > 0 && (
        <div className="wb-bar-parallel">
          <span className="muted">同时在跑</span>
          {parallel.map(item => (
            <button key={item.taskId} className="btn ghost" type="button" onClick={() => props.onSelectTask(item.taskId)}>
              <span className={`dot s-${item.status}`} />
              {item.title}
            </button>
          ))}
        </div>
      )}
      <nav className="wb-tabs" role="tablist" aria-label="工程工作台">
        {WORKBENCH_TABS.map(item => (
          <button
            key={item.id}
            role="tab"
            type="button"
            aria-selected={props.tab === item.id}
            className={props.tab === item.id ? 'is-active' : undefined}
            title={item.hint}
            onClick={() => props.onTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
