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
  const resources = input.resources ?? [];
  const assessed = assessContextSufficiency({
    role: input.role,
    resources,
    unknowns: input.unknowns,
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
    resources,
    constraints: input.constraints ?? [],
    decisions: input.decisions ?? [],
    verifiedFacts: input.verifiedFacts ?? resources.filter(r => r.verified).map(r => r.pathOrLabel),
    inferences: input.inferences ?? [],
    unknowns: input.unknowns ?? [],
    missingCritical: assessed.missingCritical,
    sufficiency: assessed.sufficiency,
    createdAt: at
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
