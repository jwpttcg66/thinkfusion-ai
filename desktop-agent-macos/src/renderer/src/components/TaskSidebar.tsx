import React from 'react';
import type { AgentTask, Identity } from '../../../shared/contracts';
import type { Conversation } from '../../../shared/conversation';
import type { WorkspaceEntry } from '../../../shared/workspace';
import { groupByWorkspace } from '../../../shared/workspace';
import { ICON_GAUGE_PATHS, ICON_GEAR_PATHS } from '../../../shared/icons';
import { Glyph } from './Glyph';

import type { WorkspaceMode } from '../../../shared/workspace';

/** 一个工作区行下面可能挂两种东西：会话，或没有会话的老任务。 */
type SidebarRow =
  | {
      kind: 'conversation';
      id: string;
      title: string;
      updatedAt: number;
      status: string;
      workspaceId?: string;
      workspaceRoot?: string;
    }
  | {
      kind: 'task';
      id: string;
      title: string;
      updatedAt: number;
      status: string;
      workspaceRoot?: string;
    };

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  return `${Math.floor(days / 30)} 个月`;
}

export function TaskSidebar(props: {
  /** V2.1 双入口。切换只改筛选项，不删任何历史会话。 */
  workspaceMode: WorkspaceMode;
  onWorkspaceModeChange: (mode: WorkspaceMode) => void;
  /** 用户维护的工作区清单。没有工作区时会话落在「未分组」。 */
  workspaces: WorkspaceEntry[];
  activeWorkspaceId: string;
  onSelectWorkspace: (workspaceId: string) => void;
  onAddWorkspace: () => void;
  /** 返回空串表示成功；非空是给人看的原因，显示在重命名输入框下面。 */
  onRenameWorkspace: (workspaceId: string, name: string) => Promise<string>;
  onRemoveWorkspace: (workspaceId: string) => Promise<string>;
  tasks: AgentTask[];
  activeId: string | null;
  onSelect: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  onNew: () => void;
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  identity: Identity | null;
  onOpenSettings: () => void;
  onOpenDiagnostics: () => void;
}) {
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [rowMenu, setRowMenu] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [renameError, setRenameError] = React.useState('');

  // 点空白处收起菜单。不用 `onBlur`：重命名输入框在菜单外面，失焦会把刚
  // 打开的面板关掉，用户还没点「保存」就没了。
  React.useEffect(() => {
    if (!moreOpen && !rowMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.more-wrap, .ws-row, .ws-menu')) return;
      setMoreOpen(false);
      setRowMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [moreOpen, rowMenu]);

  /**
   * 列表里到底有什么。
   *
   * 会话按空间过滤（V2.1 的双入口仍是一个筛选器，不是两个数据库）；任务只在
   * 工程空间出现，且只收「没有对应会话」的那些——有会话的任务已经从会话那行
   * 进得去，再列一遍就是同一件事两个入口。
   */
  const rows = React.useMemo<SidebarRow[]>(() => {
    const visibleConversations = props.conversations.filter(
      item => (item.workspaceMode ?? 'knowledge') === props.workspaceMode
    );
    const linkedTaskIds = new Set(
      props.conversations.map(item => item.taskId).filter((id): id is string => Boolean(id))
    );
    const conversationRows: SidebarRow[] = visibleConversations.map(item => ({
      kind: 'conversation',
      id: item.conversationId,
      title: item.title,
      updatedAt: item.updatedAt,
      status: item.status,
      ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
      ...(item.workspaceRoot ? { workspaceRoot: item.workspaceRoot } : {})
    }));
    const taskRows: SidebarRow[] = props.workspaceMode === 'engineering'
      ? props.tasks
          .filter(task => !linkedTaskIds.has(task.taskId))
          .map(task => ({
            kind: 'task',
            id: task.taskId,
            title: task.title,
            updatedAt: task.updatedAt,
            status: task.status,
            ...(task.workspaceRoot ? { workspaceRoot: task.workspaceRoot } : {})
          }))
      : [];
    return [...conversationRows, ...taskRows];
  }, [props.conversations, props.tasks, props.workspaceMode]);

  const filteredRows = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(row => row.title.toLowerCase().includes(needle));
  }, [rows, query]);

  const groups = React.useMemo(
    () => groupByWorkspace(filteredRows, props.workspaces),
    [filteredRows, props.workspaces]
  );
  /** 搜索时把空工作区藏起来：结果为空还留一排空文件夹，是在占地方。 */
  const visibleGroups = query.trim() ? groups.filter(group => group.items.length > 0) : groups;
  const realWorkspaceCount = props.workspaces.length;
  const allCollapsed = visibleGroups.length > 0 && visibleGroups.every(group => collapsed.has(group.workspaceId));

  function toggleGroup(workspaceId: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  }

  function toggleAll() {
    if (allCollapsed) setCollapsed(new Set());
    else setCollapsed(new Set(visibleGroups.map(group => group.workspaceId)));
  }

  function beginRename(workspace: WorkspaceEntry) {
    setRowMenu(null);
    setRenaming(workspace.workspaceId);
    setRenameDraft(workspace.name);
    setRenameError('');
  }

  async function commitRename() {
    if (!renaming) return;
    const error = await props.onRenameWorkspace(renaming, renameDraft);
    if (error) {
      setRenameError(error);
      return;
    }
    setRenaming(null);
    setRenameDraft('');
    setRenameError('');
  }

  async function removeWorkspace(workspace: WorkspaceEntry) {
    setRowMenu(null);
    const error = await props.onRemoveWorkspace(workspace.workspaceId);
    if (error) setRenameError(error);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="more-wrap">
          <button
            className="more-btn"
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(open => !open)}
          >
            更多
            <span className="caret" aria-hidden="true">⌄</span>
          </button>
          {moreOpen && (
            <div className="side-menu more-menu" role="menu">
              <button
                className="side-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false);
                  props.onAddWorkspace();
                }}
              >
                添加工作区…
              </button>
              <button
                className="side-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false);
                  props.onOpenDiagnostics();
                }}
              >
                页面诊断
              </button>
              <button
                className="side-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false);
                  props.onOpenSettings();
                }}
              >
                设置
              </button>
            </div>
          )}
        </div>
        <span className="brand-mini">
          <span className="brand-mark">◈</span>
          ThinkFusion
        </span>
      </div>

      <div className="workspace-tabs" role="tablist" aria-label="工作空间">
        {([
          { id: 'knowledge', label: '知识学习' },
          { id: 'engineering', label: '工程工作' }
        ] as const).map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={props.workspaceMode === tab.id}
            className={`workspace-tab${props.workspaceMode === tab.id ? ' active' : ''}`}
            onClick={() => props.onWorkspaceModeChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <button className="new-task" onClick={props.onNew}>
        <span>＋</span>
        新对话
      </button>

      <div className="side-section">
        <span className="side-section-title">
          工作区
          <span className="side-count">{realWorkspaceCount}</span>
        </span>
        <span className="actions">
          <button
            className={`side-icon${searchOpen ? ' on' : ''}`}
            type="button"
            title="搜索会话"
            aria-label="搜索会话"
            onClick={() => {
              setSearchOpen(open => !open);
              if (searchOpen) setQuery('');
            }}
          >
            ⌕
          </button>
          <button
            className="side-icon"
            type="button"
            title={allCollapsed ? '全部展开' : '全部收起'}
            aria-label={allCollapsed ? '全部展开' : '全部收起'}
            onClick={toggleAll}
          >
            ⇅
          </button>
          <button
            className="side-icon"
            type="button"
            title="添加工作区"
            aria-label="添加工作区"
            onClick={props.onAddWorkspace}
          >
            ＋
          </button>
        </span>
      </div>

      {searchOpen && (
        <input
          className="workspace-search"
          value={query}
          autoFocus
          placeholder="搜索会话"
          aria-label="搜索会话"
          onChange={event => setQuery(event.target.value)}
        />
      )}

      <div className="task-scroll">
        {visibleGroups.map(group => {
          const isCollapsed = collapsed.has(group.workspaceId);
          const workspace = props.workspaces.find(item => item.workspaceId === group.workspaceId) ?? null;
          const isRenaming = workspace !== null && renaming === workspace.workspaceId;
          return (
            <div className="ws-group" key={group.workspaceId || '__loose__'}>
              <div
                className={`ws-row${group.workspaceId === props.activeWorkspaceId ? ' active' : ''}`}
                onClick={() => {
                  if (group.workspaceId) props.onSelectWorkspace(group.workspaceId);
                  toggleGroup(group.workspaceId);
                }}
                title={group.root || undefined}
              >
                <span className="ws-caret" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                <span className="ws-folder" aria-hidden="true">▤</span>
                <span className="ws-name">{group.name}</span>
                <span className="ws-count">{group.items.length}</span>
                {workspace && (
                  <button
                    className="ws-more"
                    type="button"
                    aria-label="工作区菜单"
                    title="重命名或移除这个工作区"
                    onClick={event => {
                      event.stopPropagation();
                      setRowMenu(current => (current === workspace.workspaceId ? null : workspace.workspaceId));
                    }}
                  >
                    ⋯
                  </button>
                )}
                {workspace && rowMenu === workspace.workspaceId && (
                  <div className="side-menu ws-menu" role="menu">
                    <button
                      className="side-menu-item"
                      type="button"
                      role="menuitem"
                      onClick={event => {
                        event.stopPropagation();
                        beginRename(workspace);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      className="side-menu-item danger"
                      type="button"
                      role="menuitem"
                      onClick={event => {
                        event.stopPropagation();
                        void removeWorkspace(workspace);
                      }}
                    >
                      移除工作区
                    </button>
                    <p className="side-menu-note">移除只取消分组，会话与文件都不删。</p>
                  </div>
                )}
              </div>

              {isRenaming && workspace && (
                <div className="ws-rename">
                  <input
                    value={renameDraft}
                    autoFocus
                    aria-label="工作区名字"
                    onChange={event => {
                      setRenameDraft(event.target.value);
                      if (renameError) setRenameError('');
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') void commitRename();
                      if (event.key === 'Escape') {
                        setRenaming(null);
                        setRenameError('');
                      }
                    }}
                  />
                  <button className="btn ghost" type="button" onClick={() => void commitRename()}>保存</button>
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => {
                      setRenaming(null);
                      setRenameError('');
                    }}
                  >
                    取消
                  </button>
                  {renameError && <p className="ws-error">{renameError}</p>}
                </div>
              )}

              {!isCollapsed && (
                <div className="ws-rows">
                  {group.items.map(row => (
                    <div
                      key={`${row.kind}:${row.id}`}
                      className={`task-item${
                        (row.kind === 'conversation' && props.activeConversationId === row.id) ||
                        (row.kind === 'task' && props.activeId === row.id)
                          ? ' active'
                          : ''
                      }`}
                      onClick={() =>
                        row.kind === 'conversation'
                          ? props.onSelectConversation(row.id)
                          : props.onSelect(row.id)
                      }
                      title={row.title}
                    >
                      <span className={`task-dot s-${row.status}`} />
                      <span className="task-title">{row.title}</span>
                      <span className="task-time">{relTime(row.updatedAt)}</span>
                      <button
                        className="task-delete"
                        title={
                          row.kind === 'conversation'
                            ? '删除这条对话记录'
                            : '删除本地任务记录（不会删除工作区文件）'
                        }
                        onClick={event => {
                          event.stopPropagation();
                          if (row.kind === 'conversation') props.onDeleteConversation(row.id);
                          else props.onDelete(row.id);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                  {group.items.length === 0 && (
                    <p className="ws-empty">
                      {query.trim() ? '没有匹配的会话' : '还没有会话。下一问会归到这个工作区。'}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {visibleGroups.length === 0 && (
          <p className="empty">
            {query.trim()
              ? '没有匹配的会话。'
              : props.workspaceMode === 'engineering'
                ? '工程工作空间还没有内容。添加一个工作区，然后直接分析代码或提出修改需求。'
                : '还没有内容。添加一个工作区，或直接提问。'}
          </p>
        )}
      </div>

      {/* The account row.
          Not a login: there is no account. It is a name the person chose, and
          saying so is more useful than the "本地工作区" label it replaced — that
          line named a folder while looking like a profile. The two buttons are
          the two things a person reaches for from the bottom of a sidebar: how
          the pages are doing, and where the settings are.
          It used to show the operating system's user name. It no longer does,
          and the tooltip no longer shows the machine's name: neither is
          something this app was given. */}
      <div className="side-foot">
        <span className="side-foot-avatar" aria-hidden="true">
          {props.identity?.initial ?? '·'}
        </span>
        <span className="side-foot-name" title={props.identity?.device ?? ''}>
          {props.identity?.name ?? '本机用户'}
        </span>
        <span className="side-foot-actions">
          <button
            className="side-foot-btn"
            type="button"
            onClick={props.onOpenDiagnostics}
            aria-label="页面诊断"
            title="页面诊断：看内嵌页面的真实状态"
          >
            <Glyph paths={ICON_GAUGE_PATHS} />
          </button>
          <button
            className="side-foot-btn"
            type="button"
            onClick={props.onOpenSettings}
            aria-label="设置"
            title="设置：模型、网址、权限"
          >
            <Glyph paths={ICON_GEAR_PATHS} />
          </button>
        </span>
      </div>
    </aside>
  );
}
