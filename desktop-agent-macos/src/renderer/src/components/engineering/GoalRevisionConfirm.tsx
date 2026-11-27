import React from 'react';
import type { GoalRevisionPendingEvent } from '../../../../shared/goal-driven-cycle';

/**
 * 目标变更影响面确认卡（V4 P1 M1-3）。
 *
 * 删成功标准以前只用一句 `window.confirm` 问一次，问完就没了：用户看不到
 * 「这一改会把哪些子任务拖去重规划」，也看不到改完的标准到底是什么。
 * 卡片的内容全部取自 `goal.revision.pending` 事件原文——不是在这里重算一遍，
 * 否则确认的内容和真正落库的内容可能不是同一份。
 *
 * 「暂不变更」只关卡片，不写任何东西：版本没抬，所以重进任务它还会出现。
 */

const STATUS_LABEL: Record<string, string> = {
  pending: '待开始',
  ready: '就绪',
  running: '进行中',
  blocked: '受阻',
  reviewing: '评审中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过'
};

const MAX_IMPACTED_ROWS = 12;

export function GoalRevisionConfirm(props: {
  pending: GoalRevisionPendingEvent | null;
  /** 确认后走既有 reviseGoal，带上 userConfirmedChange: true。 */
  onConfirm: (criteria: string[]) => Promise<void>;
}) {
  const [dismissedAt, setDismissedAt] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const pending = props.pending;
  if (!pending || dismissedAt === pending.at) return null;

  const shown = pending.impactedTasks.slice(0, MAX_IMPACTED_ROWS);
  const hidden = pending.impactedTasks.length - shown.length;

  async function confirm(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    setError('');
    try {
      await props.onConfirm(pending.nextCriteria);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card goal-revision-confirm">
      <div className="card-head">
        <h2>目标变更待确认</h2>
        <span className="muted">
          v{String(pending.fromVersion)} → v{String(pending.nextVersion)} · 确认前不抬版本、不改任务
        </span>
      </div>
      <p className="grc-reason">{pending.reason}</p>

      <div className="grc-cols">
        <div>
          <h3>变更后的成功标准</h3>
          {pending.nextCriteria.length === 0 ? (
            <p className="muted">这一份待确认的变更没有写成功标准。</p>
          ) : (
            <ol className="grc-criteria">
              {pending.nextCriteria.map((item, index) => <li key={index}>{item}</li>)}
            </ol>
          )}
        </div>
        <div>
          <h3>受影响的任务</h3>
          {shown.length === 0 ? (
            <p className="muted">
              {pending.impactedTaskIds.length === 0
                ? '事件里没记到受影响任务（可能这一版任务树还没建）。'
                : `受影响 ${String(pending.impactedTaskIds.length)} 条，但当时没记下标题。`}
            </p>
          ) : (
            <ul className="grc-impacted">
              {shown.map(item => (
                <li key={item.workTaskId}>
                  <span className={`task-dot s-${item.status}`} />
                  <span className="grc-impacted-title" title={item.workTaskId}>{item.title}</span>
                  <span className="muted">{STATUS_LABEL[item.status] ?? item.status}</span>
                </li>
              ))}
            </ul>
          )}
          {hidden > 0 && <p className="muted">还有 {String(hidden)} 条没有列出。</p>}
          {pending.inheritedCount > 0 && (
            <p className="muted">另有 {String(pending.inheritedCount)} 条不受影响，成果可继承。</p>
          )}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      <div className="grc-actions">
        <button className="btn primary" type="button" disabled={busy} onClick={() => void confirm()}>
          {busy ? '提交中…' : '确认变更'}
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => setDismissedAt(pending.at)}
        >
          暂不变更
        </button>
        <span className="muted">确认后目标抬到 v{String(pending.nextVersion)}，受影响任务按新目标重规划。</span>
      </div>
    </section>
  );
}
