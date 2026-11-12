import React, { useEffect, useRef, useState } from 'react';
import type { CodeIndexMemory, CodeIndexMode, CodeIndexSearchResult, CodeIndexStatus } from '../../../shared/code-index';

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
  const [vectorNote, setVectorNote] = useState('');
  const [memories, setMemories] = useState<CodeIndexMemory[]>([]);
  const [linkMemoryId, setLinkMemoryId] = useState('');
  const [linkNote, setLinkNote] = useState('');
  const [deleteExternal, setDeleteExternal] = useState(false);
  const [deleteNote, setDeleteNote] = useState('');

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

  const refreshMemories = async () => {
    try {
      const list = await window.agentAPI.listCodeMemories(props.root);
      setMemories(list);
      if (!linkMemoryId && list[0]) setLinkMemoryId(list[0].factId);
    } catch {
      // 记忆列表失败不挡检索
    }
  };

  useEffect(() => {
    void refreshMemories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const buildVectors = async () => {
    setBusy(true);
    setError('');
    setVectorNote('');
    try {
      const result = await window.agentAPI.buildCodeVectors(props.root);
      setVectorNote(`已建 ${String(result.count)} 条向量（${result.model}）`);
      setStatus(await window.agentAPI.getCodeIndexStatus(props.root));
    } catch (next) {
      setVectorNote(next instanceof Error ? next.message : String(next));
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
      await refreshMemories();
    } catch (next) {
      setMemoryNote(next instanceof Error ? next.message : String(next));
    }
  };

  const linkItem = async (filePath: string, line: number) => {
    if (!linkMemoryId) {
      setLinkNote('先在下方选择一条记忆');
      return;
    }
    try {
      await window.agentAPI.linkCodeMemory({
        root: props.root,
        filePath,
        line,
        memoryEntityId: linkMemoryId,
        linkType: 'HISTORY_EXPLAINS_CODE'
      });
      setLinkNote(`已关联：${filePath}:${String(line)}`);
    } catch (next) {
      setLinkNote(next instanceof Error ? next.message : String(next));
    }
  };

  const deleteIndex = async () => {
    if (!window.confirm('删除这个工程的索引、记忆、关联和向量？此操作不可撤销。')) return;
    setBusy(true);
    setDeleteNote('');
    try {
      const result = await window.agentAPI.deleteCodeIndex(props.root, deleteExternal);
      setStatus(await window.agentAPI.getCodeIndexStatus(props.root));
      setResult(null);
      setDeleteNote(`已删除本地 ${String(Object.values(result.local).reduce((sum, value) => sum + Number(value), 0))} 条记录${result.external > 0 ? `；CGC ${String(result.external)} 个节点` : ''}${result.warnings.length > 0 ? `；${result.warnings.join('；')}` : ''}`);
    } catch (next) {
      setDeleteNote(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
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
          {status.vectors > 0 ? ` · ${String(status.vectors)} 向量` : ''}
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
      <details className="code-index-danger">
        <summary>危险操作：删除工程索引</summary>
        <label>
          <input type="checkbox" checked={deleteExternal} onChange={event => setDeleteExternal(event.target.checked)} />
          同时清理外部 CGC（按 THINKFUSION_CGC_PROJECT_PATH；Graphiti 未建 group 映射，不会删除）
        </label>
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void deleteIndex()}>删除索引</button>
        {deleteNote && <p className="muted">{deleteNote}</p>}
      </details>
      {vectorNote && <p className="muted">{vectorNote}</p>}
      {error && <div className="error">{error}</div>}
      {result && (
        <div className="code-index-result">
          <p className="muted">
            {lastRequest ? `最近检索：${lastRequest} · ` : ''}{result.items.length} 条 · 来源 {Object.entries(result.sources).filter(([, value]) => value).map(([key]) => key).join(' / ') || '无'}
            {result.stale ? ' · 索引未 READY' : ''}
          </p>
          {result.warnings.map((warning, index) => <p key={index} className="muted">· {warning}</p>)}
          {memories.length > 0 && (
            <div className="code-index-link-row">
              <span className="muted">关联到记忆</span>
              <select value={linkMemoryId} onChange={event => setLinkMemoryId(event.target.value)}>
                {memories.map(memory => (
                  <option key={memory.factId} value={memory.factId}>
                    [{memory.status}] {memory.title}
                  </option>
                ))}
              </select>
              {linkNote && <span className="muted">{linkNote}</span>}
            </div>
          )}
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
                  {item.kind === 'code' && item.filePath && item.source !== 'CGC' && (
                    <button className="btn ghost" type="button" onClick={() => void linkItem(item.filePath!, item.line ?? 1)}>
                      关联到选中记忆
                    </button>
                  )}
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
