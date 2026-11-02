import React, { useEffect, useRef, useState } from 'react';
import type { PermissionPreset } from '../../../shared/contracts';

const PERMISSIONS: Array<{ value: PermissionPreset; label: string; desc: string }> = [
  { value: 'read-only', label: '仅可查看', desc: '列目录、读文件，不允许写入' },
  { value: 'workspace-write', label: '工作区内修改', desc: '只允许改动本次授权目录' },
  { value: 'danger-full-access', label: '完全权限', desc: '受 macOS 用户权限与 TCC 约束' }
];

/** The same three labels are shown in 设置 · 通用设置, so they are defined once. */
export { PERMISSIONS };

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return parts[parts.length - 1];
}

export function TaskInput(props: {
  value: string;
  workspace: string;
  permission: PermissionPreset;
  disabled?: boolean;
  busy?: boolean;
  /** Lets the shell move the caret into the composer, e.g. after "新任务". */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onPermissionChange: (preset: PermissionPreset) => void;
  onChooseWorkspace: () => void;
  onSubmit: () => void;
}) {
  const [menu, setMenu] = useState<'none' | 'permission'>('none');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (menu === 'none') return;
    function onDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setMenu('none');
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      // Enter is always forwarded, even with an empty box: the shell answers
      // "write a goal first" instead of swallowing the keystroke.
      if (!props.disabled) props.onSubmit();
    }
  }

  const permission = PERMISSIONS.find(item => item.value === props.permission) ?? PERMISSIONS[1];

  return (
    <div className="composer" style={{ position: 'relative' }} ref={rootRef}>
      <textarea
        className="composer-input"
        rows={2}
        ref={props.inputRef}
        value={props.value}
        disabled={props.disabled}
        placeholder="问点什么，或说要改哪个文件"
        onChange={event => props.onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />

      <div className="composer-bar">
        <div className="chips">
          <button className="chip-btn" type="button" onClick={props.onChooseWorkspace} disabled={props.disabled}>
            <span>▤</span>
            <span className="label">{props.workspace ? shortPath(props.workspace) : '选择工作区'}</span>
            <span className="caret">▾</span>
          </button>

          <button
            className="chip-btn"
            type="button"
            disabled={props.disabled}
            onClick={() => setMenu(menu === 'permission' ? 'none' : 'permission')}
          >
            <span>◐</span>
            <span className="label">{permission.label}</span>
            <span className="caret">▾</span>
          </button>
        </div>

        <div className="chips">
          <span className="hint">Enter 发送</span>
          <button
            className="send"
            type="button"
            title="发送任务"
            disabled={props.disabled || !props.value.trim()}
            onClick={props.onSubmit}
          >
            {props.busy ? '·' : '↑'}
          </button>
        </div>
      </div>

      {menu === 'permission' && (
        <div className="popover" style={{ left: 12, bottom: 46 }}>
          {PERMISSIONS.map(item => (
            <button
              key={item.value}
              className={`popover-item ${item.value === props.permission ? 'active' : ''}`}
              type="button"
              onClick={() => {
                props.onPermissionChange(item.value);
                setMenu('none');
              }}
            >
              <b>{item.label}</b>
              <small>{item.desc}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
