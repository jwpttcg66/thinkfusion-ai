import React, { useMemo } from 'react';
import type { AgentTask } from '../../../../shared/contracts';
import type { ObservabilityEvent } from '../../../../shared/observability';
import { TASK_MEMBER_STATUS_LABEL, type TaskMemberStream } from '../../../../shared/task-stream';

/**
 * 任务统计（V2.1 §9.4）。
 *
 * 分层：任务 / 模型 / 工具 / 验证。每一层的数字都能追到事件——不在这里
 * 估算，也不把「没给的数据」补成 0。CLI 与网页不返回 token，那就写「未提供」；
 * 一个 0 会被读成「这个模型没花 token」，那是假话。
 */

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
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '未提供';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${String(minutes)} 分 ${String(seconds)} 秒`;
}

export function TaskStats(props: {
  task: AgentTask;
  members: readonly TaskMemberStream[];
  activity: readonly ObservabilityEvent[];
  verification: { checks?: { compile: { status: string }; tests: { status: string }; diagnostics: { status: string; errors: number; warnings: number } } } | null;
}) {
  const { task, members, activity } = props;

  const rounds = activity.filter(item => item.payload.type === 'round.started').length;
  const endedAt = activity
    .filter(item => ['task.completed', 'task.failed', 'task.cancelled'].includes(String(item.payload.type)))
    .map(item => item.occurredAt)
    .at(-1) ?? null;

  const tools = useMemo(() => {
    type Row = { tool: string; calls: number; failed: number; durationMs: number; timed: number };
    const map = new Map<string, Row>();
    for (const item of activity) {
      if (item.category !== 'tool') continue;
      const type = String(item.payload.type ?? '');
      if (type !== 'step.started' && type !== 'step.failed' && type !== 'step.completed') continue;
      // 以 callId（缺省 stepId）去重，别把三阶段数成三次调用。
      const key = item.callId ?? item.stepId ?? item.eventId;
      const row = map.get(key) ?? { tool: String(item.payload.tool ?? item.actor.label), calls: 0, failed: 0, durationMs: 0, timed: 0 };
      if (type === 'step.started') row.calls += 1;
      if (type === 'step.failed') row.failed += 1;
      if (type === 'step.completed') {
        const duration = Number((item.payload as { durationMs?: number }).durationMs ?? NaN);
        if (Number.isFinite(duration)) { row.durationMs += duration; row.timed += 1; }
      }
      map.set(key, row);
    }
    const grouped = new Map<string, Row>();
    for (const row of map.values()) {
      const hit = grouped.get(row.tool) ?? { tool: row.tool, calls: 0, failed: 0, durationMs: 0, timed: 0 };
      hit.calls += row.calls;
      hit.failed += row.failed;
      hit.durationMs += row.durationMs;
      hit.timed += row.timed;
      grouped.set(row.tool, hit);
    }
    return [...grouped.values()].sort((a, b) => b.calls - a.calls);
  }, [activity]);

  const totalChars = members.reduce((sum, item) => sum + item.text.length, 0);
  const tokens = members.reduce((sum, item) => {
    const value = item.usage?.totalTokens;
    return typeof value === 'number' ? sum + value : sum;
  }, 0);
  const tokenKnown = members.some(item => typeof item.usage?.totalTokens === 'number');

  return (
    <div className="task-stats">
      <section className="card">
        <div className="card-head">
          <h2>任务</h2>
          <span className={`pill s-${task.status}`}>{STATUS_LABEL[task.status]}</span>
        </div>
        <div className="stats-grid">
          <div><span className="task-progress-key">目标</span><b>{task.title}</b></div>
          <div><span className="task-progress-key">轮次</span><b>{rounds} 轮</b></div>
          <div><span className="task-progress-key">事件</span><b>{activity.length} 条</b></div>
          <div><span className="task-progress-key">总耗时</span><b>{formatDuration((endedAt ?? Date.now()) - task.createdAt)}</b></div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>按模型</h2>
          <span className="muted">{members.length} 个成员 · 合计 {totalChars} 字符 · {tokenKnown ? `${String(tokens)} tokens` : 'Token：未提供'}</span>
        </div>
        {members.length === 0 ? (
          <p className="muted">这一轮没有成员身份字段（旧事件），无法按模型分开统计。</p>
        ) : (
          <table className="stats-table">
            <thead>
              <tr><th>成员</th><th>状态</th><th>耗时</th><th>输出</th><th>Token</th></tr>
            </thead>
            <tbody>
              {members.map(member => (
                <tr key={member.memberId}>
                  <td title={member.memberId}>{member.label}</td>
                  <td>{TASK_MEMBER_STATUS_LABEL[member.status]}</td>
                  <td>{member.durationMs === null ? '未提供' : formatDuration(member.durationMs)}</td>
                  <td>{member.text.length} 字符</td>
                  <td>{member.tokenSupported ? (typeof member.usage?.totalTokens === 'number' ? `${String(member.usage.totalTokens)}` : '未提供') : '未提供'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>按工具</h2>
          <span className="muted">{tools.reduce((sum, row) => sum + row.calls, 0)} 次调用</span>
        </div>
        {tools.length === 0 ? (
          <p className="muted">还没有工具调用。</p>
        ) : (
          <table className="stats-table">
            <thead><tr><th>工具</th><th>调用</th><th>失败</th><th>累计耗时</th></tr></thead>
            <tbody>
              {tools.map(row => (
                <tr key={row.tool}>
                  <td>{row.tool}</td>
                  <td>{row.calls}</td>
                  <td>{row.failed}</td>
                  <td>{row.timed === 0 ? '未提供' : formatDuration(row.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h2>验证</h2></div>
        {!props.verification?.checks ? (
          <p className="muted">本次还没有执行报告，验证结果未提供。</p>
        ) : (
          <div className="stats-grid">
            <div><span className="task-progress-key">编译</span><b>{props.verification.checks.compile.status}</b></div>
            <div><span className="task-progress-key">测试</span><b>{props.verification.checks.tests.status}</b></div>
            <div>
              <span className="task-progress-key">诊断</span>
              <b>{props.verification.checks.diagnostics.status} · {props.verification.checks.diagnostics.errors} error / {props.verification.checks.diagnostics.warnings} warn</b>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
