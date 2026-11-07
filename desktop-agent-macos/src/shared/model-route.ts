import type { ExecutionMode } from './conversation';

/**
 * Model Router（产品定义第 8 节：Model Router 负责「选择合适模型」）。
 *
 * 这里只有纯规则，因为它要回答的是一个产品问题：**这一轮到底会用到哪些模型，
 * 为什么是它们**。它不推翻用户的选择——归属规则（2026-11-06 用户裁决）写得
 * 很清楚：用户选了网页主导，就只用网页；选了混合，才由这一层综合决定用哪一类。
 *
 * 三条底线：
 * 1. 回答永远来自网页通道。执行模式只决定回答之后的汇总/质疑/裁决由谁做。
 * 2. 不为了「多模型」而多调模型。`estimatedCalls` 就是把这件事摊开给人看。
 * 3. 缺成员时降级要说出来（`degraded`），不能静默少问一家。
 */
export type RouteTaskKind =
  | 'answer'
  | 'research'
  | 'compare'
  | 'extract'
  | 'engineering_analysis'
  | 'engineering_execution';

export interface ModelRouteInput {
  taskKind: RouteTaskKind;
  /** 用户在这一轮选定的执行模式。 */
  executionMode: ExecutionMode;
  available: {
    /** 已开启且可用的网页通道 id。 */
    web: string[];
    /** 可用的本地模型 id。 */
    local: string[];
    /** 可用（配了 Key 且健康）的云端模型 id。 */
    cloud: string[];
  };
  /** 用户点名只用这几条网页通道时，按这个来。 */
  selectedWebChannels?: string[];
  /** 用户点名的主导人；有值就直接用，不再挑。 */
  leadAgentId?: string;
}

export interface ModelRoute {
  /** 这一轮真的会去问的网页通道。 */
  answerers: string[];
  /** 可用作主导/汇总的成员（按执行模式的归属规则收敛）。 */
  synthesizers: string[];
  /** 可用作辩论、评审、规划的 API 成员（本地 + 云端）。 */
  executors: string[];
  /** 收敛后的实际模式。请求的模式没有可用成员时会降级。 */
  mode: ExecutionMode;
  /** 为什么这么选。 */
  reason: string;
  /** 保守估计这一轮的模型调用次数：回答者数 + 汇总一次。 */
  estimatedCalls: number;
  /** 降级说明；没有降级时为空。 */
  degraded?: string;
}

const KNOWLEDGE_KINDS: RouteTaskKind[] = ['answer', 'research', 'compare', 'extract'];

/**
 * 把会话/路由里的任务名收敛成路由认识的那几个。
 *
 * `workspace` 是旧意图名，等价于「要对工程动手」，按工程实施算；`clarify`
 * 表示还说不清要做什么，这时按工程分析估算最保守（只读、不写）。
 */
export function toRouteTaskKind(kind: string): RouteTaskKind {
  if (kind === 'workspace') return 'engineering_execution';
  if (kind === 'clarify') return 'engineering_analysis';
  if (kind === 'engineering_execution' || kind === 'engineering_analysis') return kind;
  if (kind === 'research' || kind === 'compare' || kind === 'extract') return kind;
  return 'answer';
}

export function routeModels(input: ModelRouteInput): ModelRoute {
  const selected = input.selectedWebChannels?.length
    ? input.available.web.filter(id => input.selectedWebChannels!.includes(id))
    : input.available.web;
  const answerers = [...new Set(selected)];
  const executors = [...new Set([...input.available.local, ...input.available.cloud])];

  const notes: string[] = [];
  let mode: ExecutionMode = input.executionMode;
  let synthesizers: string[] = [];

  if (input.leadAgentId) {
    synthesizers = [input.leadAgentId];
    notes.push(`主导人由用户指定：${input.leadAgentId}`);
  } else if (mode === 'web') {
    synthesizers = answerers;
    notes.push('网页主导：由回答过的网页通道汇总');
  } else if (mode === 'local') {
    synthesizers = input.available.local;
    if (synthesizers.length === 0) {
      mode = 'web';
      synthesizers = answerers;
      notes.push('本地主导但没有可用本地模型，降级为网页主导');
    }
  } else if (mode === 'cloud') {
    synthesizers = input.available.cloud;
    if (synthesizers.length === 0) {
      mode = 'web';
      synthesizers = answerers;
      notes.push('云端主导但没有可用云端模型，降级为网页主导');
    }
  } else {
    // hybrid：这一层才是真正在「综合决定」。
    // - 工程实施要写文件、跑测试、读工程，交给能稳定长输出的 API 成员；
    // - 技术比较与专题研究要长链条归纳，本地小模型容易截断，云端优先；
    // - 日常问答与工程分析结论短，本地模型够用，也最省。
    if (input.taskKind === 'engineering_execution' && input.available.cloud.length > 0) {
      mode = 'cloud';
      synthesizers = input.available.cloud;
      notes.push('混合：工程实施交给云端模型规划与评审');
    } else if (input.available.local.length > 0 && (input.taskKind === 'answer' || input.taskKind === 'engineering_analysis')) {
      mode = 'local';
      synthesizers = input.available.local;
      notes.push('混合：短结论类任务交给本地模型，不上网');
    } else if (input.available.cloud.length > 0) {
      mode = 'cloud';
      synthesizers = input.available.cloud;
      notes.push('混合：长链条任务交给云端模型');
    } else if (input.available.local.length > 0) {
      mode = 'local';
      synthesizers = input.available.local;
      notes.push('混合：没有云端模型，改用本地模型');
    } else {
      mode = 'web';
      synthesizers = answerers;
      notes.push('混合：没有可用 API 模型，降级为网页主导');
    }
  }

  if (answerers.length === 0) {
    notes.push('没有可用的网页通道：这一轮无法回答，需要先在通道设置里打开一条');
  }
  if (KNOWLEDGE_KINDS.includes(input.taskKind) && executors.length === 0) {
    notes.push('没有本地/云端模型：辩论与独立评审将不可用');
  }

  const estimatedCalls = answerers.length + (synthesizers.length > 0 ? 1 : 0);
  const degraded = mode !== input.executionMode
    ? `请求的是${modeLabel(input.executionMode)}，实际按${modeLabel(mode)}执行`
    : undefined;

  return {
    answerers,
    synthesizers: [...new Set(synthesizers)],
    executors,
    mode,
    reason: notes.join('；'),
    estimatedCalls,
    ...(degraded ? { degraded } : {})
  };
}

function modeLabel(mode: ExecutionMode): string {
  if (mode === 'web') return '网页主导';
  if (mode === 'local') return '本地主导';
  if (mode === 'cloud') return '云端主导';
  return '混合';
}
