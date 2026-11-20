import React, { useEffect, useState } from 'react';

type Mode = 'legacy' | 'shadow' | 'active';
interface View {
  mode: Mode;
  gate: { ok: boolean; reasons: string[] };
  metrics: { questions: number; planned: number; covered: number; maxTasksSimple: number };
}

/** A-04/B：协作引擎设置；active 必须过门禁。 */
export function CollaborationSettingsSection() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.agentAPI.getCollaborationSettings().then(next => setView(next as View | null)).catch(() => {});
  }, []);

  const setMode = async (mode: Mode) => {
    setBusy(true); setError('');
    try {
      const next = await window.agentAPI.setCollaborationMode(mode);
      setView(next as View | null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  return (
    <section className="settings-section collab-settings">
      <h3>协作引擎</h3>
      <p className="settings-hint">默认 legacy；shadow 只记录计划；active 必须通过门禁。</p>
      <div className="collab-mode-row">
        {(['legacy', 'shadow', 'active'] as const).map(mode => (
          <button
            key={mode}
            type="button"
            className={`chip-btn${view?.mode === mode ? ' active' : ''}`}
            disabled={busy}
            onClick={() => void setMode(mode)}
          >
            {mode}
          </button>
        ))}
      </div>
      {view && (
        <div className="collab-gate">
          <div>门禁：{view.gate.ok ? '通过' : '未通过'}</div>
          {view.gate.reasons.length > 0 && <ul>{view.gate.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
          <div className="collab-metrics">
            问题 {view.metrics.questions} · 计划 {view.metrics.planned} · 覆盖 {view.metrics.covered} · 简单任务上限 {view.metrics.maxTasksSimple}
          </div>
        </div>
      )}
      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}
