import React, { useState } from 'react';
import type { DeepSeekDiagnostics } from '../../../shared/contracts';

interface Props {
  report: DeepSeekDiagnostics | null;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onReload: () => void;
}

/**
 * Raw view of what the page probe actually found.
 *
 * Every selector is a guess about markup we do not control. When one stops
 * matching, the only useful artefact is the hit count per candidate — a zero
 * next to a selector is the whole diagnosis. This panel exists so that fact is
 * visible instead of being flattened into "页面异常".
 */
export function DiagnosticsPanel({ report, loading, onClose, onRefresh, onReload }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const hits = Object.entries(report?.probe.selectorHits ?? {});
  const dead = hits.filter(([, count]) => count <= 0);

  return (
    <div className="diag-overlay" role="dialog" aria-label="页面诊断">
      <div className="diag-panel">
        <header className="diag-head">
          <b>内嵌页面诊断</b>
          <span className="muted">probe v{report?.probeVersion ?? '?'}</span>
          <div className="diag-actions">
            <button className="btn ghost" type="button" onClick={onRefresh} disabled={loading}>
              {loading ? '检测中…' : '重新检测'}
            </button>
            <button className="btn ghost" type="button" onClick={onReload}>
              重新加载页面
            </button>
            <button className="btn ghost" type="button" onClick={copy} disabled={!report}>
              {copied ? '已复制' : '复制报告'}
            </button>
            <button className="btn ghost" type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        {!report ? (
          <p className="muted diag-empty">{loading ? '正在读取页面…' : '暂无报告'}</p>
        ) : (
          <div className="diag-body">
            <section>
              <h3>页面状态</h3>
              <dl className="diag-grid">
                <dt>地址</dt>
                <dd className="mono">{report.url || '(空白)'}</dd>
                <dt>标题</dt>
                <dd>{report.title || '(无)'}</dd>
                <dt>输入框</dt>
                <dd>
                  {report.probe.hasInput ? `找到（${report.probe.inputKind}）` : '未找到'}
                </dd>
                <dt>发送按钮</dt>
                <dd>{report.probe.hasSendButton ? '找到' : '未找到（将回退到回车）'}</dd>
                <dt>正在生成</dt>
                <dd>{report.probe.generating ? '是' : '否'}</dd>
                <dt>已识别回答</dt>
                <dd>{report.probe.messageCount} 条</dd>
                <dt>页面视图</dt>
                <dd className="mono">
                  {report.view
                    ? `${report.view.width}×${report.view.height} @ x=${report.view.x}${report.dragging ? '（拖动中，已临时移出窗口）' : ''}`
                    : '尚未创建'}
                </dd>
                <dt>诊断</dt>
                <dd>{report.status.detail ?? '正常'}</dd>
              </dl>
            </section>

            <section>
              <h3>
                命中的选择器
                {dead.length > 0 && <span className="diag-warn"> · {dead.length} 个未命中</span>}
              </h3>
              <dl className="diag-grid">
                {Object.entries(report.probe.chosen).length === 0 && (
                  <dd className="muted">全部走结构回退，没有选择器命中</dd>
                )}
                {Object.entries(report.probe.chosen).map(([role, selector]) => (
                  <React.Fragment key={role}>
                    <dt>{role}</dt>
                    <dd className="mono">{selector}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>

            <section>
              <h3>各候选命中数</h3>
              <ul className="diag-hits">
                {hits.map(([selector, count]) => (
                  <li key={selector} className={count <= 0 ? 'dead' : ''}>
                    <span className="mono">{selector}</span>
                    <b>{count < 0 ? '语法错误' : count}</b>
                  </li>
                ))}
              </ul>
            </section>

            {report.probe.lastTextPreview && (
              <section>
                <h3>最后一条回答（截断）</h3>
                <pre className="diag-preview">{report.probe.lastTextPreview}</pre>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
