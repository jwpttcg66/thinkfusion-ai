import React, { useEffect, useState } from 'react';
import type { ChannelStatus } from '../../../shared/conversation';
import type {
  CloudProviderView,
  Identity,
  PermissionPreset,
  ProviderCatalogView,
  SourcesState
} from '../../../shared/contracts';
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
import {
  allVisiblePicked,
  filterModels,
  mergeCandidates,
  toggleVisibleModels
} from '../../../shared/cloud-selection';
import { Glyph } from './Glyph';
import { PERMISSIONS } from './TaskInput';

export type Section = 'general' | 'models' | 'search' | 'plugins' | 'expertise' | 'agents';

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
  /**
   * 从输入框的「＋」打开时要落在哪一页（连接器 → 内置插件）。
   *
   * 面板自己仍然能在左侧切换；这个值只决定打开时停在哪，不在打开期间
   * 反复把它掰回去——那会让用户点不动左边的菜单。
   */
  initialSection?: Section;
}) {
  const [section, setSection] = useState<Section>(props.initialSection ?? 'models');
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

  /**
   * 云端 API 模型：端点、模型清单、Key 三件事都在这里配。
   *
   * 它原来长在「研究设置 → 执行模式」里，那是「这一轮由谁汇总」的页面，
   * 却在配三个服务的地址和凭据——找 Key 的人不会想到去那里翻。凭据属于
   * 应用级设置，所以整块搬到「模型」页，和网页来源并列。
   *
   * 草稿与已存值分开：Key 存进主进程后就不再回传原文，界面拿不到它，
   * 只能记住「已配置 / 未配置」。错误信息也只属于这一块，不与改网址共用。
   */
  const [cloud, setCloud] = useState<CloudProviderView[]>([]);
  const [cloudEditing, setCloudEditing] = useState<string | null>(null);
  /** 草稿里只剩端点：模型清单不再让人手填，由网关回答。 */
  const [cloudDrafts, setCloudDrafts] = useState<Record<string, { baseUrl: string }>>({});
  const [cloudKeys, setCloudKeys] = useState<Record<string, string>>({});
  const [cloudBusy, setCloudBusy] = useState<string | null>(null);
  const [cloudDiscovering, setCloudDiscovering] = useState<string | null>(null);
  const [cloudError, setCloudError] = useState('');
  /**
   * 「选择模型」：正在挑候选的服务、草稿里的勾选、搜索词。
   *
   * 草稿必须与已存值分开：勾选是会反悔的，只有点「更新列表」才写配置。
   * 候选是「网关报过的全部 + 已选」的并集——只列已选的话，取消勾选一条就
   * 再也加不回来。
   */
  const [modelPickerFor, setModelPickerFor] = useState<string | null>(null);
  const [modelPickerDraft, setModelPickerDraft] = useState<string[]>([]);
  const [modelPickerQuery, setModelPickerQuery] = useState('');
  /** 「还能装的」目录：从内置目录挑一家，或选自定义自己填。 */
  const [catalog, setCatalog] = useState<ProviderCatalogView[]>([]);
  const [addingCloud, setAddingCloud] = useState(false);
  const [newCloud, setNewCloud] = useState({ catalogId: '', label: '', baseUrl: '', key: '' });
  /** 「添加云模型」里从网关读到的清单；空表示还没读到。 */
  const [newCloudModels, setNewCloudModels] = useState<string[]>([]);
  const [newCloudNote, setNewCloudNote] = useState<{ tone: 'muted' | 'ok' | 'error'; text: string }>({
    tone: 'muted',
    text: ''
  });

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

  /**
   * 云端服务清单由主进程给（预设 + 用户覆盖），界面不另抄一份端点或模型名。
   * 主进程改完立即重建 Provider，所以这里保存后只需拿回那一行。
   */
  useEffect(() => {
    let alive = true;
    void window.agentAPI
      .getExecutionOptions()
      .then(options => {
        if (!alive) return;
        setCloud(options.cloudProviders);
        setCatalog(options.providerCatalog ?? []);
        /**
         * 已配 Key 但模型清单还停在预设的服务，打开设置时补问一次网关。
         *
         * 这一段是为了让「我早就配好了 Key」的人不必重启也能看到真实清单：
         * 主进程启动时也会补，但那次可能发生在打开设置之前、也可能失败。
         * 只问 `modelsDiscovered === false` 的行，避免每次打开都重新拉一遍。
         */
        for (const item of options.cloudProviders) {
          if (!item.hasKey || item.modelsDiscovered) continue;
          void window.agentAPI
            .discoverCloudModels({ id: item.id, baseUrl: item.baseUrl })
            .then(({ models, selected }) => {
              // 主进程已经落盘并标好来源，这里只更新界面这一行。
              if (!alive) return;
              setCloud(prev => prev.map(row =>
                row.id === item.id
                  ? {
                      ...row,
                      models: selected ?? row.models,
                      catalog: models,
                      modelsDiscovered: models.length > 0
                    }
                  : row
              ));
            })
            // 问不到就保持原样：清单是预设兜底，Key 本身没有问题。
            .catch(() => undefined);
        }
      })
      .catch(error => {
        if (alive) setCloudError(error instanceof Error ? error.message : String(error));
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

  /**
   * 云端服务：进编辑就先把当前值抄进草稿。
   *
   * 不在渲染时用 `?? {...}` 现算，是因为 `models.join(', ')` 每次 render 都是
   * 新字符串，受控输入会在用户还没打字时就被重置回已存值——草稿必须是一个
   * 稳定的容器。
   */
  /**
   * 目录里挑一家：端点跟着填好，用户改得动。
   *
   * 模型不跟着填——清单由网关的 `/models` 回答，界面只负责把它拿回来。
   */
  function pickCatalog(id: string) {
    const entry = catalog.find(item => item.id === id);
    setNewCloud(prev => ({
      ...prev,
      catalogId: id,
      label: entry?.custom ? '' : entry?.label ?? '',
      baseUrl: entry?.baseUrl ?? ''
    }));
    setNewCloudModels([]);
    setNewCloudNote({
      tone: 'muted',
      text: entry?.custom
        ? '填以 /v1 结尾的端点，再贴 Key 点「获取模型」；模型清单由网关回答，不用手写。'
        : entry?.note ?? '端点已按官方默认值填好，可以改。'
    });
  }

  /** 让网关说这家有哪些模型。清单不经过这里「编辑」，只经过这里「读取」。 */
  async function discoverModels() {
    setCloudBusy('discover');
    setNewCloudNote({ tone: 'muted', text: '正在向端点要模型清单…' });
    try {
      const result = await window.agentAPI.discoverCloudModels({ baseUrl: newCloud.baseUrl, key: newCloud.key });
      setNewCloudModels(result.models);
      setNewCloudNote({ tone: 'ok', text: `网关返回 ${result.models.length} 个模型，添加后会写进配置。` });
    } catch (error) {
      setNewCloudNote({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCloudBusy(null);
    }
  }

  async function addCloud() {
    setCloudBusy('add');
    setNewCloudNote({ tone: 'muted', text: '' });
    try {
      const added = await window.agentAPI.addCloudProvider({
        catalogId: newCloud.catalogId,
        label: newCloud.label || undefined,
        baseUrl: newCloud.baseUrl || undefined,
        models: newCloudModels,
        key: newCloud.key || undefined
      });
      setCloud(prev => [...prev.filter(row => row.id !== added.id), added]);
      setAddingCloud(false);
      setNewCloud({ catalogId: '', label: '', baseUrl: '', key: '' });
      setNewCloudModels([]);
      setNewCloudNote({ tone: 'muted', text: '' });
    } catch (error) {
      setNewCloudNote({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCloudBusy(null);
    }
  }

  /** 已装服务的清单刷新：按当前端点重新问一次网关。只刷新候选，不动勾选。 */
  async function refreshCloudModels(item: CloudProviderView) {
    setCloudDiscovering(item.id);
    setCloudError('');
    try {
      const { models, selected } = await window.agentAPI.discoverCloudModels({
        id: item.id,
        baseUrl: cloudDrafts[item.id]?.baseUrl ?? item.baseUrl
      });
      // 清单由主进程落盘（`modelsFromGateway` / `catalog`），这里只同步界面
      // 状态，不再走一次 `setCloudConfig`——那条路会把来源标成「手写」。
      setCloud(prev => prev.map(row =>
        row.id === item.id
          ? {
              ...row,
              models: selected ?? row.models,
              catalog: models,
              modelsDiscovered: models.length > 0
            }
          : row
      ));
      // 候选变了，正开着的选择面板跟着换，别让用户对着旧清单勾。
      if (modelPickerFor === item.id) setModelPickerDraft(selected ?? models);
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : String(error));
    } finally {
      setCloudDiscovering(null);
    }
  }

  async function removeCloud(id: string) {
    setCloudBusy(id);
    setCloudError('');
    try {
      await window.agentAPI.removeCloudProvider(id);
      setCloud(prev => prev.filter(row => row.id !== id));
      if (cloudEditing === id) setCloudEditing(null);
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : String(error));
    } finally {
      setCloudBusy(null);
    }
  }

  function startCloudEdit(item: CloudProviderView) {
    setCloudEditing(item.id);
    setCloudError('');
    setModelPickerFor(null);
    setModelPickerQuery('');
    setCloudDrafts(prev => ({
      ...prev,
      [item.id]: { baseUrl: item.baseUrl }
    }));
  }

  /** 这家服务可勾选的完整清单：网关报过的 + 已选但这次没报的。 */
  function candidatesOf(item: CloudProviderView): string[] {
    return mergeCandidates(item.catalog ?? [], item.models);
  }

  function openModelPicker(item: CloudProviderView) {
    if (modelPickerFor === item.id) {
      setModelPickerFor(null);
      setModelPickerQuery('');
      return;
    }
    setModelPickerFor(item.id);
    setModelPickerQuery('');
    setModelPickerDraft([...item.models]);
    setCloudError('');
  }

  function toggleModelPick(model: string) {
    setModelPickerDraft(prev =>
      prev.includes(model) ? prev.filter(item => item !== model) : [...prev, model]
    );
  }

  async function savePickedModels(item: CloudProviderView) {
    setCloudBusy(item.id);
    setCloudError('');
    try {
      const saved = await window.agentAPI.setCloudModels({ id: item.id, models: modelPickerDraft });
      setCloud(prev => prev.map(row => (row.id === item.id ? { ...row, ...saved } : row)));
      setModelPickerFor(null);
      setModelPickerQuery('');
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : String(error));
    } finally {
      setCloudBusy(null);
    }
  }

  async function saveCloud(item: CloudProviderView) {
    const draft = cloudDrafts[item.id] ?? { baseUrl: item.baseUrl };
    setCloudBusy(item.id);
    setCloudError('');
    try {
      // 只提交端点。模型清单只由 `/models` 写，不经过这个「保存」——
      // 一次手滑回车不该把网关的 30 个模型覆盖成一行字。
      const saved = await window.agentAPI.setCloudConfig({ id: item.id, baseUrl: draft.baseUrl });
      // 端点变了，旧清单就不再属于这个网关（主进程已清掉来源标记），
      // 界面也退回「预设兜底」，别继续标着「来自网关 /models」。
      const endpointChanged = saved.baseUrl !== item.baseUrl;
      setCloud(prev => prev.map(row =>
        row.id === item.id
          ? { ...row, baseUrl: saved.baseUrl, models: saved.models, ...(endpointChanged ? { modelsDiscovered: false } : {}) }
          : row
      ));
      setCloudDrafts(prev => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      setCloudEditing(null);
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : String(error));
    } finally {
      setCloudBusy(null);
    }
  }

  async function saveCloudKey(item: CloudProviderView) {
    const key = (cloudKeys[item.id] ?? '').trim();
    if (!key) return;
    setCloudBusy(item.id);
    setCloudError('');
    try {
      const result = await window.agentAPI.setApiKey({ id: item.id, key });
      setCloud(prev => prev.map(row => row.id === item.id
        ? {
            ...row,
            hasKey: true,
            ...(result.models && result.models.length > 0
              ? {
                  models: result.models,
                  catalog: result.catalog ?? result.models,
                  modelsDiscovered: true
                }
              : {})
          }
        : row));
      setCloudKeys(prev => ({ ...prev, [item.id]: '' }));
      // 配好就收起来：设置项读完就该让开，跟 DeepSeek 那一行一样。主进程在
      // 同一次调用里已经问过 `/models`，拿到的清单直接更新到上面那一行。
      setCloudEditing(null);
      if (result.modelNote) {
        setCloudError(
          `${item.label}：Key 已保存，但没能从网关拿到模型清单——${result.modelNote}。可以点「编辑 → 重新获取」。`
        );
      }
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : String(error));
    } finally {
      setCloudBusy(null);
    }
  }

  async function removeCloudKey(id: string) {
    setCloudBusy(id);
    setCloudError('');
    try {
      await window.agentAPI.removeApiKey(id);
      setCloud(prev => prev.map(row => (row.id === id ? { ...row, hasKey: false } : row)));
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : String(error));
    } finally {
      setCloudBusy(null);
    }
  }

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

                <div className="settings-field">
                  <h3>云端 API 模型</h3>
                  <p className="settings-lead">
                    OpenAI / DeepSeek / OpenCode Go 走远程 API，不占本机算力，也不受网页登录态影响。
                    端点和模型都能改——云厂商改模型名比改文档还快，写死会在某天开始报 404；改完立刻生效，重启也保留。
                  </p>

                  <div className="settings-list">
                    {cloud.map(item => {
                      const draft = cloudDrafts[item.id] ?? { baseUrl: item.baseUrl };
                      const rowBusy = cloudBusy === item.id;
                      const open = cloudEditing === item.id;
                      return (
                        <div key={item.id} className={`settings-row${open ? ' editing' : ''}`}>
                          <div className="settings-row-head">
                            <span className={`settings-state ${item.hasKey ? 'ok' : 'warn'}`} aria-hidden="true" />
                            <span className="settings-row-name">{item.label}</span>
                            <span className={`settings-tag${item.hasKey ? '' : ' warn'}`}>
                              {item.hasKey ? '已配置 Key' : '未配置 Key'}
                            </span>
                            <span className="settings-row-url" title={item.models.join('、') || '还没拿到模型清单'}>
                              {item.models.length > 0 ? item.models.join(' · ') : '还没拿到模型清单'}
                            </span>
                            <button
                              className="settings-edit"
                              type="button"
                              onClick={() => (open ? setCloudEditing(null) : startCloudEdit(item))}
                              aria-label={`编辑 ${item.label}`}
                            >
                              {open ? '取消' : '编辑'}
                            </button>
                          </div>

                          {open && (
                            <div className="settings-form">
                              {item.note && <p className="settings-hint">{item.note}</p>}
                              <label className="settings-input">
                                <span>端点</span>
                                <input
                                  value={draft.baseUrl}
                                  spellCheck={false}
                                  placeholder="https://example.com/v1"
                                  onChange={event => setCloudDrafts(prev => ({
                                    ...prev,
                                    [item.id]: { baseUrl: event.target.value }
                                  }))}
                                />
                              </label>
                              {/* 模型清单来自网关的 `/models`，但「这一问用哪些」
                                  由人挑：网关卡一次报 30 个，不等于每个都要参与
                                  推导。候选（含没勾的）也一并留着，取消勾选
                                  之后还能加回来。 */}
                              <div className="settings-input">
                                <span>模型</span>
                                <span className="settings-muted model-summary">
                                  {item.models.length === 0
                                    ? '还没拿到清单：先保存 Key，或点「重新获取」'
                                    : `已选 ${item.models.length} / ${candidatesOf(item).length} 个${item.modelsDiscovered ? '（清单来自网关 /models）' : '（预设兜底，还没从网关读到）'}`}
                                </span>
                                <button
                                  className="btn secondary"
                                  type="button"
                                  disabled={rowBusy || item.models.length === 0 && candidatesOf(item).length === 0}
                                  onClick={() => openModelPicker(item)}
                                >
                                  {modelPickerFor === item.id ? '收起' : '选择模型'}
                                </button>
                                <button
                                  className="btn secondary"
                                  type="button"
                                  disabled={rowBusy || cloudDiscovering === item.id}
                                  onClick={() => void refreshCloudModels(item)}
                                >
                                  {cloudDiscovering === item.id ? '获取中…' : '重新获取'}
                                </button>
                              </div>
                              {modelPickerFor === item.id && (() => {
                                const candidates = candidatesOf(item);
                                const visible = filterModels(candidates, modelPickerQuery);
                                const allPicked = allVisiblePicked(modelPickerDraft, visible);
                                return (
                                  <div className="model-picker" aria-label={`选择 ${item.label} 的模型`}>
                                    <div className="model-picker-head">
                                      <input
                                        type="search"
                                        className="model-picker-search"
                                        value={modelPickerQuery}
                                        placeholder="搜索模型…"
                                        aria-label={`搜索 ${item.label} 的模型`}
                                        onChange={event => setModelPickerQuery(event.target.value)}
                                      />
                                      <button
                                        className="btn ghost"
                                        type="button"
                                        disabled={visible.length === 0}
                                        onClick={() => setModelPickerDraft(prev =>
                                          toggleVisibleModels(prev, visible, !allPicked)
                                        )}
                                      >
                                        {allPicked ? '取消全选' : '全选'}
                                      </button>
                                    </div>
                                    {visible.length === 0 ? (
                                      <p className="settings-muted model-picker-empty">
                                        {candidates.length === 0
                                          ? '还没有候选模型：先保存 Key，或点「重新获取」'
                                          : `没有匹配「${modelPickerQuery.trim()}」的模型`}
                                      </p>
                                    ) : (
                                      <div className="model-picker-list">
                                        {visible.map(model => (
                                          <label className="model-picker-row" key={model}>
                                            <input
                                              type="checkbox"
                                              checked={modelPickerDraft.includes(model)}
                                              onChange={() => toggleModelPick(model)}
                                            />
                                            <span className="model-picker-name" title={model}>{model}</span>
                                          </label>
                                        ))}
                                      </div>
                                    )}
                                    <div className="model-picker-foot">
                                      <span className="settings-muted">
                                        已勾 {modelPickerDraft.length} / {candidates.length} 个；只影响这一问可选的模型
                                      </span>
                                      <span className="settings-spacer" />
                                      <button className="btn secondary" type="button" onClick={() => setModelPickerFor(null)}>
                                        取消
                                      </button>
                                      <button
                                        className="btn"
                                        type="button"
                                        disabled={rowBusy || modelPickerDraft.length === 0}
                                        onClick={() => void savePickedModels(item)}
                                      >
                                        {rowBusy ? '保存中…' : '更新列表'}
                                      </button>
                                    </div>
                                  </div>
                                );
                              })()}
                              {/* Key 单独一行、单独一个按钮：换地址和换凭据是两件事，
                                  一个「保存」同时干两件，用户就分不清哪件生效了。
                                  它排在「保存」上方，是因为底下那个按钮只管端点。 */}
                              <div className="settings-input">
                                <span>Key</span>
                                <input
                                  type="password"
                                  aria-label={`${item.label} 的 API Key`}
                                  placeholder={item.hasKey ? '已配置，输入新值可替换' : '粘贴 API Key'}
                                  value={cloudKeys[item.id] ?? ''}
                                  onChange={event => setCloudKeys(prev => ({ ...prev, [item.id]: event.target.value }))}
                                />
                                <button
                                  className="btn secondary"
                                  type="button"
                                  disabled={rowBusy || !(cloudKeys[item.id] ?? '').trim()}
                                  onClick={() => void saveCloudKey(item)}
                                >
                                  保存 Key
                                </button>
                                {item.hasKey && (
                                  <button className="btn ghost" type="button" disabled={rowBusy} onClick={() => void removeCloudKey(item.id)}>
                                    移除
                                  </button>
                                )}
                              </div>
                              <p className="settings-hint">
                                Key 只存主进程的系统加密区，保存后不回显，界面只看得到「已配置 / 未配置」；
                                保存 Key 时会顺手向网关要一次真实模型清单，拿到就收起这一行。
                                「选择模型」挑的是这家服务参与推导的模型，点「更新列表」立即生效；
                                「重新获取」只刷新候选，不会替你把勾选改回去。底下的「保存」只改端点。
                              </p>
                              {open && cloudError && <p className="settings-error">{cloudError}</p>}
                              <div className="settings-form-foot">
                                {item.custom && (
                                  <button className="btn ghost" type="button" disabled={rowBusy} onClick={() => void removeCloud(item.id)}>
                                    删除这个服务
                                  </button>
                                )}
                                <span className="settings-spacer" />
                                <button className="btn secondary" type="button" onClick={() => setCloudEditing(null)}>
                                  取消
                                </button>
                                <button className="btn" type="button" disabled={rowBusy} onClick={() => void saveCloud(item)}>
                                  {rowBusy ? '保存中…' : '保存'}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {cloud.length === 0 && !cloudError && <p className="settings-muted">正在读取云端服务清单…</p>}
                    {cloud.length === 0 && cloudError && <p className="settings-error">{cloudError}</p>}
                    {/* 表单收起之后，「保存 Key 成功但没读到清单」这类话得有地方
                        落脚：它说的是这一行的事，不该跟着表单一起消失。 */}
                    {cloud.length > 0 && cloudError && !cloudEditing && (
                      <p className="settings-error">{cloudError}</p>
                    )}

                    {/* 目录里挑一家，比让人背 baseUrl 现实得多；模型名还能一键拉。 */}
                    {addingCloud ? (
                      <div className="settings-form settings-form-new">
                        <label className="settings-input">
                          <span>服务</span>
                          <select
                            className="settings-select"
                            value={newCloud.catalogId}
                            onChange={event => pickCatalog(event.target.value)}
                          >
                            <option value="">选一家…</option>
                            {catalog.map(entry => {
                              const installed = !entry.custom && cloud.some(row => row.id === entry.id);
                              return (
                                <option key={entry.id} value={entry.id} disabled={installed}>
                                  {entry.label}{installed ? '（已在列表里）' : ''}
                                </option>
                              );
                            })}
                          </select>
                        </label>

                        {catalog.find(entry => entry.id === newCloud.catalogId)?.custom && (
                          <label className="settings-input">
                            <span>名称</span>
                            <input
                              value={newCloud.label}
                              placeholder="列表里显示的名字，比如 公司内网网关"
                              onChange={event => setNewCloud(prev => ({ ...prev, label: event.target.value }))}
                            />
                          </label>
                        )}

                        <label className="settings-input">
                          <span>端点</span>
                          <input
                            value={newCloud.baseUrl}
                            spellCheck={false}
                            placeholder="https://api.example.com/v1"
                            onChange={event => setNewCloud(prev => ({ ...prev, baseUrl: event.target.value }))}
                          />
                        </label>
                        {/* 模型清单不在这里填：它由网关回答。要点一下「获取模型」
                            才看得到，添加时也会自动请求一次。 */}
                        <div className="settings-input">
                          <span>模型</span>
                          <span className="settings-muted model-summary">
                            {newCloudModels.length > 0
                              ? `网关返回 ${newCloudModels.length} 个模型，添加后写进配置`
                              : '还没读到：点 Key 右边的「获取模型」，或添加时自动请求'}
                          </span>
                        </div>
                        <label className="settings-input">
                          <span>Key</span>
                          <input
                            type="password"
                            aria-label="新云模型的 API Key"
                            placeholder="粘贴 API Key"
                            value={newCloud.key}
                            onChange={event => setNewCloud(prev => ({ ...prev, key: event.target.value }))}
                          />
                          <button
                            className="btn secondary"
                            type="button"
                            disabled={cloudBusy === 'discover' || !newCloud.baseUrl.trim() || !newCloud.key.trim()}
                            onClick={() => void discoverModels()}
                          >
                            {cloudBusy === 'discover' ? '获取中…' : '获取模型'}
                          </button>
                        </label>

                        {newCloudNote.text && (
                          <p className={newCloudNote.tone === 'error' ? 'settings-error' : 'settings-hint'}>
                            {newCloudNote.text}
                          </p>
                        )}

                        <div className="settings-form-foot">
                          <span className="settings-spacer" />
                          <button
                            className="btn secondary"
                            type="button"
                            onClick={() => {
                              setAddingCloud(false);
                              setNewCloudNote({ tone: 'muted', text: '' });
                            }}
                          >
                            取消
                          </button>
                          <button
                            className="btn"
                            type="button"
                            disabled={cloudBusy === 'add' || !newCloud.catalogId}
                            onClick={() => void addCloud()}
                          >
                            {cloudBusy === 'add' ? '添加中…' : '添加'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="settings-add"
                        type="button"
                        onClick={() => {
                          setAddingCloud(true);
                          setCloudError('');
                          pickCatalog(catalog.find(entry => entry.id === 'custom')?.id ?? '');
                        }}
                      >
                        ＋ 添加云模型
                      </button>
                    )}
                  </div>
                </div>
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
