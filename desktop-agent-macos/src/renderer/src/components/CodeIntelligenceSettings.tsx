import React, { useEffect, useState } from 'react';
import type { CodeIntelligenceConfig, CodeIntelligenceMode, CodeIntelligenceStatus } from '../../../shared/code-intelligence';

/** 设置 → 工程智能：Core / Enhanced 的开关，不要求普通用户编辑环境变量。 */
export function CodeIntelligenceSettings() {
  const [config, setConfig] = useState<CodeIntelligenceConfig | null>(null);
  const [status, setStatus] = useState<CodeIntelligenceStatus | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    window.agentAPI.getCodeIntelligenceConfig().then(setConfig).catch(error => setNote(String(error)));
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setNote('');
    try {
      const next = await window.agentAPI.setCodeIntelligenceConfig(patch);
      setConfig(next);
      setNote('已保存');
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setNote('');
    try {
      setStatus(await window.agentAPI.testCodeIntelligence());
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!config) return <section className="settings-section"><p className="settings-lead">读取配置…</p></section>;

  return (
    <section className="settings-section">
      <h3>工程智能</h3>
      <p className="settings-lead">
        核心功能使用本地 AST + SQLite + FTS5 + Vector，安装即用。外部 CGC / Graphiti
        是可选增强；连不上时自动回退，不影响代码检索和执行。
      </p>
      <div className="settings-field">
        <label>运行模式</label>
        <select
          value={config.mode}
          onChange={event => {
            const mode = event.target.value as CodeIntelligenceMode;
            setConfig({ ...config, mode });
            void save({ mode });
          }}
        >
          <option value="local">本地回退（默认）</option>
          <option value="external">外部服务（CGC / Graphiti）</option>
        </select>
      </div>
      <div className="settings-field">
        <label>
          <input
            type="checkbox"
            checked={config.cgcEnabled}
            onChange={event => { setConfig({ ...config, cgcEnabled: event.target.checked }); void save({ cgcEnabled: event.target.checked }); }}
          />
          CodeGraph（CGC）
        </label>
        <label>
          <input
            type="checkbox"
            checked={config.graphitiEnabled}
            onChange={event => { setConfig({ ...config, graphitiEnabled: event.target.checked }); void save({ graphitiEnabled: event.target.checked }); }}
          />
          Graphiti 工程记忆
        </label>
      </div>
      <div className="settings-field">
        <label>Neo4j HTTP 地址</label>
        <input
          value={config.neo4jUrl}
          placeholder="http://127.0.0.1:7474"
          onChange={event => setConfig({ ...config, neo4jUrl: event.target.value })}
          onBlur={() => void save({ neo4jUrl: config.neo4jUrl })}
        />
      </div>
      <div className="settings-field">
        <label>Neo4j 用户</label>
        <input
          value={config.neo4jUser}
          onChange={event => setConfig({ ...config, neo4jUser: event.target.value })}
          onBlur={() => void save({ neo4jUser: config.neo4jUser })}
        />
      </div>
      <div className="settings-field">
        <label>Neo4j 密码</label>
        <input
          type="password"
          value={password}
          placeholder={config.passwordConfigured ? '已保存；留空不修改' : '未保存'}
          onChange={event => setPassword(event.target.value)}
        />
        <button className="btn ghost" type="button" disabled={busy || !password.trim()} onClick={() => void save({ password })}>保存密码</button>
        {config.passwordConfigured && (
          <button className="btn ghost" type="button" disabled={busy} onClick={() => { setPassword(''); void save({ password: '' }); }}>
            清除密码
          </button>
        )}
      </div>
      <div className="settings-actions">
        <button className="btn" type="button" disabled={busy} onClick={() => void test()}>连接测试</button>
        {note && <span className="settings-note">{note}</span>}
      </div>
      {status && (
        <div className="settings-status">
          <p>运行模式：{status.mode === 'external' ? '外部服务' : '本地回退'}</p>
          <p>CGC：{status.cgc} · Graphiti：{status.graphiti}</p>
          {status.detail && <p className="settings-note">{status.detail}</p>}
          <p className="settings-note">检查时间：{new Date(status.lastCheckedAt).toLocaleString()}</p>
        </div>
      )}
      <p className="settings-lead">
        环境变量 <code>THINKFUSION_NEO4J_HTTP</code> / <code>_USER</code> /
        <code>_PASSWORD</code> 仍可作为开发者覆盖；正式用户不需要编辑环境变量。
      </p>
    </section>
  );
}
