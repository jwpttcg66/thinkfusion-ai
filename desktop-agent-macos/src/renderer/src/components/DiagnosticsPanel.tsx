import React, { useEffect, useState } from 'react';
import type { DeepSeekDiagnostics, ViewBoundsMap } from '../../../shared/contracts';
import { RepairSummary, type StyleReportData } from './StyleReport';

export interface DiagnosticsChannel {
  id: string;
  label: string;
  available: boolean;
}

interface Props {
  report: DeepSeekDiagnostics | null;
  loading: boolean;
  /** True while 「更新样式」 is re-reading the page. */
  repairing: boolean;
  /** The channel the user picked; the report may be one step behind it. */
  channelId: string;
  channels: DiagnosticsChannel[];
  /** The last repair on this channel, shown in place instead of in a dialog. */
  repair: StyleReportData | null;
  onSelectChannel: (id: string) => void;
  onClose: () => void;
  onRefresh: () => void;
  onReload: () => void;
  onRepair: () => void;
}

/**
 * Raw view of what the page probe actually found, per channel.
 *
 * Every selector is a guess about markup we do not control. When one stops
 * matching, the only useful artefact is the hit count per candidate — a zero
 * next to a selector is the whole diagnosis. This panel exists so that fact is
 * visible instead of being flattened into "页面异常".
 *
 * It is a *channel* report, not a page report: with four pages open, "which one
 * did you read" is half the answer. The chips pick a channel and the numbers
 * below belong to it.
 *
 * The view positions at the bottom are here for the same reason. A page view
 * that overlaps the source rail makes the buttons dead with no error anywhere,
 * because the covering element is native and therefore absent from the DOM.
 * Printing the rectangles turns that invisible failure into a red line.
 */
export function DiagnosticsPanel({
  report,
  loading,
  repairing,
  channelId,
  channels,
  repair,
  onSelectChannel,
  onClose,
  onRefresh,
  onReload,
  onRepair
}: Props) {
  const [copied, setCopied] = useState(false);
  const [bounds, setBounds] = useState<ViewBoundsMap>({});

  useEffect(() => {
    window.agentAPI
      .getViewBounds()
      .then(setBounds)
      .catch(() => undefined);
  }, [report]);

  useEffect(() => {
    // Escape has to work: this covers the app column, and a panel that can only
    // be dismissed with the mouse is a trap on a keyboard-driven machine.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const views = Object.entries(bounds);
  const railLeft = document.querySelector('.source-rail')?.getBoundingClientRect().left ?? window.innerWidth;

  async function copy() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify({ report, views: bounds }, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const hits = Object.entries(report?.probe.selectorHits ?? {});
  // The channel this report belongs to. Falls back to the selection so the
  // header still names something during the first read.
  const shownId = report?.sourceId ?? channelId;
  const shown = channels.find(channel => channel.id === shownId) ?? null;
  const problems = problemsOf(report);

  return (
    <div className="diag-overlay" role="dialog" aria-modal="true" aria-label="通道诊断">
      <div className="diag-panel">
        <header className="diag-head">
          <b>通道诊断</b>
          <span className="muted">{shown ? `${shown.label} · probe v${report?.probeVersion ?? '?'}` : `probe v${report?.probeVersion ?? '?'}`}</span>
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

        {/* Which channel these numbers are about. Two or more pages are always
            open, so a report that cannot say whose it is invites exactly the
            mistake this panel exists to catch. */}
        {channels.length > 1 && (
          <div className="diag-channels" role="tablist" aria-label="选择通道">
            {channels.map(channel => (
              <button
                key={channel.id}
                type="button"
                role="tab"
                aria-selected={channel.id === shownId}
                className={`diag-channel${channel.id === shownId ? ' on' : ''}`}
                onClick={() => onSelectChannel(channel.id)}
                disabled={loading || repairing}
              >
                <span className={`page-dot${channel.available ? ' ok' : ' warn'}`} aria-hidden="true" />
                {channel.label}
              </button>
            ))}
          </div>
        )}

        {!report ? (
          <p className="muted diag-empty">{loading ? '正在读取页面…' : '暂无报告'}</p>
        ) : (
          <div className="diag-body">
            {problems.length > 0 && (
              <section className="diag-problem">
                <h3>
                  发现 {problems.length} 个问题<span className="diag-warn">，这个通道现在不可靠</span>
                </h3>
                <ul>
                  {problems.map(problem => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
                {/* The repair lives here, not in the page bar. Pressing it is a
                    reaction to a bad reading, so it belongs next to the reading —
                    and a bar button that is meaningless nine days out of ten was
                    taking the space of the two you actually use. */}
                <div className="diag-fix">
                  <button className="btn" type="button" onClick={onRepair} disabled={repairing}>
                    {repairing ? '正在重新提取…' : '更新样式'}
                  </button>
                  <span className="muted">
                    重新读一遍这个页面，修好提问与读取回答；只改本站，登录和会话都不动。
                  </span>
                </div>
              </section>
            )}

            {problems.length === 0 && (
              <section className="diag-ok">
                <h3>没有发现问题</h3>
                <p className="muted">输入框和发送键都能找到，页面也没报错。只有网页改版之后才需要重建样式。</p>
              </section>
            )}

            {repair && <RepairSummary report={repair} />}

            <section>
              <h3>页面状态</h3>
              <dl className="diag-grid">
                <dt>通道</dt>
                <dd>{shown ? shown.label : shownId || '(未知)'}</dd>
                <dt>地址</dt>
                <dd className="mono">{report.url || '(空白)'}</dd>
                <dt>标题</dt>
                <dd>{report.title || '(无)'}</dd>
                <dt>输入框</dt>
                <dd>
                  {report.probe.hasInput ? `找到（${report.probe.inputKind}）` : '未找到'}
                </dd>
                <dt>发送按钮</dt>
                <dd>
                  {report.probe.hasSendButton
                    ? '找到'
                    : !report.probe.hasInput
                      ? // Nothing to send from: the missing button is the missing
                        // input box, and saying "输入文字后才会出现" here would
                        // suggest the composer is fine.
                        '未找到（这一页没有输入框）'
                      : report.probe.composerChars > 0
                        ? '未找到（将回退到回车）'
                        : '未找到（输入文字后才会出现）'}
                </dd>
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
                <dt>结论</dt>
                <dd>{report.status.detail ?? '正常'}</dd>
              </dl>
            </section>

            <section>
              <h3>命中的选择器</h3>
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
              {/* Not a red list. Every site ships the candidates for all the
                  layouts it might serve, so a page that is working perfectly
                  still shows a column of zeros — counting them as "20 个未命中"
                  sent people looking for a fault that was not there. */}
              <p className="diag-note">
                0 只说明这条候选不在当前页面上，不代表故障；只有输入框或发送键「未找到」才是真问题。
              </p>
              <ul className="diag-hits">
                {hits.map(([selector, count]) => (
                  <li key={selector} className={count <= 0 ? 'zero' : ''}>
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

            <section>
              <h3>页面视图位置</h3>
              <ul className="diag-hits">
                {views.length === 0 && <li className="muted">还没有创建任何页面视图</li>}
                {views.map(([id, rect]) => {
                  const parked = rect.x >= window.innerWidth;
                  const coversRail = !parked && rect.x + rect.width > railLeft;
                  return (
                    <li key={id} className={coversRail ? 'dead' : ''}>
                      <span className="mono">{id}</span>
                      <b>
                        {parked
                          ? '停到窗口外'
                          : coversRail
                            ? '压住来源栏'
                            : `${rect.width}×${rect.height} @ x=${rect.x}`}
                      </b>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * What is actually broken, in the order it matters.
 *
 * Only conditions that stop the channel from working count. A missing
 * `messageCount` on a site that does not expose its turns in the DOM is not a
 * fault — it is a fact about that site, and saying so would make every healthy
 * ChatGPT page look broken. An empty address is not "未找到输入框": nothing has
 * loaded yet, and the one thing worth trying is a reload.
 */
function problemsOf(report: DeepSeekDiagnostics | null): string[] {
  if (!report) return [];
  const problems: string[] = [];

  if (!report.url) {
    problems.push('页面是空白的，没有打开任何地址');
    return problems;
  }
  if (!report.status.pageReady && report.probe.hasInput && report.probe.hasSendButton) {
    // Only when the probe itself found nothing wrong. Otherwise this sentence
    // and "找不到输入框" describe the same missing element in two voices, and a
    // list that repeats itself reads as two separate faults.
    problems.push(report.status.detail ?? '页面还没有就绪');
  }
  if (!report.probe.hasInput) {
    problems.push('找不到输入框，问题发不出去');
  }
  // Gemini only renders its send button once the composer has text, so a
  // missing one on an empty box is the normal state — and calling it a fault
  // would put a red block and a repair button on a page that is working.
  if (!report.probe.hasSendButton && report.probe.composerChars > 0) {
    problems.push('输入框里有字却找不到发送按钮，这一页只能靠回车发送');
  }

  return problems;
}
