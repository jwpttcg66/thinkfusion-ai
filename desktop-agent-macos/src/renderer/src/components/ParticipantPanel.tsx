import React, { useEffect, useState } from 'react';
import type { CollaborationDetailsView, CollaborationParticipantView } from '../../../shared/contracts';

const STATUS_LABEL: Record<CollaborationParticipantView['status'], string> = {
  pending: '等待', running: '进行中', done: '完成', failed: '失败', skipped: '跳过'
};

/** B-02：参与者、分工、状态、输出摘要、失败原因。 */
export function ParticipantPanel(props: { conversationId: string }) {
  const [details, setDetails] = useState<CollaborationDetailsView | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await window.agentAPI.getCollaborationDetails(props.conversationId);
        if (!cancelled) setDetails(next);
      } catch { if (!cancelled) setDetails(null); }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [props.conversationId]);

  if (!details || details.participants.length === 0) return null;
  return (
    <section className="collab-people" aria-label="参与者">
      <header className="collab-section-head">参与者</header>
      <ul>
        {details.participants.map(item => (
          <li key={item.participantId} className={`collab-person is-${item.status}`}>
            <div className="collab-person-line">
              <strong>{item.participantId}</strong>
              <span className="collab-person-role">{item.role === 'questioner' ? '提问' : '回答'}</span>
              <span className="collab-person-status">{STATUS_LABEL[item.status]}</span>
            </div>
            {item.reason && <div className="collab-person-reason">{item.reason}</div>}
            {item.outputPreview && <div className="collab-person-output">{item.outputPreview}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
