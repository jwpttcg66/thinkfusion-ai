import React from 'react';
import type { ObservabilityEvent } from '../../../shared/observability';
import { projectComputerUse } from '../../../shared/computer-use-view';

export function ComputerUsePanel(props: { events: readonly ObservabilityEvent[]; onStop: () => void }) {
  const view = projectComputerUse(props.events);
  if (!view) return null;
  return (
    <section className="card computer-use">
      <div className="card-head">
        <h2>桌面操作</h2>
        <button className="btn ghost" type="button" onClick={props.onStop}>停止任务</button>
      </div>
      <p>
        {view.appName ?? '还没有读到前台应用'}
        {view.bundleId ? ` · ${view.bundleId}` : ''}
        {view.windowId ? ` · 窗口 ${view.windowId}` : ''}
      </p>
      {view.permission && <p className="muted">权限：{view.permission}</p>}
      {view.action && <p>{view.action}</p>}
      {view.verified !== undefined && (
        <p>验证：{view.verified ? '已核对' : '未验证'}{view.verification ? ` · ${view.verification}` : ''}</p>
      )}
      {view.snapshotId && <p className="muted">快照 {view.snapshotId}</p>}
      {view.screenshotRef && <p className="muted">截图 {view.screenshotRef}</p>}
      {view.stopped && <p>后续桌面操作已停止</p>}
      {view.events.length > 0 && (
        <ol>
          {view.events.map((event, index) => (
            <li key={`${event.type}-${String(event.timestamp ?? index)}`}>{event.type}</li>
          ))}
        </ol>
      )}
    </section>
  );
}
