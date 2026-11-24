/**
 * 主活动区五层结果面板（V3 U4/U5）。
 *
 * 只读 CollaborationResultView：结论 → 意见/争议 → 评审/验证 → 过程摘要 → 证据入口。
 * 不在这里重新推导业务状态。
 */

import React, { useState } from 'react';
import type { CollaborationResultView, ReviewDisposition } from '../../../shared/collaboration-result';
import { MarkdownBody } from './MarkdownBody';

export function CollaborationResultPanel(props: {
  result: CollaborationResultView;
  /** 轨迹/详情入口：可选，不传就不显示跳转。 */
  onOpenEvidence?: () => void;
  /** 默认展开结论；过程层默认收起。 */
  compactProcess?: boolean;
  /**
   * 写回评审问题处理决定。不传则只读展示（例如会话结果没有工程评审闭环）。
   */
  onSetDisposition?: (input: {
    issueId: string;
    disposition: ReviewDisposition;
    reason: string;
  }) => void | Promise<void>;
}) {
  const { result } = props;
  const [processOpen, setProcessOpen] = useState(true);
  const [busyIssueId, setBusyIssueId] = useState<string | null>(null);
  const hasOpinions = result.keyOpinions.length > 0 || result.disputes.length > 0;
  const hasReview = result.reviews.length > 0 || result.verifications.length > 0;

  async function decide(
    issueId: string,
    disposition: ReviewDisposition,
    promptLabel: string
  ): Promise<void> {
    if (!props.onSetDisposition) return;
    const reason = window.prompt(promptLabel, '')?.trim() ?? '';
    if ((disposition === 'rejected' || disposition === 'deferred') && !reason) return;
    setBusyIssueId(issueId);
    try {
      await props.onSetDisposition({
        issueId,
        disposition,
        reason: reason || (disposition === 'accepted' ? '已采纳' : '改回待决定')
      });
    } finally {
      setBusyIssueId(null);
    }
  }

  return (
    <section className="collab-result" aria-label="协作结果">
      <header className="collab-result-head">
        <b>任务结果</b>
        <span className="muted">
          {result.scene === 'engineering' ? '工程' : result.scene === 'knowledge' ? '知识' : '问答'}
          {' · '}
          {result.progress.summary}
        </span>
      </header>

      {/* 01 核心结论 */}
      <details className="collab-result-section" open>
        <summary>核心结论</summary>
        {result.conclusion ? (
          <div className="collab-result-body">
            <div className="collab-result-conclusion">
              <MarkdownBody text={result.conclusion.text} />
            </div>
            {result.conclusion.executionGoal && (
              <div className="collab-result-exec">
                <p className="muted">执行目标</p>
                <p>{result.conclusion.executionGoal}</p>
              </div>
            )}
            {result.conclusion.executionResults && result.conclusion.executionResults.length > 0 && (
              <div className="collab-result-exec">
                <p className="muted">执行结果</p>
                <ul className="collab-result-facts">
                  {result.conclusion.executionResults.map(item => (
                    <li key={item}>
                      <pre className="collab-result-pre">{item}</pre>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(() => {
              const paths = (result.conclusion?.deliverables && result.conclusion.deliverables.length > 0)
                ? result.conclusion.deliverables
                : result.deliverables.map(item => item.path ?? item.label).filter(Boolean);
              if (paths.length === 0) return null;
              return (
                <div className="collab-result-exec">
                  <p className="muted">目标物（{String(paths.length)}）</p>
                  <ul className="collab-result-facts">
                    {paths.slice(0, 40).map(path => (
                      <li key={path}><code>{path}</code></li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            {result.conclusion.facts.length > 0 && (
              <ul className="collab-result-facts">
                {result.conclusion.facts
                  .filter(fact => !(result.conclusion?.executionResults ?? []).includes(fact))
                  .map(fact => <li key={fact}>{fact}</li>)}
              </ul>
            )}
            {result.conclusion.uncertainties.length > 0 && (
              <p className="muted">不确定性：{result.conclusion.uncertainties.join('；')}</p>
            )}
            {result.conclusion.openItems.length > 0 && (
              <p className="collab-result-open">待处理：{result.conclusion.openItems.join('；')}</p>
            )}
          </div>
        ) : (
          <p className="muted">还没有可展示的结论文本。</p>
        )}
      </details>

      {/* 目标物单独一节：任务收尾后必须和结论一样显眼，不能只塞进协作过程。 */}
      {result.deliverables.length > 0 && !(result.conclusion?.deliverables && result.conclusion.deliverables.length > 0) && (
        <details className="collab-result-section" open>
          <summary>目标物（{String(result.deliverables.length)}）</summary>
          <div className="collab-result-body">
            <ul className="collab-result-facts">
              {result.deliverables.slice(0, 40).map(item => (
                <li key={item.deliverableId}>
                  <code>{item.path ?? item.label}</code>
                  <span className="muted"> · {item.kind === 'file' ? '改动文件' : '工程产物'}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

      {/* 02 核心意见与争议 */}
      {hasOpinions && (
        <details className="collab-result-section" open>
          <summary>
            核心意见与争议
            <span className="muted">
              {' '}（意见 {String(result.keyOpinions.length)} · 争议 {String(result.disputes.length)}）
            </span>
          </summary>
          <div className="collab-result-body">
            {result.keyOpinions.slice(0, 8).map(opinion => (
              <article key={opinion.opinionId} className="collab-result-opinion">
                <header>
                  <b>{opinion.author}</b>
                  <span className="muted">{positionLabel(opinion.position)}</span>
                </header>
                <MarkdownBody text={opinion.statement} />
                {opinion.rationale && <p className="muted">理由：{opinion.rationale}</p>}
              </article>
            ))}
            {result.disputes.map(dispute => (
              <article key={dispute.disputeId} className="collab-result-dispute">
                <header>
                  <b>{dispute.topic}</b>
                  <span className="muted">{disputeStatusLabel(dispute.status)}</span>
                </header>
                {dispute.claims.map(claim => (
                  <p key={claim.claimId}>
                    <b>{claim.author}</b>：{claim.statement}
                  </p>
                ))}
                {dispute.exchanges.slice(0, 6).map(exchange => (
                  <p key={exchange.exchangeId} className="muted">
                    [{exchange.kind}] {exchange.author}：{exchange.text.slice(0, 280)}
                  </p>
                ))}
                {dispute.verdict && <p><b>裁决：</b>{dispute.verdict}</p>}
                {dispute.unresolvedReason && (
                  <p className="collab-result-open">未解决：{dispute.unresolvedReason}</p>
                )}
              </article>
            ))}
          </div>
        </details>
      )}

      {/* 03 评审与验证 */}
      {hasReview && (
        <details className="collab-result-section" open>
          <summary>
            评审与验证
            <span className="muted">
              {' '}（评审 {String(result.reviews.length)} · 验证 {String(result.verifications.length)}）
            </span>
          </summary>
          <div className="collab-result-body">
            {result.reviews.map(review => (
              <article key={review.reviewId} className={`collab-result-review${review.needsFix ? ' needs-fix' : ''}`}>
                <header>
                  <b>第 {String(review.index)} 次独立评审 · {review.needsFix ? '需修复' : '通过'}</b>
                  <span className="muted">
                    {review.backend === 'rules' ? '本机规则版' : review.reviewer}
                  </span>
                </header>
                <p>{review.verdict}</p>
                {review.issues.length === 0 ? (
                  <p className="muted">没有可跟踪的具体问题。</p>
                ) : (
                  <ul>
                    {review.issues.map(issue => (
                      <li key={issue.issueId}>
                        <b>[{severityLabel(issue.severity ?? 'unknown')}] {issue.title}</b>
                        {issue.description !== issue.title && <div>{issue.description}</div>}
                        <div className="muted">
                          处理：{dispositionLabel(issue.disposition)}
                          {issue.dispositionReason ? ` · ${issue.dispositionReason}` : ''}
                          {issue.recommendation ? ` · 建议：${issue.recommendation}` : ''}
                        </div>
                        {issue.resolutionRefs.length > 0 && (
                          <div className="muted">
                            修正：{issue.resolutionRefs.map(item => item.label ?? item.kind).join('；')}
                          </div>
                        )}
                        {issue.verificationRefs.length > 0 && (
                          <div className="muted">
                            验证：{issue.verificationRefs.map(item => item.label ?? item.kind).join('；')}
                          </div>
                        )}
                        {props.onSetDisposition && issue.disposition === 'pending' && (
                          <div className="collab-result-disposition-actions">
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={busyIssueId === issue.issueId}
                              onClick={() => void decide(issue.issueId, 'accepted', '采纳原因（可留空）')}
                            >
                              采纳
                            </button>
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={busyIssueId === issue.issueId}
                              onClick={() => void decide(issue.issueId, 'rejected', '拒绝原因（必填）')}
                            >
                              拒绝
                            </button>
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={busyIssueId === issue.issueId}
                              onClick={() => void decide(issue.issueId, 'deferred', '暂缓条件或原因（必填）')}
                            >
                              暂缓
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
            {result.verifications.map(item => (
              <article key={item.verificationId} className="collab-result-verification">
                <header>
                  <b>第 {String(item.index)} 次验证 · {item.statusLabel}</b>
                </header>
                {item.reasons.length > 0 && (
                  <ul>{item.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
                )}
                {!item.fullyVerified && (
                  <p className="muted">未完全验证：不能把「模型说已解决」当成测试已通过。</p>
                )}
              </article>
            ))}
          </div>
        </details>
      )}

      {/* 04 协作过程（紧凑） */}
      <details
        className="collab-result-section is-process"
        open={processOpen}
        onToggle={event => setProcessOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary>协作过程</summary>
        <div className="collab-result-body">
          <p className="muted">
            参与者约 {String(result.progress.participantCount)} 人
            {result.meta.eventCount !== undefined ? ` · 事件 ${String(result.meta.eventCount)}` : ''}
            {result.meta.conversationEntryCount !== undefined
              ? ` · 对话条目 ${String(result.meta.conversationEntryCount)}`
              : ''}
            。主推导见上方「核心意见与争议」与对话流中的计划摘要 / 思考过程。
            {result.deliverables.length > 0
              ? ` 目标物见上方「核心结论 / 目标物」（${String(result.deliverables.length)}）。`
              : ''}
          </p>
        </div>
      </details>

      {/* 05 证据入口 */}
      {props.onOpenEvidence && (
        <div className="collab-result-evidence">
          <button type="button" className="btn ghost" onClick={props.onOpenEvidence}>
            打开完整轨迹与原始输出
          </button>
        </div>
      )}
    </section>
  );
}

function positionLabel(position: string): string {
  switch (position) {
    case 'support': return '支持';
    case 'oppose': return '反对';
    case 'supplement': return '补充';
    case 'revise': return '修正';
    default: return '中立';
  }
}

function disputeStatusLabel(status: string): string {
  switch (status) {
    case 'verdict': return '已裁决';
    case 'exchanging': return '交锋中';
    case 'retained': return '保留分歧';
    case 'undetermined': return '无法判断';
    case 'partially_resolved': return '部分解决';
    case 'pending_exchange': return '待交锋';
    default: return '已识别';
  }
}

function severityLabel(severity: string): string {
  switch (severity) {
    case 'high': return '高';
    case 'medium': return '中';
    case 'low': return '低';
    default: return '未分级';
  }
}

function dispositionLabel(disposition: string): string {
  switch (disposition) {
    case 'accepted': return '已采纳';
    case 'rejected': return '已拒绝';
    case 'deferred': return '暂缓';
    default: return '待决定';
  }
}
