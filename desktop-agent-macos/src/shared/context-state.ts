/**
 * 上下文状态投影（V4 P1 M2-3）。
 *
 * 「上下文」段要回答四件事：现在挂的是哪份上下文、最近一次检查点留下了什么、
 * 副作用核对结果如何、上次重建（恢复 / 需重新采集 / 续跑判定）发生在什么时候、为什么。
 *
 * 口径：**只转述事件说过的话**。不新增事件、不在这里读磁盘检查点文件——文件内容由
 * 恢复链路自己核对后发进事件流（M2-1/M2-2），界面读事件才能保证「在线时」与
 * 「刷新后」看到的是同一份事实。取不到的字段一律 `null`，不用 0 或空串顶替：
 * 「没有记录」和「记录了 0 项」是两件事，后者会让人以为已经核对过。
 */
import type { AgentEvent } from './contracts';
import { contextEventView, type ContextEventPayload, type ContextEventType } from './context';

/** 一次检查点存档（暂停 / 取消 / 长任务压缩）。 */
export interface ContextCheckpointRow {
  at: number;
  /** 空串（没有 checkpointId）不落这一行——那属于「没存下来」，写进 unavailableReason。 */
  checkpointId: string;
  source: 'pause' | 'cancel' | 'compaction';
  contextId: string | null;
  /** 暂停/取消事件带的待核对条数；压缩存档不产账本，留 null。 */
  needsReconciliation: number | null;
  goalVersion: number | null;
  taskRevision: number | null;
  /** 检查点没落盘时点名原因（无检查点能力的宿主、写入失败）。 */
  unavailableReason: string | null;
}

/** 一次「上下文被重建/判定」的经过。 */
export interface ContextRebuildRow {
  at: number;
  kind: 'recovered' | 'refresh-required' | 'resume-continue' | 'resume-replan' | 'compaction-stale' | 'checkpoint-missing';
  /** 与时间线/对话流同一句话，取自 `contextEventView()`，不再另写一份文案。 */
  text: string;
  tone: 'warn' | 'muted';
  contextId: string | null;
  checkpointId: string | null;
  /** 这次读的是落库指针还是事件流重建（M2-1 要求路径可观测）。 */
  pointerSource: string | null;
  reason: string | null;
  sideEffects: { applied: number; missing: number; needsReconciliation: number } | null;
  resume: {
    reusedStepIds: string[];
    pendingStepIds: string[];
    reasons: string[];
    planId: string | null;
    roundId: string | null;
  } | null;
}

export interface ContextStateView {
  /** 当前 contextId：时间最新一条**非空** contextId，并记下它是哪条事件给的。 */
  contextId: string | null;
  contextIdFrom: { at: number; label: string } | null;
  checkpoints: ContextCheckpointRow[];
  /** 按时间升序；「上次重建时间与原因」取最后一条。 */
  rebuilds: ContextRebuildRow[];
  lastRebuild: ContextRebuildRow | null;
  /** 最近一次真实核对结果（暂停/取消事件或恢复事件里的计数）。 */
  lastReconciliation: {
    at: number;
    applied: number | null;
    missing: number | null;
    needsReconciliation: number;
    source: 'pause' | 'cancel' | 'recovered';
  } | null;
  /** 预算水位：取最后一条真带 usage 的事件。 */
  budget: {
    at: number;
    level: string;
    estimatedTokens: number | null;
    contextWindow: number | null;
    usageRatio: number | null;
  } | null;
  /** §8 的详情检查入口：逐条原文（含 payload），按时间升序。 */
  entries: Array<{ at: number; type: string; text: string; tone: 'warn' | 'muted'; detail: Record<string, unknown> }>;
  hasEvents: boolean;
}

export const EMPTY_CONTEXT_STATE: ContextStateView = {
  contextId: null,
  contextIdFrom: null,
  checkpoints: [],
  rebuilds: [],
  lastRebuild: null,
  lastReconciliation: null,
  budget: null,
  entries: [],
  hasEvents: false
};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const REBUILD_KIND: Partial<Record<ContextEventType, ContextRebuildRow['kind']>> = {
  'context.recovered': 'recovered',
  'context.refresh.required': 'refresh-required',
  'context.resume.continued': 'resume-continue',
  'context.resume.replanned': 'resume-replan',
  'context.compaction.stale': 'compaction-stale'
};

function rebuildRow(
  at: number,
  kind: ContextRebuildRow['kind'],
  eventType: ContextEventType,
  payload: ContextEventPayload
): ContextRebuildRow {
  const view = contextEventView(eventType);
  const side = payload.sideEffects;
  const resume = payload.resume;
  return {
    at,
    kind,
    text: view.text,
    tone: view.tone,
    contextId: text(payload.contextId),
    checkpointId: text(payload.checkpointId),
    pointerSource: text(payload.pointerSource),
    reason: text(payload.reason),
    sideEffects: side
      ? { applied: side.applied, missing: side.missing, needsReconciliation: side.needsReconciliation }
      : null,
    resume: resume
      ? {
          reusedStepIds: resume.reusedStepIds ?? [],
          pendingStepIds: resume.pendingStepIds ?? [],
          reasons: resume.reasons ?? [],
          planId: text(resume.planId),
          roundId: text(resume.roundId)
        }
      : null
  };
}

export function projectContextState(events: readonly AgentEvent[]): ContextStateView {
  // 同刻事件按 sequence 保序：恢复打点与续跑判定常落在同一毫秒。
  const ordered = [...events].sort(
    (a, b) => a.at - b.at || (a.sequence ?? 0) - (b.sequence ?? 0)
  );
  const checkpoints: ContextCheckpointRow[] = [];
  const rebuilds: ContextRebuildRow[] = [];
  const entries: ContextStateView['entries'] = [];
  let contextId: string | null = null;
  let contextIdFrom: ContextStateView['contextIdFrom'] = null;
  let reconciliation: ContextStateView['lastReconciliation'] = null;
  let budget: ContextStateView['budget'] = null;

  for (const event of ordered) {
    // 暂停/取消存档是一等事件（contracts.ts:2401），带任务版本与待核对条数。
    if (event.type === 'context.checkpoint.paused') {
      const verb = event.reason === 'pause' ? '暂停' : '取消';
      const checkpointId = text(event.checkpointId);
      // 与时间线同一句话（M2-2 落的「暂停已提交检查点 cp_…」），未落盘时点名原因。
      const label = checkpointId ? `${verb}已提交检查点 ${checkpointId}` : `${verb}未提交检查点`;
      entries.push({
        at: event.at,
        type: event.type,
        text: checkpointId || !event.unavailableReason ? label : `${label}：${event.unavailableReason}`,
        tone: checkpointId ? 'muted' : 'warn',
        detail: {
          reason: event.reason,
          goalVersion: event.goalVersion,
          taskRevision: event.taskRevision,
          needsReconciliation: event.needsReconciliation,
          ...(event.checkpointId ? { checkpointId: event.checkpointId } : {}),
          ...(event.contextId ? { contextId: event.contextId } : {}),
          ...(event.activeRunId ? { activeRunId: event.activeRunId } : {}),
          ...(event.unavailableReason ? { unavailableReason: event.unavailableReason } : {})
        }
      });
      if (text(event.contextId)) {
        contextId = text(event.contextId);
        contextIdFrom = { at: event.at, label };
      }
      if (checkpointId) {
        checkpoints.push({
          at: event.at,
          checkpointId,
          source: event.reason === 'cancel' ? 'cancel' : 'pause',
          contextId: text(event.contextId),
          needsReconciliation: count(event.needsReconciliation),
          goalVersion: count(event.goalVersion),
          taskRevision: count(event.taskRevision),
          unavailableReason: text(event.unavailableReason)
        });
      }
      // 没留下 checkpointId 也要能被看见：上面已进 entries，这里额外记一句原因。
      if (!checkpointId) {
        rebuilds.push({
          at: event.at,
          kind: 'checkpoint-missing',
          text: label,
          tone: 'warn',
          contextId: text(event.contextId),
          checkpointId: null,
          pointerSource: null,
          reason: text(event.unavailableReason) ?? '事件里没有 checkpointId',
          sideEffects: null,
          resume: null
        });
      }
      const needs = count(event.needsReconciliation);
      if (needs !== null) {
        reconciliation = {
          at: event.at,
          applied: null,
          missing: null,
          needsReconciliation: needs,
          source: event.reason === 'cancel' ? 'cancel' : 'pause'
        };
      }
      continue;
    }

    if (event.type !== 'context.event') continue;
    const payload = event.context;
    const at = event.at;
    const label = contextEventView(event.event).text;
    entries.push({
      at,
      type: `context.event:${event.event}`,
      text: label,
      tone: contextEventView(event.event).tone,
      detail: { ...payload }
    });
    if (text(payload.contextId)) {
      contextId = text(payload.contextId);
      contextIdFrom = { at, label };
    }
    if (count(payload.estimatedTokens) !== null || text(payload.level)) {
      budget = {
        at,
        level: text(payload.level) ?? 'unknown',
        estimatedTokens: count(payload.estimatedTokens),
        contextWindow: count(payload.contextWindow),
        usageRatio: count(payload.usageRatio)
      };
    }
    if (event.event === 'context.compaction.committed' && text(payload.checkpointId)) {
      checkpoints.push({
        at,
        checkpointId: String(payload.checkpointId),
        source: 'compaction',
        contextId: text(payload.contextId),
        needsReconciliation: null,
        goalVersion: null,
        taskRevision: null,
        unavailableReason: null
      });
    }
    const kind = REBUILD_KIND[event.event];
    if (kind) {
      rebuilds.push(rebuildRow(at, kind, event.event, payload));
      if (payload.sideEffects) {
        reconciliation = {
          at,
          applied: count(payload.sideEffects.applied),
          missing: count(payload.sideEffects.missing),
          needsReconciliation: payload.sideEffects.needsReconciliation,
          source: 'recovered'
        };
      }
    }
  }

  return {
    contextId,
    contextIdFrom,
    checkpoints,
    rebuilds,
    lastRebuild: rebuilds.at(-1) ?? null,
    lastReconciliation: reconciliation,
    budget,
    entries,
    hasEvents: entries.length > 0
  };
}

/**
 * 段头一句话。口径与卡片一致：没有事件就说「没有记录」，不画成「已核对 0 项」——
 * 后者会让用户以为暂停真的留下了检查点。
 */
/**
 * 折叠段收起时那一行要说的三件事：有几条事件、最近一份检查点、核对到什么程度。
 *
 * 不带 contextId：它是 `pause:<taskId>:<时间戳>` 这种长串，摆在标题后面会把
 * 后面两句挤没；完整值在展开后的「当前上下文」栏里。
 */
export function contextStateSummary(view: ContextStateView): string {
  if (!view.hasEvents) return '没有记录到上下文事件';
  const parts: string[] = [`${String(view.entries.length)} 条 context 事件`];
  const latest = view.checkpoints.at(-1);
  parts.push(latest ? `最近检查点 ${latest.checkpointId}` : '没有检查点存档');
  const rec = view.lastReconciliation;
  parts.push(
    rec
      ? `核对 applied ${String(rec.applied ?? '?')} / missing ${String(rec.missing ?? '?')} / 待核对 ${String(rec.needsReconciliation)}`
      : '未做副作用核对'
  );
  return parts.join(' · ');
}
