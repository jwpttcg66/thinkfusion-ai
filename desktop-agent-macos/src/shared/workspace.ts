/**
 * V2.1 工作空间与任务路由。
 *
 * 这一层是纯规则，不读文件、不调模型、不碰 IPC。理由和 `intent.ts` 一样：
 * 一条问题为什么被判成「分析」或「实施」必须能指着规则解释，否则用户没
 * 办法纠正它。
 *
 * 三条边界，写在这里防止以后被悄悄放宽：
 *
 * - **只对工程空间生效。** 知识空间的提问仍走 `classifyIntent()` 的五个旧值，
 *   老会话、老行为一个字节都不改。
 * - **识别不等于授权。** 这里返回 `execution` 只是说「用户想改东西」，
 *   写不写由 `TaskGrant` / 审批说了算。
 * - **不确定就问。** 规则认不出来的实施类表达一律 `clarify`，不猜、不默认执行。
 */

import { classifyIntent, type IntentKind } from './intent';

export type WorkspaceMode = 'knowledge' | 'engineering';
export type EngineeringTaskKind = 'analysis' | 'execution';
export type DebateMode = 'auto' | 'on' | 'off';

/** 路由结果。`taskKind` 是给界面看的，`engineeringKind` 是给执行链用的。 */
export type TaskRoutingKind =
  | IntentKind
  | 'engineering_analysis'
  | 'engineering_execution'
  | 'clarify';

export interface TaskRouting {
  workspaceMode: WorkspaceMode;
  taskKind: TaskRoutingKind;
  reason: string;
  /** 用户本轮明确指定、规则判的，还是模型判的。界面上要能看出区别。 */
  source: 'user_selected' | 'rule' | 'model';
  /** 只在工程空间有值。 */
  engineeringKind?: EngineeringTaskKind | 'clarify';
  /** 规则命中的词，供界面解释判据。 */
  signals?: string[];
  /** 「先分析再修改」这类两阶段请求。 */
  stages?: EngineeringTaskKind[];
  /** 需要用户补信息：缺项目、或表达含糊。 */
  needsProject?: boolean;
  needsClarification?: boolean;
  /**
   * 这一问要不要读工程目录里的文件。
   *
   * 只在 `source === 'model'` 且模型明确给了答案时才有值；`undefined` 表示模型
   * 没判（网页主导 / 超时 / 没接线），由 `needsProjectEvidence()` 按规则兜底。
   */
  readsProject?: boolean;
}

export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = 'knowledge';
export const DEFAULT_DEBATE_MODE: DebateMode = 'auto';

/** 全局默认：下次启动仍然停在用户上次的空间与项目。 */
export interface WorkspaceState {
  workspaceMode: WorkspaceMode;
  workspaceRoot: string;
  /**
   * 当前使用的工作区（侧栏分组里的那一个）。
   *
   * 和 `workspaceRoot` 分开存：工作区是「这条会话/下一问归在哪一组」，根目录
   * 是「工程分析读哪个目录」。知识空间也会挂在某个工作区下，但它不读目录，
   * 所以两者不能合并成一个字段。老文件没有它时为空，界面按未分组处理。
   */
  activeWorkspaceId: string;
}

export const DEFAULT_WORKSPACE_STATE: WorkspaceState = {
  workspaceMode: DEFAULT_WORKSPACE_MODE,
  workspaceRoot: '',
  activeWorkspaceId: ''
};

/** 坏文件、旧版本、不可信 IPC 输入统一收敛到这里。 */
export function normalizeWorkspaceState(raw: unknown): WorkspaceState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_WORKSPACE_STATE };
  const value = raw as { workspaceMode?: unknown; workspaceRoot?: unknown; activeWorkspaceId?: unknown };
  return {
    workspaceMode: normalizeWorkspaceMode(value.workspaceMode),
    workspaceRoot: typeof value.workspaceRoot === 'string' ? value.workspaceRoot.slice(0, 2000) : '',
    activeWorkspaceId: typeof value.activeWorkspaceId === 'string' ? value.activeWorkspaceId.slice(0, 64) : ''
  };
}

// --- 工作区（多项目） -------------------------------------------------------

/**
 * 侧栏里的一个工作区：一个名字 + 一个本地目录。
 *
 * 这是 V2.1 之后新增的一层。此前只有「空间」（知识/工程）和「项目目录」，
 * 会话平铺在空间里；一旦同时做两个工程，历史就没有任何分组依据。工作区把
 * 同一目录下的会话收在一起，切换时只换分组，不删任何记录。
 *
 * `workspaceId` 是随机的、与目录无关的稳定 id：目录可以改名、移动，但已经
 * 归到这个名字下的会话不会因此丢掉分组。
 */
export interface WorkspaceEntry {
  workspaceId: string;
  name: string;
  root: string;
  createdAt: number;
  updatedAt: number;
}

export const WORKSPACE_NAME_MAX = 60;

/** 目录名去掉末尾斜杠。工作区比较、分组都靠它，避免 `/a/b` 与 `/a/b/` 分成两组。 */
export function normalizeWorkspaceRoot(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  // 只剪末尾斜杠：根目录 `/` 要保留。
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

export function sameWorkspaceRoot(left: string, right: string): boolean {
  const normalized = normalizeWorkspaceRoot(left);
  return normalized !== '' && normalized === normalizeWorkspaceRoot(right);
}

/** 默认名字取目录最后一段；取不到就退回完整路径，不凭空造一个名字。 */
export function workspaceNameFromRoot(root: string): string {
  const normalized = normalizeWorkspaceRoot(root);
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  return (parts[parts.length - 1] ?? normalized).slice(0, WORKSPACE_NAME_MAX);
}

export function normalizeWorkspaceName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, WORKSPACE_NAME_MAX) : '';
}

/**
 * 读盘/读 IPC 的统一入口。
 *
 * 坏条目跳过而不是让整份列表失效——一个手改坏的工作区不该把其他工作区一起
 * 藏起来。同一个目录只留第一条，否则侧栏会出现两个同名分组。
 */
export function normalizeWorkspaceEntries(raw: unknown): WorkspaceEntry[] {
  if (!Array.isArray(raw)) return [];
  const seenRoots = new Set<string>();
  const seenIds = new Set<string>();
  const out: WorkspaceEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId.trim().slice(0, 64) : '';
    const root = typeof value.root === 'string' ? normalizeWorkspaceRoot(value.root) : '';
    if (!workspaceId || !root || seenRoots.has(root) || seenIds.has(workspaceId)) continue;
    seenRoots.add(root);
    seenIds.add(workspaceId);
    const name = normalizeWorkspaceName(value.name) || workspaceNameFromRoot(root);
    const createdAt = Number.isFinite(value.createdAt) ? Number(value.createdAt) : 0;
    const updatedAt = Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : createdAt;
    out.push({ workspaceId, name, root, createdAt, updatedAt });
  }
  return out;
}

/**
 * 把会话（或任务）按工作区分组。
 *
 * 三级回退，顺序是刻意的：
 * 1. 会话自己记着 `workspaceId` —— 新数据，最准确；
 * 2. 没有 id 时按 `workspaceRoot` 找同名目录 —— 这次升级前的会话仍能归位，
 *    不需要改一次盘；
 * 3. 都找不到 —— 归到「未分组」，而不是塞进第一个工作区。
 *
 * 空工作区也返回，这样用户能看到自己添加过它；「未分组」只在有内容时返回。
 */
export interface WorkspaceGroupable {
  workspaceId?: string;
  workspaceRoot?: string;
  updatedAt?: number;
}

export interface WorkspaceGroup<T> {
  /** 空串代表「未分组」。 */
  workspaceId: string;
  name: string;
  root: string;
  items: T[];
  updatedAt: number;
}

export function groupByWorkspace<T extends WorkspaceGroupable>(
  items: readonly T[],
  workspaces: readonly WorkspaceEntry[],
  ungroupedName = '未分组'
): Array<WorkspaceGroup<T>> {
  const byId = new Map<string, WorkspaceEntry>();
  const byRoot = new Map<string, WorkspaceEntry>();
  const groups = new Map<string, WorkspaceGroup<T>>();
  for (const workspace of workspaces) {
    byId.set(workspace.workspaceId, workspace);
    byRoot.set(normalizeWorkspaceRoot(workspace.root), workspace);
    groups.set(workspace.workspaceId, {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      root: workspace.root,
      items: [],
      updatedAt: workspace.updatedAt
    });
  }

  const loose: WorkspaceGroup<T> = { workspaceId: '', name: ungroupedName, root: '', items: [], updatedAt: 0 };
  for (const item of items) {
    const byIdMatch = item.workspaceId ? byId.get(item.workspaceId) : undefined;
    const byRootMatch = !byIdMatch && item.workspaceRoot
      ? byRoot.get(normalizeWorkspaceRoot(item.workspaceRoot))
      : undefined;
    const matched = byIdMatch ?? byRootMatch;
    const group = matched ? groups.get(matched.workspaceId) ?? loose : loose;
    group.items.push(item);
    if ((item.updatedAt ?? 0) > group.updatedAt) group.updatedAt = item.updatedAt ?? 0;
  }

  const list = [...groups.values()];
  if (loose.items.length > 0) list.push(loose);
  // 最近用过的排前面；空工作区排在最后（按创建/更新时间），未分组固定末尾。
  return list.sort((left, right) => {
    if (!left.workspaceId) return 1;
    if (!right.workspaceId) return -1;
    const leftEmpty = left.items.length === 0;
    const rightEmpty = right.items.length === 0;
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
    return right.updatedAt - left.updatedAt || left.name.localeCompare(right.name);
  });
}

export function normalizeWorkspaceMode(value: unknown): WorkspaceMode {
  return value === 'engineering' ? 'engineering' : DEFAULT_WORKSPACE_MODE;
}

export function normalizeDebateMode(value: unknown): DebateMode {
  return value === 'on' || value === 'off' ? value : DEFAULT_DEBATE_MODE;
}

// --- 工程意图 ---------------------------------------------------------------

/**
 * 明确的改动动词。旧的 `intent.ts` 只认「修改/创建/删除 + 文件线索」，
 * 所以「实现一个功能」「重构这个模块」全被判成闲聊。这里把工程空间里
 * 真正会落到文件上的动词补齐。
 */
const EXECUTION_VERBS =
  /(修改|改成|改一下|改这个|编辑|写入|写到|覆盖|替换|实现|新增|添加|加上|补上|创建|新建|删除|删掉|移除|重命名|移动|重构|重写|修复|修好|解决这个\s?bug|接入|集成|升级|安装|提交|回滚|跑一下测试|执行测试|跑测试|执行命令|执行(?:这个|以下)?命令|跑命令|跑(?:这个)?命令|截屏|截图|打开(?:应用|软件|程序)|启动(?:应用|软件|程序)|搜索文件|查找文件|找文件|列出文件|抓取|抓一下网页|发(?:一)?条[^。；]{0,6}通知|发送[^。；]{0,6}通知|列出[^。；]{0,20}进程|结束进程|搜索(?:一下|下)?|搜一下|搜搜|联网搜|检索|查资料|查找资料|最新消息|官网地址|跑(?:一段|这个|一下)?代码|运行代码|执行代码|跑(?:一段|这个)?脚本|试一下这段代码)/;

/** 明确只读的动词。先判这类，避免「分析一下怎么改」被误判成实施。 */
const ANALYSIS_VERBS =
  /(分析|解释|说明|看一下|看看|读一下|梳理|理解|定位|排查|追查|评审|评估|审阅|review|为什么|为何|原因|原理|机制|调用链|调用关系|依赖|架构|结构|影响范围|性能瓶颈|代码走查)/i;

/**
 * 强动作：说到它就是在要求系统做一件事，不是"顺便看看"。
 *
 * 「帮我截屏，看看当前界面」同时命中「截屏」和「看看」，按原来的冲突规则
 * 会退成 clarify——用户明明说清了要截屏，却被告知"请明确是分析还是实施"。
 * 这类动词本身就是动作，目的词（看看/分析一下）不该把它降级。
 */
const STRONG_EXEC_VERBS = /(执行命令|运行命令|跑命令|截屏|截图|打开(?:应用|软件|程序)|启动(?:应用|软件|程序)|搜索(?:一下|下)?|搜一下|联网搜|查资料|跑(?:一段|这个|一下)?代码|运行代码|执行代码)/;

/** 「先分析再修改」这类两阶段请求，顺序词出现就把两段都记下来。 */
const TWO_STAGE = /(先.{0,12}(分析|看|排查|定位|评审).{0,12}(再|然后|之后|接着).{0,12}(改|修改|实现|修|重构|写))|(分析.{0,8}(后|完).{0,8}(再|然后)?(改|修改|实现|修))/;

export interface EngineeringIntent {
  kind: EngineeringTaskKind | 'clarify';
  reason: string;
  /** 命中了哪些词，界面上可以显示「为什么这么判」。 */
  signals: string[];
  stages?: EngineeringTaskKind[];
}

export function classifyEngineeringIntent(text: string): EngineeringIntent {
  const input = text.trim();
  if (!input) return { kind: 'clarify', reason: '没有可识别的内容', signals: [] };

  const execHit = EXECUTION_VERBS.exec(input)?.[0];
  const analysisHit = ANALYSIS_VERBS.exec(input)?.[0];
  const twoStage = TWO_STAGE.test(input);

  if (twoStage) {
    return {
      kind: 'analysis',
      reason: '先分析再修改：本轮先只读分析，实施需要下一轮明确确认',
      signals: [analysisHit, execHit].filter((item): item is string => !!item),
      stages: ['analysis', 'execution']
    };
  }

  // 两边都命中且没有顺序词时，按「不确定」处理，不擅自进入高权限执行。
  // 例外：命中强动作词（截屏/执行命令/打开应用）时，目的词只是补充说明。
  if (execHit && analysisHit) {
    if (STRONG_EXEC_VERBS.test(input)) {
      return { kind: 'execution', reason: `出现系统动作「${STRONG_EXEC_VERBS.exec(input)?.[0]}」`, signals: [execHit, analysisHit] };
    }
    return {
      kind: 'clarify',
      reason: `同时出现只读词「${analysisHit}」与改动词「${execHit}」，请明确这次是分析还是实施`,
      signals: [analysisHit, execHit]
    };
  }

  if (execHit) {
    return { kind: 'execution', reason: `出现改动动词「${execHit}」`, signals: [execHit] };
  }
  if (analysisHit) {
    return { kind: 'analysis', reason: `出现只读分析词「${analysisHit}」`, signals: [analysisHit] };
  }
  return { kind: 'clarify', reason: '没有明确的分析或实施动词，需要用户确认', signals: [] };
}

// --- 总路由 -----------------------------------------------------------------

export interface RouteInput {
  text: string;
  workspaceMode?: WorkspaceMode;
  /** 用户在输入框里手动选的「本次按分析 / 本次按实施」。 */
  override?: EngineeringTaskKind | null;
  /** 工程空间是否已有项目目录。 */
  hasProject?: boolean;
  /**
   * 这一问随行的附件数量。
   *
   * 「附了文件却没说做什么」（比如只写「这个方案」或文件名）在规则里没有动词，
   * 原来一律落到 clarify，用户点发送后被要求「明确说分析还是实施」——附件已经
   * 挑好了，等于把已经表达的动作意图丢掉。带附件时默认只读分析：方向安全
   * （不写文件），也不违反「不确定不默认执行」。
   */
  attachmentCount?: number;
}

/**
 * 唯一入口：把一句话变成一个 `TaskRouting`。
 *
 * 优先级按 V2.1 §5：用户本轮明确指令 > 用户选择的工作空间 > 工程上下文 > 规则。
 * 知识空间直接复用旧的 `classifyIntent`，所以老 behavior 完全不变。
 */
export function routeTask(input: RouteInput): TaskRouting {
  const workspaceMode = normalizeWorkspaceMode(input.workspaceMode);
  const text = (input.text ?? '').trim();

  if (workspaceMode === 'knowledge') {
    const intent = classifyIntent(text);
    return {
      workspaceMode,
      taskKind: intent.kind,
      reason: intent.reason,
      source: input.override ? 'user_selected' : 'rule'
    };
  }

  if (input.override === 'analysis' || input.override === 'execution') {
    return {
      workspaceMode,
      taskKind: input.override === 'analysis' ? 'engineering_analysis' : 'engineering_execution',
      reason: '用户本轮明确指定',
      source: 'user_selected',
      engineeringKind: input.override
    };
  }

  const classified = classifyEngineeringIntent(text);
  const needsProject = !input.hasProject;
  const attachmentCount = Math.max(0, Math.floor(input.attachmentCount ?? 0));

  // 附件优先于「动词缺失」：用户亲手挑了文件就是明确要「看这个文件」。
  // 只升到只读分析，而且只在**一个动词都没有**时生效——同时命中只读词与改动词
  // （signals 非空）仍然是「不确定就问」，附件不该替用户化解这条冲突。
  if (classified.kind === 'clarify' && classified.signals.length === 0 && attachmentCount > 0) {
    return {
      workspaceMode,
      taskKind: 'engineering_analysis',
      reason: `随这一问附了 ${attachmentCount} 个文件，按只读分析处理`,
      source: 'rule',
      engineeringKind: 'analysis',
      signals: [],
      needsProject
    };
  }

  if (classified.kind === 'clarify') {
    return {
      workspaceMode,
      taskKind: 'clarify',
      reason: classified.reason,
      source: 'rule',
      engineeringKind: 'clarify',
      signals: classified.signals,
      needsClarification: true,
      needsProject
    };
  }

  return {
    workspaceMode,
    taskKind: classified.kind === 'analysis' ? 'engineering_analysis' : 'engineering_execution',
    reason: classified.reason,
    source: 'rule',
    engineeringKind: classified.kind,
    stages: classified.stages,
    signals: classified.signals,
    needsProject
  };
}

/** 界面上的短标签。 */
export function routingLabel(routing: TaskRouting | null | undefined): string {
  if (!routing) return '';
  switch (routing.taskKind) {
    case 'engineering_analysis': return '工程分析';
    case 'engineering_execution': return '工程实施';
    case 'clarify': return '待确认';
    case 'workspace': return '工作区任务';
    case 'research': return '专题研究';
    case 'compare': return '技术比较';
    case 'extract': return '网页提取';
    default: return '日常问答';
  }
}

export function workspaceLabel(mode: WorkspaceMode): string {
  return mode === 'engineering' ? '工程工作空间' : '知识学习空间';
}

// --- 要不要读工程目录 -------------------------------------------------------

/**
 * 一句话里提到了工程本身（而不是随附的那份文件）时，才算「要看工程」。
 *
 * 只用于**模型没给结论时的兜底**，不是主判据。刻意收窄：宁可多读一次工程，
 * 也不要因为漏了一个同义词而让模型凭空答工程问题。
 */
const PROJECT_TERMS =
  /工程|项目|仓库|代码|源码|模块|函数|接口|调用|依赖|目录|文件树|结构|架构|配置|实现|编译|测试|本机|workspace|repo\b/i;

export interface ProjectNeedInput {
  /** 用户原话（不含附件正文）。 */
  text: string;
  /** 这一问随行附件数量。 */
  attachmentCount: number;
  /** 模型判定给的结论；`undefined` / `null` 表示模型没给。 */
  modelReadsProject?: boolean | null;
}

/**
 * 这一问要不要先读工程目录。
 *
 * 2026-11-09 用户裁决：「为什么要读取工程目录内容，只有需要的时候才需要读啊。」
 * 真机现场：只附了一份 md 问「这个文件有多少行」，却把整个 Downloads 扫了一遍
 * （257 项、读进 69 个文件），转录里多出 20 条顶层文件清单，还把无关的
 * readme.txt 递给了汇总，反过来把附件里的事实否掉。
 *
 * 顺序：模型说了算 → 模型没给时只省「附了文件、又没提工程」这一种 →
 * 其余照旧读。**省掉扫描是省事，不是省证据**：一旦模型或规则认为要看工程，
 * 证据照旧真实读取，绝不拿上一轮的旧证据顶。
 */
export function needsProjectEvidence(input: ProjectNeedInput): { read: boolean; reason: string } {
  if (input.modelReadsProject === true) {
    return { read: true, reason: '模型判定这一问要看工程里的文件' };
  }
  if (input.modelReadsProject === false) {
    return { read: false, reason: '模型判定只看随附文件就能答' };
  }
  if (input.attachmentCount > 0 && !PROJECT_TERMS.test(input.text)) {
    return {
      read: false,
      reason: `这一问只问了随附的 ${String(input.attachmentCount)} 个文件，没有提到工程`
    };
  }
  return { read: true, reason: '按规则读取工程目录' };
}
