/**
 * Workflow Definition（P1，第一版）。
 *
 * 只做「定义 + 校验 + 拓扑序」：节点引用的是现有能力 id，不引入新的执行器，
 * 也不允许节点自带模型/提示词。执行仍由现有 orchestrator 按拓扑序映射成步骤，
 * 这样 TDL 事件、审批、证据链都不用重写。
 */

export interface WorkflowNode {
  id: string;
  /** 现有能力的 id（capabilities 清单里的那一项）。 */
  capabilityId: string;
  title?: string;
  dependsOn?: string[];
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
    if (!known.has(node.capabilityId)) {
      errors.push(`节点 ${node.id} 引用了未知能力：${node.capabilityId}`);
    }
    if (node.capabilityId.trim() === '') errors.push(`节点 ${node.id} 缺少能力 id`);
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
