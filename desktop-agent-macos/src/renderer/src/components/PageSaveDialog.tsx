import React, { useEffect, useMemo, useState } from 'react';
import type { PageExtractPreview } from '../../../shared/export';

/**
 * 「保存网页对话」的多选面板。
 *
 * 网页里读到的回答往往不止一条（一场聊天会、一页问答记录），以前点保存
 * 只能整页存下来。这里按微信多选的做法先列出来：
 *
 * - 勾一条存一条（合并成一个文件）——`合并保存`；
 * - 每条各存一个文件——`逐条保存`；
 * - 不勾了，直接 `全部保存` 存整页。
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

  return (
    <div className="diag-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="diag-panel page-save-panel" role="dialog" aria-label="保存网页对话">
        <div className="diag-head">
          <b>保存网页对话</b>
          <span className="muted page-save-source" title={preview.url}>
            {preview.sourceLabel}{preview.pageTitle ? ` · ${preview.pageTitle}` : ''}
          </span>
          <div className="diag-actions">
            <button className="btn ghost" type="button" onClick={onClose}>关闭</button>
          </div>
        </div>

        <div className="diag-body">
          <p className="muted">
            这一页读到 {preview.items.length} 条对话，共 {preview.totalChars} 字。
            勾选要保存的内容；保存时正文由主进程去页面里现读，不经过模型。
          </p>

          <div className="page-save-toolbar">
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
            <span className="muted">
              已选 {selectedIndexes.length}/{preview.items.length} 条 · {selectedChars} 字
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

          <div className="page-save-list">
            {preview.items.length === 0 && (
              <p className="muted">这一页没有可保存的对话（可能停在登录页或空会话）。</p>
            )}
            {preview.items.map(item => (
              <label
                key={item.index}
                className={`page-save-item${selected.has(item.index) ? ' on' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(item.index)}
                  disabled={busy}
                  onChange={() => toggle(item.index)}
                />
                <span className="page-save-item-body">
                  <span className="page-save-item-title">
                    对话 {item.index + 1} · {item.title}
                  </span>
                  <span className="page-save-item-excerpt">{item.excerpt || '（这条没有正文）'}</span>
                </span>
                <span className="page-save-item-chars">{item.chars} 字</span>
              </label>
            ))}
          </div>
        </div>

        {/* 动作条照微信多选：先选，再决定合并还是逐条；全部保存是给「不想挑」的那一次。 */}
        <div className="page-save-actions">
          <button
            className="btn"
            type="button"
            disabled={disabled || nothingSelected}
            onClick={() => onSave({ documents: selectedIndexes, mode: 'merge', includeTranscript })}
          >
            合并保存{format === 'docx' ? '（Word）' : ''}
          </button>
          <button
            className="btn ghost"
            type="button"
            disabled={disabled || nothingSelected || selectedIndexes.length === 0}
            title="每条对话各存一个文件，放在同一个文件夹里；不附页面转录"
            onClick={() => onSave({ documents: selectedIndexes, mode: 'per-item', includeTranscript: false })}
          >
            逐条保存
          </button>
          <button
            className="btn ghost"
            type="button"
            disabled={disabled}
            onClick={() => onSave({ documents: allIndexes, mode: 'merge', includeTranscript })}
          >
            全部保存
          </button>
          <span className="settings-spacer" />
          <span className="muted">
            {busy ? '正在保存…' : '合并保存 = 选中的写在同一个文件里'}
          </span>
        </div>
      </div>
    </div>
  );
}
