import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MemoryCandidate, MemoryRecord } from '../../../shared/memory';
import type {
  MemoryAuditEntry,
  MemoryConflictGroup,
  MemoryStatusView
} from '../../../shared/memory-api';

/**
 * 设置 · 全局记忆。
 *
 * 四件事必须能在这里做完，否则「可观测 / 可治理」只是一句话：
 * 1. 看到库的状态（ready / degraded、记录数、迁移结果）；
 * 2. 关掉记忆（关闭后不读、不写、不注入）；
 * 3. 审候选（确认 / 拒绝），并看到候选的**原文引述**与来源；
 * 4. 治理记录（纠错、否定、过期、归档、删除）与冲突裁决。
 *
 * 这里的文案刻意不写「模型已使用记忆」——最多只能说「已注入（Provider
 * 层已确认拼装）」，见 `docs/spec/GLOBAL_MEMORY.md` §1.3。
 */
export function MemoryPanel() {
  const api = window.agentAPI.memory;
  const [status, setStatus] = useState<MemoryStatusView | null>(null);
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [conflicts, setConflicts] = useState<MemoryConflictGroup[]>([]);
  const [audit, setAudit] = useState<MemoryAuditEntry[]>([]);
  const [tab, setTab] = useState<'candidates' | 'records' | 'conflicts' | 'audit'>('candidates');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [nextStatus, nextCandidates, nextRecords, nextConflicts, nextAudit] = await Promise.all([
        api.status(),
        api.listCandidates('pending'),
        api.listRecords({ limit: 200 }),
        api.conflicts(),
        api.audit(30)
      ]);
      setStatus(nextStatus);
      setCandidates(nextCandidates);
      setRecords(nextRecords);
      setConflicts(nextConflicts);
      setAudit(nextAudit);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);

  useEffect(() => { void reload(); }, [reload]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const patch = useCallback((next: Partial<MemoryStatusView['settings']>) =>
    run(async () => { await api.setSettings(next); }), [api, run]);

  const visibleRecords = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return records;
    return records.filter(r =>
      r.title.toLowerCase().includes(needle) || r.content.toLowerCase().includes(needle)
    );
  }, [filter, records]);

  if (!status) {
    return <div className="settings-body"><p className="settings-hint">正在读取记忆库…</p></div>;
  }

  const degraded = status.state === 'degraded';

  return (
    <div className="settings-body memory-panel">
      <div className={`memory-status${degraded ? ' is-degraded' : ''}`}>
        <div className="memory-status-head">
          <strong>{degraded ? '记忆库不可用（降级）' : status.enabled ? '记忆已开启' : '记忆已关闭'}</strong>
          <span className="muted">{status.file}</span>
        </div>
        {degraded && <p className="settings-error">{status.detail ?? '原因未知'}；回答不受影响，但不会注入记忆。</p>}
        <div className="memory-status-grid">
          <span>记录 <b>{status.records}</b></span>
          <span>待审候选 <b>{status.candidates}</b></span>
          <span>schema <b>v{status.schemaVersion}</b></span>
          <span>迁移 <b>{status.migration}</b></span>
        </div>
        {status.migrationDetail && <p className="settings-hint">{status.migrationDetail}</p>}
      </div>

      <div className="settings-field">
        <label className="settings-field-label">
          <input
            type="checkbox"
            checked={status.settings.enabled}
            disabled={degraded || busy}
            onChange={event => void patch({ enabled: event.target.checked })}
          />
          启用全局记忆（关闭后不读取、不写入、不注入）
        </label>
        <label className="settings-field-label">
          <input
            type="checkbox"
            checked={status.settings.inject}
            disabled={degraded || busy}
            onChange={event => void patch({ inject: event.target.checked })}
          />
          允许注入模型请求（关闭后仍可管理与导出）
        </label>
        <label className="settings-field-label">
          <input
            type="checkbox"
            checked={status.settings.autoApproveExplicit}
            disabled={degraded || busy}
            onChange={event => void patch({ autoApproveExplicit: event.target.checked })}
          />
          用户显式「记住…」时自动批准（默认关：规则开 ≠ 自动批准）
        </label>
      </div>

      <div className="settings-field memory-numbers">
        <label className="settings-field-label">
          写入模式
          <select
            className="settings-input"
            value={status.settings.writeMode}
            disabled={degraded || busy}
            onChange={event => void patch({ writeMode: event.target.value as typeof status.settings.writeMode })}
          >
            <option value="off">off（完全不抽取）</option>
            <option value="rule">rule（规则，默认）</option>
            <option value="rule+model">rule+model（模型通道，默认关）</option>
          </select>
        </label>
        <label className="settings-field-label">
          单次注入上限（条）
          <input
            className="settings-input" type="number" min={1} max={20}
            value={status.settings.maxRecords}
            disabled={degraded || busy}
            onChange={event => void patch({ maxRecords: Number(event.target.value) })}
          />
        </label>
        <label className="settings-field-label">
          单次注入预算（字）
          <input
            className="settings-input" type="number" min={0} max={8000} step={100}
            value={status.settings.budgetChars}
            disabled={degraded || busy}
            onChange={event => void patch({ budgetChars: Number(event.target.value) })}
          />
        </label>
      </div>

      {error && <p className="settings-error">{error}</p>}

      <div className="memory-tabs">
        {([
          ['candidates', `待审候选 ${candidates.length}`],
          ['records', `记录 ${records.length}`],
          ['conflicts', `冲突 ${conflicts.length}`],
          ['audit', '审计']
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`btn${tab === id ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <button type="button" className="btn" disabled={busy} onClick={() => void reload()}>刷新</button>
        <button
          type="button" className="btn" disabled={degraded || busy}
          onClick={() => void run(async () => {
            const dump = await api.exportAll();
            const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'thinkfusion-memory-export.json';
            link.click();
            URL.revokeObjectURL(url);
          })}
        >
          导出
        </button>
      </div>

      {tab === 'candidates' && (
        <div className="memory-list">
          {candidates.length === 0 && <p className="settings-hint">没有待审候选。抽取到「记住…」或稳定偏好时会出现在这里。</p>}
          {candidates.map(candidate => (
            <div key={candidate.candidateId} className="memory-item">
              <div className="memory-item-head">
                <strong>{candidate.proposedTitle}</strong>
                <span className="muted">
                  {candidate.proposedScope} · {candidate.proposedKind} · {candidate.reason} · 风险 {candidate.riskLevel}
                </span>
              </div>
              <p className="memory-item-body">{candidate.proposedContent}</p>
              {candidate.quote && <blockquote className="memory-quote">原文：{candidate.quote}</blockquote>}
              <div className="memory-item-actions">
                <button type="button" className="btn" disabled={busy}
                  onClick={() => void run(async () => { await api.confirmCandidate(candidate.candidateId); })}>
                  确认写入
                </button>
                <button type="button" className="btn" disabled={busy}
                  onClick={() => void run(async () => { await api.rejectCandidate(candidate.candidateId); })}>
                  拒绝
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'records' && (
        <div className="memory-list">
          <input
            className="settings-input memory-search"
            placeholder="按标题或内容搜索"
            value={filter}
            onChange={event => setFilter(event.target.value)}
          />
          {visibleRecords.map(record => (
            <div key={record.memoryId} className="memory-item">
              <div className="memory-item-head">
                <strong>{record.title}</strong>
                <span className="muted">
                  {record.scope}{record.scopeId ? `:${record.scopeId}` : ''} · {record.kind} · {record.status} · {record.riskLevel}
                </span>
              </div>
              <p className="memory-item-body">{record.content}</p>
              <div className="memory-item-actions">
                {record.status !== 'active' && <span className="settings-hint">当前状态：{record.status}</span>}
                <button type="button" className="btn" disabled={busy}
                  onClick={() => void run(async () => { await api.refute(record.memoryId); })}>否定</button>
                <button type="button" className="btn" disabled={busy}
                  onClick={() => void run(async () => { await api.expire(record.memoryId); })}>过期</button>
                <button type="button" className="btn" disabled={busy}
                  onClick={() => void run(async () => { await api.archive(record.memoryId); })}>归档</button>
                <button type="button" className="btn memory-danger" disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`删除「${record.title}」？删除会留审计，但记录本身不再可恢复。`)) return;
                    void run(async () => { await api.deleteRecord(record.memoryId); });
                  }}>删除</button>
              </div>
            </div>
          ))}
          {visibleRecords.length === 0 && <p className="settings-hint">没有匹配的记录。</p>}
        </div>
      )}

      {tab === 'conflicts' && (
        <div className="memory-list">
          {conflicts.length === 0 && <p className="settings-hint">没有冲突。同 scope 同 key 的多条 active 会出现在这里。</p>}
          {conflicts.map(group => (
            <div key={`${group.scope}|${group.scopeId}|${group.normalizedKey}`} className="memory-item">
              <div className="memory-item-head">
                <strong>{group.normalizedKey}</strong>
                <span className="muted">{group.scope}:{group.scopeId} · {group.memoryIds.length} 条</span>
              </div>
              {group.memoryIds.map(id => {
                const record = records.find(r => r.memoryId === id);
                return (
                  <div key={id} className="memory-conflict-row">
                    <span>{record?.title ?? id}</span>
                    <span className="muted">{record?.content?.slice(0, 60)}</span>
                    <button type="button" className="btn" disabled={busy}
                      onClick={() => void run(async () => { await api.refute(id); })}>否定这条</button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {tab === 'audit' && (
        <div className="memory-list">
          {audit.length === 0 && <p className="settings-hint">还没有审计记录。</p>}
          {audit.map(entry => (
            <div key={`${entry.at}-${entry.action}-${entry.memoryId ?? ''}`} className="memory-audit-row">
              <span className="muted">{new Date(entry.at).toLocaleString()}</span>
              <span>{entry.action}</span>
              <span className="muted">{entry.memoryId ?? ''}</span>
              <span className="muted">{entry.detail ?? ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
