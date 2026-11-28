import React, { useCallback, useEffect, useState } from 'react';
import { contextStateSummary, type ContextStateView } from '../../../../shared/context-state';

/**
 * 上下文状态（V4 P1 M2-3）。
 *
 * 暂停留下了哪份检查点、恢复走的是落库指针还是事件流重建、副作用核对剩几条没对上、
 * 上次重建是什么时候、为什么——这些以前只写在事件里，界面上一个字都看不到，
 * 用户只能翻 `context-checkpoints/` 下的 JSON。这一段把既有 `context.*` 事件投影出来，
 * 不新增事件、不新增写入路径：数字与理由都来自事件原文，取不到就写「未记录」。
 */

const SOURCE_LABEL: Record<string, string> = {
  pause: '暂停存档',
  cancel: '取消存档',
  compaction: '压缩存档'
};

const RECON_SOURCE_LABEL: Record<string, string> = {
  pause: '暂停时核对',
  cancel: '取消时核对',
  recovered: '恢复时核对'
};

function formatTime(at: number | null): string {
  if (at === null) return '未记录';
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 计数缺失一律写「未记录」，不用 0 顶替：0 意味着真的核对过并且没有问题。 */
function num(value: number | null): string {
  return value === null ? '未记录' : String(value);
}

function RebuildLine({ row }: { row: ContextStateView['rebuilds'][number] }) {
  return (
    <article className={`ctx-row t-${row.tone}`}>
      <header className="ctx-row-head">
        <span className="muted">{formatTime(row.at)}</span>
        <b>{row.text}</b>
        <span className={`exec-chip ${row.tone === 'warn' ? 'warn' : 'muted'}`}>
          {row.pointerSource === 'events-replay'
            ? '指针来自事件流重建'
            : row.pointerSource === 'task-fields'
              ? '指针来自任务字段'
              : '指针来源未记录'}
        </span>
        {row.resume ? (
          <span className="muted">
            {row.resume.reusedStepIds.length + row.resume.pendingStepIds.length > 0
              ? `复用 ${String(row.resume.reusedStepIds.length)} 步 · 本轮执行 ${String(row.resume.pendingStepIds.length)} 步`
              // 重规划时两个清单都是空的：写「复用 0 步 · 本轮执行 0 步」会被读成「这一轮没干活」，
              // 而它真正的意思是整轮作废、不复用上一轮任何步骤。
              : '不复用上一轮步骤'}
          </span>
        ) : null}
      </header>
      {row.reason && <p className="ctx-line"><span className="task-progress-key">原因</span>{row.reason}</p>}
      {row.checkpointId && (
        <p className="ctx-line">
          <span className="task-progress-key">检查点</span>
          <code title={row.checkpointId}>{row.checkpointId}</code>
        </p>
      )}
      {row.sideEffects && (
        <p className="ctx-line">
          <span className="task-progress-key">副作用</span>
          存在 {String(row.sideEffects.applied)} · 已消失 {String(row.sideEffects.missing)} · 待核对{' '}
          {String(row.sideEffects.needsReconciliation)}
        </p>
      )}
      {row.resume && row.resume.reasons.length > 0 && (
        <ul className="ctx-reasons">
          {row.resume.reasons.map((reason, index) => (
            <li key={`${String(index)}-${reason}`}>{reason}</li>
          ))}
        </ul>
      )}
      {row.resume && (row.resume.reusedStepIds.length > 0 || row.resume.pendingStepIds.length > 0) && (
        <details>
          <summary>步骤清单</summary>
          <p className="ctx-line">
            <span className="task-progress-key">复用</span>
            {row.resume.reusedStepIds.join('、') || '无'}
          </p>
          <p className="ctx-line">
            <span className="task-progress-key">本轮</span>
            {row.resume.pendingStepIds.join('、') || '无'}
          </p>
          <p className="ctx-line muted">
            <span className="task-progress-key">计划</span>
            {row.resume.planId ? row.resume.planId.slice(0, 8) : '未记录'} · 轮次{' '}
            {row.resume.roundId ? row.resume.roundId.slice(0, 8) : '未记录'}
          </p>
        </details>
      )}
    </article>
  );
}

export function TaskContextCard({ taskId, refreshKey = 0 }: { taskId: string; refreshKey?: number }) {
  const [view, setView] = useState<ContextStateView | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setView(await window.agentAPI.getTaskContext(taskId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [taskId]);

  useEffect(() => {
    setView(null);
    setError('');
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (refreshKey > 0) void refresh();
  }, [refreshKey, refresh]);

  const latest = view?.checkpoints.at(-1) ?? null;
  const rec = view?.lastReconciliation ?? null;
  const resume = [...(view?.rebuilds ?? [])].reverse().find(row => row.kind === 'resume-continue' || row.kind === 'resume-replan') ?? null;

  return (
    <details className="card task-context-card">
      <summary>
        上下文
        <span className="muted">
          {view === null ? '读取中…' : contextStateSummary(view)}
        </span>
      </summary>
      {error && <p className="settings-error">{error}</p>}
      {view !== null && !view.hasEvents && !error && (
        <p className="muted">这个任务没有记录到上下文事件：没有暂停存档、没有压缩、也没有恢复过。</p>
      )}
      {view !== null && view.hasEvents && !error && (
        <>
          <div className="stats-grid">
            <div>
              <span className="task-progress-key">当前上下文</span>
              <b title={view.contextId ?? ''}>{view.contextId ?? '未记录'}</b>
            </div>
            <div>
              <span className="task-progress-key">来源事件</span>
              <b>{view.contextIdFrom ? `${view.contextIdFrom.label} @ ${formatTime(view.contextIdFrom.at)}` : '未记录'}</b>
            </div>
            <div>
              <span className="task-progress-key">最近检查点</span>
              <b title={latest?.checkpointId ?? ''}>
                {latest ? `${latest.checkpointId}（${SOURCE_LABEL[latest.source] ?? latest.source}）` : '没有检查点存档'}
              </b>
            </div>
            <div>
              <span className="task-progress-key">存档时间</span>
              <b>{latest ? formatTime(latest.at) : '未记录'}</b>
            </div>
            <div>
              <span className="task-progress-key">副作用核对</span>
              <b>
                {rec
                  ? `存在 ${num(rec.applied)} · 已消失 ${num(rec.missing)} · 待核对 ${String(rec.needsReconciliation)}`
                  : '未做核对'}
              </b>
            </div>
            <div>
              <span className="task-progress-key">核对来源</span>
              <b>{rec ? `${RECON_SOURCE_LABEL[rec.source] ?? rec.source} @ ${formatTime(rec.at)}` : '未记录'}</b>
            </div>
            <div>
              <span className="task-progress-key">上次重建</span>
              <b>{view.lastRebuild ? `${view.lastRebuild.text} @ ${formatTime(view.lastRebuild.at)}` : '未重建'}</b>
            </div>
            <div>
              <span className="task-progress-key">重建原因</span>
              <b>{view.lastRebuild?.reason ?? '未记录'}</b>
            </div>
            <div>
              <span className="task-progress-key">续跑判定</span>
              <b>{resume ? `${resume.text} @ ${formatTime(resume.at)}` : '没有点过「继续」'}</b>
            </div>
            <div>
              <span className="task-progress-key">预算水位</span>
              <b>
                {view.budget
                  ? `${view.budget.level} · ${num(view.budget.estimatedTokens)} tokens / ${num(view.budget.contextWindow)}`
                  : '未记录'}
              </b>
            </div>
          </div>

          {rec && (rec.applied === null || rec.missing === null) && (
            <p className="ctx-line muted">
              <span className="task-progress-key">口径</span>
              暂停事件只记了待核对条数，「存在 / 已消失」要在恢复核对后才有——这里不拿 0 代替没核对。
            </p>
          )}

          {view.checkpoints.length > 1 && (
            <div className="ctx-block">
              <h3>检查点存档 {String(view.checkpoints.length)} 次</h3>
              <ul>
                {view.checkpoints.map((row, index) => (
                  <li key={`${row.checkpointId}-${String(index)}`}>
                    <span className="muted">{formatTime(row.at)}</span>
                    <code title={row.checkpointId}>{row.checkpointId}</code>
                    <span className="muted">
                      {SOURCE_LABEL[row.source] ?? row.source} · 待核对 {num(row.needsReconciliation)} · 目标 v
                      {num(row.goalVersion)} · 任务树 r{num(row.taskRevision)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {view.rebuilds.length > 0 && (
            <div className="ctx-block">
              <h3>重建经过 {String(view.rebuilds.length)} 条</h3>
              {view.rebuilds.map((row, index) => (
                <RebuildLine key={`${String(row.at)}-${row.kind}-${String(index)}`} row={row} />
              ))}
            </div>
          )}

          <details className="ctx-entries">
            <summary>逐条原文 {String(view.entries.length)} 条（详情检查入口）</summary>
            {view.entries.map((row, index) => (
              <details key={`${String(row.at)}-${row.type}-${String(index)}`} className={`ctx-entry t-${row.tone}`}>
                <summary>
                  <span className="muted">{formatTime(row.at)}</span>
                  <span className="ctx-entry-type">{row.type}</span>
                  {row.text}
                </summary>
                <pre className="exec-code">{JSON.stringify(row.detail, null, 2)}</pre>
              </details>
            ))}
          </details>

          <p className="exec-sources muted">
            依据：{String(view.entries.length)} 条持久化的 context 事件（只读投影，取自 store 而非界面事件流；
            检查点文件内容由恢复链路核对后发进事件流，这里不重复读盘）
          </p>
        </>
      )}
    </details>
  );
}
