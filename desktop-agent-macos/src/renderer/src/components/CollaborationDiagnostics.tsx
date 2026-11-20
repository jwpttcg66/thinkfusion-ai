import React, { useEffect, useState } from 'react';
import type { CollaborationDetailsView, CollaborationPlanView } from '../../../shared/contracts';

/** C-03：协作诊断；只展示失败/阻塞/未解决，不展示用户正文。 */
export function CollaborationDiagnostics(props: { conversationId: string }) {
  const [plan, setPlan] = useState<CollaborationPlanView | null>(null);
  const [details, setDetails] = useState<CollaborationDetailsView | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [nextPlan, nextDetails] = await Promise.all([
          window.agentAPI.getCollaborationPlanView(props.conversationId),
          window.agentAPI.getCollaborationDetails(props.conversationId)
        ]);
        if (!cancelled) { setPlan(nextPlan); setDetails(nextDetails); }
      } catch { if (!cancelled) { setPlan(null); setDetails(null); } }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [props.conversationId]);

  const failedTasks = plan?.tasks.filter(t => t.status === 'failed' || t.status === 'blocked' || t.status === 'skipped') ?? [];
  const failedPeople = details?.participants.filter(p => p.status === 'failed') ?? [];
  const open = details?.deliverable?.openQuestions ?? [];
  if (failedTasks.length === 0 && failedPeople.length === 0 && open.length === 0) return null;

  return (
    <details className="collab-diagnostics">
      <summary>诊断（{failedTasks.length + failedPeople.length + open.length}）</summary>
      {failedTasks.length > 0 && (
        <ul>
          {failedTasks.map(task => (
            <li key={task.taskId}>{task.taskId}：{task.status}{task.reason ? ` — ${task.reason}` : ''}</li>
          ))}
        </ul>
      )}
      {failedPeople.length > 0 && (
        <ul>
          {failedPeople.map(person => (
            <li key={person.participantId}>{person.participantId}：{person.reason ?? '失败'}</li>
          ))}
        </ul>
      )}
      {open.length > 0 && (
        <ul>{open.map((item, index) => <li key={String(index)}>{item}</li>)}</ul>
      )}
    </details>
  );
}
