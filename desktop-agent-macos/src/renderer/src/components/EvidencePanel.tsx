import React, { useEffect, useState } from 'react';
import type { CollaborationDetailsView } from '../../../shared/contracts';

const TRUST_LABEL: Record<'verified' | 'unverified' | 'degraded', string> = {
  verified: '已验证', unverified: '未核验', degraded: '降级'
};

/** B-03：证据引用、来源与 trust。 */
export function EvidencePanel(props: { conversationId: string }) {
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

  if (!details || details.evidence.length === 0) return null;
  return (
    <section className="collab-evidence" aria-label="证据">
      <header className="collab-section-head">证据 {details.evidence.length}</header>
      <ul>
        {details.evidence.map(item => (
          <li key={item.evidenceId} className={`collab-evidence-item is-${item.trust}`}>
            <div className="collab-evidence-line">
              <span className="collab-evidence-kind">{item.kind}</span>
              <span className="collab-evidence-trust">{TRUST_LABEL[item.trust]}</span>
              {item.taskId && <span className="collab-evidence-task">{item.taskId}</span>}
            </div>
            <div className="collab-evidence-summary">{item.summary}</div>
            <div className="collab-evidence-source">{item.source}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
