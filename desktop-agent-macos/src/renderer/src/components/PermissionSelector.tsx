import React from 'react';
import type { PermissionPreset } from '../../../shared/contracts';

const OPTIONS: Array<{ value: PermissionPreset; label: string; desc: string }> = [
  { value: 'read-only', label: '仅可查看', desc: '列目录、读文件' },
  { value: 'workspace-write', label: '工作区内修改', desc: '只动授权目录' },
  { value: 'danger-full-access', label: '完全权限', desc: '受 macOS 权限约束' }
];

export function PermissionSelector(props: {
  value: PermissionPreset;
  disabled?: boolean;
  onChange: (preset: PermissionPreset) => void;
}) {
  return (
    <div className="permission">
      <div className="permission-label">
        执行权限
        <span className="muted"> · 任务创建后固定，扩大权限需重新确认</span>
      </div>
      <div className="permission-options">
        {OPTIONS.map(option => (
          <button
            key={option.value}
            type="button"
            disabled={props.disabled}
            className={`permission-option ${props.value === option.value ? 'selected' : ''}`}
            onClick={() => props.onChange(option.value)}
          >
            <b>{option.label}</b>
            <small>{option.desc}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
