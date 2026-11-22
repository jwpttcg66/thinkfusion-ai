import React, { useState } from 'react';
import { TASK_MEMBER_STATUS_LABEL, type TaskMemberStream } from '../../../../shared/task-stream';

/**
 * 每个成员一张卡（V2.1 §5.2）。
 *
 * 这里只画已经发生的：没有 reasoning 的来源写「未提供」，没有 token 写
 * 「未提供」，不拿 0 冒充「用了 0 个 token」。卡片是并排的，因为把它们合成
 * 一段没有来源的文字，用户就再也分不清哪句话是谁说的。
 */

const STATUS_LABEL = TASK_MEMBER_STATUS_LABEL;

export type MemberLayout = 'one' | 'two' | 'three';

function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function formatTokens(usage: TaskMemberStream['usage']): string {
  if (!usage) return '未提供';
  const total = usage.totalTokens;
  if (typeof total === 'number') return `${String(total)} tokens`;
  const parts: string[] = [];
  if (typeof usage.promptTokens === 'number') parts.push(`入 ${String(usage.promptTokens)}`);
  if (typeof usage.completionTokens === 'number') parts.push(`出 ${String(usage.completionTokens)}`);
  return parts.length > 0 ? parts.join(' · ') : '未提供';
}

function MemberCard(props: {
  member: TaskMemberStream;
  now: number;
  focused: boolean;
  onFocus: () => void;
}) {
  const { member, now } = props;
  const [openReasoning, setOpenReasoning] = useState(false);
  const live = member.status === 'preparing' || member.status === 'streaming';
  const elapsed = member.durationMs ?? (member.startedAt ? now - member.startedAt : null);
  return (
    <article className={`member-card is-${member.status}${props.focused ? ' is-focused' : ''}`}>
      <header className="member-card-head">
        <div className="member-card-title">
          <b title={member.memberId}>{member.label}</b>
          {member.modelId && member.modelId !== member.label && <span className="muted">{member.modelId}</span>}
        </div>
        <span className={`member-pill is-${member.status}`}>
          {live && <span className="spinner" />}
          {STATUS_LABEL[member.status]}
        </span>
      </header>
      <div className="member-card-meta">
        <span>{formatMs(elapsed)}</span>
        <span>{member.text.length} 字符</span>
        <span>{formatTokens(member.usage)}</span>
        <button className="btn ghost" type="button" onClick={props.onFocus}>
          {props.focused ? '取消聚焦' : '聚焦'}
        </button>
      </div>
      {member.error && <p className="member-card-error">{member.error}</p>}
      <div className="member-card-body">
        {member.reasoningSupported ? (
          <details open={openReasoning} onToggle={event => setOpenReasoning((event.target as HTMLDetailsElement).open)}>
            <summary>思考（{member.reasoning.length} 字符）</summary>
            {member.reasoning ? <pre>{member.reasoning}</pre> : <p className="muted">这个来源本次没有返回思考内容。</p>}
          </details>
        ) : (
          <p className="muted member-absent">思考：未提供</p>
        )}
        <pre className="member-text">{member.text || (live ? '等待模型输出…' : '本次没有输出正文。')}</pre>
      </div>
    </article>
  );
}

export function ModelOutputGrid(props: {
  members: readonly TaskMemberStream[];
  /** 没有任何成员身份字段时（旧事件）由调用方决定是否退回单路显示。 */
  fallback?: React.ReactNode;
}) {
  const [layout, setLayout] = useState<MemberLayout>('two');
  const [focused, setFocused] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const hasLive = props.members.some(item => item.status === 'preparing' || item.status === 'streaming');

  React.useEffect(() => {
    if (!hasLive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasLive]);

  if (props.members.length === 0) return <>{props.fallback ?? null}</>;

  const focusedMember = focused ? props.members.find(item => item.memberId === focused) : undefined;
  const visible = focusedMember ? [focusedMember] : props.members;

  return (
    <section className="member-section card">
      <div className="card-head">
        <h2>模型独立输出（{props.members.length}）</h2>
        <div className="member-layout">
          {(['one', 'two', 'three'] as const).map(option => (
            <button
              key={option}
              type="button"
              className={`btn ghost${layout === option ? ' is-active' : ''}`}
              onClick={() => setLayout(option)}
              aria-pressed={layout === option}
            >
              {option === 'one' ? '单列' : option === 'two' ? '两列' : '三列'}
            </button>
          ))}
        </div>
      </div>
      <div className={`member-grid is-${focused ? 'one' : layout}`}>
        {visible.map(member => (
          <MemberCard
            key={member.memberId}
            member={member}
            now={now}
            focused={focused === member.memberId}
            onFocus={() => setFocused(current => (current === member.memberId ? null : member.memberId))}
          />
        ))}
      </div>
    </section>
  );
}
