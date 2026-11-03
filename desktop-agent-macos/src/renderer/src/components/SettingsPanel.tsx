import React, { useEffect, useState } from 'react';
import type { ChannelStatus } from '../../../shared/conversation';
import type { Identity, PermissionPreset, SourcesState } from '../../../shared/contracts';
import type { PageSource } from '../../../shared/sources';
import { ICON_GEAR_PATHS } from '../../../shared/icons';
import { DEFAULT_DISPLAY_NAME, MAX_DISPLAY_NAME_LENGTH, initialOf } from '../../../shared/identity';
import { Glyph } from './Glyph';
import { PERMISSIONS } from './TaskInput';

type Section = 'general' | 'models' | 'plugins' | 'agents';

const SECTIONS: Array<{ id: Section; label: string; icon: readonly string[] }> = [
  { id: 'general', label: '通用设置', icon: ICON_GEAR_PATHS },
  { id: 'models', label: '模型', icon: ['M3 5h10M3 8h10M3 11h6'] },
  { id: 'plugins', label: '内置插件', icon: ['M8 2.4 13 5.2v5.6L8 13.6 3 10.8V5.2z', 'M3 5.2 8 8l5-2.8'] },
  { id: 'agents', label: 'Agent 预设', icon: ['M5.2 3.2h5.6v2.4H5.2zM3.2 8.4h9.6v4.4H3.2z'] }
];

/**
 * 设置.
 *
 * The reason this exists is the 模型 page: every source the app embeds has an
 * address, those addresses move, and until now the only way to follow a move
 * was a new release. So the page is not a list of logos — it is a list of
 * editable addresses with an on/off switch and an honest status dot.
 *
 * Two rules are enforced in the main process, not here, and this panel only
 * reports them: an address has to be https, and at least one source has to stay
 * switched on. Both are product decisions, and a renderer that could bypass
 * them would be a second, weaker copy of the rules.
 *
 * Every row's switch works, including the planner's. The 规划通道 tag follows
 * `planningId` — the source the agent is actually using right now — rather than
 * the shipped flag, so switching the planner off visibly moves the tag instead
 * of leaving it on a page the app has stopped using.
 */
export function SettingsPanel(props: {
  sources: SourcesState;
  channelStatuses: ChannelStatus[];
  identity: Identity | null;
  permission: PermissionPreset;
  onClose: () => void;
  onSaveSource: (id: string, patch: { url?: string; enabled?: boolean }) => Promise<string>;
  onAddSource: (input: { label: string; url: string }) => Promise<string>;
  onRemoveSource: (id: string) => Promise<string>;
  /** Rename the sidebar row. Empty string means 「恢复默认」. */
  onRename: (name: string) => Promise<string>;
  onPermissionChange: (preset: PermissionPreset) => void;
}) {
  const [section, setSection] = useState<Section>('models');
  /** The row whose form is open. One at a time: two open forms is two truths. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draftUrl, setDraftUrl] = useState('');
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * The name field is its own draft, with its own error.
   *
   * Two reasons it does not share `error` with the 模型 page: the two are never on
   * screen at the same time (a message about an address under a name box is a
   * lie about what went wrong), and typing must not clear a message about
   * something else.
   */
  const [draftName, setDraftName] = useState('');
  const [nameError, setNameError] = useState('');

  // The identity arrives after the first render, and 「恢复默认」 changes it from
  // the main process — so the draft follows the stored value, not the other way
  // round.
  useEffect(() => {
    setDraftName(props.identity?.name ?? DEFAULT_DISPLAY_NAME);
  }, [props.identity?.name]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  function startEdit(source: PageSource) {
    setEditing(source.id);
    setDraftUrl(source.url);
    setDraftEnabled(source.enabled);
    setError('');
    setAdding(false);
  }

  function stopEdit() {
    setEditing(null);
    setDraftUrl('');
    setError('');
  }

  async function save(source: PageSource) {
    if (busy) return;
    setBusy(true);
    setError('');
    const problem = await props.onSaveSource(source.id, { url: draftUrl, enabled: draftEnabled });
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    stopEdit();
  }

  async function add() {
    if (busy) return;
    setBusy(true);
    setError('');
    const problem = await props.onAddSource({ label: newLabel, url: newUrl });
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    setAdding(false);
    setNewLabel('');
    setNewUrl('');
  }

  async function remove(source: PageSource) {
    if (busy) return;
    setBusy(true);
    setError('');
    const problem = await props.onRemoveSource(source.id);
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    stopEdit();
  }

  /**
   * Rename the sidebar row.
   *
   * The panel does not pre-validate: the main process owns the rules (trimming,
   * length, control characters) and answers with a sentence, which lands under
   * the field. A second copy of the rules here would drift, and a name that
   * passed in the renderer but failed on disk is the worst of both.
   */
  async function rename(next: string) {
    if (busy) return;
    setBusy(true);
    setNameError('');
    const problem = await props.onRename(next);
    setBusy(false);
    if (problem) setNameError(problem);
  }

  const statusOf = (id: string) => props.channelStatuses.find(status => status.id === id) ?? null;
  /** Used to say "this is the last one" before the save is refused, not after. */
  const enabledCount = props.sources.sources.filter(source => source.enabled).length;

  return (
    <div className="diag-overlay settings-overlay" onMouseDown={event => event.target === event.currentTarget && props.onClose()}>
      <div className="diag-panel settings-panel" role="dialog" aria-label="设置">
        <div className="diag-head">
          <b>设置</b>
          <span className="settings-spacer" />
          <button className="settings-close" type="button" onClick={props.onClose} aria-label="关闭设置">
            ✕
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav" aria-label="设置分类">
            {SECTIONS.map(item => (
              <button
                key={item.id}
                type="button"
                className={`settings-nav-item${section === item.id ? ' active' : ''}`}
                onClick={() => {
                  setSection(item.id);
                  setError('');
                  stopEdit();
                }}
              >
                <Glyph paths={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="settings-main">
            {section === 'general' && (
              <section className="settings-section">
                <h3>通用设置</h3>
                <p className="settings-lead">这个应用只跑在这台机器上，任务、对话和网页登录都留在本地。</p>
                <div className="settings-field">
                  <span className="settings-field-label">显示名称</span>
                  <div className="settings-account">
                    {/* The avatar follows the draft, not the stored name: typing
                        「小柯」 and seeing the old character is a small lie about
                        what is about to happen. */}
                    <span className="side-foot-avatar">{initialOf(draftName)}</span>
                    <div className="settings-account-body">
                      <input
                        className="settings-name-input"
                        value={draftName}
                        maxLength={MAX_DISPLAY_NAME_LENGTH}
                        spellCheck={false}
                        placeholder={DEFAULT_DISPLAY_NAME}
                        aria-label="显示名称"
                        onChange={event => {
                          setDraftName(event.target.value);
                          setNameError('');
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Enter') void rename(draftName);
                        }}
                      />
                      <span className="settings-muted">{props.identity?.device ?? ''}</span>
                    </div>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={busy || draftName === (props.identity?.name ?? DEFAULT_DISPLAY_NAME)}
                      onClick={() => void rename(draftName)}
                    >
                      保存
                    </button>
                    <button className="btn ghost" type="button" disabled={busy} onClick={() => void rename('')}>
                      恢复默认
                    </button>
                  </div>
                  <p className="settings-hint">
                    侧栏左下角显示的就是这个名字。默认「{DEFAULT_DISPLAY_NAME}」，不读取系统的用户名和机器名。
                  </p>
                  {nameError && <p className="settings-error">{nameError}</p>}
                </div>
                <div className="settings-field">
                  <span className="settings-field-label">执行权限</span>
                  <div className="settings-choices">
                    {PERMISSIONS.map(item => (
                      <button
                        key={item.value}
                        type="button"
                        className={`settings-choice${props.permission === item.value ? ' active' : ''}`}
                        onClick={() => props.onPermissionChange(item.value)}
                      >
                        <b>{item.label}</b>
                        <span>{item.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {section === 'models' && (
              <section className="settings-section">
                <h3>模型</h3>
                <p className="settings-lead">
                  每个提供商就是一个内嵌网页。填它的网址就能用；改完网址重新打开这个页面即可。
                </p>

                <div className="settings-list">
                  {props.sources.sources.map(source => {
                    const status = statusOf(source.id);
                    const state = !source.enabled ? 'off' : status?.available ? 'ok' : 'warn';
                    return (
                      <div key={source.id} className={`settings-row${editing === source.id ? ' editing' : ''}`}>
                        <div className="settings-row-head">
                          <span className={`settings-state ${state}`} aria-hidden="true" />
                          <span className="settings-row-name">{source.label}</span>
                          {props.sources.planningId === source.id && <span className="settings-tag">规划通道</span>}
                          {!source.enabled && <span className="settings-tag off">未启用</span>}
                          {!source.url && <span className="settings-tag warn">还没填网址</span>}
                          <span className="settings-row-url" title={source.url || '未填写网址'}>
                            {source.url || '未填写网址'}
                          </span>
                          <button
                            className="settings-edit"
                            type="button"
                            onClick={() => (editing === source.id ? stopEdit() : startEdit(source))}
                            aria-label={`编辑 ${source.label}`}
                          >
                            {editing === source.id ? '取消' : '编辑'}
                          </button>
                        </div>

                        {editing === source.id && (
                          <div className="settings-form">
                            <label className="settings-input">
                              <span>网址</span>
                              <input
                                value={draftUrl}
                                autoFocus
                                spellCheck={false}
                                placeholder="https://example.com/"
                                onChange={event => setDraftUrl(event.target.value)}
                                onKeyDown={event => {
                                  if (event.key === 'Enter') void save(source);
                                }}
                              />
                            </label>
                            <label className="settings-toggle">
                              <input
                                type="checkbox"
                                checked={draftEnabled}
                                onChange={event => setDraftEnabled(event.target.checked)}
                              />
                              <span>
                                启用这个提供商
                                {source.enabled && enabledCount === 1 && (
                                  <em className="settings-muted">（这是最后一个，关掉就没地方问了）</em>
                                )}
                              </span>
                            </label>
                            <div className="settings-form-foot">
                              {source.custom && (
                                <button className="btn ghost" type="button" onClick={() => void remove(source)}>
                                  删除
                                </button>
                              )}
                              <span className="settings-spacer" />
                              <button className="btn secondary" type="button" onClick={stopEdit}>
                                取消
                              </button>
                              <button className="btn" type="button" disabled={busy} onClick={() => void save(source)}>
                                {busy ? '保存中…' : '保存'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {adding ? (
                    <div className="settings-form settings-form-new">
                      <label className="settings-input">
                        <span>名称</span>
                        <input value={newLabel} autoFocus placeholder="比如 Kimi" onChange={event => setNewLabel(event.target.value)} />
                      </label>
                      <label className="settings-input">
                        <span>网址</span>
                        <input
                          value={newUrl}
                          spellCheck={false}
                          placeholder="https://example.com/"
                          onChange={event => setNewUrl(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === 'Enter') void add();
                          }}
                        />
                      </label>
                      <div className="settings-form-foot">
                        <span className="settings-spacer" />
                        <button className="btn secondary" type="button" onClick={() => setAdding(false)}>
                          取消
                        </button>
                        <button className="btn" type="button" disabled={busy} onClick={() => void add()}>
                          {busy ? '添加中…' : '添加'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button className="settings-add" type="button" onClick={() => (setAdding(true), stopEdit(), setError(''))}>
                      ＋ 添加模型提供商
                    </button>
                  )}
                </div>

                {error && <p className="settings-error">{error}</p>}
              </section>
            )}

            {section === 'plugins' && (
              <section className="settings-section">
                <h3>内置插件</h3>
                <p className="settings-lead">还没有插件。现在能用的只有网页通道，它们在上面的「模型」里配置。</p>
                <p className="settings-lead">
                  一个插件要能做的事是确定的：读哪个文件、跑哪条命令、什么时候停下来问人。在这些能写清楚之前，摆一排开关只会让人以为它们有用。
                </p>
              </section>
            )}

            {section === 'agents' && (
              <section className="settings-section">
                <h3>Agent 预设</h3>
                <p className="settings-lead">
                  规划用的提示词和工具白名单目前写在构建里，还没有可编辑的预设。执行权限在「通用设置」里改。
                </p>
                <p className="settings-lead">
                  工具面是刻意收窄的：列目录、读文件、建目录、新建文件。没有 shell，没有删除，没有覆盖。
                </p>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
