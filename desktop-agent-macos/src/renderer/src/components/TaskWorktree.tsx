import React, { useCallback, useEffect, useState } from 'react';
import type { TaskWorktreeDiff, TaskWorktreeView } from '../../../shared/worktree';

/**
 * 外部 Agent 的独立工作树。
 *
 * 这个面板只做三件事：让人看见「改动在哪」，把打开/复制这种低风险动作做好，
 * 以及把提交、合并、删除这类不可逆动作变成显式两步确认。它不会自动合并、
 * 不会自动删树，也不会把未提交的改动当成已交付。
 */

function shortPath(value: string, max = 64): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

export function TaskWorktree({ taskId, refreshKey = 0 }: { taskId: string; refreshKey?: number }) {
  const [view, setView] = useState<TaskWorktreeView | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [diff, setDiff] = useState<TaskWorktreeDiff | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [forceRemove, setForceRemove] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setView(await window.agentAPI.getTaskWorktree(taskId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [taskId]);

  useEffect(() => {
    setView(null);
    setDiff(null);
    setNote('');
    setError('');
    setCommitOpen(false);
    setConfirmMerge(false);
    setConfirmRemove(false);
    void refresh();
  }, [refresh]);

  // 审批后主进程才建树，建树完成会发一条 log 事件；事件数变化时再取一次，
  // 否则用户要切走再切回来才看得到这棵树。
  useEffect(() => {
    if (refreshKey > 0) void refresh();
  }, [refreshKey, refresh]);

  if (!view) return null;

  const run = async (action: string, work: () => Promise<void>) => {
    setBusy(action);
    setError('');
    setNote('');
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleDiff = () =>
    run('diff', async () => {
      if (diff) {
        setDiff(null);
        return;
      }
      setDiff(await window.agentAPI.getTaskWorktreeDiff(taskId));
    });

  const commit = () =>
    run('commit', async () => {
      const next = await window.agentAPI.commitTaskWorktree({ taskId, message: commitMessage });
      setView(next);
      setCommitOpen(false);
      setCommitMessage('');
      setDiff(null);
      setNote('已提交到工作树分支；下一步可以合并到主工作区。');
    });

  const merge = () =>
    run('merge', async () => {
      const result = await window.agentAPI.mergeTaskWorktree(taskId);
      setConfirmMerge(false);
      setNote(`已合并 ${result.branch}（${result.commit.slice(0, 12)}）：${result.message}`);
      await refresh();
    });

  const remove = () =>
    run('remove', async () => {
      await window.agentAPI.removeTaskWorktree({ taskId, force: forceRemove });
      setConfirmRemove(false);
      setForceRemove(false);
      setNote('工作树已删除。');
      await refresh();
    });

  const dirtyLabel = view.dirty ? `${view.changedFiles.length} 个文件未提交` : '没有未提交改动';
  const mergeLabel = view.merged ? '已合并' : view.ahead > 0 ? `领先 ${view.ahead} 个提交` : '尚未提交';

  return (
    <section className="card task-worktree">
      <header className="task-worktree-head">
        <b>独立工作树</b>
        <code>{view.branch}</code>
        <span className={view.dirty ? 'worktree-chip warn' : 'worktree-chip'}>{dirtyLabel}</span>
        <span className="worktree-chip">{mergeLabel}</span>
      </header>
      <p className="task-worktree-path" title={view.dir}>
        {shortPath(view.dir)}
      </p>
      <div className="task-worktree-actions">
        <button
          type="button"
          className="btn ghost"
          disabled={busy !== null || !view.exists}
          onClick={() =>
            run('open', async () => {
              const result = await window.agentAPI.openTaskWorktree(taskId);
              if (!result.opened) throw new Error(result.error || '无法打开目录');
            })
          }
        >
          在 Finder 中打开
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={busy !== null}
          onClick={() =>
            run('copy', async () => {
              await window.agentAPI.copyTaskWorktreePath(taskId);
              setNote('路径已复制。');
            })
          }
        >
          复制路径
        </button>
        <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => void toggleDiff()}>
          {diff ? '收起改动' : '查看改动'}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={busy !== null || !view.dirty}
          onClick={() => setCommitOpen(open => !open)}
        >
          提交改动
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={busy !== null || view.dirty || !view.exists}
          onClick={() => setConfirmMerge(open => !open)}
        >
          合并到主工作区
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={busy !== null || !view.exists}
          onClick={() => setConfirmRemove(open => !open)}
        >
          删除工作树
        </button>
      </div>

      {commitOpen && (
        <div className="task-worktree-confirm">
          <input
            value={commitMessage}
            maxLength={200}
            placeholder="这次改动做了什么（必填，最多 200 字）"
            onChange={event => setCommitMessage(event.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={busy !== null || commitMessage.trim().length === 0}
            onClick={() => void commit()}
          >
            确认提交
          </button>
          <button type="button" className="btn ghost" onClick={() => setCommitOpen(false)}>
            取消
          </button>
        </div>
      )}

      {confirmMerge && (
        <div className="task-worktree-confirm">
          <span>
            把 <code>{view.branch}</code> 合并到主工作区当前分支？冲突会自动回滚，不会留下半合并状态。
          </span>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void merge()}>
            确认合并
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirmMerge(false)}>
            取消
          </button>
        </div>
      )}

      {confirmRemove && (
        <div className="task-worktree-confirm">
          <span>
            删除这棵工作树？{view.merged ? '分支已合并。' : '分支还没有合并，未合并的提交会被保留。'}
          </span>
          {view.dirty && (
            <label className="task-worktree-force">
              <input
                type="checkbox"
                checked={forceRemove}
                onChange={event => setForceRemove(event.target.checked)}
              />
              有未提交改动，仍然强制删除（这些改动会丢失）
            </label>
          )}
          <button
            type="button"
            className="btn"
            disabled={busy !== null || (view.dirty && !forceRemove)}
            onClick={() => void remove()}
          >
            确认删除
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirmRemove(false)}>
            取消
          </button>
        </div>
      )}

      {diff && (
        <div className="task-worktree-diff">
          {diff.untracked.length > 0 && (
            <p className="muted">
              未跟踪文件（只列名字）：{diff.untracked.slice(0, 20).join('、')}
              {diff.untracked.length > 20 ? ` 等 ${String(diff.untracked.length)} 个` : ''}
            </p>
          )}
          <pre>{diff.diff || '（已跟踪文件没有差异）'}</pre>
        </div>
      )}

      {note && <p className="settings-hint">{note}</p>}
      {error && <p className="settings-error">{error}</p>}
      <p className="muted">
        外部 Agent 只改这棵树；主工作区不会被直接修改。取消任务也会保留这棵树，方便你查看半成品。
      </p>
    </section>
  );
}
