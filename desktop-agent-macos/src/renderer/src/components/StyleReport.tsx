import React, { useEffect } from 'react';
import type { LearnedRole, SelectorRole } from '../../../shared/selectors';

/**
 * What one press of 「更新样式」 found, as a dialog.
 *
 * It used to be a line of text inside the page bar, and that was wrong for a
 * measurable reason: the bar lives in the page pane, which can be dragged down to
 * 380px, and the sentence is longer than the space left after the buttons. The
 * result was `DeepSeek：输入框和发送键都正常；回答区域要等页面上有一条…` — the
 * one clause that matters, cut off.
 *
 * A dialog also has room for the part that was never shown at all: *which* roles
 * were repaired, and the selectors that were written down. Without that, "已重新
 * 提取 2 项" is a claim the user cannot check.
 */
export interface StyleReportData {
  sourceLabel: string;
  message: string;
  learned: LearnedRole[];
  intact: SelectorRole[];
  failed: SelectorRole[];
  probe: {
    hasInput: boolean;
    hasSendButton: boolean;
    messageCount: number;
    viewportWidth: number;
  } | null;
}

const ROLE_LABEL: Record<string, string> = {
  input: '输入框',
  sendButton: '发送键',
  assistant: '回答区域'
};

/** The three roles a repair can touch, in the order a person thinks about them. */
const ROLE_ORDER = ['input', 'sendButton', 'assistant'] as const;

export function StyleReport({ report, onClose }: { report: StyleReportData; onClose: () => void }) {
  // Escape has to work: this is a modal over the app column, and a dialog that
  // can only be dismissed with the mouse is a trap on a keyboard-driven machine.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stateOf = (role: string): 'learned' | 'ok' | 'missing' | 'unknown' => {
    if (report.learned.some(item => item.role === role)) return 'learned';
    if (report.intact.includes(role as SelectorRole)) return 'ok';
    if (report.failed.includes(role as SelectorRole)) return 'missing';
    return 'unknown';
  };

  const stateText = { learned: '已重新提取', ok: '正常', missing: '未找到', unknown: '未检查' } as const;

  return (
    <div className="diag-overlay" role="dialog" aria-modal="true" aria-label="更新样式结果" onClick={onClose}>
      <div className="diag-panel style-panel" onClick={event => event.stopPropagation()}>
        <header className="diag-head">
          <b>更新样式 · {report.sourceLabel}</b>
          <div className="diag-actions">
            <button className="btn ghost" type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        <div className="diag-body">
          <p className="style-lead">{report.message}</p>

          <ul className="style-roles">
            {ROLE_ORDER.map(role => {
              const state = stateOf(role);
              return (
                <li key={role} className={`style-role s-${state}`}>
                  <span className="style-role-name">{ROLE_LABEL[role]}</span>
                  <span className="style-badge">{stateText[state]}</span>
                </li>
              );
            })}
          </ul>

          {report.learned.length > 0 && (
            <div className="style-selectors">
              <p className="style-selectors-label">已保存到本机，只在当前站点生效；内置选择器仍然优先。</p>
              {report.learned.map(item => (
                <code key={item.role}>
                  {ROLE_LABEL[item.role] ?? item.role} → {item.selector}
                </code>
              ))}
            </div>
          )}

          {report.probe && (
            <p className="style-probe">
              页面 {report.probe.viewportWidth}px 宽 · {report.probe.messageCount} 条回答 · 输入框
              {report.probe.hasInput ? '可用' : '不可用'} · 发送键{report.probe.hasSendButton ? '可用' : '不可用'}
            </p>
          )}
        </div>

        <footer className="style-foot">
          <button className="btn" type="button" onClick={onClose}>
            知道了
          </button>
        </footer>
      </div>
    </div>
  );
}
