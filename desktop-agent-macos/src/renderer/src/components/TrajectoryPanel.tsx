import React, { useEffect, useMemo, useState } from 'react';
import type { ConversationEvent } from '../../../shared/conversation';
import {
  foldTrace,
  type TraceEntry,
  type TraceGroup,
  type TraceStatus,
  type TraceStep,
  type TraceTurn
} from '../../../shared/trace';
import { MarkdownBody } from './MarkdownBody';
import { TraceTimeline, type TraceRange } from './TraceTimeline';

const GROUP_LABEL: Record<TraceGroup, string> = {
  prepare: '提问前',
  first: '第一轮 · 各家回答',
  lead: '第二轮 · 主导人汇总',
  debate: '辩论',
  followup: '追加研究',
  synthesis: '综合',
  execute: '执行'
};

const GROUP_ORDER: TraceGroup[] = ['prepare', 'first', 'lead', 'debate', 'followup', 'synthesis', 'execute'];

const STAGE_LABEL: Record<string, string> = {
  route: '路由',
  prepare: '准备',
  extract: '抓网页',
  answer: '回答',
  lead: '汇总',
  debate: '辩论',
  followup: '追加',
  tool: '工具',
  synthesis: '综合',
  execute: '执行'
};

const STATUS_LABEL: Record<TraceStatus, string> = {
  running: '运行中',
  ok: '已回答',
  failed: '失败',
  busy: '忙',
  skipped: '跳过',
  cancelled: '已取消',
  interrupted: '中断'
};

function formatMs(value: number | null): string {
  if (value === null) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function formatTime(value: number | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  const pad = (input: number, size = 2) => String(input).padStart(size, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function Unknown({ title }: { title: string }) {
  return <span className="trace-unknown" title={title}>—</span>;
}

function mergeEntries(previous: TraceEntry[], incoming: TraceEntry[]): TraceEntry[] {
  const bySeq = new Map(previous.map(entry => [entry.seq, entry]));
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function matches(step: TraceStep, query: string, status: TraceStatus | 'all'): boolean {
  if (status !== 'all' && step.status !== status) return false;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    step.actorLabel,
    step.actorId,
    step.reason,
    step.inputPreview,
    step.outputPreview,
    step.error?.detail,
    step.stage
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle);
}

export function TrajectoryPanel(props: { conversationId: string }) {
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [source, setSource] = useState<'trace' | 'messages'>('trace');
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<TraceStatus | 'all'>('all');
  const [turnFilter, setTurnFilter] = useState<number | 'all'>('all');
  const [showEvents, setShowEvents] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** 手动重读：事件订阅只补新行，错过一条时总得有个重来的入口。 */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setEntries([]);
    setSelected(null);
    setHasMore(false);
    void window.agentAPI
      .getTrace({ conversationId: props.conversationId })
      .then(result => {
        if (!alive) return;
        setEntries(result.entries);
        setSource(result.source);
        setHasMore(result.hasMore);
      })
      .catch(cause => {
        if (!alive) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [props.conversationId, reloadKey]);

  useEffect(() => window.agentAPI.onConversationEvent((event: ConversationEvent) => {
    if (event.type !== 'trace.appended' || event.conversationId !== props.conversationId) return;
    setEntries(previous => mergeEntries(previous, event.entries));
  }), [props.conversationId]);

  const turns = useMemo(() => foldTrace(entries), [entries]);
  const visibleTurns = useMemo(
    () => turns.filter(turn => turnFilter === 'all' || turn.turn === turnFilter),
    [turns, turnFilter]
  );
  const selectedStep = useMemo(() => {
    if (!selected) return null;
    for (const turn of turns) {
      const found = [...turn.steps, ...turn.events].find(step => step.key === selected);
      if (found) return found;
    }
    return null;
  }, [selected, turns]);

  async function loadOlder() {
    const oldest = entries[0]?.seq;
    if (oldest === undefined || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const result = await window.agentAPI.getTrace({
        conversationId: props.conversationId,
        beforeSeq: oldest,
        limit: 500
      });
      setEntries(previous => mergeEntries(result.entries, previous));
      setHasMore(result.hasMore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingOlder(false);
    }
  }

  if (loading) {
    return <section className="trace-panel"><p className="muted">正在读取轨迹…</p></section>;
  }
  if (error) {
    return <section className="trace-panel"><p className="trace-error">{error}</p></section>;
  }
  if (entries.length === 0) {
    return (
      <section className="trace-panel">
        <p className="muted">这条会话还没有轨迹。发一个问题，回答、失败原因和每步用时会出现在这里。</p>
      </section>
    );
  }

  return (
    <section className="trace-panel" aria-label="轨迹">
      {source === 'messages' && (
        <p className="trace-banner">
          这条会话没有轨迹文件，下面是按消息时间重建的旧记录；只有发送时间，没有 token、首 token 和失败原因。
        </p>
      )}

      <header className="trace-toolbar">
        <div className="trace-filters">
          <select
            value={turnFilter}
            aria-label="选择轮次"
            onChange={event => setTurnFilter(event.target.value === 'all' ? 'all' : Number(event.target.value))}
          >
            <option value="all">全部轮次</option>
            {turns.map(turn => (
              <option key={turn.turn} value={turn.turn}>第 {turn.turn} 轮</option>
            ))}
          </select>
          <select
            value={status}
            aria-label="按状态筛选"
            onChange={event => setStatus(event.target.value as TraceStatus | 'all')}
          >
            <option value="all">全部状态</option>
            {(['ok', 'failed', 'busy', 'skipped', 'running', 'cancelled', 'interrupted'] as TraceStatus[]).map(item => (
              <option key={item} value={item}>{STATUS_LABEL[item]}</option>
            ))}
          </select>
          <input
            type="search"
            value={query}
            placeholder="搜索参与者、原因、输入输出…"
            aria-label="搜索轨迹"
            onChange={event => setQuery(event.target.value)}
          />
        </div>
        <div className="trace-filters">
          <label className="trace-toggle">
            <input type="checkbox" checked={showEvents} onChange={event => setShowEvents(event.target.checked)} />
            显示事件行
          </label>
          <button
            className="btn ghost"
            type="button"
            disabled={loading}
            onClick={() => setReloadKey(key => key + 1)}
            title="重新从轨迹文件读取；不改变任何记录"
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </header>

      {visibleTurns.length === 0 && <p className="muted">没有匹配的记录。</p>}

      {visibleTurns.map(turn => (
        <TurnSection
          key={turn.turn}
          turn={turn}
          query={query}
          status={status}
          showEvents={showEvents}
          selected={selected}
          onSelect={key => setSelected(current => current === key ? null : key)}
        />
      ))}

      {hasMore && (
        <button type="button" className="btn secondary trace-more" onClick={() => void loadOlder()} disabled={loadingOlder}>
          {loadingOlder ? '加载中…' : '加载更早的轨迹'}
        </button>
      )}

      {selectedStep && (
        <Inspector
          step={selectedStep}
          onClose={() => setSelected(null)}
          onJump={messageId => {
            document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)?.scrollIntoView({ block: 'center' });
          }}
        />
      )}
    </section>
  );
}

function TurnSection(props: {
  turn: TraceTurn;
  query: string;
  status: TraceStatus | 'all';
  showEvents: boolean;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const { turn } = props;
  const [range, setRange] = useState<TraceRange | null>(null);
  const inRange = (step: TraceStep) => {
    if (!range) return true;
    if (step.startedAt === null) return false;
    const end = step.endedAt ?? (step.status === 'running' ? Date.now() : step.startedAt);
    return step.startedAt <= range.end && end >= range.start;
  };
  const groups = GROUP_ORDER
    .map(group => ({
      group,
      steps: turn.steps.filter(step => step.group === group && inRange(step) && matches(step, props.query, props.status)),
      events: props.showEvents
        ? turn.events.filter(step => step.group === group && matches(step, props.query, props.status))
        : []
    }))
    .filter(item => item.steps.length > 0 || item.events.length > 0);

  return (
    <section className="trace-turn">
      <header className="trace-turn-head">
        <b>第 {turn.turn} 轮</b>
        <span className="trace-turn-trigger" title={turn.trigger ?? ''}>{turn.trigger ?? '—'}</span>
        <span className={`trace-status s-${turn.status}`}>{STATUS_LABEL[turn.status]}</span>
        <span className="trace-turn-time">
          总 {formatMs(turn.wallMs)} · 第一轮 {formatMs(turn.first.wallMs)} · 汇总 {formatMs(turn.leadMs)}
        </span>
      </header>
      <TraceTimeline
        turn={turn}
        selected={props.selected}
        range={range}
        onSelect={props.onSelect}
        onRange={setRange}
      />
      {groups.length === 0 && <p className="muted trace-empty">这一轮没有可显示的步骤。</p>}
      {groups.map(item => (
        <div key={item.group} className="trace-group">
          <div className="trace-group-label">
            {GROUP_LABEL[item.group]}
            {item.group === 'first' && (
              <span className="trace-group-count">
                回答 {turn.first.answered} / 失败 {turn.first.failed} / 跳过 {turn.first.skipped}
              </span>
            )}
          </div>
          <table className="trace-table">
            <thead>
              <tr>
                <th>#</th>
                <th>阶段</th>
                <th>参与者</th>
                <th>状态</th>
                <th>思考</th>
                <th>输入</th>
                <th>输出</th>
                <th>用时</th>
                <th>tokens</th>
                <th>开始</th>
              </tr>
            </thead>
            <tbody>
              {[...item.steps, ...item.events]
                .sort((left, right) => left.step - right.step)
                .map(step => (
                  <TraceRow
                    key={step.key}
                    step={step}
                    selected={props.selected === step.key}
                    onSelect={() => props.onSelect(step.key)}
                  />
                ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function TraceRow(props: { step: TraceStep; selected: boolean; onSelect: () => void }) {
  const { step } = props;
  const [showReasoning, setShowReasoning] = React.useState(false);
  return (
    <>
    <tr
      className={`trace-row${props.selected ? ' is-selected' : ''}`}
      onClick={props.onSelect}
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          props.onSelect();
        }
      }}
    >
      <td className="trace-step-no">{step.turn}.{step.step}</td>
      <td>{STAGE_LABEL[step.stage] ?? step.stage}{step.kind === 'event' ? ' · 事件' : ''}</td>
      <td>
        <span className="trace-actor">{step.actorLabel}</span>
        <span className={`trace-source s-${step.sourceType}`}>{step.sourceType}</span>
      </td>
      <td><span className={`trace-status s-${step.status}`}>{STATUS_LABEL[step.status]}</span></td>
      <td>
        {step.reasoning
          ? (
            <button
              type="button"
              className="btn ghost trace-reasoning-toggle"
              onClick={event => {
                event.stopPropagation();
                setShowReasoning(value => !value);
              }}
            >
              {showReasoning ? '收起' : `查看（${step.reasoning.length} 字）`}
            </button>
          )
          : '—'}
      </td>
      <td className="trace-preview" title={step.inputPreview ?? ''}>{step.inputPreview ?? '—'}</td>
      <td className="trace-preview" title={step.outputPreview ?? ''}>{step.outputPreview ?? step.error?.detail ?? '—'}</td>
      <td>{formatMs(step.durationMs)}</td>
      <td>
        {step.contextTokens === null && step.outputTokens === null
          ? <Unknown title="这一通道没有上报 token" />
          : `${step.contextTokens ?? '—'} / ${step.outputTokens ?? '—'}`}
      </td>
      <td className="trace-time">{formatTime(step.startedAt)}</td>
    </tr>
    {showReasoning && step.reasoning && (
      <tr className="trace-reasoning-row">
        <td colSpan={10}>
          <pre>{step.reasoning}</pre>
        </td>
      </tr>
    )}
    </>
  );
}

function Inspector(props: { step: TraceStep; onClose: () => void; onJump: (messageId: string) => void }) {
  const { step } = props;
  return (
    <aside className="trace-inspector" aria-label="轨迹详情">
      <header>
        <b>第 {step.turn}.{step.step} 步 · {STAGE_LABEL[step.stage] ?? step.stage}</b>
        <span className={`trace-status s-${step.status}`}>{STATUS_LABEL[step.status]}</span>
        <span className="settings-spacer" />
        <button type="button" className="btn ghost" onClick={props.onClose}>关闭</button>
      </header>
      <dl className="trace-facts">
        <dt>参与者</dt><dd>{step.actorLabel}（{step.sourceType}{step.modelId ? ` · ${step.modelId}` : ''}）</dd>
        <dt>起止</dt><dd>{formatTime(step.startedAt)} → {formatTime(step.endedAt)}（{formatMs(step.durationMs)}）</dd>
        <dt>首 token</dt><dd>{formatMs(step.ttftMs)}</dd>
        <dt>上下文 / 输出</dt>
        <dd>
          {step.contextTokens === null ? <Unknown title="未上报" /> : step.contextTokens}
          {' / '}
          {step.outputTokens === null ? <Unknown title="未上报" /> : step.outputTokens}
        </dd>
        <dt>缓存命中</dt>
        <dd>{step.cacheHit === null ? <Unknown title="未上报" /> : `${Math.round(step.cacheHit * 100)}%`}</dd>
        {step.usage?.cost && (
          <><dt>费用</dt><dd>{step.usage.cost.amount.toFixed(4)} {step.usage.cost.currency}</dd></>
        )}
        {step.reason && <><dt>原因</dt><dd>{step.reason}</dd></>}
        {step.error && <><dt>错误</dt><dd className="trace-error">{step.error.code} · {step.error.detail}</dd></>}
      </dl>
      {step.inputPreview && (
        <section className="trace-detail">
          <h4>输入</h4>
          <pre className="trace-pre">{step.inputPreview}</pre>
        </section>
      )}
      {step.outputPreview && (
        <section className="trace-detail">
          <h4>输出</h4>
          <MarkdownBody text={step.outputPreview} />
        </section>
      )}
      {step.refs.length > 0 && (
        <section className="trace-detail">
          <h4>引用</h4>
          <ul className="trace-refs">
            {step.refs.map((ref, index) => (
              <li key={`${ref.kind}:${ref.id}:${index}`}>
                <span className="trace-ref-kind">{ref.kind}</span>
                <code>{ref.id}{typeof ref.line === 'number' ? `:${ref.line}` : ''}</code>
                {ref.sha256 && <span className="muted"> · {ref.sha256.slice(0, 12)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {step.messageId && (
        <button type="button" className="btn secondary" onClick={() => props.onJump(step.messageId!)}>
          跳到这条回答
        </button>
      )}
    </aside>
  );
}
