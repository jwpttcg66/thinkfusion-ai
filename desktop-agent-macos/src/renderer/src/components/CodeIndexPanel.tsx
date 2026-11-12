import React, { useEffect, useRef, useState } from 'react';
import type { CodeIndexMode, CodeIndexSearchResult, CodeIndexStatus } from '../../../shared/code-index';

/**
 * 工程索引面板：让本地方案 A/B 在界面上真的可用。
 *
 * 没有 CGC/Graphiti/Neo4j 时这里走 AST + SQLite FTS5；面板不声称已经接入
 * 外部组件，只显示本地索引的 generation、文件/节点/边和检索结果。
 */
export function CodeIndexPanel(props: { root: string }) {
  const [status, setStatus] = useState<CodeIndexStatus | null>(null);
  const [query, setQuery] = useState('');
  const queryRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<CodeIndexMode>('HYBRID');
  const [result, setResult] = useState<CodeIndexSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastRequest, setLastRequest] = useState('');
  const [memoryKind, setMemoryKind] = useState<'decision' | 'constraint' | 'fact' | 'issue' | 'solution' | 'debate'>('decision');
  const [memoryTitle, setMemoryTitle] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryNote, setMemoryNote] = useState('');

  useEffect(() => {
    let alive = true;
    setStatus(null);
    setResult(null);
    setError('');
    window.agentAPI
      .getCodeIndexStatus(props.root)
      .then(next => { if (alive) setStatus(next); })
      .catch(next => { if (alive) setError(next instanceof Error ? next.message : String(next)); });
    return () => { alive = false; };
  }, [props.root]);

  useEffect(() => {
    let alive = true;
    void window.agentAPI.watchCodeIndex(props.root).catch(() => undefined);
    const timer = window.setInterval(() => {
      window.agentAPI.getCodeIndexStatus(props.root)
        .then(next => { if (alive) setStatus(next); })
        .catch(() => undefined);
    }, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      void window.agentAPI.unwatchCodeIndex(props.root).catch(() => undefined);
    };
  }, [props.root]);

  const build = async () => {
    setBusy(true);
    setError('');
    try {
      setStatus(await window.agentAPI.buildCodeIndex(props.root));
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  };

  const search = async () => {
    const text = (queryRef.current?.value ?? query).trim();
    if (!text) return;
    setBusy(true);
    setError('');
    setLastRequest(`${text} · ${mode}`);
    try {
      setResult(await window.agentAPI.searchCodeIndex({
        root: props.root,
        query: text,
        mode,
        context: true,
        limit: 12
      }));
      setStatus(await window.agentAPI.getCodeIndexStatus(props.root));
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  };

  const saveMemory = async () => {
    if (!memoryTitle.trim() || !memoryContent.trim()) return;
    setMemoryNote('');
    try {
      await window.agentAPI.rememberCodeMemory({
        root: props.root,
        kind: memoryKind,
        title: memoryTitle.trim(),
        content: memoryContent.trim(),
        source: 'user',
        status: 'confirmed',
        confidence: 0.95
      });
      setMemoryTitle('');
      setMemoryContent('');
      setMemoryNote('已保存为已确认记忆；切到「只看工程记忆」可检索。');
    } catch (next) {
      setMemoryNote(next instanceof Error ? next.message : String(next));
    }
  };

  return (
    <section className="card code-index-card">
      <div className="row">
        <h2>工程索引</h2>
        <span className="muted">
          {status === null
            ? '读取中…'
            : status.generation === null
              ? '未建立'
              : `generation ${String(status.generation)}`}
        </span>
      </div>
      {status && status.generation !== null && (
        <p className="muted code-index-counts">
          {status.files} 文件 · {status.nodes} 节点 · {status.edges} 边 · {status.docs} 文档
        </p>
      )}
      <p className="muted">
        本地 AST + SQLite FTS5；没有 Python/Neo4j 时也能用。建立后模型可通过
        <code> code.search </code> 查询同一份索引。
      </p>
      <div className="code-index-actions">
        <button className="btn" type="button" disabled={busy} onClick={() => void build()}>
          {busy ? '处理中…' : status?.generation == null ? '建立索引' : '更新索引'}
        </button>
        <input
          ref={queryRef}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') void search(); }}
          placeholder="搜索符号 / 错误码 / 中文注释"
        />
        <select value={mode} onChange={event => setMode(event.target.value as CodeIndexMode)}>
          <option value="HYBRID">CODE + 记忆</option>
          <option value="CODE">只看代码</option>
          <option value="MEMORY">只看工程记忆</option>
        </select>
        <button className="btn" type="button" disabled={busy} onClick={() => void search()}>
          检索
        </button>
      </div>
      <details className="code-index-memory">
        <summary>记住一条工程事实</summary>
        <div className="code-index-memory-form">
          <select value={memoryKind} onChange={event => setMemoryKind(event.target.value as typeof memoryKind)}>
            <option value="decision">决策</option>
            <option value="constraint">约束</option>
            <option value="fact">事实</option>
            <option value="issue">历史问题</option>
            <option value="solution">解决方案</option>
            <option value="debate">辩论结论</option>
          </select>
          <input value={memoryTitle} onChange={event => setMemoryTitle(event.target.value)} placeholder="标题，例如：订单必须幂等" />
          <textarea value={memoryContent} onChange={event => setMemoryContent(event.target.value)} rows={3} placeholder="内容与依据" />
          <button className="btn" type="button" disabled={!memoryTitle.trim() || !memoryContent.trim()} onClick={() => void saveMemory()}>
            保存为已确认
          </button>
          {memoryNote && <p className="muted">{memoryNote}</p>}
        </div>
      </details>
      {error && <div className="error">{error}</div>}
      {result && (
        <div className="code-index-result">
          <p className="muted">
            {lastRequest ? `最近检索：${lastRequest} · ` : ''}{result.items.length} 条 · 来源 {Object.entries(result.sources).filter(([, value]) => value).map(([key]) => key).join(' / ') || '无'}
            {result.stale ? ' · 索引未 READY' : ''}
          </p>
          {result.warnings.map((warning, index) => <p key={index} className="muted">· {warning}</p>)}
          {result.items.length === 0 ? (
            <p className="muted">没有命中；这不等于事实不存在。</p>
          ) : (
            <ul className="code-index-hits">
              {result.items.map(item => (
                <li key={`${item.kind}-${item.id}`}>
                  <span className={`exec-badge ${item.kind === 'code' ? 'is-call' : 'is-possible'}`}>
                    {item.kind === 'code' ? '代码' : '记忆'}
                  </span>
                  <b>{item.title}</b>
                  {item.filePath && (
                    <code>{item.filePath}{item.line ? `:${String(item.line)}` : ''}</code>
                  )}
                  <span className="muted">{item.source} · {item.confidence.toFixed(2)}</span>
                  {item.status && <span className="exec-badge is-possible">{item.status}</span>}
                  <p>{item.content.slice(0, 280)}</p>
                </li>
              ))}
            </ul>
          )}
          {result.context && (
            <details className="code-index-context">
              <summary>组装后的上下文（{result.context.length} 字符）</summary>
              <pre>{result.context}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
