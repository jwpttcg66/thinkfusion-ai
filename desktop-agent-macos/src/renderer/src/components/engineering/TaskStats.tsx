import React, { useMemo, useState } from 'react';
import type { AgentEvent, AgentTask } from '../../../../shared/contracts';
import type { ObservabilityEvent } from '../../../../shared/observability';
import { TASK_MEMBER_STATUS_LABEL, type TaskMemberStream } from '../../../../shared/task-stream';
import { BUDGET_DIMENSION_TEXT, budgetStateOf, normalizeTaskBudget } from '../../../../shared/task-budget';
import { autoContinueOf } from '../../../../shared/task-continue';

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
  pause_requested: '暂停请求中',
  pausing: '停止工具中',
  cancel_requested: '取消请求中',
  cancelling: '取消中',
  paused: '已暂停',
  interrupted: '已中断',
  budget_exhausted: '预算用尽',
  blocked: '受阻',
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
  events?: readonly AgentEvent[];
}) {
  const { task, members, activity } = props;
  const contextEvents = (props.events ?? []).filter(
    (event): event is Extract<AgentEvent, { type: 'context.event' }> => event.type === 'context.event'
  );
  const latestContext = contextEvents.at(-1) ?? null;
  const committed = contextEvents.filter(event => event.event === 'context.compaction.committed').length;
  const warnings = contextEvents.filter(event => event.event === 'context.budget.warning').length;
  const recoveries = contextEvents.filter(event => event.event === 'context.recovered').length;

  const rounds = activity.filter(item => item.payload.type === 'round.started').length;
  /**
   * 计划修正轮单独列出来（M3-4d）：修正轮一样占预算轮数（M3-3 只有一个记账点，
   * 不在这里开例外），但它没做任何工作——不写清就会把「烧掉两轮」读成「做了两轮」。
   */
  const repairRounds = activity.filter(item => {
    const payload = item.payload as { type?: string; inputType?: string };
    return payload.type === 'round.started' && payload.inputType === 'plan_repair';
  }).length;
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

  /**
   * 预算（M3-3）：读主进程判定当时用的那份数，界面不再自己比轮数。
   * 这里再算一遍就是第五处记账——超限提示会和判定结论对不上。
   */
  const budgetEvents = props.events ?? [];
  const lastBudget = [...budgetEvents].reverse()
    .filter((event): event is Extract<AgentEvent, { type: 'cycle.decision.created' }> => event.type === 'cycle.decision.created')
    .at(-1)?.budget ?? null;
  const exhaustedAt = [...budgetEvents].reverse()
    .filter((event): event is Extract<AgentEvent, { type: 'task.budget.exhausted' }> => event.type === 'task.budget.exhausted')
    .at(-1) ?? null;
  const budget = task.budget ?? normalizeTaskBudget({ maxRounds: task.maxRounds });
  const budgetState = budgetStateOf({
    budget,
    // 模型调用没有任务级账本、成员 token 只覆盖辩论模型（不等于整轮消耗），
    // 所以两条都如实传 null：显示「未记账」，不拿 0 装作还有余量。
    usage: { rounds: rounds > 0 ? rounds : (lastBudget?.roundUsed ?? 0), modelCalls: null, tokens: null }
  });
  const limitText = (used: number | null, limit: number | null) =>
    limit === null ? '未设限' : used === null ? '未记账' : `${String(used)}/${String(limit)}`;
  const [extraRounds, setExtraRounds] = useState('');
  const [budgetMsg, setBudgetMsg] = useState('');
  const [budgetBusy, setBudgetBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoMsg, setAutoMsg] = useState('');
  const autoOn = autoContinueOf(task);
  const toggleAutoContinue = async (next: boolean) => {
    setAutoBusy(true);
    try {
      const result = await window.agentAPI.setTaskAutoContinue({ taskId: task.taskId, autoContinue: next });
      setAutoMsg(
        result.autoContinue
          ? `已打开：下一轮判定要开就自动开（改之前${result.previous ? '本来就是开的' : '是关着的'}）`
          : `已关闭：判定要开下一轮时会停在「等待你继续」（改之前${result.previous ? '是开的' : '本来就是关的'}）`
      );
    } catch (err) {
      setAutoMsg(`设置失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAutoBusy(false);
    }
  };
  const addRounds = async () => {
    const add = Number.parseInt(extraRounds, 10);
    if (!Number.isInteger(add) || add <= 0) {
      setBudgetMsg('要追加的轮数得是正整数');
      return;
    }
    setBudgetBusy(true);
    try {
      const result = await window.agentAPI.setTaskBudget({
        taskId: task.taskId,
        maxRounds: (budget.maxRounds ?? budgetState.limits.maxRounds) + add
      });
      setBudgetMsg(
        result.gate.ok
          ? `轮数上限已调到 ${String(result.budget.maxRounds)}：${result.gate.reason}；任务状态 ${STATUS_LABEL[result.status]}`
          : `已写入但仍不放行：${result.gate.reason}`
      );
      setExtraRounds('');
    } catch (err) {
      setBudgetMsg(`追加失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBudgetBusy(false);
    }
  };

  return (
    <div className="task-stats">
      <section className="card">
        <div className="card-head">
          <h2>任务</h2>
          <span className={`pill s-${task.status}`}>{STATUS_LABEL[task.status]}</span>
        </div>
        <div className="stats-grid">
          <div><span className="task-progress-key">目标</span><b>{task.title}</b></div>
          <div>
            <span className="task-progress-key">轮次</span>
            <b>{rounds} 轮{repairRounds > 0 ? `（含 ${repairRounds} 次计划修正）` : ''}</b>
          </div>
          <div><span className="task-progress-key">事件</span><b>{activity.length} 条</b></div>
          <div><span className="task-progress-key">总耗时</span><b>{formatDuration((endedAt ?? Date.now()) - task.createdAt)}</b></div>
          {/* 无人值守续轮（M3-4c）：关掉的只是「判定说该开下一轮时自动开」，预算超限、
              空转、待审批这些停法与它无关——开关不能变成「跳过闸门」。 */}
          <div>
            <span className="task-progress-key">无人值守</span>
            <label>
              <input
                type="checkbox"
                checked={autoOn}
                disabled={autoBusy}
                onChange={event => void toggleAutoContinue(event.target.checked)}
              />
              {autoOn ? '判定要开下一轮时自动开' : '停在轮次开始前，等你点「继续下一轮」'}
            </label>
          </div>
          {autoMsg && <div><span className="task-progress-key">结果</span><b>{autoMsg}</b></div>}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>预算</h2>
          <span className="muted">
            {budgetState.exceeded.length > 0
              ? `已用尽：${budgetState.exceeded.map(dim => BUDGET_DIMENSION_TEXT[dim]).join('、')}`
              : '仍可开新一轮'}
          </span>
        </div>
        <div className="stats-grid">
          <div><span className="task-progress-key">轮数</span><b>{limitText(budgetState.usage.rounds, budgetState.limits.maxRounds)}</b></div>
          <div><span className="task-progress-key">模型调用</span><b>{limitText(budgetState.usage.modelCalls, budgetState.limits.maxModelCalls)}</b></div>
          <div><span className="task-progress-key">Token</span><b>{limitText(budgetState.usage.tokens, typeof budgetState.limits.maxTokens === 'number' ? budgetState.limits.maxTokens : null)}</b></div>
          <div><span className="task-progress-key">判定用的数</span><b>{lastBudget?.note ?? '本轮还没有判定'}</b></div>
        </div>
        {(budget.dirty?.length ?? 0) > 0 && (
          <p className="muted">预算里写错的字段已回落默认：{budget.dirty!.join('、')}。</p>
        )}
        {exhaustedAt && (
          <div className="stats-grid">
            <div>
              <span className="task-progress-key">追加轮数</span>
              <input
                type="number"
                min={1}
                value={extraRounds}
                disabled={budgetBusy}
                onChange={e => setExtraRounds(e.target.value)}
              />
              <button type="button" disabled={budgetBusy} onClick={() => void addRounds()}>
                {budgetBusy ? '提交中…' : '追加并继续'}
              </button>
            </div>
            {budgetMsg && <div><span className="task-progress-key">结果</span><b>{budgetMsg}</b></div>}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>上下文</h2>
          <span className="muted">{latestContext ? latestContext.event : '未记录'}</span>
        </div>
        <div className="stats-grid">
          <div><span className="task-progress-key">估算输入</span><b>{typeof latestContext?.context.estimatedTokens === 'number' ? `${String(latestContext.context.estimatedTokens)} tokens` : '未提供'}</b></div>
          <div><span className="task-progress-key">窗口</span><b>{typeof latestContext?.context.contextWindow === 'number' ? String(latestContext.context.contextWindow) : '未提供'}</b></div>
          <div><span className="task-progress-key">使用率</span><b>{typeof latestContext?.context.usageRatio === 'number' ? `${String(Math.round(latestContext.context.usageRatio * 100))}%` : '未提供'}</b></div>
          <div><span className="task-progress-key">检查点</span><b>{committed > 0 ? `${String(committed)} 次提交` : '未提交'}</b></div>
          <div><span className="task-progress-key">预警 / 恢复</span><b>{warnings} / {recoveries}</b></div>
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
