import React, { useMemo, useState } from 'react';
import type { ObservabilityEvent } from '../../../../shared/observability';

/**
 * 任务轨迹（V2.1 §9.3）。
 *
 * 数据源是同一份 `ObservabilityEvent` 投影，和输出页用的是一个东西——这样
 * 「轨迹里看到这条」和「输出里点开这条」不会对不上。
 *
 * 两段：阶段时间线（谁在什么时候推进了任务），工具调用链（同一个 callId
 * 的 preparing / started / completed 三阶段聚成一条）。三阶段不聚合的话，
 * 一次工具调用会被读成三次。
 */

const TASK_PHASE_LABEL: Record<string, string> = {
  understanding: '理解',
  planning: '规划',
  approval: '审批',
  execution: '执行',
  verification: '验证',
  review: '评审',
  delivery: '交付',
  terminal: '结束'
};

const RUN_PHASE_LABEL: Record<string, string> = {
  preparing: '准备',
  started: '开始',
  streaming: '输出中',
  completed: '完成',
  failed: '失败',
  cancelled: '取消'
};

const CATEGORY_LABEL: Record<string, string> = {
  lifecycle: '生命周期',
  reasoning: '思考',
  assistant: '回答',
  planning: '计划',
  approval: '审批',
  tool: '工具',
  subagent: '成员',
  file: '文件',
  terminal: '终端',
  test: '测试',
  review: '评审',
  delivery: '交付',
  diagnostic: '诊断'
};

function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatMs(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未提供';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

interface ToolChain {
  callId: string;
  tool: string;
  actor: string;
  /** 发起这次调用的成员（来自事件 participantId）；没有就留空。 */
  owner: string | null;
  preparing?: ObservabilityEvent;
  started?: ObservabilityEvent;
  completed?: ObservabilityEvent;
  failed?: ObservabilityEvent;
}

function chainTools(items: readonly ObservabilityEvent[]): ToolChain[] {
  const map = new Map<string, ToolChain>();
  for (const item of items) {
    if (item.category !== 'tool') continue;
    const callId = item.callId ?? item.stepId ?? item.eventId;
    const chain: ToolChain = map.get(callId) ?? {
      callId,
      tool: String(item.payload.tool ?? item.actor.label),
      actor: item.actor.label,
      owner: typeof item.payload.participantId === 'string' ? item.payload.participantId : null
    };
    if (item.payload.type === 'step.preparing') chain.preparing = item;
    else if (item.payload.type === 'step.started') chain.started = item;
    else if (item.payload.type === 'step.completed') chain.completed = item;
    else if (item.payload.type === 'step.failed') chain.failed = item;
    map.set(callId, chain);
  }
  return [...map.values()];
}

export function TaskTrajectory(props: {
  activity: readonly ObservabilityEvent[];
  onLocate?: (eventId: string) => void;
}) {
  const [scope, setScope] = useState<'all' | 'notable'>('notable');
  const items = useMemo(() => {
    const sorted = [...props.activity].sort((a, b) => a.occurredAt - b.occurredAt);
    if (scope === 'all') return sorted;
    // 默认不列每条 delta：一次输出会有几百条，把它们铺开等于让时间线失效。
    // task.updated 是状态快照，同一个状态会重复出现多次，也不是「发生了什么」。
    return sorted.filter(item =>
      item.payload.type !== 'task.updated' &&
      (item.category !== 'reasoning' || item.phase === 'completed')
    );
  }, [props.activity, scope]);
  const chains = useMemo(() => chainTools(props.activity), [props.activity]);

  return (
    <section className="card task-trajectory">
      <div className="card-head">
        <h2>任务轨迹</h2>
        <div className="member-layout">
          <button
            type="button"
            className={`btn ghost${scope === 'notable' ? ' is-active' : ''}`}
            onClick={() => setScope('notable')}
          >
            关键节点
          </button>
          <button
            type="button"
            className={`btn ghost${scope === 'all' ? ' is-active' : ''}`}
            onClick={() => setScope('all')}
          >
            全部事件
          </button>
        </div>
      </div>

      {chains.length > 0 && (
        <div className="trace-chains">
          <h3>工具调用（{chains.length}）</h3>
          <div className="trace-chain-list">
            {chains.map(chain => {
              const end = chain.completed ?? chain.failed;
              const duration = end ? Number((end.payload as { durationMs?: number }).durationMs ?? NaN) : NaN;
              const status = chain.failed ? 'failed' : chain.completed ? 'completed' : 'running';
              return (
                <div key={chain.callId} className={`trace-chain is-${status}`}>
                  <div className="trace-chain-head">
                    <b>{chain.tool}</b>
                    <span className="muted">{chain.owner ? `发起：${chain.owner}` : '发起者未标注'}</span>
                    <span className={`member-pill is-${status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : 'streaming'}`}>
                      {status === 'failed' ? '失败' : status === 'completed' ? '完成' : '进行中'}
                    </span>
                    <span className="muted">{Number.isFinite(duration) ? formatMs(duration) : '未提供时长'}</span>
                  </div>
                  <div className="trace-chain-phases">
                    {/**
                     * 只印真实发生过的阶段。
                     *
                     * 四格常驻看着整齐，但没失败的调用也会出现一个「失败」标签，
                     * 扫一眼像是失败了——轨迹页最不该出的就是假信号。
                     */}
                    {(['preparing', 'started', 'completed', 'failed'] as const).map(phase => {
                      const hit = chain[phase];
                      if (!hit) return null;
                      return (
                        <span key={phase} className="trace-phase is-hit">
                          {phase === 'preparing' ? '准备' : phase === 'started' ? '开始' : phase === 'completed' ? '完成' : '失败'}
                          {` ${formatTime(hit.occurredAt)}`}
                        </span>
                      );
                    })}
                    {!chain.preparing && !chain.started && !chain.completed && !chain.failed && (
                      <span className="trace-phase">没有阶段时间，只有结果</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="trace-timeline">
        <h3>阶段时间线（{items.length}）</h3>
        {items.length === 0 ? (
          <p className="muted">还没有可展示的事件。</p>
        ) : (
          <ol>
            {items.map(item => (
              <li key={item.eventId} className={`trace-item is-${item.phase}`}>
                <span className="trace-time">{formatTime(item.occurredAt)}</span>
                <span className="trace-phase-pill">
                  {TASK_PHASE_LABEL[String(item.payload.phase ?? '')] ?? RUN_PHASE_LABEL[item.phase] ?? item.phase}
                </span>
                <span className="trace-category">{CATEGORY_LABEL[item.category] ?? item.category}</span>
                <span className="trace-actor">{item.actor.label}</span>
                <span className="trace-type">{item.payload.type as string}</span>
                {props.onLocate && (
                  <button className="btn ghost" type="button" onClick={() => props.onLocate?.(item.eventId)}>
                    定位
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
