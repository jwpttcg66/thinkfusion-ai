/**
 * 每轮代码引用 Pack：把本轮发言/主张里的代码引用变成冻结条目。
 *
 * 只记录「这条主张引用了这段基准源码」；不判断支持/反驳。关系留到
 * ClaimEvidenceLink 的显式决策层，不能在这一层写成 supports。
 */
import path from 'node:path';
import type { DebateRound, DebateRoundEvidencePack, DebateState } from '../debate/types';
import { resolveBaselineCodeReference } from './baseline-code-reference-resolver';
import { extractCodeReferences } from './code-references';
import type { EvidencePackStore } from './store';
import type { EvidencePackItemDraft } from './types';

export interface RoundEvidenceInput {
  state: DebateState;
  round: DebateRound;
  store: EvidencePackStore | null | undefined;
  baselinePackId: string;
  createdAt: number;
}

function keyOf(relative: string, startLine: number, endLine: number): string {
  return `${relative}\0${String(startLine)}\0${String(endLine)}`;
}

function referencedClaims(round: DebateRound): Map<string, Set<string>> {
  const byKey = new Map<string, Set<string>>();
  for (const claim of round.claims ?? []) {
    for (const candidate of extractCodeReferences(claim.text)) {
      if (candidate.startLine === undefined || candidate.endLine === undefined) continue;
      const normalized = path.posix.normalize(candidate.path);
      if (normalized === '.' || normalized.startsWith('..')) continue;
      const key = keyOf(normalized, candidate.startLine, candidate.endLine);
      const claims = byKey.get(key) ?? new Set<string>();
      claims.add(claim.claimId);
      byKey.set(key, claims);
    }
  }
  return byKey;
}

export function publishRoundEvidencePack(input: RoundEvidenceInput): DebateRoundEvidencePack | null {
  const { state, round, store, baselinePackId, createdAt } = input;
  if (!store || !state.repository || !baselinePackId) return null;

  const text = [
    ...round.messages.map(message => message.text),
    ...(round.claims ?? []).map(claim => claim.text)
  ].join('\n');
  const candidates = extractCodeReferences(text);
  if (candidates.length === 0) return null;

  const resolved = new Map<string, {
    path: string;
    startLine: number;
    endLine: number;
    content: string;
    partial: boolean;
  }>();
  const errors: string[] = [];
  for (const candidate of candidates) {
    const outcome = resolveBaselineCodeReference({
      state,
      baselinePackId,
      store,
      candidate
    });
    if (outcome.resolved) {
      const key = keyOf(outcome.resolved.path, outcome.resolved.startLine, outcome.resolved.endLine);
      resolved.set(key, {
        path: outcome.resolved.path,
        startLine: outcome.resolved.startLine,
        endLine: outcome.resolved.endLine,
        content: outcome.resolved.content,
        partial: outcome.status === 'partial'
      });
    } else if (outcome.error) {
      errors.push(`${outcome.error.code}: ${outcome.error.message}`);
    }
  }

  const claimMap = referencedClaims(round);
  const claimIds = [...new Set(
    [...resolved.keys()].flatMap(key => [...(claimMap.get(key) ?? [])])
  )].sort();

  if (resolved.size === 0) {
    return {
      roundIndex: round.index,
      status: 'partial',
      itemCount: 0,
      claimIds: [],
      errors: [...new Set(errors)],
      createdAt
    };
  }

  const items: EvidencePackItemDraft[] = [...resolved.values()].map(item => ({
    kind: 'source-file',
    content: item.content,
    source: { commit: state.repository!.commit, path: item.path },
    locator: { path: item.path, startLine: item.startLine, endLine: item.endLine },
    meta: {
      tool: 'debate-round',
      capturedAt: createdAt,
      snapshotRole: 'round'
    }
  }));

  const status = errors.length > 0 || [...resolved.values()].some(item => item.partial)
    ? 'partial'
    : 'complete';
  try {
    const published = store.publish({
      repoRoot: state.repository.root,
      idempotencyKey: `debate:${state.debateId}:round:${String(round.index)}`,
      repo: {
        commit: state.repository.commit,
        dirty: state.repository.dirty,
        branch: state.repository.branch
      },
      context: {
        kind: 'round',
        debateId: state.debateId,
        roundIndex: round.index,
        baselinePackId
      },
      createdAt,
      items
    });
    return {
      roundIndex: round.index,
      status,
      packId: published.manifest.packId,
      itemCount: published.manifest.items.length,
      claimIds,
      errors: [...new Set(errors)],
      createdAt
    };
  } catch (error) {
    return {
      roundIndex: round.index,
      status: 'failed',
      itemCount: 0,
      claimIds,
      errors: [...new Set([...errors, error instanceof Error ? error.message : String(error)])],
      createdAt
    };
  }
}
