import React from 'react';
import type { LearnedRole, SelectorRole } from '../../../shared/selectors';

/**
 * What one press of 「更新样式」 found, written into the diagnostics panel.
 *
 * It used to be a dialog of its own, because the result was once a line of text
 * in a bar that can be dragged down to 380px. The repair lives in the panel now,
 * so the result belongs directly under the problem that caused it — stacking a
 * second modal over the panel just to say "已重新提取 2 项" hides the numbers
 * the user pressed the button to fix.
 *
 * The role list is the part that makes the claim checkable: *which* roles were
 * repaired, and the selectors that were written down.
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

export function RepairSummary({ report }: { report: StyleReportData }) {
  const stateOf = (role: string): 'learned' | 'ok' | 'missing' | 'unknown' => {
    if (report.learned.some(item => item.role === role)) return 'learned';
    if (report.intact.includes(role as SelectorRole)) return 'ok';
    if (report.failed.includes(role as SelectorRole)) return 'missing';
    return 'unknown';
  };

  const stateText = { learned: '已重新提取', ok: '正常', missing: '未找到', unknown: '未检查' } as const;

  return (
    <section className="diag-repair">
      <h3>
        更新样式 · {report.sourceLabel}
      </h3>
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
    </section>
  );
}
