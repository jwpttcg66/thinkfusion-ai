/**
 * 执行历史投影（V4 P1 M1-1）。
 *
 * 「一次执行」在代码里一直是隐式的：一轮 `AgentRound` + 该轮的 `ExecutionReport`
 * 就是它，但没有一个可寻址的对象能把它列出来。这里把它显式化——纯推导，
 * 不新建实体、不新增写入路径，`store` 里已有的 rounds / reports / events 是唯一来源。
 *
 * 口径：
 * - 一次执行 = 一轮。同一 Task 的多轮各自成条，后面的轮次不覆盖前面的事实。
 * - 同一轮里出现多份报告（口径重判）仍是一条执行：结论取最新一份，证据与失败原因取并集。
 * - 缺字段一律 `null` / 空数组，并如实标出这轮有没有报告。把「没记录到」写成
 *   「没有失败」，界面上就是一次假的成功。
 */

import type { AgentEvent, AgentRound, ExecutionReport } from './contracts';
import type { EvidenceRef } from './engineering-evidence';

export interface ExecutionParticipant {
  /** 与 `participantId` / `memberId` 同源；老事件两者都没有时为 null。 */
  id: string | null;
  label: string;
  providerId: string | null;
  modelId: string | null;
  /** 只来自 `round.peer` 的收口状态；没有该事件时为 null，不从别处推断。 */
  status: string | null;
  /** 这一轮里它是否真给出过内容。 */
  answered: boolean;
}

export interface ExecutionStepSummary {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  /** 步骤数完全没有来源时为 true——界面要显示「未记录」而不是 0。 */
  unknown: boolean;
}

export interface ExecutionRecord {
  /** 等于 `roundId`；老数据没有轮次记录时退化为稳定生成的占位 id。 */
  executionId: string;
  taskId: string;
  roundId: string | null;
  roundNumber: number | null;
  inputType: AgentRound['inputType'] | null;
  /** 一次连续执行过程的身份；老任务未写 runId 时为 null。 */
  runId: string | null;
  planId: string | null;
  roundStatus: AgentRound['status'] | null;
  /** 执行结论；本轮没有落报告时为 null，不拿 `roundStatus` 冒充。 */
  outcome: ExecutionReport['status'] | null;
  nextAction: ExecutionReport['nextAction'] | null;
  startedAt: number | null;
  endedAt: number | null;
  /** 起止任一缺失时为 null，不用当前时间补齐。 */
  durationMs: number | null;
  participants: ExecutionParticipant[];
  steps: ExecutionStepSummary;
  /** `verification.verified`；没有报告时 null。 */
  verified: boolean | null;
  fullyVerified: boolean | null;
  changedFiles: number | null;
  /** 改动文件路径，只取报告记录；无报告时为空并标 `sources.report=false`。 */
  deliverables: string[];
  evidenceRefs: EvidenceRef[];
  failureReasons: string[];
  sources: {
    round: boolean;
    report: boolean;
    /** 该轮真实归属的事件条数，供界面说明投影依据。 */
    events: number;
  };
}

export interface ExecutionHistoryInput {
  task?: { taskId: string; runId?: string } | null;
  rounds?: readonly AgentRound[];
  reports?: readonly ExecutionReport[];
  events?: readonly AgentEvent[];
}

interface Bucket {
  roundId: string | null;
  round: AgentRound | null;
  reports: ExecutionReport[];
  events: AgentEvent[];
}

function roundIdOf(event: AgentEvent): string | null {
  return 'roundId' in event && typeof event.roundId === 'string' ? event.roundId : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function evidenceKey(ref: EvidenceRef): string {
  if (ref.kind === 'file') return `file:${ref.path}:${String(ref.line ?? '')}:${String(ref.sha256 ?? '')}`;
  if (ref.kind === 'url') return `url:${ref.url}:${String(ref.fetchedAt)}`;
  return `command:${ref.command}:${String(ref.exitCode)}:${String(ref.at)}`;
}

/** 老事件两者皆无时不能凭空起一个名字，只能标「未记录成员」。 */
function participantLabel(id: string | null, modelId: string | null, providerId: string | null): string {
  if (modelId) return providerId ? `${providerId}/${modelId}` : modelId;
  if (id) return id;
  if (providerId) return providerId;
  return '未记录成员';
}

/**
 * 没有轮次记录时的兜底 id。
 *
 * 报告和事件都带 `roundId`，轮次记录理论上必有；缺了通常是 journal 被裁掉或
 * 老版本落盘差异。仍然要把这次执行列出来，否则界面会「少一次执行」——
 * 而那正是本任务要消灭的现象。
 */
function fallbackExecutionId(roundId: string | null, taskId: string, index: number): string {
  return roundId ?? `${taskId}:unbound-${String(index)}`;
}

function collectParticipants(events: readonly AgentEvent[]): ExecutionParticipant[] {
  const byId = new Map<string, ExecutionParticipant>();
  const anonymous: ExecutionParticipant[] = [];

  const touch = (
    id: string | null,
    patch: Partial<Omit<ExecutionParticipant, 'id' | 'label'>> & { label?: string }
  ): void => {
    const existing = id
      ? byId.get(id)
      : anonymous.find(item => item.providerId === (patch.providerId ?? null) && item.modelId === (patch.modelId ?? null));
    const merged: ExecutionParticipant = {
      id,
      label: '',
      providerId: patch.providerId ?? existing?.providerId ?? null,
      modelId: patch.modelId ?? existing?.modelId ?? null,
      status: patch.status ?? existing?.status ?? null,
      answered: (patch.answered ?? false) || (existing?.answered ?? false)
    };
    merged.label = patch.label ?? participantLabel(merged.id, merged.modelId, merged.providerId);
    if (!id) {
      if (existing) anonymous[anonymous.indexOf(existing)] = merged;
      else anonymous.push(merged);
      return;
    }
    byId.set(id, merged);
  };

  for (const event of events) {
    if (event.type === 'round.peer') {
      touch(event.memberId ?? null, {
        label: text(event.label) ?? undefined,
        providerId: text(event.providerId),
        modelId: text(event.modelId),
        status: event.status,
        answered: event.status === 'answered'
      });
      continue;
    }
    if (event.type === 'round.delta') {
      const hadContent = Boolean(text(event.text) || text(event.reasoning));
      touch(text(event.participantId), { providerId: text(event.providerId), modelId: text(event.modelId), answered: hadContent });
      continue;
    }
    if (event.type === 'round.answer') {
      touch(text(event.participantId), { answered: true });
      continue;
    }
    if (event.type === 'step.preparing' || event.type === 'step.started' || event.type === 'step.completed' || event.type === 'step.failed') {
      // 只有事件真记了成员才认领这一步：没有 participantId 的旧事件不能和一个
      // 「没记录身份的模型」共用一条成员，那会把两件事说成一件事。
      const id = text(event.participantId);
      if (id) touch(id, {});
    }
  }

  return [...byId.values(), ...anonymous];
}

/** 无报告轮也要能说「跑到哪了」：从 step 事件按 stepId/callId 收口。 */
function stepsFromEvents(events: readonly AgentEvent[]): ExecutionStepSummary {
  type StepState = 'preparing' | 'running' | 'completed' | 'failed';
  const status = new Map<string, StepState>();
  for (const event of events) {
    if (event.type !== 'step.preparing' && event.type !== 'step.started' && event.type !== 'step.completed' && event.type !== 'step.failed') continue;
    const key = text(event.callId) ?? event.stepId;
    if (event.type === 'step.failed') status.set(key, 'failed');
    else if (event.type === 'step.completed') status.set(key, 'completed');
    else if (event.type === 'step.started') status.set(key, 'running');
    else if (!status.has(key)) status.set(key, 'preparing');
  }
  const counts = { total: status.size, completed: 0, failed: 0, skipped: 0, unknown: status.size === 0 };
  for (const value of status.values()) {
    if (value === 'completed') counts.completed += 1;
    else if (value === 'failed') counts.failed += 1;
  }
  return counts;
}

function stepsFromReport(report: ExecutionReport | null): ExecutionStepSummary | null {
  if (!report) return null;
  const counts = {
    total: report.results.length,
    completed: 0,
    failed: 0,
    skipped: 0,
    unknown: false
  };
  for (const step of report.results) {
    if (step.status === 'completed') counts.completed += 1;
    else if (step.status === 'failed') counts.failed += 1;
    else if (step.status === 'skipped') counts.skipped += 1;
  }
  return counts;
}

function deliverablesOf(reports: readonly ExecutionReport[]): string[] {
  const paths = new Set<string>();
  for (const report of reports) {
    const verification = report.verification;
    if (!verification) continue;
    const listed = verification.changedPaths ?? verification.checks?.changedFiles ?? [];
    for (const item of listed) if (typeof item === 'string' && item) paths.add(item);
  }
  return [...paths];
}

function evidenceOf(reports: readonly ExecutionReport[]): EvidenceRef[] {
  const byKey = new Map<string, EvidenceRef>();
  for (const report of reports) {
    for (const ref of report.evidence?.refs ?? []) {
      const key = evidenceKey(ref);
      if (!byKey.has(key)) byKey.set(key, ref);
    }
  }
  return [...byKey.values()];
}

function failuresOf(
  reports: readonly ExecutionReport[],
  round: AgentRound | null,
  events: readonly AgentEvent[]
): string[] {
  const reasons = new Set<string>();
  for (const report of reports) {
    for (const error of report.errors) {
      const message = text(error.message);
      if (message) reasons.add(text(error.code) ? `${error.code}: ${message}` : message);
    }
    if (report.verification && report.verification.verified === false) {
      for (const reason of report.verification.reasons) {
        if (reason) reasons.add(reason);
      }
    }
  }
  for (const event of events) {
    if (event.type !== 'step.failed') continue;
    const message = text(event.error);
    if (message) reasons.add(`${event.tool}: ${message}`);
  }
  if (reasons.size === 0 && (round?.status === 'failed' || reports.some(report => report.status === 'failed'))) {
    reasons.add('本轮以失败收口，未记录具体原因');
  }
  return [...reasons];
}

function boundsOf(round: AgentRound | null, reports: readonly ExecutionReport[], events: readonly AgentEvent[]) {
  const stamps = events.map(event => event.at).filter((value): value is number => typeof value === 'number');
  const startedAt = round?.createdAt ?? (stamps.length > 0 ? Math.min(...stamps) : null);
  const lastReport = reports[reports.length - 1];
  // 不用「最后一条事件的时间」当结束时间：还在跑的执行会因此显示成一个已收口的时长。
  const endedAt = round?.completedAt ?? lastReport?.createdAt ?? null;
  const durationMs = typeof startedAt === 'number' && typeof endedAt === 'number' && endedAt >= startedAt ? endedAt - startedAt : null;
  return { startedAt: startedAt ?? null, endedAt: endedAt ?? null, durationMs };
}

/**
 * 把 rounds + reports + events 推导成按轮次排列的执行列表。
 *
 * 排序按 `roundNumber`（老数据没有就按 `createdAt`），执行顺序必须和真实推进一致，
 * 不能按落库先后——重判口径的报告后落，会把第 1 轮排到最后一次执行后面。
 */
export function buildExecutionHistory(input: ExecutionHistoryInput): ExecutionRecord[] {
  const rounds = input.rounds ?? [];
  const reports = input.reports ?? [];
  const events = input.events ?? [];
  const taskId = input.task?.taskId ?? rounds[0]?.taskId ?? reports[0]?.taskId ?? '';

  const buckets = new Map<string, Bucket>();
  const bucketFor = (roundId: string | null): Bucket => {
    const key = roundId ?? '#unbound';
    const existing = buckets.get(key);
    if (existing) return existing;
    const created: Bucket = { roundId, round: null, reports: [], events: [] };
    buckets.set(key, created);
    return created;
  };

  for (const round of rounds) bucketFor(round.roundId).round = round;
  for (const report of reports) {
    if (report.taskId && taskId && report.taskId !== taskId) continue;
    bucketFor(report.roundId).reports.push(report);
  }
  for (const event of events) {
    const roundId = roundIdOf(event);
    if (!roundId) continue;
    bucketFor(roundId).events.push(event);
  }

  const ordered = [...buckets.values()].sort((a, b) => {
    const aNumber = a.round?.roundNumber ?? Number.MAX_SAFE_INTEGER;
    const bNumber = b.round?.roundNumber ?? Number.MAX_SAFE_INTEGER;
    if (aNumber !== bNumber) return aNumber - bNumber;
    const aAt = a.round?.createdAt ?? a.reports[0]?.createdAt ?? 0;
    const bAt = b.round?.createdAt ?? b.reports[0]?.createdAt ?? 0;
    return aAt - bAt;
  });

  return ordered.map((bucket, index) => {
    const reportsInRound = [...bucket.reports].sort((a, b) => a.createdAt - b.createdAt);
    const latest = reportsInRound[reportsInRound.length - 1] ?? null;
    const steps = stepsFromReport(latest) ?? stepsFromEvents(bucket.events);
    const runId =
      bucket.events.map(event => text(event.runId)).find((value): value is string => value !== null) ??
      input.task?.runId ??
      null;
    const bounds = boundsOf(bucket.round, reportsInRound, bucket.events);

    return {
      executionId: fallbackExecutionId(bucket.roundId, taskId, index),
      taskId,
      roundId: bucket.roundId,
      roundNumber: bucket.round?.roundNumber ?? null,
      inputType: bucket.round?.inputType ?? null,
      runId,
      planId: latest?.planId ?? null,
      roundStatus: bucket.round?.status ?? null,
      outcome: latest?.status ?? null,
      nextAction: latest?.nextAction ?? null,
      startedAt: bounds.startedAt,
      endedAt: bounds.endedAt,
      durationMs: bounds.durationMs,
      participants: collectParticipants(bucket.events),
      steps,
      verified: latest?.verification ? latest.verification.verified : null,
      fullyVerified: latest?.verification?.fullyVerified ?? null,
      changedFiles: latest?.verification ? latest.verification.changedFiles : null,
      deliverables: deliverablesOf(reportsInRound),
      evidenceRefs: evidenceOf(reportsInRound),
      failureReasons: failuresOf(reportsInRound, bucket.round, bucket.events),
      sources: {
        round: bucket.round !== null,
        report: latest !== null,
        events: bucket.events.length
      }
    };
  });
}

function numBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
