/**
 * 转交工程时挑主导模型的探活范围。
 *
 * 真机：OpenCode Go 一个 Provider 挂 30 个模型，每个模型是一个 SubAgent。
 * 旧逻辑对 30 个串行打 `/models`，转交后空等十几秒，界面只剩「正在生成计划」。
 * 健康检查按 Provider 去重、只探真正可能当主导的那几个。
 */

export interface PlanningHealthAgent {
  id: string;
  sourceType: 'web' | 'local' | 'cloud' | string;
  providerId?: string;
}

export function planningHealthShortlist<T extends PlanningHealthAgent>(
  agents: readonly T[],
  input: {
    executionMode: 'local' | 'cloud' | 'hybrid';
    plannerAgentId?: string;
    selectedCloudModels?: readonly string[];
  }
): T[] {
  const modeOk = (agent: T): boolean => {
    if (input.executionMode === 'local') return agent.sourceType === 'local';
    if (input.executionMode === 'cloud') return agent.sourceType === 'cloud';
    return agent.sourceType === 'local' || agent.sourceType === 'cloud';
  };
  let shortlist = agents.filter(modeOk);
  if (input.plannerAgentId) {
    const preferred = shortlist.filter(agent => agent.id === input.plannerAgentId);
    if (preferred.length > 0) return preferred;
  }
  if (input.executionMode === 'cloud' && input.selectedCloudModels && input.selectedCloudModels.length > 0) {
    const selected = shortlist.filter(agent => input.selectedCloudModels!.includes(agent.id));
    if (selected.length > 0) shortlist = selected;
  }
  return shortlist;
}

/** 同一 Provider 只留一个代表去探活；没 providerId 的各自探。 */
export function uniqueByProvider<T extends PlanningHealthAgent>(agents: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const agent of agents) {
    const key = agent.providerId ? `provider:${agent.providerId}` : `agent:${agent.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(agent);
  }
  return out;
}
