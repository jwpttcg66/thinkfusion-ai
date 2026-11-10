/**
 * 「选择模型」的纯逻辑。
 *
 * 两个界面共用：设置里的「选择模型」是完整的候选清单（网关报过的全部模型），
 * 输入框旁的「模型」胶囊是这一问的成员清单。共同的规则只有三条：
 *
 * 1. **全选只动看得见的那几条。** 搜索框把清单缩窄之后点「全选」，不能把
 *    被过滤掉、用户根本看不见的已选项一起清掉——那等于在看不见的地方改动
 *    他的选择。（deepseekharness 的“选择模型”对话框是同一条规则。）
 * 2. **去重、保序。** 候选来自「网关清单 + 已选清单」两处，同一个模型名会
 *    各出现一次；顺序按候选原顺序，勾选不会让行跳来跳去。
 * 3. **空清单不提交。** 空数组在配置里表示「用预设兜底」，不是「一个都不
 *    要」；把它当成后者存下去，用户会以为模型全被删了。
 */

/** 去空白、去重并保持首次出现的顺序。 */
export function uniqueModels(input: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** 候选清单：网关报过的在前，只留在已选里的旧模型补在后面。 */
export function mergeCandidates(catalog: readonly string[], selected: readonly string[]): string[] {
  return uniqueModels([...catalog, ...selected]);
}

/** 大小写不敏感的搜索；空查询返回原清单。 */
export function filterModels(models: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter(model => model.toLowerCase().includes(needle));
}

/**
 * 勾上/取消「看得见的那一批」。
 *
 * @param picked 已经勾选的模型名
 * @param visible 当前搜索结果
 * @param check true = 全选可见项，false = 取消全选可见项
 */
export function toggleVisibleModels(
  picked: readonly string[],
  visible: readonly string[],
  check: boolean
): string[] {
  const visibleSet = new Set(visible);
  if (check) return uniqueModels([...picked, ...visible]);
  return picked.filter(model => !visibleSet.has(model));
}

/** 可见项是否已经全被勾上（空清单不算「全选」）。 */
export function allVisiblePicked(picked: readonly string[], visible: readonly string[]): boolean {
  return visible.length > 0 && visible.every(model => picked.includes(model));
}

/**
 * 某家服务「更新列表」之后，把研究设置里挂着的旧成员裁掉。
 *
 * 设置里的勾选决定这家服务还能出场的模型；研究设置 / 输入框里的
 * `selectedCloudModels` 与 `leadAgentId` 是另一份名单。两份不对齐时，
 * 用户以为已经关掉的模型还会出现在提问条上——所以保存后必须按这家
 * 新清单裁一次，只动属于这家的 id，别误伤别家或网页通道。
 */
export function pruneCloudParticipantsForProvider(
  selectedCloudModels: readonly string[] | undefined,
  leadAgentId: string | undefined,
  providerId: string,
  models: readonly string[]
): {
  selectedCloudModels?: string[];
  leadAgentId?: string;
  clearLead: boolean;
  changed: boolean;
} {
  const allowed = new Set(models.map(model => `${providerId}:${model}`));
  const fromProvider = (id: string) => id.startsWith(`${providerId}:`);
  let changed = false;
  let nextSelected = selectedCloudModels;
  if (Array.isArray(selectedCloudModels)) {
    const pruned = selectedCloudModels.filter(id => !fromProvider(id) || allowed.has(id));
    if (pruned.length !== selectedCloudModels.length) {
      nextSelected = pruned;
      changed = true;
    }
  }
  const clearLead = Boolean(leadAgentId && fromProvider(leadAgentId) && !allowed.has(leadAgentId));
  if (clearLead) changed = true;
  return {
    ...(nextSelected !== undefined ? { selectedCloudModels: [...nextSelected] } : {}),
    ...(!clearLead && leadAgentId ? { leadAgentId } : {}),
    clearLead,
    changed
  };
}

/**
 * 关闭设置后按当前可选云端成员裁一次：池子里已经没了的 id 不能再留在勾选里。
 */
export function pruneCloudParticipantsAgainstPool(
  selectedCloudModels: readonly string[] | undefined,
  leadAgentId: string | undefined,
  availableMemberIds: ReadonlySet<string>,
  cloudProviderIds: ReadonlySet<string>
): {
  selectedCloudModels?: string[];
  leadAgentId?: string;
  clearLead: boolean;
  changed: boolean;
} {
  let changed = false;
  let nextSelected = selectedCloudModels;
  if (Array.isArray(selectedCloudModels)) {
    const pruned = selectedCloudModels.filter(id => availableMemberIds.has(id));
    if (pruned.length !== selectedCloudModels.length) {
      nextSelected = pruned;
      changed = true;
    }
  }
  let clearLead = false;
  if (leadAgentId) {
    const colon = leadAgentId.indexOf(':');
    const providerId = colon > 0 ? leadAgentId.slice(0, colon) : '';
    if (cloudProviderIds.has(providerId) && !availableMemberIds.has(leadAgentId)) {
      clearLead = true;
      changed = true;
    }
  }
  return {
    ...(nextSelected !== undefined ? { selectedCloudModels: [...nextSelected] } : {}),
    ...(!clearLead && leadAgentId ? { leadAgentId } : {}),
    clearLead,
    changed
  };
}
