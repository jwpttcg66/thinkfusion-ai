import React, { useEffect, useMemo, useState } from 'react';
import type { PageExtractPreview } from '../../../shared/export';

/**
 * 「保存网页对话」的多选面板。
 *
 * 网页里读到的回答往往不止一条（一场聊天会、一页问答记录），以前点保存
 * 只能整页存下来。这里照微信多选的样子先列出来：
 *
 * - 左边一个圆点，点一下勾选，整行变浅绿；
 * - 每条是一颗对话气泡，谁说的、多少字都在一行里；
 * - 底部动作条：逐条保存 / 合并保存 / 全部保存 / 取消。
 *
 * 面板不做提取，只是把主进程读到的预览画出来；点保存时只回传下标，
 * 正文仍由主进程去页面里现读，避免列表和落盘内容来自两个时刻。
 */
export function PageSaveDialog({
  preview,
  format,
  busy,
  onClose,
  onSave
}: {
  preview: PageExtractPreview;
  format: 'md' | 'docx';
  busy: boolean;
  onClose: () => void;
  onSave: (input: { documents: number[]; mode: 'merge' | 'per-item'; includeTranscript: boolean }) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [includeTranscript, setIncludeTranscript] = useState(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const allIndexes = useMemo(() => preview.items.map(item => item.index), [preview.items]);
  const selectedIndexes = useMemo(
    () => allIndexes.filter(index => selected.has(index)),
    [allIndexes, selected]
  );
  const selectedChars = useMemo(
    () => preview.items
      .filter(item => selected.has(item.index))
      .reduce((sum, item) => sum + item.chars, 0),
    [preview.items, selected]
  );

  function toggle(index: number) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const disabled = busy || preview.items.length === 0;
  const nothingSelected = selectedIndexes.length === 0;
  // 每条都来自同一个网页源；头像先用源名的首字，和会话列表里的站点记号一致。
  const avatar = (preview.sourceLabel || '?').trim().slice(0, 1).toUpperCase();

  return (
    <div className="diag-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="diag-panel page-save-panel" role="dialog" aria-label="保存网页对话">
        <div className="diag-head">
          <b>保存网页对话</b>
          <span className="muted page-save-source" title={preview.url}>
            {preview.sourceLabel}{preview.pageTitle ? ` · ${preview.pageTitle}` : ''}
          </span>
          <div className="diag-actions">
            <button
              className="btn ghost" type="button"
              disabled={disabled || selectedIndexes.length === preview.items.length}
              onClick={() => setSelected(new Set(allIndexes))}
            >
              全选
            </button>
            <button
              className="btn ghost" type="button"
              disabled={disabled || nothingSelected}
              onClick={() => setSelected(new Set())}
            >
              清空
            </button>
            <button className="btn ghost" type="button" onClick={onClose}>关闭</button>
          </div>
        </div>

        <div className="diag-body page-save-body">
          <p className="muted page-save-lead">
            这一页读到 {preview.items.length} 条消息，共 {preview.totalChars} 字。
            绿色是你在页面里问的，白色是回答；点左边的圆点勾选要保存的。
          </p>

          <div className="chat-pick-list">
            {preview.items.length === 0 && (
              <p className="muted">这一页没有可保存的对话（可能停在登录页或空会话）。</p>
            )}
            {preview.items.map(item => {
              const mine = item.role === 'user';
              return (
                <React.Fragment key={item.index}>
                  <div className="chat-pick-stamp">
                    第 {item.index + 1} 条 · {mine ? '我问的' : '回答'} · {item.chars} 字
                  </div>
                  <label className={`chat-pick-row${selected.has(item.index) ? ' on' : ''}${mine ? ' is-user' : ' is-assistant'}`}>
                    <input
                      className="chat-pick-input"
                      type="checkbox"
                      checked={selected.has(item.index)}
                      disabled={busy}
                      onChange={() => toggle(item.index)}
                      aria-label={`选择第 ${item.index + 1} 条（${mine ? '提问' : '回答'}）：${item.title}`}
                    />
                    <span className="chat-pick-check" aria-hidden="true" />
                    {!mine && (
                      <span className="chat-pick-avatar" aria-hidden="true" title={preview.sourceLabel}>{avatar}</span>
                    )}
                    <span className="chat-pick-bubble">
                      <span className="chat-pick-title">{item.title}</span>
                      <span className="chat-pick-text">{item.excerpt || '（这条没有正文）'}</span>
                    </span>
                    {mine && (
                      <span className="chat-pick-avatar is-me" aria-hidden="true" title="我">我</span>
                    )}
                  </label>
                </React.Fragment>
              );
            })}
          </div>

          <div className="page-save-summary">
            <span className="muted">
              已选 {selectedIndexes.length}/{preview.items.length} 条 · {selectedChars} 字
              {nothingSelected ? '' : ` · 合并为 1 个文件，或逐条存 ${selectedIndexes.length} 个文件`}
            </span>
            <span className="settings-spacer" />
            <label className="page-save-transcript" title="把页面完整转录作为附录；逐条保存时不附，避免每个文件都复制一份">
              <input
                type="checkbox"
                checked={includeTranscript}
                onChange={event => setIncludeTranscript(event.target.checked)}
              />
              附页面转录
            </label>
          </div>
        </div>

        {/* 动作条照微信多选：图标在上、文字在下；区别写在副标题里，不让人猜。 */}
        <div className="chat-pick-actions">
          <button
            className="chat-pick-action"
            type="button"
            disabled={disabled || nothingSelected}
            title="每条对话各存一个文件，放在同一个文件夹里；不附页面转录"
            onClick={() => onSave({ documents: selectedIndexes, mode: 'per-item', includeTranscript: false })}
          >
            <span className="chat-pick-action-icon" aria-hidden="true">☰</span>
            <b>逐条保存</b>
            <span>{nothingSelected ? '先勾选' : `${selectedIndexes.length} 个文件`}</span>
          </button>
          <button
            className="chat-pick-action"
            type="button"
            disabled={disabled || nothingSelected}
            title="把勾选的对话按顺序写进同一个文件"
            onClick={() => onSave({ documents: selectedIndexes, mode: 'merge', includeTranscript })}
          >
            <span className="chat-pick-action-icon" aria-hidden="true">⧉</span>
            <b>合并保存</b>
            <span>{nothingSelected ? '先勾选' : `1 个文件 · ${selectedIndexes.length} 条`}</span>
          </button>
          <button
            className="chat-pick-action"
            type="button"
            disabled={disabled}
            title="不管勾选，整页所有对话存成一个文件"
            onClick={() => onSave({ documents: allIndexes, mode: 'merge', includeTranscript })}
          >
            <span className="chat-pick-action-icon" aria-hidden="true">⇩</span>
            <b>全部保存</b>
            <span>全部 {preview.items.length} 条</span>
          </button>
          <span className="chat-pick-divider" aria-hidden="true" />
          <button className="chat-pick-action" type="button" onClick={onClose}>
            <span className="chat-pick-action-icon" aria-hidden="true">✕</span>
            <b>取消</b>
            <span>{busy ? '正在保存…' : format === 'docx' ? 'Word' : 'Markdown'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
