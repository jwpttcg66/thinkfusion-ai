/**
 * Workflow Definition（P1-04）。
 *
 * 只做「定义 + 校验 + 拓扑序 + 展开成步骤」：节点引用的是现有能力 id，不引入
 * 新的执行器，也不接收模型/提示词。执行仍由现有 orchestrator 走审批、TaskGrant、
 * Journal、执行报告与验证——所以条件/循环一旦在这里展开，跑的就是真步骤。
 *
 * 支持的节点：
 * - task：一个能力调用（默认类型）；
 * - condition：按输入变量判定；不成立时本节点不执行，依赖它的节点一并跳过；
 * - loop：按 count / maxIterations 展开成 N 个真实步骤（每轮一个 step id）；
 * - parallel：其 children 作为一组执行。**本 Runtime 同一任务不允许并发计划**，
 *   因此按定义顺序串行执行，并在 notes 里如实写明，不画成并行；
 * - approval：不产生步骤，只把「这份工作流必须人工批准」抬上去，调用方据此
 *   取消自动批准。
 *
 * `until` 这类「运行时才知道要不要再跑一轮」的循环**不支持**：本版会明确报错，
 * 而不是把它展开成固定次数假装跑过。
 */

import { PlanSchema, type AgentPlan } from './contracts';

export type WorkflowNodeKind = 'task' | 'condition' | 'loop' | 'parallel' | 'approval';

export type WorkflowConditionOp =
  | 'equals'
  | 'not_equals'
  | 'truthy'
  | 'falsy'
  | 'gt'
  | 'lt'
  | 'contains'
  | 'matches';

export interface WorkflowCondition {
  /** 输入变量名（支持 `a.b` 取嵌套字段）。 */
  field: string;
  op: WorkflowConditionOp;
  value?: string | number | boolean;
}

export interface WorkflowNode {
  id: string;
  /** 现有能力的 id（capabilities 清单里的那一项）。approval / condition 可留空。 */
  capabilityId: string;
  title?: string;
  dependsOn?: string[];
  kind?: WorkflowNodeKind;
  /** 节点守卫：不成立时本节点跳过（依赖它的节点也跳过）。 */
  when?: WorkflowCondition;
  /** condition 节点的判定表达式。 */
  condition?: WorkflowCondition;
  /** loop 节点：展开轮数；`until` 不支持，写了会明确报错。 */
  loop?: {
    count?: number;
    maxIterations?: number;
    until?: WorkflowCondition;
  };
  /** parallel 节点的子节点 id；按定义顺序串行执行（单计划 Runtime）。 */
  children?: string[];
  /** 节点参数；调用方也可以按 nodeId 从 argsByNode 覆盖。 */
  args?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  title: string;
  nodes: WorkflowNode[];
}

export interface WorkflowValidation {
  ok: boolean;
  errors: string[];
}

const NODE_KINDS: readonly WorkflowNodeKind[] = ['task', 'condition', 'loop', 'parallel', 'approval'];
const LOOP_MAX = 10;

function kindOf(node: WorkflowNode): WorkflowNodeKind {
  return node.kind ?? 'task';
}

/** 只有真正执行能力的节点需要 capabilityId。 */
function needsCapability(node: WorkflowNode): boolean {
  const kind = kindOf(node);
  return kind === 'task' || kind === 'loop' || kind === 'parallel';
}

export function validateWorkflow(
  definition: WorkflowDefinition,
  knownCapabilities: readonly string[]
): WorkflowValidation {
  const errors: string[] = [];
  if (!definition.id.trim()) errors.push('workflow.id 不能为空');
  if (definition.nodes.length === 0) errors.push('workflow 至少需要一个节点');

  const known = new Set(knownCapabilities);
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (ids.has(node.id)) errors.push(`节点 id 重复：${node.id}`);
    ids.add(node.id);
    const kind = kindOf(node);
    if (!NODE_KINDS.includes(kind)) {
      errors.push(`节点 ${node.id} 的类型未知：${String(kind)}`);
    }
    if (needsCapability(node)) {
      if (!known.has(node.capabilityId)) {
        errors.push(`节点 ${node.id} 引用了未知能力：${node.capabilityId}`);
      }
      if (node.capabilityId.trim() === '') errors.push(`节点 ${node.id} 缺少能力 id`);
    }
    if (kind === 'condition' && !node.condition) {
      errors.push(`条件节点 ${node.id} 缺少 condition 判定`);
    }
    if (kind === 'loop') {
      if (!node.loop || (node.loop.count === undefined && node.loop.maxIterations === undefined)) {
        errors.push(`循环节点 ${node.id} 必须给出 loop.count 或 loop.maxIterations`);
      }
      if (node.loop?.until) {
        errors.push(`循环节点 ${node.id} 使用了 until：运行时条件循环本版不支持，请改用 count/maxIterations 或拆成两次提交`);
      }
      for (const value of [node.loop?.count, node.loop?.maxIterations]) {
        if (value === undefined) continue;
        if (!Number.isInteger(value) || value < 1 || value > LOOP_MAX) {
          errors.push(`循环节点 ${node.id} 的轮数必须在 1–${String(LOOP_MAX)} 之间`);
        }
      }
    }
    if (kind === 'parallel') {
      if (!node.children || node.children.length === 0) {
        errors.push(`并行节点 ${node.id} 必须给出 children`);
      }
      for (const child of node.children ?? []) {
        if (!ids.has(child) && !definition.nodes.some(item => item.id === child)) {
          errors.push(`并行节点 ${node.id} 的子节点不存在：${child}`);
        }
        if (child === node.id) errors.push(`并行节点 ${node.id} 不能把自己当子节点`);
      }
    }
    if (node.when && !node.when.field.trim()) {
      errors.push(`节点 ${node.id} 的 when 缺少字段名`);
    }
  }

  // 子节点由 parallel 节点负责执行，不能作为独立节点再跑一次。
  const childIds = new Set(definition.nodes.flatMap(node => (kindOf(node) === 'parallel' ? node.children ?? [] : [])));
  for (const node of definition.nodes) {
    if (kindOf(node) === 'parallel') continue;
    for (const child of node.children ?? []) {
      errors.push(`节点 ${node.id} 不是并行节点，不能声明 children：${child}`);
    }
  }
  for (const id of childIds) {
    const node = definition.nodes.find(item => item.id === id);
    if (!node) continue;
    if (kindOf(node) === 'parallel' || kindOf(node) === 'approval') {
      errors.push(`并行的子节点 ${id} 只能是普通任务节点`);
    }
    if (kindOf(node) === 'condition') {
      errors.push(`并行的子节点 ${id} 不能是条件节点（条件请在并行节点上用 when 表达）`);
    }
  }

  for (const node of definition.nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!ids.has(dep)) errors.push(`节点 ${node.id} 依赖了不存在的节点：${dep}`);
      if (dep === node.id) errors.push(`节点 ${node.id} 不能依赖自己`);
    }
  }

  if (topologicalOrder(definition).order === null && errors.length === 0) {
    errors.push('工作流存在环，无法确定执行顺序');
  }
  return { ok: errors.length === 0, errors };
}

/** 拓扑序（稳定：同层按定义顺序）。有环时 order=null。 */
export function topologicalOrder(definition: WorkflowDefinition): { order: string[] | null } {
  const byId = new Map(definition.nodes.map(node => [node.id, node]));
  const indegree = new Map<string, number>();
  for (const node of definition.nodes) {
    indegree.set(node.id, (node.dependsOn ?? []).filter(dep => byId.has(dep)).length);
  }
  const queue = definition.nodes
    .filter(node => (indegree.get(node.id) ?? 0) === 0)
    .map(node => node.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const node of definition.nodes) {
      if (!(node.dependsOn ?? []).includes(id)) continue;
      const next = (indegree.get(node.id) ?? 0) - 1;
      indegree.set(node.id, next);
      if (next === 0) queue.push(node.id);
    }
  }
  return { order: order.length === definition.nodes.length ? order : null };
}

function readField(inputs: Record<string, unknown>, field: string): unknown {
  const segments = field.split('.').filter(Boolean);
  let current: unknown = inputs;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 条件求值：只读输入变量，不做表达式求值（不 eval 任何东西）。 */
export function evaluateWorkflowCondition(
  condition: WorkflowCondition,
  variables: Record<string, unknown>
): boolean {
  const actual = readField(variables, condition.field);
  const expected = condition.value;
  switch (condition.op) {
    case 'truthy':
      return Boolean(actual);
    case 'falsy':
      return !actual;
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'gt':
    case 'lt': {
      const left = typeof actual === 'number' ? actual : Number(actual);
      const right = typeof expected === 'number' ? expected : Number(expected);
      if (Number.isNaN(left) || Number.isNaN(right)) return false;
      return condition.op === 'gt' ? left > right : left < right;
    }
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'matches': {
      if (typeof actual !== 'string' || typeof expected !== 'string') return false;
      try {
        return new RegExp(expected).test(actual);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

export interface ResolvedWorkflowStep {
  index: number;
  nodeId: string;
  capabilityId: string;
  title?: string;
  args: Record<string, unknown>;
  /** loop 节点展开时的第几轮（从 1 开始）；非循环节点为 undefined。 */
  iteration?: number;
  dependsOn: string[];
}

export interface ResolvedWorkflow {
  ok: boolean;
  errors: string[];
  steps: ResolvedWorkflowStep[];
  /** 没执行的节点与原因（条件不成立、依赖未执行等）。 */
  skipped: Array<{ nodeId: string; reason: string }>;
  /** 出现 approval 节点时必须人工批准，调用方不得自动放行。 */
  requiresApproval: boolean;
  notes: string[];
}

/**
 * 定义 → 真实步骤序列。
 *
 * 条件读的是调用方给的 inputs（不是模型自由发挥的文本）；循环按固定轮数展开
 * 成多个步骤；并行节点按定义顺序串行执行并如实记 note。所有跳过都写原因。
 */
export function resolveWorkflow(input: {
  definition: WorkflowDefinition;
  knownCapabilities: readonly string[];
  inputs?: Record<string, unknown>;
  argsByNode?: Record<string, Record<string, unknown>>;
}): ResolvedWorkflow {
  const validation = validateWorkflow(input.definition, input.knownCapabilities);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, steps: [], skipped: [], requiresApproval: false, notes: [] };
  }
  const { order } = topologicalOrder(input.definition);
  if (!order) {
    return { ok: false, errors: ['工作流存在环，无法确定执行顺序'], steps: [], skipped: [], requiresApproval: false, notes: [] };
  }
  const byId = new Map(input.definition.nodes.map(node => [node.id, node]));
  const childIds = new Set(input.definition.nodes.flatMap(node => (kindOf(node) === 'parallel' ? node.children ?? [] : [])));
  const variables: Record<string, unknown> = { ...(input.inputs ?? {}) };
  const steps: ResolvedWorkflowStep[] = [];
  const skipped: ResolvedWorkflow['skipped'] = [];
  const notes: string[] = [];
  const skippedIds = new Set<string>();
  let requiresApproval = false;

  const argsOf = (node: WorkflowNode): Record<string, unknown> => {
    const override = input.argsByNode?.[node.id];
    return { ...(node.args ?? {}), ...(override ?? {}) };
  };
  const push = (node: WorkflowNode, args: Record<string, unknown>, iteration?: number): void => {
    steps.push({
      index: steps.length,
      nodeId: iteration !== undefined ? `${node.id}#${String(iteration)}` : node.id,
      capabilityId: node.capabilityId,
      ...(node.title ? { title: iteration !== undefined ? `${node.title}（第 ${String(iteration)} 轮）` : node.title } : {}),
      args,
      ...(iteration !== undefined ? { iteration } : {}),
      dependsOn: [...(node.dependsOn ?? [])]
    });
  };
  const guardOk = (node: WorkflowNode): boolean => {
    if (!node.when) return true;
    return evaluateWorkflowCondition(node.when, variables);
  };

  for (const id of order) {
    if (childIds.has(id)) continue; // 由所属 parallel 节点执行
    const node = byId.get(id)!;
    const kind = kindOf(node);
    const blockedBy = (node.dependsOn ?? []).filter(dep => skippedIds.has(dep));
    if (blockedBy.length > 0) {
      skipped.push({ nodeId: id, reason: `依赖节点未执行：${blockedBy.join('、')}` });
      skippedIds.add(id);
      continue;
    }
    if (kind === 'approval') {
      requiresApproval = true;
      notes.push(`节点 ${id} 要求人工批准`);
      continue;
    }
    if (kind === 'condition') {
      const passed = node.condition
        ? evaluateWorkflowCondition(node.condition, variables)
        : guardOk(node);
      variables[id] = passed;
      if (!passed) {
        skipped.push({ nodeId: id, reason: '条件不成立' });
        skippedIds.add(id);
      } else {
        notes.push(`条件 ${id} 成立`);
      }
      continue;
    }
    if (!guardOk(node)) {
      skipped.push({ nodeId: id, reason: 'when 条件不成立' });
      skippedIds.add(id);
      continue;
    }
    if (kind === 'loop') {
      const count = Math.min(
        LOOP_MAX,
        Math.max(1, Math.floor(node.loop?.count ?? node.loop?.maxIterations ?? 1))
      );
      for (let index = 1; index <= count; index += 1) push(node, argsOf(node), index);
      if (count > 1) notes.push(`循环 ${id} 展开为 ${String(count)} 轮`);
      continue;
    }
    if (kind === 'parallel') {
      const children = node.children ?? [];
      notes.push(`并行节点 ${id} 的 ${String(children.length)} 个子节点在本 Runtime 按定义顺序串行执行（同一任务不允许并发计划）`);
      for (const childId of children) {
        const child = byId.get(childId);
        if (!child) continue;
        if (!guardOk(child)) {
          skipped.push({ nodeId: childId, reason: 'when 条件不成立' });
          skippedIds.add(childId);
          continue;
        }
        push(child, argsOf(child));
      }
      continue;
    }
    push(node, argsOf(node));
  }

  return { ok: true, errors: [], steps, skipped, requiresApproval, notes };
}

/** 执行器需要的步骤骨架：顺序、依赖、能力；参数由调用方按能力 schema 补。 */
export interface WorkflowStepSkeleton {
  index: number;
  nodeId: string;
  capabilityId: string;
  dependsOn: string[];
  title?: string;
}

/**
 * 定义 → 步骤骨架（不含条件/循环展开）。
 *
 * 保留给只需要「顺序 + 依赖」的调用方；要真实执行请用 {@link resolveWorkflow}，
 * 它会把条件、循环、并行都算清楚。
 */
export function workflowToSteps(
  definition: WorkflowDefinition,
  knownCapabilities: readonly string[]
): { steps: WorkflowStepSkeleton[]; error?: string } {
  const validation = validateWorkflow(definition, knownCapabilities);
  if (!validation.ok) return { steps: [], error: validation.errors.join('；') };
  const { order } = topologicalOrder(definition);
  if (!order) return { steps: [], error: '工作流存在环，无法确定执行顺序' };
  const byId = new Map(definition.nodes.map(node => [node.id, node]));
  const childIds = new Set(definition.nodes.flatMap(node => (kindOf(node) === 'parallel' ? node.children ?? [] : [])));
  return {
    steps: order
      .filter(id => !childIds.has(id))
      .filter(id => {
        const kind = kindOf(byId.get(id)!);
        return kind === 'task' || kind === 'loop';
      })
      .map((nodeId, index) => {
        const node = byId.get(nodeId)!;
        return {
          index,
          nodeId: node.id,
          capabilityId: node.capabilityId,
          dependsOn: [...(node.dependsOn ?? [])],
          ...(node.title ? { title: node.title } : {})
        };
      })
  };
}

/**
 * 定义 → 可提交的计划（执行器桥）。
 *
 * 节点能力必须就是工具名（fs.readFile / code.run ...），参数由调用方按节点给；
 * 条件/循环在这里就展开成真实步骤，最后用 PlanSchema 校验，参数不对就整份拒绝，
 * 不会带着错参数进审批。
 */
export function workflowToPlan(input: {
  definition: WorkflowDefinition;
  knownCapabilities: readonly string[];
  taskId: string;
  roundId: string;
  argsByNode?: Record<string, Record<string, unknown>>;
  inputs?: Record<string, unknown>;
  completionCondition?: string;
}): {
  plan?: AgentPlan;
  error?: string;
  skipped?: ResolvedWorkflow['skipped'];
  requiresApproval?: boolean;
  notes?: string[];
} {
  const resolved = resolveWorkflow({
    definition: input.definition,
    knownCapabilities: input.knownCapabilities,
    ...(input.inputs ? { inputs: input.inputs } : {}),
    ...(input.argsByNode ? { argsByNode: input.argsByNode } : {})
  });
  if (!resolved.ok) return { error: resolved.errors.join('；') };
  if (resolved.steps.length === 0) {
    return {
      error: `工作流没有任何可执行步骤（${resolved.skipped.map(item => `${item.nodeId}: ${item.reason}`).join('；') || '全部节点被跳过'}）`,
      skipped: resolved.skipped,
      requiresApproval: resolved.requiresApproval,
      notes: resolved.notes
    };
  }
  const candidate = {
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId: input.taskId,
    roundId: input.roundId,
    title: input.definition.title,
    description: `工作流 ${input.definition.id}${resolved.notes.length > 0 ? `（${resolved.notes.join('；')}）` : ''}`,
    kind: 'implementation',
    steps: resolved.steps.map(step => ({
      id: step.nodeId,
      tool: step.capabilityId,
      ...(step.title ? { description: step.title } : {}),
      args: step.args
    })),
    completion: {
      condition: input.completionCondition ?? '工作流全部节点执行完成并各自验证通过'
    }
  };
  const parsed = PlanSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      error: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；'),
      skipped: resolved.skipped,
      notes: resolved.notes
    };
  }
  return {
    plan: parsed.data,
    skipped: resolved.skipped,
    requiresApproval: resolved.requiresApproval,
    notes: resolved.notes
  };
}
