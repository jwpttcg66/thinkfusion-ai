import React, { useEffect, useRef, useState } from 'react';
import type { ExecutionMode } from '../../../shared/conversation';
import type { ConversationAttachment } from '../../../shared/attachments';
import { describeBytes } from '../../../shared/attachments';
import type { ExpertiseId, ExpertiseView } from '../../../shared/expertise';
import type { WorkspaceMode } from '../../../shared/workspace';

/**
 * 输入框里的「＋」。
 *
 * 形状照 WorkBuddy：一个按钮，一组可以往这一问里「加东西」的入口，每一项
 * 点开都是真的，没有装饰性的菜单项。这一版落地的是——
 *
 * - 添加文件：挑本机文件，发送时读正文随问题一起发出去（附件不是提示词，
 *   用户知道自己挑了什么；不带附件时问题与原来逐字相同）。
 * - 引用对话中的文件：这条会话里带过的文件，追问时不用重挑。
 * - 模式：知识 / 工程两个空间，以及网页 / 本地 / 云端 / 混合四种主导。
 * - 专家、技能：这两份 .md 的开关（与「设置 · 专家与技能」同一份）。
 * - 连接器：内嵌的网页来源，点一下切到那一页。
 *
 * 刻意不做的：不做没有后端支撑的入口。菜单里每一项要么改一个真实状态，
 * 要么当场打开一个真对话框；不做「敬请期待」。
 */

export type PlusSection = 'files' | 'reference' | 'mode' | 'expert' | 'skill' | 'connector';

const MODE_EXECUTION: Array<{ id: ExecutionMode; label: string; hint: string }> = [
  { id: 'web', label: '网页主导', hint: '由网页通道汇总、交锋、给最终意见' },
  { id: 'local', label: '本地主导', hint: '只由本机模型读材料并给意见' },
  { id: 'cloud', label: '云端主导', hint: '由配了 Key 的云端模型主导' },
  { id: 'hybrid', label: '混合主导', hint: '由本地模型按答案质量挑一位主导' }
];

export interface PlusMenuProps {
  workspaceMode: WorkspaceMode;
  executionMode: ExecutionMode;
  expertise: ExpertiseView[];
  /** 这条会话里带过的文件（只存引用）。 */
  conversationFiles: ConversationAttachment[];
  /** 这一问已经带上的路径，用来把重复项标成「已带上」。 */
  attachedPaths: string[];
  sources: Array<{ id: string; label: string; available: boolean; active: boolean }>;
  busy?: boolean;
  onAddFiles: () => void;
  onReferenceFile: (file: ConversationAttachment) => void;
  onWorkspaceMode: (mode: WorkspaceMode) => void;
  onExecutionMode: (mode: ExecutionMode) => void;
  onToggleExpertise: (id: ExpertiseId, enabled: boolean) => void;
  onSelectSource: (id: string) => void;
  onOpenPlugins: () => void;
  onClose: () => void;
}

const ROWS: Array<{ id: PlusSection | 'add'; label: string; icon: string; note: string }> = [
  { id: 'add', label: '添加文件', icon: '⌘', note: '本机文件，随这一问一起发出' },
  { id: 'reference', label: '引用对话中的文件', icon: '◎', note: '这条会话里带过的文件' },
  { id: 'mode', label: '模式', icon: '◈', note: '空间与主导方式' },
  { id: 'expert', label: '专家', icon: '☰', note: '工程空间常驻的人设' },
  { id: 'skill', label: '技能', icon: '✎', note: '按场景加载的工作流' },
  { id: 'connector', label: '连接器', icon: '⌾', note: '内嵌的网页来源' }
];

export function PlusMenu(props: PlusMenuProps) {
  const [section, setSection] = useState<PlusSection | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点外面就收起来。和权限胶囊用同一套判据：点击落在这块面板之外。
  //
  // 「＋」按钮本身要排除：那是开合它的开关。不排除的话，mousedown 先把菜单
  // 关掉、随后的 click 又把同一个按钮判成「现在是关的，打开它」，于是点了
  // 两次也关不掉。
  useEffect(() => {
    function onDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.plus-btn')) return;
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) props.onClose();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onClose]);

  const experts = props.expertise.filter(item => item.kind === 'expert');
  const skills = props.expertise.filter(item => item.kind === 'skill');

  return (
    <div className="popover plus-menu" ref={rootRef} role="menu" aria-label="往这一问里添加东西">
      {ROWS.map(row => {
        if (row.id === 'add') {
          return (
            <button
              key={row.id}
              type="button"
              className="plus-row"
              disabled={props.busy}
              onClick={() => {
                props.onAddFiles();
                props.onClose();
              }}
            >
              <span className="plus-icon" aria-hidden="true">{row.icon}</span>
              <span className="plus-text">
                <b>{row.label}</b>
                <small>{row.note}</small>
              </span>
            </button>
          );
        }
        const id: PlusSection = row.id;
        return (
          <button
            key={id}
            type="button"
            className={`plus-row${section === id ? ' active' : ''}`}
            aria-expanded={section === id}
            onClick={() => setSection(section === id ? null : id)}
          >
            <span className="plus-icon" aria-hidden="true">{row.icon}</span>
            <span className="plus-text">
              <b>{row.label}</b>
              <small>{row.note}</small>
            </span>
            <span className="plus-caret" aria-hidden="true">›</span>
          </button>
        );
      })}

      {section && (
        <div className="plus-sub" role="menu" aria-label={ROWS.find(row => row.id === section)?.label}>
          {section === 'reference' && (
            props.conversationFiles.length === 0 ? (
              <p className="plus-empty">这条对话里还没有带过文件。先点「添加文件」挑一份。</p>
            ) : (
              props.conversationFiles.map(file => {
                const attached = props.attachedPaths.includes(file.path);
                return (
                  <button
                    key={file.id}
                    type="button"
                    className="plus-item"
                    disabled={attached}
                    onClick={() => {
                      props.onReferenceFile(file);
                      props.onClose();
                    }}
                  >
                    <span className="plus-item-name">{file.name}</span>
                    <small>{attached ? '已带上' : describeBytes(file.bytes)}</small>
                  </button>
                );
              })
            )
          )}

          {section === 'mode' && (
            <>
              <p className="plus-group">空间</p>
              {([
                { id: 'knowledge' as const, label: '知识空间', hint: '交叉验证网页回答，不动本机文件' },
                {
                  id: 'engineering' as const,
                  label: '工程空间',
                  hint: '模型读本机项目；切换会先退出当前会话（它还在侧栏）'
                }
              ]).map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`plus-item${props.workspaceMode === item.id ? ' on' : ''}`}
                  onClick={() => {
                    props.onWorkspaceMode(item.id);
                    props.onClose();
                  }}
                >
                  <span className="plus-item-name">{item.label}</span>
                  <small>{item.hint}</small>
                </button>
              ))}
              <p className="plus-group">主导</p>
              {MODE_EXECUTION.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`plus-item${props.executionMode === item.id ? ' on' : ''}`}
                  onClick={() => {
                    props.onExecutionMode(item.id);
                    props.onClose();
                  }}
                >
                  <span className="plus-item-name">{item.label}</span>
                  <small>{item.hint}</small>
                </button>
              ))}
            </>
          )}

          {(section === 'expert' || section === 'skill') && (
            <>
              {(section === 'expert' ? experts : skills).map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`plus-item${item.enabled && !item.error ? ' on' : ''}`}
                  disabled={Boolean(item.error) || props.busy}
                  title={item.error ?? `${item.trigger}｜不加载：${item.doNotTrigger}`}
                  onClick={() => {
                    props.onToggleExpertise(item.id, !item.enabled);
                    props.onClose();
                  }}
                >
                  <span className="plus-item-name">{item.title}</span>
                  <small>{item.error ?? (item.enabled ? `已启用 · ${describeExpertiseSource(item)}` : '已停用')}</small>
                </button>
              ))}
              <p className="plus-note">
                与「设置 · 专家与技能」是同一份开关；只在工程空间生效。技能还受场景判定约束：
                读数、查事实那类问题即使开着也不会加载。
              </p>
            </>
          )}

          {section === 'connector' && (
            <>
              {props.sources.length === 0 ? (
                <p className="plus-empty">没有开启的网页来源。到「设置 · 模型」里打开一个。</p>
              ) : (
                props.sources.map(source => (
                  <button
                    key={source.id}
                    type="button"
                    className={`plus-item${source.active ? ' on' : ''}`}
                    onClick={() => {
                      props.onSelectSource(source.id);
                      props.onClose();
                    }}
                  >
                    <span className="plus-item-name">{source.label}</span>
                    <small>{source.active ? '当前显示' : source.available ? '就绪' : '未就绪'}</small>
                  </button>
                ))
              )}
              <button
                type="button"
                className="plus-item"
                onClick={() => {
                  props.onOpenPlugins();
                  props.onClose();
                }}
              >
                <span className="plus-item-name">内置插件</span>
                <small>本地能力、联网与保存</small>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function describeExpertiseSource(item: ExpertiseView): string {
  return item.source === 'user' ? '你的文件' : '内置文件';
}
