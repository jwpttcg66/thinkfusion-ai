/**
 * ECO：Engineering Context Orchestration（工程上下文编排）薄层。
 *
 * 职责：上下文包、充分度、事实分类、补充请求、版本失效。
 * 不负责：任务调度、角色分配（DMOCA）、工具权限、第二 Runtime。
 * 权威内容仍来自 Journal / 文件读取证据；本模块做可审计投影与门禁。
 */

import type { AgentEvent } from './contracts';

export type EcoFactClass =
  | 'verified_fact'
  | 'provided_context'
  | 'inference'
  | 'general_knowledge'
  | 'unknown';

export type ContextSufficiency = 'sufficient' | 'partial' | 'insufficient' | 'stale';

export type EcoRole =
  | 'architect'
  | 'analyst'
  | 'challenger'
  | 'planner'
  | 'implementer'
  | 'reviewer'
  | 'adjudicator';

export interface ContextResourceRef {
  resourceId: string;
  kind: 'file' | 'module' | 'symbol' | 'doc' | 'test' | 'decision' | 'commit' | 'other';
  pathOrLabel: string;
  verified: boolean;
  factClass: EcoFactClass;
}

export interface ContextRequest {
  requestId: string;
  modelRunId?: string;
  workId: string;
  workTaskId?: string;
  reason: string;
  requiredFor: 'analysis' | 'design' | 'implementation' | 'review' | 'verification';
  priority: 'low' | 'normal' | 'high';
  requestedPaths?: string[];
}

export interface EngineeringContextPackage {
  contextPackageId: string;
  contextVersion: number;
  workId: string;
  workTaskId?: string;
  goalVersion?: number;
  stage: string;
  role: EcoRole;
  repository?: {
    branch?: string;
    commit?: string;
    workingTreeState?: string;
  };
  architectureSummary: string;
  resources: ContextResourceRef[];
  constraints: string[];
  decisions: string[];
  verifiedFacts: string[];
  inferences: string[];
  unknowns: string[];
  missingCritical: string[];
  sufficiency: ContextSufficiency;
  createdAt: number;
}

export interface EcoWorkbenchView {
  package: EngineeringContextPackage | null;
  requests: ContextRequest[];
  canAssumeFormalRole: boolean;
  gateReason: string;
}

/** 不同职责的最低充分度要求。 */
export function requiredSufficiencyForRole(role: EcoRole): ContextSufficiency[] {
  switch (role) {
    case 'architect':
    case 'reviewer':
    case 'adjudicator':
      return ['sufficient'];
    case 'analyst':
    case 'planner':
    case 'implementer':
      return ['sufficient', 'partial'];
    case 'challenger':
      return ['sufficient', 'partial'];
  }
}

export function canAssumeRole(
  sufficiency: ContextSufficiency,
  role: EcoRole
): { ok: boolean; reason: string } {
  if (sufficiency === 'insufficient') {
    return { ok: false, reason: `上下文不足（insufficient），不能承担 ${role}` };
  }
  if (sufficiency === 'stale') {
    return { ok: false, reason: `上下文过期（stale），须重新核验后再承担 ${role}` };
  }
  const allowed = requiredSufficiencyForRole(role);
  if (!allowed.includes(sufficiency)) {
    return { ok: false, reason: `${sufficiency} 不满足 ${role} 所需充分度` };
  }
  return { ok: true, reason: `${sufficiency} 允许 ${role}` };
}

/**
 * 根据已验证资源与阶段粗评充分度。
 * 不做「假装读过仓库」——无 verified 资源时，正式架构/审核角色一律不足。
 */
export function assessContextSufficiency(input: {
  role: EcoRole;
  resources: readonly ContextResourceRef[];
  unknowns?: readonly string[];
  codeVersionChanged?: boolean;
}): {
  sufficiency: ContextSufficiency;
  missingCritical: string[];
  reasons: string[];
} {
  if (input.codeVersionChanged) {
    return {
      sufficiency: 'stale',
      missingCritical: ['代码版本已变化，须刷新上下文'],
      reasons: ['repository 版本与包不一致']
    };
  }

  const verified = input.resources.filter(item => item.verified || item.factClass === 'verified_fact');
  const missingCritical: string[] = [];
  const reasons: string[] = [];

  if (verified.length === 0) {
    missingCritical.push('无已核验工程资源');
    reasons.push('旁听或通用知识不能替代工程事实');
    const formal = input.role === 'architect' || input.role === 'reviewer' || input.role === 'adjudicator';
    return {
      sufficiency: formal ? 'insufficient' : 'partial',
      missingCritical,
      reasons
    };
  }

  if ((input.unknowns?.length ?? 0) > 0) {
    missingCritical.push(...input.unknowns!);
    reasons.push('仍有未确认项');
    return {
      sufficiency: verified.length >= 2 ? 'partial' : 'insufficient',
      missingCritical,
      reasons
    };
  }

  reasons.push(`已核验资源 ${String(verified.length)}`);
  return { sufficiency: 'sufficient', missingCritical: [], reasons };
}

/** 禁止将弱事实类升格为 verified_fact（默认）。 */
export function assertFactClassPromotion(
  from: EcoFactClass,
  to: EcoFactClass,
  options?: { allowUpgrade?: boolean }
): void {
  if (from === to) return;
  if (to !== 'verified_fact') return;
  if (options?.allowUpgrade && from === 'provided_context') return;
  if (from === 'inference' || from === 'general_knowledge' || from === 'unknown' || from === 'provided_context') {
    throw new Error(`禁止将 ${from} 升格为 verified_fact`);
  }
}

function normalizeResources(resources: readonly ContextResourceRef[]): {
  resources: ContextResourceRef[];
  demotedUnknowns: string[];
} {
  const demotedUnknowns: string[] = [];
  const next = resources.map(item => {
    if (item.verified && (item.factClass === 'inference' || item.factClass === 'unknown' || item.factClass === 'general_knowledge')) {
      demotedUnknowns.push(`伪核验已降级：${item.pathOrLabel}（${item.factClass}）`);
      return { ...item, verified: false };
    }
    return { ...item };
  });
  return { resources: next, demotedUnknowns };
}

/** 组装上下文包（调用方提供已读资源与摘要；本函数只做结构化与充分度）。 */
export function buildEngineeringContextPackage(input: {
  workId: string;
  workTaskId?: string;
  goalVersion?: number;
  stage: string;
  role: EcoRole;
  architectureSummary: string;
  resources?: ContextResourceRef[];
  constraints?: string[];
  decisions?: string[];
  verifiedFacts?: string[];
  inferences?: string[];
  unknowns?: string[];
  repository?: EngineeringContextPackage['repository'];
  codeVersionChanged?: boolean;
  now?: number;
  version?: number;
}): EngineeringContextPackage {
  const normalized = normalizeResources(input.resources ?? []);
  const unknowns = [...(input.unknowns ?? []), ...normalized.demotedUnknowns];
  const assessed = assessContextSufficiency({
    role: input.role,
    resources: normalized.resources,
    unknowns,
    codeVersionChanged: input.codeVersionChanged
  });
  const at = input.now ?? Date.now();
  return {
    contextPackageId: `eco:${input.workId}:${input.stage}:${String(at)}`,
    contextVersion: input.version ?? 1,
    workId: input.workId,
    workTaskId: input.workTaskId,
    goalVersion: input.goalVersion,
    stage: input.stage,
    role: input.role,
    repository: input.repository,
    architectureSummary: input.architectureSummary,
    resources: normalized.resources,
    constraints: input.constraints ?? [],
    decisions: input.decisions ?? [],
    verifiedFacts: input.verifiedFacts ?? normalized.resources.filter(r => r.verified).map(r => r.pathOrLabel),
    inferences: input.inferences ?? [],
    unknowns,
    missingCritical: assessed.missingCritical,
    sufficiency: assessed.sufficiency,
    createdAt: at
  };
}

/** 履行补充请求：合并资源、抬升版本、重评充分度。 */
export function fulfillContextRequest(
  pkg: EngineeringContextPackage,
  request: ContextRequest,
  newResources: readonly ContextResourceRef[]
): EngineeringContextPackage {
  const byId = new Map(pkg.resources.map(item => [item.resourceId, item]));
  for (const item of newResources) byId.set(item.resourceId, item);
  const paths = new Set([
    ...newResources.map(item => item.pathOrLabel),
    ...(request.requestedPaths ?? [])
  ]);
  const unknowns = pkg.unknowns.filter(item => {
    for (const path of paths) {
      if (item.includes(path)) return false;
    }
    return true;
  });
  return buildEngineeringContextPackage({
    workId: pkg.workId,
    workTaskId: pkg.workTaskId,
    goalVersion: pkg.goalVersion,
    stage: pkg.stage,
    role: pkg.role,
    architectureSummary: pkg.architectureSummary,
    resources: [...byId.values()],
    constraints: pkg.constraints,
    decisions: pkg.decisions,
    verifiedFacts: pkg.verifiedFacts,
    inferences: pkg.inferences,
    unknowns,
    repository: pkg.repository,
    now: Date.now(),
    version: pkg.contextVersion + 1
  });
}

/** 代码/目标版本变化后标记过期。 */
export function invalidateContextPackage(
  pkg: EngineeringContextPackage,
  reason: string
): EngineeringContextPackage {
  return {
    ...pkg,
    contextVersion: pkg.contextVersion + 1,
    sufficiency: 'stale',
    missingCritical: [...pkg.missingCritical, reason],
    createdAt: Date.now()
  };
}

export function classifyClaim(text: string, hasVerifiedRef: boolean): EcoFactClass {
  const t = text.trim();
  if (!t) return 'unknown';
  if (hasVerifiedRef) return 'verified_fact';
  if (/^我认为|^可能|^推测|^似乎/.test(t)) return 'inference';
  if (/通用|一般来说|通常/.test(t)) return 'general_knowledge';
  return 'provided_context';
}

/** 从任务事件投影 ECO 工作台（读取 eco.context.* 事件）。 */
export function projectEcoFromEvents(input: {
  workId: string;
  events: readonly AgentEvent[];
}): EcoWorkbenchView {
  let pkg: EngineeringContextPackage | null = null;
  const requests: ContextRequest[] = [];
  for (const event of input.events) {
    if (!('taskId' in event) || event.taskId !== input.workId) continue;
    if (event.type === 'eco.context.prepared') {
      pkg = event.package;
    }
    if (event.type === 'eco.context.requested') {
      requests.push(event.request);
    }
  }
  if (!pkg) {
    return {
      package: null,
      requests,
      canAssumeFormalRole: false,
      gateReason: '尚未准备工程上下文包'
    };
  }
  const gate = canAssumeRole(pkg.sufficiency, pkg.role);
  return {
    package: pkg,
    requests,
    canAssumeFormalRole: gate.ok,
    gateReason: gate.reason
  };
}
