import React, { useEffect, useState } from 'react';
import type { ChannelStatus } from '../../../shared/conversation';
import type { Identity, PermissionPreset, SourcesState } from '../../../shared/contracts';
import type { PageSource } from '../../../shared/sources';
import { ICON_GEAR_PATHS } from '../../../shared/icons';
import { DEFAULT_DISPLAY_NAME, MAX_DISPLAY_NAME_LENGTH, initialOf } from '../../../shared/identity';
import {
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_FIELD,
  SEARCH_PROVIDER_LABEL,
  type SearchProvider,
  type SearchSettingsView
} from '../../../shared/search';
import {
  CAPABILITY_KIND_LABELS,
  CAPABILITY_PERMISSION_LABELS,
  type CapabilityView
} from '../../../shared/capabilities';
import { EXPERTISE_KIND_LABELS, type ExpertiseView } from '../../../shared/expertise';
import { Glyph } from './Glyph';
import { PERMISSIONS } from './TaskInput';

type Section = 'general' | 'models' | 'search' | 'plugins' | 'expertise' | 'agents';

const SECTIONS: Array<{ id: Section; label: string; icon: readonly string[] }> = [
  { id: 'general', label: '通用设置', icon: ICON_GEAR_PATHS },
  { id: 'models', label: '模型', icon: ['M3 5h10M3 8h10M3 11h6'] },
  { id: 'search', label: '联网搜索', icon: ['M7.2 3.2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M10.4 10.4 13.6 13.6'] },
  { id: 'plugins', label: '内置插件', icon: ['M8 2.4 13 5.2v5.6L8 13.6 3 10.8V5.2z', 'M3 5.2 8 8l5-2.8'] },
  { id: 'expertise', label: '专家与技能', icon: ['M4 2.8h8v10.4H4z', 'M6.4 5.6h3.2', 'M6.4 8h3.2'] },
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
 *
 * The switch is the row's first control and it works in one click. It used to
 * live inside the edit form as 「启用这个提供商」, which made the cheapest action
 * on the page — turn a provider off — cost four: open the form, untick, save,
 * watch it close. Two verbs (开关 / 改地址) were sharing one door (编辑), and the
 * door said 编辑.
 *
 * Two things the switch deliberately does **not** gate:
 *
 * - The address field. "Only editable while on" reads tidier than it behaves:
 *   turning a source on creates its `WebContentsView` and loads the page, so
 *   fixing the address of a source you just switched off would first load the
 *   address you are trying to get rid of. 编辑 stays available on every row.
 * - Its own default. Every row cannot ship on: WorkBuddy has no address and Kimi
 *   has no selector profile, so a fresh install would show four pages of which
 *   two can only fail. A source that is added here does come in on, because it
 *   arrives with an address.
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

  /**
   * 搜索设置自带一套状态，不复用上面的 `error`/`busy`。
   *
   * 理由和名字字段一样：面板切换时两套表单不会同时在屏幕上，共用一条错误
   * 信息只会让「刚才那句红字在说哪件事」变成猜谜。另外这里要保存的是
   * 「已填但还没保存」的草稿——key 一旦保存就不再回传原文，界面拿不到它。
   */
  const [search, setSearch] = useState<SearchSettingsView | null>(null);
  const [searchProvider, setSearchProvider] = useState<SearchProvider | null>(null);
  const [searchKey, setSearchKey] = useState('');
  const [searchUrl, setSearchUrl] = useState('');
  const [searchNote, setSearchNote] = useState('');
  const [searchTone, setSearchTone] = useState<'ok' | 'error' | 'muted'>('muted');
  const [searchBusy, setSearchBusy] = useState(false);

  /** 内置插件清单由主进程给，界面不另抄一份名字或权限。 */
  const [capabilities, setCapabilities] = useState<CapabilityView[]>([]);
  const [capabilityBusy, setCapabilityBusy] = useState<string | null>(null);
  const [capabilityNote, setCapabilityNote] = useState('');
  /** 专家与技能：清单也是主进程读盘给的，界面不假装知道 .md 里写了什么。 */
  const [expertise, setExpertise] = useState<ExpertiseView[]>([]);
  const [expertiseBusy, setExpertiseBusy] = useState<string | null>(null);
  const [expertiseNote, setExpertiseNote] = useState('');

  useEffect(() => {
    let alive = true;
    void window.agentAPI
      .getCapabilities()
      .then(list => {
        if (alive) setCapabilities(list);
      })
      .catch(error => {
        if (alive) setCapabilityNote(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
    };
  }, []);

  async function toggleCapability(id: string, enabled: boolean) {
    setCapabilityBusy(id);
    setCapabilityNote('');
    try {
      setCapabilities(await window.agentAPI.setCapabilityEnabled(id, enabled));
    } catch (error) {
      setCapabilityNote(error instanceof Error ? error.message : String(error));
    } finally {
      setCapabilityBusy(null);
    }
  }

  async function toggleExpertise(id: string, enabled: boolean) {
    setExpertiseBusy(id);
    setExpertiseNote('');
    try {
      setExpertise(await window.agentAPI.setExpertiseEnabled(id, enabled));
    } catch (error) {
      setExpertiseNote(error instanceof Error ? error.message : String(error));
    } finally {
      setExpertiseBusy(null);
    }
  }

  useEffect(() => {
    let alive = true;
    void window.agentAPI
      .getExpertise()
      .then(list => {
        if (alive) setExpertise(list);
      })
      .catch(error => {
        if (alive) setExpertiseNote(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void window.agentAPI
      .getSearchSettings()
      .then(view => {
        if (!alive) return;
        setSearch(view);
        setSearchProvider(view.provider ?? null);
        setSearchUrl(view.searxngUrl ?? '');
      })
      .catch(error => {
        if (alive) {
          setSearchTone('error');
          setSearchNote(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      alive = false;
    };
  }, []);

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
    const problem = await props.onSaveSource(source.id, { url: draftUrl });
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    stopEdit();
  }

  /**
   * Flip one source on or off. One click, no form.
   *
   * A row with no address cannot be switched on — the main process refuses it
   * (`先填网址，再打开这个提供商`) and is right to. Rather than print a refusal for
   * something the row already shows, the click opens the address field: the dead
   * end becomes the next step. That is also why the refusal is not duplicated
   * here as a disabled switch; a disabled control with no sentence is a wall.
   */
  async function toggle(source: PageSource) {
    if (busy) return;
    if (!source.enabled && !source.url) {
      startEdit(source);
      setError('先填网址，再打开这个提供商');
      return;
    }
    setBusy(true);
    setError('');
    const problem = await props.onSaveSource(source.id, { enabled: !source.enabled });
    setBusy(false);
    if (problem) setError(problem);
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

  /**
   * 保存搜索凭据。
   *
   * 只发用户真的动过的那几个字段：key 留空表示「不改」，不是「清空」——
   * 界面上根本看不到已存的 key，一次误触「保存」不该把凭据抹掉。
   */
  async function saveSearch(patch: {
    provider?: SearchProvider | null;
    apiKey?: string;
    searxngUrl?: string;
  }) {
    if (searchBusy) return;
    setSearchBusy(true);
    setSearchNote('');
    try {
      const view = await window.agentAPI.saveSearchSettings(patch);
      setSearch(view);
      setSearchProvider(view.provider ?? null);
      setSearchUrl(view.searxngUrl ?? '');
      setSearchKey('');
      setSearchTone('ok');
      setSearchNote('已保存');
    } catch (error) {
      setSearchTone('error');
      setSearchNote(error instanceof Error ? error.message : String(error));
    } finally {
      setSearchBusy(false);
    }
  }

  /** 真发一次请求。凭据对不对，只有服务端的回答算数。 */
  async function testSearch() {
    if (searchBusy) return;
    setSearchBusy(true);
    setSearchNote('正在请求搜索服务…');
    setSearchTone('muted');
    try {
      const result = await window.agentAPI.testSearchSettings({
        provider: searchProvider,
        ...(searchKey.trim() ? { apiKey: searchKey.trim() } : {}),
        ...(searchUrl.trim() ? { searxngUrl: searchUrl.trim() } : {})
      });
      setSearchTone(result.ok ? 'ok' : 'error');
      setSearchNote(result.ok ? `${result.note}${result.sample ? `，例如「${result.sample}」` : ''}` : result.note);
    } catch (error) {
      setSearchTone('error');
      setSearchNote(error instanceof Error ? error.message : String(error));
    } finally {
      setSearchBusy(false);
    }
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
                  每个提供商就是一个内嵌网页。左边的开关决定它在不在来源栏里，点一下就生效，不用进编辑。改完网址重新打开这个页面即可。
                </p>

                <div className="settings-list">
                  {props.sources.sources.map(source => {
                    const status = statusOf(source.id);
                    const state = !source.enabled ? 'off' : status?.available ? 'ok' : 'warn';
                    // Said out loud before the click, because after it the answer
                    // is a refusal and the person has already lost the click.
                    const switchTitle = !source.enabled
                      ? `启用 ${source.label}`
                      : enabledCount === 1
                        ? '这是最后一个开着的来源，关掉就没地方问了'
                        : `关掉 ${source.label}`;
                    return (
                      <div
                        key={source.id}
                        className={`settings-row${editing === source.id ? ' editing' : ''}${source.enabled ? '' : ' off'}`}
                      >
                        <div className="settings-row-head">
                          <button
                            className="settings-switch"
                            type="button"
                            role="switch"
                            aria-checked={source.enabled}
                            aria-label={`启用 ${source.label}`}
                            title={switchTitle}
                            disabled={busy}
                            onClick={() => void toggle(source)}
                          />
                          <span className={`settings-state ${state}`} aria-hidden="true" />
                          <span className="settings-row-name">{source.label}</span>
                          {props.sources.planningId === source.id && <span className="settings-tag">规划通道</span>}
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
                            {/* The reason belongs to the row it is about. It used to
                                render once at the bottom of the list, which put the
                                answer to a click on the fourth row three rows away
                                from the click. */}
                            {error && <p className="settings-error">{error}</p>}
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

                {/* Only when no row has a form open: otherwise the message is
                    already printed inside the form it belongs to. */}
                {error && !editing && <p className="settings-error">{error}</p>}
              </section>
            )}

            {section === 'search' && (
              <section className="settings-section">
                <h3>联网搜索</h3>
                <p className="settings-lead">
                  搜索要落到一个外部服务上：配了凭据就用它的完整结果列表；没配也能用——应用会用自己的
                  浏览器打开 Bing 结果页把标题和链接取回来（免凭据），结果里会写明这次是哪种。
                </p>

                <div className="settings-field">
                  <span className="settings-field-label">搜索服务</span>
                  <div className="settings-choices">
                    {SEARCH_PROVIDERS.map(id => (
                      <button
                        key={id}
                        type="button"
                        className={`settings-choice${searchProvider === id ? ' active' : ''}`}
                        onClick={() => {
                          setSearchProvider(id);
                          setSearchNote('');
                          setSearchTone('muted');
                          setSearchKey('');
                        }}
                      >
                        <b>{SEARCH_PROVIDER_LABEL[id]}</b>
                        <span>{SEARCH_PROVIDER_FIELD[id] === 'searxngUrl' ? '填实例地址' : '填 API key'}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {searchProvider && SEARCH_PROVIDER_FIELD[searchProvider] === 'searxngUrl' && (
                  <div className="settings-field">
                    <span className="settings-field-label">SearXNG 实例地址</span>
                    <div className="settings-account">
                      <input
                        className="settings-name-input"
                        value={searchUrl}
                        spellCheck={false}
                        placeholder="https://searx.example.com"
                        aria-label="SearXNG 实例地址"
                        onChange={event => setSearchUrl(event.target.value)}
                      />
                    </div>
                    <p className="settings-hint">
                      实例要开了 JSON 输出（`search.formats` 里带 `json`），否则只会返回 HTML，这里会报「不是 JSON」。
                    </p>
                  </div>
                )}

                {searchProvider && SEARCH_PROVIDER_FIELD[searchProvider] === 'apiKey' && (
                  <div className="settings-field">
                    <span className="settings-field-label">API key</span>
                    <div className="settings-account">
                      <input
                        className="settings-name-input"
                        value={searchKey}
                        type="password"
                        spellCheck={false}
                        autoComplete="off"
                        placeholder={search?.hasKey ? `已保存 ${search.keyHint ?? ''}，留空表示不改` : '粘贴 key'}
                        aria-label="搜索 API key"
                        onChange={event => setSearchKey(event.target.value)}
                      />
                    </div>
                    <p className="settings-hint">
                      key 存在本机、只用于搜索请求；保存后不再回传到这里，界面只记得末四位。
                    </p>
                  </div>
                )}

                <div className="settings-field">
                  <div className="settings-account">
                    <button
                      className="btn"
                      type="button"
                      disabled={searchBusy || !searchProvider}
                      onClick={() =>
                        void saveSearch({
                          provider: searchProvider,
                          ...(searchKey.trim() ? { apiKey: searchKey.trim() } : {}),
                          ...(searchUrl.trim() ? { searxngUrl: searchUrl.trim() } : {})
                        })
                      }
                    >
                      {searchBusy ? '处理中…' : '保存'}
                    </button>
                    <button className="btn secondary" type="button" disabled={searchBusy} onClick={() => void testSearch()}>
                      测试连接
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={searchBusy || !search?.provider}
                      onClick={() => void saveSearch({ provider: null })}
                    >
                      清除
                    </button>
                  </div>
                  {searchNote && (
                    <p className={searchTone === 'error' ? 'settings-error' : 'settings-hint'}>{searchNote}</p>
                  )}
                </div>

                <div className="settings-field">
                  <span className="settings-field-label">当前状态</span>
                  <p className="settings-hint">
                    {search?.fromEnv
                      ? '配置文件不生效：环境变量里配了搜索凭据，环境变量优先。'
                      : search?.fallbackOnly
                        ? '还没配凭据：搜索走应用内浏览器打开的 Bing 结果页，能拿到标题与链接；再不行才退回 DuckDuckGo / Wikipedia 摘要。'
                        : `已配置 ${SEARCH_PROVIDER_LABEL[search?.provider ?? ''] ?? search?.provider}。`}
                  </p>
                  <p className="settings-muted">
                    配置文件：{search?.configPath ?? '（未读取）'}（也可以直接编辑它，格式是 JSON）
                  </p>
                </div>
              </section>
            )}

            {section === 'plugins' && (
              <section className="settings-section">
                <h3>内置插件</h3>
                <p className="settings-lead">
                  本地能力、联网能力和保存能力都按插件登记，和 DeepSeek Harness 一样一条一行：读哪个文件、
                  搜哪个网、写哪份文档、需要什么权限都能看清。停用的能力执行时会明确报错，不会悄悄跳过。
                </p>
                <p className="settings-lead">开关在下次执行时生效，已经跑起来的计划不受影响。</p>
                {capabilityNote && <p className="settings-error">{capabilityNote}</p>}
                {(['local', 'network', 'save'] as const).map(kind => {
                  const items = capabilities.filter(item => item.kind === kind);
                  const on = items.filter(item => item.enabled).length;
                  return (
                    <div className="capability-group" key={kind}>
                      <h4 className="capability-group-title">
                        {CAPABILITY_KIND_LABELS[kind]}
                        <span>{on}/{items.length} 已启用</span>
                      </h4>
                      <div className="settings-list">
                        {items.map(item => (
                          <div className={`capability-row${item.enabled ? '' : ' off'}`} key={item.id}>
                            <button
                              type="button"
                              className="settings-switch"
                              role="switch"
                              aria-checked={item.enabled}
                              aria-label={`${item.title}：${item.enabled ? '已启用' : '已停用'}`}
                              disabled={capabilityBusy === item.id}
                              onClick={() => void toggleCapability(item.id, !item.enabled)}
                            />
                            <div className="capability-body">
                              <div className="capability-head">
                                <b>{item.title}</b>
                                <code>{item.id}</code>
                                <span className="capability-permission">
                                  {CAPABILITY_PERMISSION_LABELS[item.permission]}
                                </span>
                              </div>
                              <p>{item.description}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </section>
            )}

            {section === 'expertise' && (
              <section className="settings-section">
                <h3>专家与技能</h3>
                <p className="settings-lead">
                  工程空间的第一意见由本地 / 云端模型读工程证据给出。这两份 .md 只往它的 system 轮次里添内容：
                  专家是常驻人设，技能只在设计、实施、改造类问题上加载。知识空间、网页通道和用户原话都不受影响。
                </p>
                <p className="settings-lead">
                  它们不是新的 agent，也不占成员名额，和「Agent 预设」里的通道配置是两回事。
                  把同名文件放进「可替换路径」就能覆盖内置版本，改完不用重启应用；写坏了会在这里显示原因，并且不会注入。
                </p>
                {expertiseNote && <p className="settings-error">{expertiseNote}</p>}
                {(['expert', 'skill'] as const).map(kind => {
                  const items = expertise.filter(item => item.kind === kind);
                  const on = items.filter(item => item.enabled).length;
                  return (
                    <div className="capability-group" key={kind}>
                      <h4 className="capability-group-title">
                        {EXPERTISE_KIND_LABELS[kind]}
                        <span>{on}/{items.length} 已启用</span>
                      </h4>
                      <div className="settings-list">
                        {items.map(item => (
                          <div className={`capability-row${item.enabled ? '' : ' off'}`} key={item.id}>
                            <button
                              type="button"
                              className="settings-switch"
                              role="switch"
                              aria-checked={item.enabled}
                              aria-label={`${item.title}：${item.enabled ? '已启用' : '已停用'}`}
                              disabled={expertiseBusy === item.id}
                              onClick={() => void toggleExpertise(item.id, !item.enabled)}
                            />
                            <div className="capability-body">
                              <div className="capability-head">
                                <b>{item.title}</b>
                                <code>{item.id}</code>
                                <span className="capability-permission">
                                  {item.source === 'user' ? '用户替换' : '内置'} · {item.version}
                                </span>
                              </div>
                              <p>{item.description}</p>
                              <p className="settings-muted">
                                触发：{item.trigger}；不触发：{item.doNotTrigger}
                              </p>
                              {item.error ? (
                                <p className="settings-error">{item.error}</p>
                              ) : (
                                <p className="settings-muted">
                                  正文 {item.chars} 字 · 生效文件 {item.filePath}
                                </p>
                              )}
                              <p className="settings-muted">可替换路径：{item.userPath}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </section>
            )}

            {section === 'agents' && (
              <section className="settings-section">
                <h3>Agent 预设</h3>
                <p className="settings-lead">
                  规划用的提示词和工具白名单目前写在构建里，还没有可编辑的预设。执行权限在「通用设置」里改。
                </p>
                <p className="settings-lead">
                  工具面是 29 个 Runtime 能力（27 个本地、2 个联网），另有 4 个主进程插件
                  （读工程证据、浏览器联网搜索、导出会话、保存网页文档），全部列在「内置插件」里，
                  可以逐条启用或停用。执行权限决定哪些能真跑。
                </p>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
