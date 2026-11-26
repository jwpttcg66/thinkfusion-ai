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

/**
 * 补充上下文的请求类型（P1-01）。
 *
 * 以前只有「给我这些路径」，模型没法说「我要这个符号的调用关系 / 我要这个
 * 模块的测试」。类型化之后，每条补充证据都能回答「为什么要读它」，
 * 也才能在版本变化时精确失效。
 */
export type ContextRequestKind =
  | 'FILE_READ'
  | 'DIRECTORY_DISCOVERY'
  | 'SYMBOL_LOOKUP'
  | 'CALL_RELATION'
  | 'TEST_DISCOVERY'
  | 'DIFF_READ';

export const CONTEXT_REQUEST_KINDS: readonly ContextRequestKind[] = [
  'FILE_READ',
  'DIRECTORY_DISCOVERY',
  'SYMBOL_LOOKUP',
  'CALL_RELATION',
  'TEST_DISCOVERY',
  'DIFF_READ'
];

export function isContextRequestKind(value: unknown): value is ContextRequestKind {
  return typeof value === 'string' && CONTEXT_REQUEST_KINDS.includes(value as ContextRequestKind);
}

export interface ContextResourceRef {
  resourceId: string;
  kind: 'file' | 'module' | 'symbol' | 'doc' | 'test' | 'decision' | 'commit' | 'other';
  pathOrLabel: string;
  verified: boolean;
  factClass: EcoFactClass;
  /** 读到内容时的 sha256；没有摘要的「已核验」不算读过工程。 */
  digest?: string;
  /** 读到的字节数；用于说明这份证据有多大，不参与充分度计算。 */
  size?: number;
  verifiedAt?: number;
  /** 这条证据是被哪条请求、以什么方式取得的；分发/审计时要能回答来源。 */
  provenance?: {
    requestId: string;
    kind: ContextRequestKind;
  };
}

/** 一份上下文包由哪些请求补齐；与 contextVersion 一起构成来源记录。 */
export interface ContextSourceRecord {
  requestId: string;
  kind: ContextRequestKind;
  resourceIds: string[];
  at: number;
}

/** 交给评审/辩论用的证据摘要：只带路径、摘要与来源，不带整份文件内容。 */
export interface EcoEvidenceSummary {
  path: string;
  digest: string;
  size?: number;
  /** 证据类型（file/test/symbol…）；评审材料里用于区分「读文件」与「读测试」。 */
  kind?: ContextResourceRef['kind'];
  /** 由哪条请求取得；没有请求记录（例如计划路径直达）时为 undefined。 */
  requestId?: string;
}

/** 从上下文包里挑出真正的工程证据（已过滤掉计划/工作区路径）。 */
export function engineeringEvidenceOf(pkg: EngineeringContextPackage): EcoEvidenceSummary[] {
  return pkg.resources.filter(isEngineeringEvidence).map(item => ({
    path: item.pathOrLabel,
    digest: item.digest!,
    ...(item.size === undefined ? {} : { size: item.size }),
    kind: item.kind,
    ...(item.provenance ? { requestId: item.provenance.requestId } : {})
  }));
}

export interface ContextRequest {
  requestId: string;
  modelRunId?: string;
  workId: string;
  workTaskId?: string;
  reason: string;
  requiredFor: 'analysis' | 'design' | 'implementation' | 'review' | 'verification';
  priority: 'low' | 'normal' | 'high';
  /** 证据类型；缺省按 FILE_READ 处理（兼容旧事件）。 */
  kind?: ContextRequestKind;
  requestedPaths?: string[];
  /** DIRECTORY_DISCOVERY 的目标目录（工作区相对路径）。 */
  directory?: string;
  /** SYMBOL_LOOKUP / CALL_RELATION 的符号名。 */
  symbol?: string;
  /** DIFF_READ 的基线；缺省 HEAD。 */
  baseRef?: string;
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
  /** 这份包由哪些补充请求补齐；分发时要能带出「来源 + 版本」。 */
  sources?: ContextSourceRecord[];
  constraints: string[];
  decisions: string[];
  verifiedFacts: string[];
  inferences: string[];
  unknowns: string[];
  missingCritical: string[];
  sufficiency: ContextSufficiency;
  /** 被判定过期时写明原因与时间；仍保留资源供审计，但不再算正式证据。 */
  invalidatedBy?: string;
  invalidatedAt?: number;
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
 * 哪些资源算「真的读过工程」。
 *
 * `decision`（计划）与 `other`（工作区路径）只证明「知道计划长什么样 / 工程在哪」，
 * 不证明读过任何工程内容；只有带内容摘要的文件/模块/符号/文档/测试才算证据。
 */
export const ENGINEERING_EVIDENCE_KINDS: readonly ContextResourceRef['kind'][] = [
  'file',
  'module',
  'symbol',
  'doc',
  'test'
];

export function isEngineeringEvidence(item: ContextResourceRef): boolean {
  return (
    item.verified === true &&
    item.factClass === 'verified_fact' &&
    ENGINEERING_EVIDENCE_KINDS.includes(item.kind) &&
    typeof item.digest === 'string' &&
    item.digest.length > 0
  );
}

/**
 * 根据已验证资源与阶段粗评充分度。
 * 不做「假装读过仓库」——没有带摘要的工程证据时，正式架构/审核角色一律不足；
 * 计划本身与工作区路径不属于工程证据（它们只说明「知道在哪」，不说明「读过」）。
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

  const verified = input.resources.filter(item => item.verified && item.factClass === 'verified_fact');
  const evidence = verified.filter(isEngineeringEvidence);
  const missingCritical: string[] = [];
  const reasons: string[] = [];
  const formal = input.role === 'architect' || input.role === 'reviewer' || input.role === 'adjudicator';

  if (evidence.length === 0) {
    missingCritical.push('无已核验的工程代码证据（需实际读取文件并附内容摘要）');
    reasons.push('计划与工作区路径只说明「知道在哪」，不等于「读过工程」');
    if ((input.unknowns?.length ?? 0) > 0) missingCritical.push(...input.unknowns!);
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
      sufficiency: evidence.length >= 2 ? 'partial' : 'insufficient',
      missingCritical,
      reasons
    };
  }

  reasons.push(`已核验工程证据 ${String(evidence.length)} 份`);
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
  sources?: ContextSourceRecord[];
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
    ...(input.sources ? { sources: [...input.sources] } : {}),
    constraints: input.constraints ?? [],
    decisions: input.decisions ?? [],
    verifiedFacts: [
      ...new Set([
        ...(input.verifiedFacts ?? []),
        ...normalized.resources.filter(isEngineeringEvidence).map(r => r.pathOrLabel)
      ])
    ],
    inferences: input.inferences ?? [],
    unknowns,
    missingCritical: assessed.missingCritical,
    sufficiency: assessed.sufficiency,
    createdAt: at
  };
}

/**
 * 履行补充请求：合并资源、抬升版本、重评充分度。
 *
 * 每条新资源都会盖上 `provenance`（来自哪条请求、什么类型），包上再记一条
 * `sources`：给其他协作成员分发时，「这行结论读的是哪份文件、怎么读的」
 * 必须能一路带回去，否则补充上下文就变成了不可追溯的加料。
 */
export function fulfillContextRequest(
  pkg: EngineeringContextPackage,
  request: ContextRequest,
  newResources: readonly ContextResourceRef[]
): EngineeringContextPackage {
  const kind = request.kind ?? 'FILE_READ';
  const byId = new Map(pkg.resources.map(item => [item.resourceId, item]));
  const stamped: string[] = [];
  for (const item of newResources) {
    const withSource: ContextResourceRef = item.provenance
      ? { ...item }
      : { ...item, provenance: { requestId: request.requestId, kind } };
    byId.set(withSource.resourceId, withSource);
    stamped.push(withSource.resourceId);
  }
  const paths = new Set([
    ...newResources.map(item => item.pathOrLabel),
    ...(request.requestedPaths ?? []),
    ...(request.directory ? [request.directory] : []),
    ...(request.symbol ? [request.symbol] : [])
  ]);
  const unknowns = pkg.unknowns.filter(item => {
    for (const path of paths) {
      if (item.includes(path)) return false;
    }
    return true;
  });
  const sources: ContextSourceRecord[] = [...(pkg.sources ?? [])];
  if (stamped.length > 0) {
    sources.push({
      requestId: request.requestId,
      kind,
      resourceIds: stamped,
      at: Date.now()
    });
  }
  return buildEngineeringContextPackage({
    workId: pkg.workId,
    workTaskId: pkg.workTaskId,
    goalVersion: pkg.goalVersion,
    stage: pkg.stage,
    role: pkg.role,
    architectureSummary: pkg.architectureSummary,
    resources: [...byId.values()],
    ...(sources.length > 0 ? { sources } : {}),
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

/**
 * 由缺失证据生成一条补充请求。
 *
 * 这是「上下文不足」到「去读文件」之间的桥：调用方把这个请求写进事件（可审计），
 * 再按 `requestedPaths` 真正读取文件，最后用 {@link fulfillContextRequest} 抬版本。
 * 已充分时返回 null——没有缺口就不该造一条请求。
 */
export function contextRequestForGaps(
  pkg: EngineeringContextPackage,
  input?: {
    modelRunId?: string;
    requiredFor?: ContextRequest['requiredFor'];
    requestedPaths?: string[];
    reason?: string;
    priority?: ContextRequest['priority'];
    now?: number;
  }
): ContextRequest | null {
  if (pkg.sufficiency === 'sufficient') return null;
  const paths = [...new Set((input?.requestedPaths ?? []).filter(Boolean))];
  const reason =
    input?.reason ??
    (pkg.missingCritical.length > 0
      ? `上下文不足：${pkg.missingCritical.join('；')}`
      : '上下文不足，需要读取真实工程文件');
  return {
    requestId: `eco-req:${pkg.workId}:${String(input?.now ?? Date.now())}`,
    ...(input?.modelRunId ? { modelRunId: input.modelRunId } : {}),
    workId: pkg.workId,
    ...(pkg.workTaskId ? { workTaskId: pkg.workTaskId } : {}),
    reason,
    requiredFor: input?.requiredFor ?? 'review',
    priority: input?.priority ?? 'high',
    ...(paths.length > 0 ? { requestedPaths: paths } : {})
  };
}

/** 代码/目标版本变化后标记过期。 */
export function invalidateContextPackage(
  pkg: EngineeringContextPackage,
  reason: string,
  now?: number
): EngineeringContextPackage {
  return {
    ...pkg,
    contextVersion: pkg.contextVersion + 1,
    sufficiency: 'stale',
    missingCritical: [...pkg.missingCritical, reason],
    invalidatedBy: reason,
    invalidatedAt: now ?? Date.now(),
    createdAt: now ?? Date.now()
  };
}

/**
 * 包是否还对应「现在的工程与目标」（P1-01 / P1-05）。
 *
 * 只比可观测的事实：commit、工作树状态、目标版本。任何一项变了，包里那些
 * 「已核验」的行号/调用关系就可能已经指向别的东西，不能继续当正式证据用。
 * 不带可比字段就不判过期——宁可不判，也不靠猜。
 */
export function contextInvalidation(
  pkg: EngineeringContextPackage,
  current: {
    commit?: string;
    workingTreeState?: string;
    goalVersion?: number;
  }
): { stale: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (pkg.sufficiency === 'stale') {
    reasons.push(pkg.invalidatedBy ?? '包已被标记过期');
  }
  if (
    current.goalVersion !== undefined &&
    pkg.goalVersion !== undefined &&
    current.goalVersion !== pkg.goalVersion
  ) {
    reasons.push(`目标版本已从 v${String(pkg.goalVersion)} 变为 v${String(current.goalVersion)}`);
  }
  if (current.commit && pkg.repository?.commit && current.commit !== pkg.repository.commit) {
    reasons.push(`代码提交已从 ${pkg.repository.commit.slice(0, 8)} 变为 ${current.commit.slice(0, 8)}`);
  }
  if (
    current.workingTreeState &&
    pkg.repository?.workingTreeState &&
    current.workingTreeState !== pkg.repository.workingTreeState
  ) {
    reasons.push(`工作树状态已从 ${pkg.repository.workingTreeState} 变为 ${current.workingTreeState}`);
  }
  return { stale: reasons.length > 0, reasons };
}

/**
 * 按缺口产出**类型化**补充请求（P1-01）。
 *
 * 与 {@link contextRequestForGaps} 的区别：那条只问「给我这些路径」，
 * 这条能问「这个符号在哪定义/被谁调用」「这个模块的测试在哪」「这次改动
 * 到底改了什么」。顺序按「最能证明读过工程」排：先读文件，再看符号与
 * 调用关系，然后找测试，最后看目录结构和 diff。
 *
 * 已充分时不产出任何请求——没有缺口就不该造请求。
 */
export function contextRequestsForGaps(
  pkg: EngineeringContextPackage,
  input?: {
    paths?: readonly string[];
    directory?: string;
    symbols?: readonly string[];
    discoverTests?: boolean;
    readDiff?: boolean;
    baseRef?: string;
    modelRunId?: string;
    requiredFor?: ContextRequest['requiredFor'];
    now?: number;
    limit?: number;
  }
): ContextRequest[] {
  if (pkg.sufficiency === 'sufficient') return [];
  const now = input?.now ?? Date.now();
  const limit = input?.limit ?? 4;
  const paths = [...new Set((input?.paths ?? []).filter(Boolean))].slice(0, 24);
  const symbols = [...new Set((input?.symbols ?? []).filter(Boolean))].slice(0, 6);
  const missing = pkg.missingCritical.length > 0
    ? pkg.missingCritical.join('；')
    : '上下文不足，需要读取真实工程内容';
  const requests: ContextRequest[] = [];
  let seq = 0;
  const push = (
    kind: ContextRequestKind,
    reason: string,
    extra: Partial<ContextRequest>
  ): void => {
    if (requests.length >= limit) return;
    seq += 1;
    requests.push({
      requestId: `eco-req:${pkg.workId}:${String(now)}:${String(seq)}`,
      ...(input?.modelRunId ? { modelRunId: input.modelRunId } : {}),
      workId: pkg.workId,
      ...(pkg.workTaskId ? { workTaskId: pkg.workTaskId } : {}),
      reason,
      requiredFor: input?.requiredFor ?? 'review',
      priority: requests.length === 0 ? 'high' : 'normal',
      kind,
      ...extra
    });
  };

  if (paths.length > 0) {
    push('FILE_READ', `上下文不足：${missing}；先真实读取计划引用的 ${String(paths.length)} 个文件`, {
      requestedPaths: paths
    });
  }
  if (symbols.length > 0) {
    push('SYMBOL_LOOKUP', `上下文不足：${missing}；定位符号 ${symbols.join('、')} 的定义位置`, {
      symbol: symbols[0]
    });
    push('CALL_RELATION', `上下文不足：${missing}；核对符号 ${symbols.join('、')} 的调用关系`, {
      symbol: symbols[0]
    });
  }
  if (input?.discoverTests && paths.length > 0) {
    push('TEST_DISCOVERY', '上下文不足：没有测试证据，无法判断这次改动会被哪组测试覆盖', {
      requestedPaths: paths
    });
  }
  if (input?.directory) {
    push('DIRECTORY_DISCOVERY', '上下文不足：需要确认目标目录的真实结构，而不是从计划标题推断', {
      directory: input.directory
    });
  }
  if (input?.readDiff) {
    push('DIFF_READ', '上下文不足：需要看这次改动到底改了什么', {
      ...(input.baseRef ? { baseRef: input.baseRef } : {})
    });
  }
  return requests;
}

/** 挂到检查点 evidenceRefs 的 ECO 版本引用（不改 LT Checkpoint schema）。 */
export interface EcoCheckpointRef {
  contextPackageId: string;
  contextVersion: number;
  sufficiency: ContextSufficiency;
  goalVersion?: number;
}

export function buildEcoCheckpointRef(pkg: EngineeringContextPackage): EcoCheckpointRef {
  return {
    contextPackageId: pkg.contextPackageId,
    contextVersion: pkg.contextVersion,
    sufficiency: pkg.sufficiency,
    goalVersion: pkg.goalVersion
  };
}

export function toEcoEvidenceRef(ref: EcoCheckpointRef): string {
  const goal = ref.goalVersion !== undefined ? `:g${String(ref.goalVersion)}` : '';
  return `eco-context:${ref.contextPackageId}:v${String(ref.contextVersion)}:${ref.sufficiency}${goal}`;
}

export function parseEcoEvidenceRef(value: string): EcoCheckpointRef | null {
  const match = /^eco-context:(.+):v(\d+):(sufficient|partial|insufficient|stale)(?::g(\d+))?$/.exec(value.trim());
  if (!match) return null;
  return {
    contextPackageId: match[1]!,
    contextVersion: Number(match[2]),
    sufficiency: match[3] as ContextSufficiency,
    ...(match[4] ? { goalVersion: Number(match[4]) } : {})
  };
}

/** 恢复时：当前包是否仍兼容检查点所钉版本。 */
export function isEcoRefCompatible(saved: EcoCheckpointRef, current: EngineeringContextPackage): boolean {
  if (current.sufficiency === 'stale') return false;
  if (current.workId && saved.contextPackageId.includes(current.workId) === false
    && current.contextPackageId !== saved.contextPackageId) {
    // 不同 work 的包不兼容
    const savedWork = saved.contextPackageId.split(':')[1];
    if (savedWork && savedWork !== current.workId) return false;
  }
  if (current.contextVersion < saved.contextVersion) return false;
  if (saved.goalVersion !== undefined && current.goalVersion !== undefined && current.goalVersion < saved.goalVersion) {
    return false;
  }
  return true;
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

/**
 * 恢复时判断「检查点钉住的 ECO 版本还作不作数」。
 *
 * 恢复链路手上没有当前上下文包，但事件流里有：重放该 work 最后一条
 * eco.context.prepared 即可，不需要新增存储。没有包或版本不兼容时
 * 一律要求重新读取工程，不返回半可用结论。
 */
export function ecoCompatibilityFromEvents(input: {
  saved: EcoCheckpointRef;
  workId: string;
  events: readonly AgentEvent[];
}): { ok: boolean; reason: string; current?: EngineeringContextPackage } {
  let current: EngineeringContextPackage | null = null;
  for (const event of input.events) {
    if (!('taskId' in event) || event.taskId !== input.workId) continue;
    if (event.type === 'eco.context.prepared') current = event.package;
  }
  if (!current) {
    return { ok: false, reason: '没有可用的工程上下文包，须重新读取工程' };
  }
  if (!isEcoRefCompatible(input.saved, current)) {
    return {
      ok: false,
      reason: `检查点 ECO v${String(input.saved.contextVersion)} 与当前 v${String(current.contextVersion)} 不兼容`
    };
  }
  return { ok: true, reason: 'ECO 版本兼容', current };
}
