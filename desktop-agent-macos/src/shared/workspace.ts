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
  /** 用户本轮明确指定，还是规则判的。界面上要能看出区别。 */
  source: 'user_selected' | 'rule';
  /** 只在工程空间有值。 */
  engineeringKind?: EngineeringTaskKind | 'clarify';
  /** 规则命中的词，供界面解释判据。 */
  signals?: string[];
  /** 「先分析再修改」这类两阶段请求。 */
  stages?: EngineeringTaskKind[];
  /** 需要用户补信息：缺项目、或表达含糊。 */
  needsProject?: boolean;
  needsClarification?: boolean;
}

export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = 'knowledge';
export const DEFAULT_DEBATE_MODE: DebateMode = 'auto';

/** 全局默认：下次启动仍然停在用户上次的空间与项目。 */
export interface WorkspaceState {
  workspaceMode: WorkspaceMode;
  workspaceRoot: string;
}

export const DEFAULT_WORKSPACE_STATE: WorkspaceState = {
  workspaceMode: DEFAULT_WORKSPACE_MODE,
  workspaceRoot: ''
};

/** 坏文件、旧版本、不可信 IPC 输入统一收敛到这里。 */
export function normalizeWorkspaceState(raw: unknown): WorkspaceState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_WORKSPACE_STATE };
  const value = raw as { workspaceMode?: unknown; workspaceRoot?: unknown };
  return {
    workspaceMode: normalizeWorkspaceMode(value.workspaceMode),
    workspaceRoot: typeof value.workspaceRoot === 'string' ? value.workspaceRoot.slice(0, 2000) : ''
  };
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
  /(修改|改成|改一下|改这个|编辑|写入|写到|覆盖|替换|实现|新增|添加|加上|补上|创建|新建|删除|删掉|移除|重命名|移动|重构|重写|修复|修好|解决这个\s?bug|接入|集成|升级|安装|提交|回滚|跑一下测试|执行测试|跑测试)/;

/** 明确只读的动词。先判这类，避免「分析一下怎么改」被误判成实施。 */
const ANALYSIS_VERBS =
  /(分析|解释|说明|看一下|看看|读一下|梳理|理解|定位|排查|追查|评审|评估|审阅|review|为什么|为何|原因|原理|机制|调用链|调用关系|依赖|架构|结构|影响范围|性能瓶颈|代码走查)/i;

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
  if (execHit && analysisHit) {
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
