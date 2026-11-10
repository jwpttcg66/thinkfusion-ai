import React, { useEffect, useMemo, useState } from 'react';
import type { Conversation, ConversationEvent } from '../../../shared/conversation';
import {
  aggregateTotals,
  foldTrace,
  type TraceEntry,
  type TraceGroup,
  type TraceStatus,
  type TraceStep,
  type TraceTotals,
  type TraceTurn
} from '../../../shared/trace';

const GROUP_LABEL: Record<TraceGroup, string> = {
  prepare: '提问前',
  first: '第一轮 · 各家回答',
  lead: '第二轮 · 主导人汇总',
  debate: '辩论',
  followup: '追加研究',
  synthesis: '综合',
  execute: '执行'
};

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
  ok: '完成',
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

function formatTokens(value: number | null): React.ReactNode {
  if (value === null) return <span className="trace-unknown" title="没有上报">—</span>;
  if (value >= 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

function formatPercent(value: number | null): React.ReactNode {
  if (value === null) return <span className="trace-unknown" title="没有上报">—</span>;
  return `${Math.round(value * 100)}%`;
}

function contextFor(turn: TraceTurn, mode: 'latest' | 'cumulative'): number | null {
  if (mode === 'latest') return turn.contextTokens;
  let sum = 0;
  let measured = false;
  for (const step of turn.steps) {
    if (step.contextTokens === null) continue;
    sum += step.contextTokens;
    measured = true;
  }
  return measured ? sum : null;
}

function mergeEntries(previous: TraceEntry[], incoming: TraceEntry[]): TraceEntry[] {
  const bySeq = new Map(previous.map(entry => [entry.seq, entry]));
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

interface ChannelRow {
  actorId: string;
  actorLabel: string;
  sourceType: string;
  asked: number;
  answered: number;
  failed: number;
  busy: number;
  skipped: number;
  durations: number[];
  chars: number[];
}

function channelRows(turns: readonly TraceTurn[]): ChannelRow[] {
  const rows = new Map<string, ChannelRow>();
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (step.group !== 'first' || step.stage !== 'answer') continue;
      const row = rows.get(step.actorId) ?? {
        actorId: step.actorId,
        actorLabel: step.actorLabel,
        sourceType: step.sourceType,
        asked: 0,
        answered: 0,
        failed: 0,
        busy: 0,
        skipped: 0,
        durations: [],
        chars: []
      };
      row.asked += 1;
      if (step.status === 'ok') row.answered += 1;
      if (step.status === 'failed') row.failed += 1;
      if (step.status === 'busy') row.busy += 1;
      if (step.status === 'skipped') row.skipped += 1;
      if (step.durationMs !== null) row.durations.push(step.durationMs);
      if (step.meta?.outputChars) row.chars.push(step.meta.outputChars);
      rows.set(step.actorId, row);
    }
  }
  return [...rows.values()].sort((left, right) => right.asked - left.asked);
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index] ?? null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function qualityOf(turns: readonly TraceTurn[]): {
  claims: number;
  disputes: number;
  unique: number;
  gaps: number;
  degraded: boolean;
  leadSummary: boolean;
  evidence: number;
  citations: number;
} {
  const synthesis = [...turns].reverse()
    .flatMap(turn => turn.steps)
    .find(step => step.stage === 'synthesis' && step.status === 'ok');
  const meta = synthesis?.meta;
  return {
    claims: meta?.claims ?? 0,
    disputes: meta?.disputes ?? 0,
    unique: meta?.unique ?? 0,
    gaps: meta?.gaps ?? 0,
    degraded: meta?.degraded === true,
    leadSummary: meta?.leadSummary === true,
    evidence: meta?.evidence ?? 0,
    citations: meta?.citations ?? 0
  };
}

export function StatsPanel(props: { conversationId: string; conversation: Conversation }) {
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [source, setSource] = useState<'trace' | 'messages'>('trace');
  const [hasMore, setHasMore] = useState(false);
  const [fullTotals, setFullTotals] = useState<TraceTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showEvents, setShowEvents] = useState(false);
  const [contextMode, setContextMode] = useState<'latest' | 'cumulative'>('latest');
  const [open, setOpen] = useState<Set<number>>(new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setEntries([]);
    setFullTotals(null);
    void window.agentAPI
      .getTrace({ conversationId: props.conversationId })
      .then(result => {
        if (!alive) return;
        setEntries(result.entries);
        setSource(result.source);
        setHasMore(result.hasMore);
        setFullTotals(result.totals);
        const turns = foldTrace(result.entries);
        const latest = turns.at(-1)?.turn;
        if (latest !== undefined) setOpen(new Set([latest]));
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
  }, [props.conversationId]);

  useEffect(() => window.agentAPI.onConversationEvent((event: ConversationEvent) => {
    if (event.type !== 'trace.appended' || event.conversationId !== props.conversationId) return;
    setEntries(previous => mergeEntries(previous, event.entries));
  }), [props.conversationId]);

  const turns = useMemo(() => foldTrace(entries), [entries]);
  const windowTotals = useMemo(() => aggregateTotals(turns), [turns]);
  const totals = source === 'trace' && fullTotals ? fullTotals : windowTotals;
  const channels = useMemo(() => channelRows(turns), [turns]);
  const quality = useMemo(() => qualityOf(turns), [turns]);
  const label = source === 'trace' && !hasMore ? '全量合计' : source === 'messages' ? '旧记录合计' : '本窗口合计';

  if (loading) return <section className="stats-panel"><p className="muted">正在读取统计…</p></section>;
  if (error) return <section className="stats-panel"><p className="trace-error">{error}</p></section>;
  if (entries.length === 0) {
    return (
      <section className="stats-panel">
        <p className="muted">这条会话还没有统计。发一个问题，每轮的用时、token 和成功率会出现在这里。</p>
      </section>
    );
  }

  return (
    <section className="stats-panel" aria-label="统计">
      {source === 'messages' && (
        <p className="trace-banner">
          这条会话没有轨迹文件，下面是按消息时间重建的旧记录；只有发送时间，没有 token / 首 token。
        </p>
      )}

      <QualityCard turns={turns} quality={quality} />
      <TotalsRow label={label} totals={totals} />

      <table className="stats-table">
        <thead>
          <tr>
            <th>轮次</th>
            <th>触发</th>
            <th>参与</th>
            <th>第一轮</th>
            <th>汇总</th>
            <th>辩论</th>
            <th>上下文</th>
            <th>输出</th>
            <th>缓存</th>
            <th>首 token</th>
            <th>模型/页面</th>
            <th>TPS</th>
            <th>工具</th>
            <th>总用时</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {turns.map(turn => {
            const expanded = open.has(turn.turn);
            return (
              <React.Fragment key={turn.turn}>
                <tr
                  className={`stats-turn${expanded ? ' is-open' : ''}`}
                  onClick={() => {
                    setOpen(current => {
                      const next = new Set(current);
                      if (next.has(turn.turn)) next.delete(turn.turn);
                      else next.add(turn.turn);
                      return next;
                    });
                  }}
                  tabIndex={0}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      (event.currentTarget as HTMLElement).click();
                    }
                  }}
                >
                  <td>第 {turn.turn} 轮</td>
                  <td className="trace-preview" title={turn.trigger ?? ''}>{turn.trigger ?? '—'}</td>
                  <td>
                    答 {turn.first.answered} / 败 {turn.first.failed} / 跳 {turn.first.skipped}
                  </td>
                  <td>{formatMs(turn.first.wallMs)}</td>
                  <td>{formatMs(turn.leadMs)}</td>
                  <td>{turn.debateMs !== null ? `${formatMs(turn.debateMs)}` : '—'}</td>
                  <td>{formatTokens(contextFor(turn, contextMode))}</td>
                  <td>{formatTokens(turn.outputTokens)}</td>
                  <td>{formatPercent(turn.cacheHit)}</td>
                  <td>{formatMs(turn.ttftMs)}</td>
                  <td>{formatMs(turn.stepMs)}</td>
                  <td>{turn.tps === null ? '—' : turn.tps.toFixed(1)}</td>
                  <td>{formatMs(turn.toolMs)}</td>
                  <td>{formatMs(turn.wallMs)}</td>
                  <td><span className={`trace-status s-${turn.status}`}>{STATUS_LABEL[turn.status]}</span></td>
                </tr>
                {expanded && (
                  <tr className="stats-steps">
                    <td colSpan={15}>
                      <StepTable
                        turn={turn}
                        showEvents={showEvents}
                      />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      <div className="stats-foot">
        <label className="trace-toggle">
          <input type="checkbox" checked={showEvents} onChange={event => setShowEvents(event.target.checked)} />
          显示事件行（页面重置、跳过、降级、路由）
        </label>
        <label className="trace-toggle">
          上下文口径
          <select value={contextMode} onChange={event => setContextMode(event.target.value as 'latest' | 'cumulative')}>
            <option value="latest">最新</option>
            <option value="cumulative">累计</option>
          </select>
        </label>
      </div>

      <ChannelTable rows={channels} />
    </section>
  );
}

function TotalsRow(props: { label: string; totals: TraceTotals }) {
  const { totals } = props;
  return (
    <div className="stats-totals">
      <div className="stats-totals-head">
        <b>{props.label}</b>
        <span>{totals.turns} 轮 · {totals.steps} 步</span>
        <span className="trace-unknown" title="只有真正上报过的步才计入">
          覆盖率：用量 {totals.coverage.usage}/{totals.coverage.total} · 首 token {totals.coverage.ttft}/{totals.coverage.total}
        </span>
      </div>
      <div className="stats-totals-grid">
        <span>回答 {totals.answered}</span>
        <span>失败 {totals.failed}</span>
        <span>跳过 {totals.skipped}</span>
        <span>上下文 {formatTokens(totals.contextTokens)}</span>
        <span>输出 {formatTokens(totals.outputTokens)}</span>
        <span>缓存 {formatPercent(totals.cacheHit)}</span>
        <span>首 token {formatMs(totals.ttftMs)}</span>
        <span>TPS {totals.tps === null ? '—' : totals.tps.toFixed(1)}</span>
        <span>工具 {formatMs(totals.toolMs)}</span>
        <span>墙钟 {formatMs(totals.wallMs)}</span>
        {totals.cost.map(item => (
          <span key={item.currency}>费用 {item.amount.toFixed(4)} {item.currency}</span>
        ))}
      </div>
    </div>
  );
}

function QualityCard(props: { turns: readonly TraceTurn[]; quality: ReturnType<typeof qualityOf> }) {
  const first = props.turns.reduce(
    (sum, turn) => ({
      answered: sum.answered + turn.first.answered,
      failed: sum.failed + turn.first.failed,
      skipped: sum.skipped + turn.first.skipped
    }),
    { answered: 0, failed: 0, skipped: 0 }
  );
  const q = props.quality;
  return (
    <div className="stats-quality">
      <b>协作质量</b>
      <span>第一轮：回答 {first.answered} / 失败 {first.failed} / 跳过 {first.skipped}</span>
      <span>共识 {q.claims}</span>
      <span>分歧 {q.disputes}</span>
      <span>独有 {q.unique}</span>
      <span>缺口 {q.gaps}</span>
      <span>证据 {q.evidence}</span>
      <span>引用 {q.citations}</span>
      <span>{q.leadSummary ? '主导人五段汇总' : '规则版综合'}</span>
      {q.degraded && <span className="trace-error">综合降级</span>}
    </div>
  );
}

function StepTable(props: {
  turn: TraceTurn;
  showEvents: boolean;
}) {
  const steps = [...props.turn.steps, ...(props.showEvents ? props.turn.events : [])]
    .sort((left, right) => left.step - right.step);
  if (steps.length === 0) return <p className="muted">这一轮没有步骤。</p>;
  return (
    <table className="stats-step-table">
      <thead>
        <tr>
          <th>阶段</th>
          <th>组</th>
          <th>参与者</th>
          <th>状态</th>
          <th>上下文</th>
          <th>输出</th>
          <th>缓存</th>
          <th>首 token</th>
          <th>用时</th>
          <th>TPS</th>
          <th>原因 / 错误</th>
        </tr>
      </thead>
      <tbody>
        {steps.map(step => (
          <tr key={step.key}>
            <td>{STAGE_LABEL[step.stage] ?? step.stage}{step.kind === 'event' ? ' · 事件' : ''}</td>
            <td>{GROUP_LABEL[step.group]}</td>
            <td>{step.actorLabel}</td>
            <td><span className={`trace-status s-${step.status}`}>{STATUS_LABEL[step.status]}</span></td>
            <td>{step.contextTokens === null ? '—' : formatTokens(step.contextTokens)}</td>
            <td>{formatTokens(step.outputTokens)}</td>
            <td>{formatPercent(step.cacheHit)}</td>
            <td>{formatMs(step.ttftMs)}</td>
            <td>{formatMs(step.durationMs)}</td>
            <td>{step.tps === null ? '—' : step.tps.toFixed(1)}</td>
            <td className="trace-preview" title={step.error?.detail ?? step.reason ?? ''}>
              {step.error?.detail ?? step.reason ?? '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ChannelTable(props: { rows: ChannelRow[] }) {
  if (props.rows.length === 0) return null;
  return (
    <div className="stats-channels">
      <h3>按通道</h3>
      <table className="stats-step-table">
        <thead>
          <tr>
            <th>通道</th>
            <th>来源</th>
            <th>被问</th>
            <th>回答</th>
            <th>失败</th>
            <th>忙</th>
            <th>跳过</th>
            <th>成功率</th>
            <th>P50</th>
            <th>P95</th>
            <th>平均字符</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map(row => {
            const total = row.asked || 1;
            return (
              <tr key={row.actorId}>
                <td>{row.actorLabel}</td>
                <td>{row.sourceType}</td>
                <td>{row.asked}</td>
                <td>{row.answered}</td>
                <td>{row.failed}</td>
                <td>{row.busy}</td>
                <td>{row.skipped}</td>
                <td>{Math.round((row.answered / total) * 100)}%</td>
                <td>{formatMs(percentile(row.durations, 0.5))}</td>
                <td>{formatMs(percentile(row.durations, 0.95))}</td>
                <td>{Math.round(average(row.chars) ?? 0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
