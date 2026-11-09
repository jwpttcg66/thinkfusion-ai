import React, { useEffect, useRef, useState } from 'react';
import type { PermissionPreset } from '../../../shared/contracts';
import type { EngineeringTaskKind, WorkspaceMode } from '../../../shared/workspace';
import { describeBytes, type ConversationAttachment } from '../../../shared/attachments';
import { PlusMenu, type PlusMenuProps } from './PlusMenu';

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
  /** V2.1：知识空间不要求工程目录与权限，工程空间才显示这两个胶囊。 */
  workspaceMode: WorkspaceMode;
  /** 路由预览：判成什么、依据是什么、是用户指定还是规则判的。 */
  routing: { label: string; reason: string; source: 'user_selected' | 'rule' } | null;
  taskKindOverride: EngineeringTaskKind | null;
  onTaskKindChange: (kind: EngineeringTaskKind | null) => void;
  /**
   * 研究设置的口子就开在这个输入框里。
   *
   * 它影响的是「下一条怎么问」（谁当主导人、哪些模型可以参辩、要不要出报告），
   * 和左边那两个胶囊是同一类东西；单占一行摆在框外，既多出一条横线，也让
   * 输入框上方空出一块不属于任何东西的地方。
   */
  researchLabel: string;
  researchDetail: string;
  /**
   * 开着某条会话时，这里写着它的标题；没有会话就是 null。
   *
   * 「接着上一条问」和「问个新问题」在输入框里长得一模一样，只有发出去之后才
   * 知道进了哪条——用户看到答案里带着上一条的上下文，会以为进了旧对话。把归属
   * 写在框上方，点一下就能改成新对话。
   */
  followupTitle?: string | null;
  /** 这一问要带出去的文件（「＋ · 添加文件」挑的）。 */
  attachments: ConversationAttachment[];
  /**
   * 「＋」菜单要的全部东西。
   *
   * 收成一个对象而不是十几个 prop：菜单里每一项都属于「往这一问里加什么」，
   * 分开传会让这个组件看起来像在管整台应用。
   */
  plus: Omit<PlusMenuProps, 'attachedPaths' | 'onClose'>;
  disabled?: boolean;
  busy?: boolean;
  /** Lets the shell move the caret into the composer, e.g. after "新任务". */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onPermissionChange: (preset: PermissionPreset) => void;
  onChooseWorkspace: () => void;
  onOpenResearch: () => void;
  onNewConversation: () => void;
  onRemoveAttachment: (id: string) => void;
  onSubmit: () => void;
}) {
  const [menu, setMenu] = useState<'none' | 'permission' | 'plus'>('none');
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
      {props.followupTitle && (
        <div className="composer-scope">
          <span className="scope-label" title={props.followupTitle}>
            追问《{props.followupTitle}》
          </span>
          <button
            className="scope-new"
            type="button"
            onClick={props.onNewConversation}
            disabled={props.disabled}
            title="不接这一条，按新对话提问"
          >
            新对话
          </button>
        </div>
      )}

      {props.workspaceMode === 'engineering' && props.routing && (
        <div className="routing-preview">
          <span className="routing-label" title={props.routing.reason}>
            本次判为「{props.routing.label}」· {props.routing.reason}
            {props.routing.source === 'user_selected' ? '（你指定的）' : ''}
          </span>
          <span className="routing-actions">
            {([
              { id: null, label: '自动' },
              { id: 'analysis', label: '按分析' },
              { id: 'execution', label: '按实施' }
            ] as const).map(item => (
              <button
                key={item.label}
                type="button"
                className={`routing-btn${props.taskKindOverride === item.id ? ' active' : ''}`}
                disabled={props.disabled}
                onClick={() => props.onTaskKindChange(item.id)}
                title={item.id === 'execution' ? '交去生成执行计划，仍需审批才可能改文件' : '按只读分析跑'}
              >
                {item.label}
              </button>
            ))}
          </span>
        </div>
      )}

      {/* 附件写在输入框上方：它们是这一问的一部分，不是框外的设置。
          正文不进界面——这里只显示文件名和体积，正文在发送那一刻由主进程读。 */}
      {props.attachments.length > 0 && (
        <div className="attach-row">
          {props.attachments.map(item => (
            <span className="attach-chip" key={item.id} title={item.path}>
              <span className="attach-name">{item.name}</span>
              <span className="attach-size">{describeBytes(item.bytes)}</span>
              <button
                type="button"
                className="attach-remove"
                aria-label={`去掉附件 ${item.name}`}
                disabled={props.disabled}
                onClick={() => props.onRemoveAttachment(item.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

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
          {/* 「＋」放在最左：它是「往这一问里加东西」的入口，和右边那几个
              「这一问怎么跑」的胶囊不是一类，位置把这件事说清楚。 */}
          <button
            className={`chip-btn plus-btn${menu === 'plus' ? ' active' : ''}`}
            type="button"
            disabled={props.disabled}
            aria-label="添加文件、模式、专家、技能或连接器"
            aria-expanded={menu === 'plus'}
            title="往这一问里加东西：文件、模式、专家、技能、连接器"
            onClick={() => setMenu(menu === 'plus' ? 'none' : 'plus')}
          >
            <span className="plus-glyph" aria-hidden="true">＋</span>
          </button>

          {props.workspaceMode === 'engineering' && (
            <>
              <button className="chip-btn" type="button" onClick={props.onChooseWorkspace} disabled={props.disabled}>
                <span>▤</span>
                <span className="label">{props.workspace ? shortPath(props.workspace) : '选择项目'}</span>
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
            </>
          )}

          {/* 和其他两个胶囊同一种形状、同样高度：这里放的是「下一条怎么问」，
              点开才是那块面板。设置项读完就收起来，不占正文一行。 */}
          <button
            className="chip-btn"
            type="button"
            onClick={props.onOpenResearch}
            title={`研究设置：主导人、参辩模型与报告。下一条提问用「${props.researchLabel} / ${props.researchDetail}」`}
            aria-label={`研究设置（下一条：${props.researchLabel}）`}
          >
            <span>◎</span>
            <span className="label">研究设置</span>
            <span className="chip-dot" aria-hidden="true">·</span>
            <span className="chip-sub">{props.researchLabel}</span>
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

      {menu === 'plus' && (
        <PlusMenu
          {...props.plus}
          attachedPaths={props.attachments.map(item => item.path)}
          busy={props.plus.busy || props.disabled}
          onClose={() => setMenu('none')}
        />
      )}
    </div>
  );
}
