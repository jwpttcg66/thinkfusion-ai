/**
 * Evidence Pack 引用可达性 GC。
 *
 * 核心原则：从仍然存在的辩论记录建立引用根；被引用的 Pack 永不按时间删除。
 * 没有引用、且超过宽限期的 Pack 才进入候选。读不了辩论记录时整个 GC 中止，
 * 因为「读不了」不等于「没引用」。
 */
import fs from 'node:fs';
import type { DebateState } from '../debate/types';
import type { EvidencePackStore } from './store';
import type { EvidencePackListEntry } from './types';

const PACK_ID_PATTERN = /^pack_[a-f0-9]{16}$/;
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

export type PackGcSkipKind = 'pack' | 'temp' | 'quarantine';

export interface PackGcSkip {
  kind: PackGcSkipKind;
  id: string;
  reason: string;
  bytes: number;
}

export interface PackGcAudit {
  action: 'delete' | 'delete-temp' | 'delete-quarantine' | 'protect' | 'skip';
  kind: PackGcSkipKind;
  id: string;
  reason: string;
  bytes: number;
}

export interface PackGcPlan {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  graceMs: number;
  scannedPacks: number;
  referencedPacks: number;
  unreferencedPacks: number;
  corruptPacks: number;
  protectedPacks: number;
  candidatePacks: number;
  deletedPacks: number;
  deletedBytes: number;
  reclaimableBytes: number;
  temp: { scanned: number; deleted: number; bytes: number };
  quarantine: { scanned: number; deleted: number; bytes: number };
  skipped: PackGcSkip[];
  audit: PackGcAudit[];
  aborted?: { reason: string; scanErrors: string[] };
}

export interface PackGcOptions {
  store: EvidencePackStore;
  debates: readonly DebateState[];
  scanErrors?: readonly string[];
  dryRun?: boolean;
  now?: number;
  graceMs?: number;
}

function packIdFromEvidenceId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('pack:')) return null;
  const [, packId] = value.split(':');
  return packId && PACK_ID_PATTERN.test(packId) ? packId : null;
}

interface ReferenceScan {
  referenced: Set<string>;
  errors: string[];
}

/** 从辩论记录收集 Pack 引用；任何看起来像 pack: 但解析不了的引用都报错。 */
export function collectPackReferences(debates: readonly DebateState[]): ReferenceScan {
  const referenced = new Set<string>();
  const errors: string[] = [];
  const addPackId = (value: unknown, where: string) => {
    if (value === undefined || value === null || value === '') return;
    if (typeof value === 'string' && PACK_ID_PATTERN.test(value)) referenced.add(value);
    else errors.push(`${where}: 无法解析的 Pack id ${String(value)}`);
  };
  const addEvidenceId = (value: unknown, where: string) => {
    if (value === undefined || value === null || value === '') return;
    const packId = packIdFromEvidenceId(value);
    if (packId) referenced.add(packId);
    else errors.push(`${where}: 无法解析的 Pack 引用 ${String(value)}`);
  };

  for (const state of debates) {
    const debateId = state.debateId ?? 'unknown';
    addPackId(state.evidencePack?.baselinePackId, `${debateId}.evidencePack`);
    for (const pack of state.roundEvidencePacks ?? []) addPackId(pack.packId, `${debateId}.roundEvidencePacks`);
    for (const evidence of state.packEvidence ?? []) addEvidenceId(evidence.evidenceId, `${debateId}.packEvidence`);
    for (const link of state.packEvidenceLinks ?? []) addEvidenceId(link.evidenceId, `${debateId}.packEvidenceLinks`);
    for (const evidence of state.evidence ?? []) {
      if (evidence.origin === 'repo-snapshot') addEvidenceId(evidence.evidenceId, `${debateId}.evidence`);
    }
  }
  return { referenced, errors };
}

function ageOf(createdAt: number | null, now: number): number | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  return Math.max(0, now - createdAt);
}

export function collectPackGarbage(options: PackGcOptions): PackGcPlan {
  const now = options.now ?? Date.now();
  const graceMs = Math.max(0, options.graceMs ?? DEFAULT_GRACE_MS);
  const dryRun = options.dryRun !== false;
  const startedAt = new Date(now).toISOString();
  const skipped: PackGcSkip[] = [];
  const audit: PackGcAudit[] = [];
  const plan: PackGcPlan = {
    dryRun,
    startedAt,
    finishedAt: startedAt,
    graceMs,
    scannedPacks: 0,
    referencedPacks: 0,
    unreferencedPacks: 0,
    corruptPacks: 0,
    protectedPacks: 0,
    candidatePacks: 0,
    deletedPacks: 0,
    deletedBytes: 0,
    reclaimableBytes: 0,
    temp: { scanned: 0, deleted: 0, bytes: 0 },
    quarantine: { scanned: 0, deleted: 0, bytes: 0 },
    skipped,
    audit
  };

  const references = collectPackReferences(options.debates);
  const scanErrors = [...(options.scanErrors ?? []), ...references.errors];
  if (scanErrors.length > 0) {
    plan.aborted = { reason: '辩论记录无法完整读取，拒绝删除任何 Pack', scanErrors };
    plan.finishedAt = new Date(now).toISOString();
    return plan;
  }

  const packs = options.store.list();
  plan.scannedPacks = packs.length;
  const protect = (entry: EvidencePackListEntry, reason: string) => {
    plan.protectedPacks += 1;
    skipped.push({ kind: 'pack', id: entry.packId, reason, bytes: entry.bytes });
    audit.push({ action: 'protect', kind: 'pack', id: entry.packId, reason, bytes: entry.bytes });
  };

  for (const entry of packs) {
    if (entry.status === 'corrupt') {
      plan.corruptPacks += 1;
      protect(entry, 'corrupt');
      continue;
    }
    if (references.referenced.has(entry.packId)) {
      plan.referencedPacks += 1;
      protect(entry, 'referenced');
      continue;
    }
    plan.unreferencedPacks += 1;
    const age = ageOf(entry.createdAt, now);
    if (age === null) {
      protect(entry, 'unknown-created-at');
      continue;
    }
    if (age < graceMs) {
      protect(entry, `grace:${String(graceMs - age)}ms-left`);
      continue;
    }

    plan.candidatePacks += 1;
    plan.reclaimableBytes += entry.bytes;
    if (dryRun) {
      skipped.push({ kind: 'pack', id: entry.packId, reason: 'candidate-dry-run', bytes: entry.bytes });
      audit.push({ action: 'skip', kind: 'pack', id: entry.packId, reason: 'candidate-dry-run', bytes: entry.bytes });
      continue;
    }
    const result = options.store.delete(entry.packId);
    if (result.deleted) {
      plan.deletedPacks += 1;
      plan.deletedBytes += result.bytes;
      audit.push({ action: 'delete', kind: 'pack', id: entry.packId, reason: 'unreferenced', bytes: result.bytes });
    } else {
      skipped.push({ kind: 'pack', id: entry.packId, reason: result.reason ?? 'delete-failed', bytes: entry.bytes });
      audit.push({ action: 'skip', kind: 'pack', id: entry.packId, reason: result.reason ?? 'delete-failed', bytes: entry.bytes });
    }
  }

  const cleanup = (
    kind: 'temp' | 'quarantine',
    items: Array<{ name: string; path: string; ageMs: number; bytes: number }>
  ) => {
    plan[kind].scanned = items.length;
    for (const item of items) {
      if (item.ageMs < graceMs) {
        skipped.push({ kind, id: item.name, reason: 'grace', bytes: item.bytes });
        audit.push({ action: 'protect', kind, id: item.name, reason: 'grace', bytes: item.bytes });
        continue;
      }
      plan.reclaimableBytes += item.bytes;
      if (dryRun) {
        skipped.push({ kind, id: item.name, reason: 'candidate-dry-run', bytes: item.bytes });
        audit.push({ action: 'skip', kind, id: item.name, reason: 'candidate-dry-run', bytes: item.bytes });
        continue;
      }
      try {
        fs.rmSync(item.path, { recursive: true, force: true });
        plan[kind].deleted += 1;
        plan[kind].bytes += item.bytes;
        plan.deletedBytes += item.bytes;
        audit.push({
          action: kind === 'temp' ? 'delete-temp' : 'delete-quarantine',
          kind,
          id: item.name,
          reason: 'orphan',
          bytes: item.bytes
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push({ kind, id: item.name, reason, bytes: item.bytes });
        audit.push({ action: 'skip', kind, id: item.name, reason, bytes: item.bytes });
      }
    }
  };
  cleanup('temp', options.store.listTemporary());
  cleanup('quarantine', options.store.listQuarantine());

  plan.finishedAt = new Date(now).toISOString();
  return plan;
}
