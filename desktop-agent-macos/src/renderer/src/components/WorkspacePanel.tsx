import React, { useEffect, useState } from 'react';
import type { CollaborationDetailsView } from '../../../shared/contracts';

function EngineeringSection(props: { details: CollaborationDetailsView; workspaceRoot?: string }) {
  const engineering = props.details.engineering;
  if (!engineering) {
    return (
      <section className="collab-workspace">
        <header className="collab-section-head">工程</header>
        <p className="collab-muted">
          {props.workspaceRoot ? `已绑定 ${props.workspaceRoot}，暂无工程任务状态。` : '还没有绑定工程目录。'}
        </p>
      </section>
    );
  }
  return (
    <section className="collab-workspace">
      <header className="collab-section-head">工程</header>
      <p className="collab-muted">{engineering.repoRoot}{engineering.branch ? ` · ${engineering.branch}` : ''}</p>
      <div className="collab-kv">
        <span>起点</span><code>{engineering.start?.commit ?? '—'}</code>
        <span>终点</span><code>{engineering.end?.commit ?? '—'}</code>
        <span>测试</span><code>{engineering.tests.map(t => `${t.command}:${t.status}`).join(' / ') || '—'}</code>
        <span>构建</span><code>{engineering.build?.status ?? '—'}</code>
        <span>评审</span><code>{engineering.review ? `${engineering.review.verdict}${engineering.review.issues.length ? `（${engineering.review.issues.length} 个问题）` : ''}` : '—'}</code>
      </div>
    </section>
  );
}

function KnowledgeSection(props: { details: CollaborationDetailsView }) {
  const knowledge = props.details.knowledge;
  if (!knowledge) return null;
  const blocks: Array<[string, typeof knowledge.confirmed]> = [
    ['已确认', knowledge.confirmed],
    ['争议', knowledge.disputed],
    ['未回答', knowledge.unanswered]
  ];
  return (
    <section className="collab-workspace">
      <header className="collab-section-head">知识</header>
      {blocks.map(([label, items]) => (
        <div key={label} className="collab-knowledge-block">
          <div className="collab-knowledge-label">{label}（{items.length}）</div>
          {items.length === 0 ? <div className="collab-muted">暂无</div> : (
            <ul>
              {items.map((item, index) => (
                <li key={`${label}-${String(index)}`}>{item.statement}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

function DeliverableSection(props: { details: CollaborationDetailsView }) {
  const deliverable = props.details.deliverable;
  if (!deliverable) return null;
  return (
    <section className="collab-deliverable">
      <header className="collab-section-head">交付</header>
      <div className="collab-deliverable-meta">
        <span>停止：{deliverable.stopReason}</span>
        <span>证据覆盖：{Math.round(deliverable.evidenceCoverage * 100)}%</span>
      </div>
      <div className="collab-deliverable-body">{deliverable.content}</div>
      {deliverable.openQuestions.length > 0 && (
        <div className="collab-open">
          <div className="collab-knowledge-label">未解决</div>
          <ul>{deliverable.openQuestions.map((item, index) => <li key={String(index)}>{item}</li>)}</ul>
        </div>
      )}
      {deliverable.claims.length > 0 && (
        <div className="collab-claims">
          <div className="collab-knowledge-label">结论与验证</div>
          <ul>
            {deliverable.claims.map((claim, index) => (
              <li key={String(index)}><span className={`is-${claim.relation}`}>{claim.relation}</span> {claim.text}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** B-04/05/06/07：按工作空间展示工程/知识/通用交付。 */
export function WorkspacePanel(props: {
  conversationId: string;
  workspaceMode?: 'knowledge' | 'engineering';
  workspaceRoot?: string;
}) {
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

  if (!details) return null;
  return (
    <>
      {props.workspaceMode === 'engineering' && <EngineeringSection details={details} workspaceRoot={props.workspaceRoot} />}
      {props.workspaceMode === 'knowledge' && <KnowledgeSection details={details} />}
      <DeliverableSection details={details} />
    </>
  );
}
