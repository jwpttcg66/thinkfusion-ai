import React, { useEffect, useRef, useState } from 'react';
import type { CloudMemberView, PermissionPreset } from '../../../shared/contracts';
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

export function TaskInput(props: {
  value: string;
  permission: PermissionPreset;
  /** V2.1：知识空间不要求工程目录与权限，工程空间才显示这两个胶囊。 */
  workspaceMode: WorkspaceMode;
  /** 路由预览：判成什么、依据是什么、是用户指定还是规则判的。 */
  routing: { label: string; reason: string; source: 'user_selected' | 'rule' | 'model' } | null;
  /**
   * 模型主导时，输入框里这份只是规则预估：真正的判定在发送时由模型给出。
   * 不标出来就会变成「面板写着工程分析、跑起来却是实施」。
   */
  routingByModel?: boolean;
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
   * 这一问用哪些云端模型做推导。
   *
   * 模型清单来自主进程（服务 + 模型），不是界面写死的几个名字；勾选写回
   * `selectedCloudModels`，和「研究设置 → 参与成员」是同一份配置，两处
   * 永远说同一件事。放在输入框边上的理由：选模型是「这一问怎么跑」，
   * 不是应用级设置——它不该逼人先打开设置面板再回来提问。
   */
  models: {
    cloud: CloudMemberView[];
    /** undefined = 全部；空数组 = 一个都不用。 */
    selected?: string[];
    onChange: (next: string[]) => void;
  };
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
  onOpenResearch: () => void;
  /** 跳过第一轮与汇总，直接用这句话开一场辩论。 */
  onOpenDebate: () => void;
  onNewConversation: () => void;
  onRemoveAttachment: (id: string) => void;
  onSubmit: () => void;
}) {
  const [menu, setMenu] = useState<'none' | 'permission' | 'models' | 'plus'>('none');
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
  /**
   * 模型胶囊说两件事：能不能选、现在选了几个。
   *
   * 「全部」和「已选 2/7」都写出来，是因为 `undefined`（默认全部）和空数组
   * （一个都不用）在配置里是两个意思，在界面上却只差一次点击——不写清楚，
   * 用户会以为自己取消了一个而其实取消了全部。
   */
  const cloudModels = props.models.cloud;
  /** 只算真有 Key 的成员：没 Key 的那些运行时也调不通，不该算进「全部」。 */
  const selectableModels = cloudModels.filter(item => item.hasKey).map(item => item.id);
  const chosenModels = props.models.selected ?? cloudModels.map(item => item.id);
  const checkedCount = chosenModels.filter(id => selectableModels.includes(id)).length;
  const modelSummary = selectableModels.length === 0
    ? '未配置'
    : checkedCount === 0
      ? '未选'
      : checkedCount === selectableModels.length
        ? '全部'
        : `已选 ${checkedCount}/${selectableModels.length}`;

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
            {props.routingByModel && props.routing.source !== 'user_selected'
              ? '发送后由模型判定这一句是分析还是实施'
              : <>
                  本次判为「{props.routing.label}」· {props.routing.reason}
                  {props.routing.source === 'user_selected' ? '（你指定的）' : ''}
                </>}
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

          {/* 工作区不在输入框里选：左边侧栏已经有一整层工作区，两处入口
              只会让人以为它们不是同一件事。这里只留「这一问怎么跑」。 */}
          {props.workspaceMode === 'engineering' && (
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
          )}

          {/* 和其他两个胶囊同一种形状、同样高度：这里放的是「下一条怎么问」，
              点开才是那块面板。设置项读完就收起来，不占正文一行。 */}
          <button
            className={`chip-btn${menu === 'models' ? ' active' : ''}`}
            type="button"
            onClick={() => setMenu(menu === 'models' ? 'none' : 'models')}
            disabled={props.disabled}
            aria-expanded={menu === 'models'}
            title={`这一问用哪些云端模型做推导（${modelSummary}）`}
            aria-label={`选择模型（${modelSummary}）`}
          >
            <span>◈</span>
            <span className="label">模型</span>
            <span className="chip-dot" aria-hidden="true">·</span>
            <span className="chip-sub">{modelSummary}</span>
          </button>

          <button
            className="chip-btn"
            type="button"
            onClick={props.onOpenDebate}
            title="跳过第一轮回答与汇总，直接用输入框里的这句话开一场辩论"
          >
            <span>⚔</span>
            <span className="label">直接辩论</span>
          </button>

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

      {menu === 'models' && (
        <div className="popover model-popover" style={{ left: 12, bottom: 46 }}>
          <div className="model-popover-head">
            <b>这一问用哪些云端模型</b>
            <span className="settings-spacer" />
            <button
              type="button"
              className="btn ghost"
              disabled={selectableModels.length === 0}
              onClick={() => props.models.onChange(selectableModels)}
            >
              全选
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={cloudModels.length === 0}
              onClick={() => props.models.onChange([])}
            >
              清空
            </button>
          </div>
          {cloudModels.length === 0 && (
            <p className="model-popover-empty">
              还没有可用的云端模型。去「设置 → 模型 → 云端 API 模型」贴一个 Key，
              模型清单会由网关自动读回来，不用手填名字。
            </p>
          )}
          <div className="model-popover-list">
            {cloudModels.map(item => {
              const checked = item.hasKey && chosenModels.includes(item.id);
              return (
                <label
                  key={item.id}
                  className={`model-option${item.hasKey ? '' : ' off'}`}
                  title={item.hasKey ? item.label : '这个服务的 Key 还没配'}
                >
                  <input
                    type="checkbox"
                    disabled={!item.hasKey}
                    checked={checked}
                    onChange={() => props.models.onChange(
                      chosenModels.includes(item.id)
                        ? chosenModels.filter(id => id !== item.id)
                        : [...chosenModels, item.id]
                    )}
                  />
                  <span className="model-option-label">{item.label}</span>
                  {!item.hasKey && <span className="model-option-note">未配置 Key</span>}
                </label>
              );
            })}
          </div>
          <p className="model-popover-foot">
            勾选只影响这一问和它的追问。一个都不勾 = 这一轮云端模型不参与推导，
            只剩本地模型和网页通道。
          </p>
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
