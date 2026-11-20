/** B-02/B-03/B-07：参与者、证据、交付的 UI View。 */
import type {
  CollaborationDetailsView,
  CollaborationEvidenceView,
  CollaborationParticipantView
} from '../../shared/contracts';
import type { CollaborationState } from './domain/types';
import { buildKnowledgeMap } from '../knowledge/map';

function participantStatus(
  state: CollaborationState,
  participantId: string
): CollaborationParticipantView['status'] {
  const tasks = state.taskStates.filter(task =>
    state.assignments.some(assignment => assignment.taskId === task.taskId && assignment.participantId === participantId)
  );
  if (tasks.length === 0) return 'skipped';
  const statuses = tasks.map(task => task.status);
  if (statuses.some(status => status === 'running' || status === 'retrying')) return 'running';
  if (statuses.some(status => status === 'failed')) return 'failed';
  if (statuses.every(status => status === 'done')) return 'done';
  if (statuses.some(status => status === 'skipped')) return 'skipped';
  return 'pending';
}

export function buildCollaborationDetails(state: CollaborationState): CollaborationDetailsView {
  const participants: CollaborationParticipantView[] = state.activePlan.participants.map(item => {
    const taskIds = state.assignments
      .filter(assignment => assignment.participantId === item.participantId)
      .map(assignment => assignment.taskId);
    const observation = state.observations.find(
      itemObservation => itemObservation.participantId === item.participantId && itemObservation.status === 'done'
    );
    const failure = state.taskStates.find(
      task => taskIds.includes(task.taskId) && (task.status === 'failed' || task.status === 'skipped')
    );
    return {
      participantId: item.participantId,
      role: 'answerer',
      status: participantStatus(state, item.participantId),
      ...(observation?.text ? { outputPreview: observation.text.slice(0, 160) } : {}),
      reason: failure?.reason ?? item.reason,
      taskIds
    };
  });

  const evidence: CollaborationEvidenceView[] = state.evidence.map(item => ({
    evidenceId: item.evidenceId,
    kind: item.kind,
    summary: item.summary,
    source: item.source.uri ?? item.source.commit ?? '—',
    trust: item.trust,
    ...(item.scope.taskId ? { taskId: item.scope.taskId } : {})
  }));

  const deliverable = state.deliverable
    ? {
        content: state.deliverable.content,
        stopReason: state.deliverable.stopReason,
        evidenceCoverage: state.deliverable.evidenceCoverage,
        openQuestions: state.deliverable.openQuestions,
        claims: state.deliverable.claims.map(claim => ({
          text: claim.text,
          relation:
            state.deliverable!.verifications.find(item => item.claimId === claim.claimId)?.relation ?? 'unverified'
        }))
      }
    : undefined;

  const engineering = state.engineering
    ? {
        repoRoot: String(state.engineering.context.repoRoot ?? ''),
        ...(state.engineering.context.branch ? { branch: String(state.engineering.context.branch) } : {}),
        ...(state.engineering.start
          ? { start: state.engineering.start as { commit: string; dirty: boolean; snapshot: string } }
          : {}),
        ...(state.engineering.end
          ? { end: state.engineering.end as { commit: string; dirty: boolean; snapshot: string; diffHash?: string; diff?: string } }
          : {}),
        progress: {
          done: state.taskStates.filter(task => task.status === 'done').length,
          total: state.taskStates.length
        },
        tests: state.engineering.testReports.map(item => ({
          command: String(item.command ?? ''),
          status: String(item.status ?? 'unknown')
        })),
        ...(state.engineering.build
          ? { build: { status: String(state.engineering.build.status ?? 'unknown') } }
          : {}),
        ...(state.engineering.review
          ? {
              review: {
                verdict: String(state.engineering.review.verdict ?? 'unknown'),
                issues: Array.isArray(state.engineering.review.issues)
                  ? state.engineering.review.issues.map(String)
                  : []
              }
            }
          : {})
      }
    : undefined;

  const knowledge = state.goal.workspace === 'knowledge'
    ? buildKnowledgeMap({
        cards: [],
        claims: state.claims,
        disputes: state.disputes,
        conflicts: state.conflicts
      })
    : undefined;

  return {
    participants,
    evidence,
    ...(deliverable ? { deliverable } : {}),
    ...(engineering ? { engineering } : {}),
    ...(knowledge ? { knowledge } : {})
  };
}
