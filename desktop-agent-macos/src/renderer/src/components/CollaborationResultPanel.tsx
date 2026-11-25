/**
 * 主活动区五层结果面板（V3 U4/U5 · U7 质量收敛）。
 *
 * 只读 CollaborationResultView：结论 → 意见/争议 → 评审/验证 → 过程摘要 → 证据入口。
 * 不在这里重新推导业务状态。
 */

import React, { useState } from 'react';
import type { CollaborationResultView, ReviewDisposition, SourceReference } from '../../../shared/collaboration-result';
import type { GoalDrivenWorkbenchView } from '../../../shared/goal-driven-cycle';
import { MarkdownBody } from './MarkdownBody';

const OPINION_PREVIEW = 8;

export function CollaborationResultPanel(props: {
  result: CollaborationResultView;
  /** GDC：目标 / 循环进度 / 下一步（派生视图，可缺省）。 */
  workbench?: GoalDrivenWorkbenchView | null;
  /** 轨迹/详情入口：可选，不传就不显示跳转。 */
  onOpenEvidence?: () => void;
  /** 默认展开结论；过程层默认收起（true = 收起）。 */
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
  const { result, workbench } = props;
  // 任务书：过程层默认收起；compactProcess 缺省按 true 处理。
  const [processOpen, setProcessOpen] = useState(!(props.compactProcess ?? true));
  const [opinionsExpanded, setOpinionsExpanded] = useState(false);
  const [busyIssueId, setBusyIssueId] = useState<string | null>(null);
  const hasOpinions = result.keyOpinions.length > 0 || result.disputes.length > 0;
  const hasReview = result.reviews.length > 0 || result.verifications.length > 0;
  const coreOpinions = result.keyOpinions.filter(item =>
    item.position === 'support' || item.position === 'oppose' || item.position === 'revise');
  const supplementOpinions = result.keyOpinions.filter(item =>
    item.position === 'supplement' || item.position === 'neutral');
  const orderedOpinions = [...coreOpinions, ...supplementOpinions];
  const visibleOpinions = opinionsExpanded
    ? orderedOpinions
    : orderedOpinions.slice(0, OPINION_PREVIEW);
  const hiddenOpinionCount = Math.max(0, orderedOpinions.length - OPINION_PREVIEW);

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

      {workbench && (
        <>
          <details className="collab-result-section" open>
            <summary>工程目标</summary>
            <div className="collab-result-body">
              <p>{workbench.goal.intent || workbench.goal.originalRequest}</p>
              <p className="muted">
                状态：{workbench.goal.status}
                {' · '}符合度：{fitLabel(workbench.goal.fit)}
                {' · '}版本 v{String(workbench.goal.goalVersion)}
              </p>
              {workbench.goal.successCriteria.length > 0 && (
                <ul className="collab-result-facts">
                  {workbench.goal.successCriteria.map(item => <li key={item}>{item}</li>)}
                </ul>
              )}
              {workbench.goal.fitNotes.length > 0 && (
                <p className="muted">符合度说明：{workbench.goal.fitNotes.join('；')}</p>
              )}
              {workbench.goal.openQuestions.length > 0 && (
                <p className="collab-result-open">待澄清：{workbench.goal.openQuestions.join('；')}</p>
              )}
            </div>
          </details>
          <details className="collab-result-section" open>
            <summary>
              循环进度
              <span className="muted">
                {' '}· 第 {String(workbench.cycle.cycleNumber)} 轮 · {stageLabel(workbench.cycle.currentStage)}
              </span>
            </summary>
            <div className="collab-result-body">
              <ul className="collab-result-facts">
                {workbench.cycle.stages.map(item => (
                  <li key={item.stage}>
                    {stageLabel(item.stage)}
                    {' · '}
                    {item.status === 'active' ? '进行中' : item.status === 'done' ? '完成' : item.status === 'skipped' ? '跳过' : '待定'}
                    {item.reason ? `（${item.reason}）` : ''}
                  </li>
                ))}
              </ul>
              <p className="muted">
                迭代 {String(workbench.cycle.budget.roundCount)}/{String(workbench.cycle.budget.maxIterations)}
                {workbench.cycle.budget.nearLimit ? ' · 接近预算上限' : ''}
              </p>
              {workbench.cycle.rollback && (
                <p className="collab-result-open">
                  回退：{stageLabel(workbench.cycle.rollback.from)} → {stageLabel(workbench.cycle.rollback.to)}
                  （{workbench.cycle.rollback.reason}）
                </p>
              )}
            </div>
          </details>
          <details className="collab-result-section" open>
            <summary>结论与下一步</summary>
            <div className="collab-result-body">
              <p>
                <b>{conclusionLabel(workbench.cycle.conclusionType)}</b>
                {workbench.cycle.conclusionSummary ? ` · ${workbench.cycle.conclusionSummary}` : ''}
              </p>
              <p>{workbench.cycle.nextAction}</p>
              {workbench.artifacts.filter(item => item.status === 'superseded').length > 0 && (
                <p className="muted">
                  已替代产物 {String(workbench.artifacts.filter(item => item.status === 'superseded').length)} 项（历史仍可追溯）
                </p>
              )}
              {workbench.decisions.length > 0 && (
                <p className="muted">
                  处理决定 {String(workbench.decisions.length)} 条
                </p>
              )}
            </div>
          </details>
        </>
      )}

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
              return (
                <div className="collab-result-exec">
                  <p className="muted">
                    目标物{paths.length > 0 ? `（${String(paths.length)}）` : ''}
                  </p>
                  {paths.length > 0 ? (
                    <ul className="collab-result-facts">
                      {paths.slice(0, 40).map(path => (
                        <li key={path}><code>{path}</code></li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">没有记录到交付文件。</p>
                  )}
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
            <SourceRefList refs={result.conclusion.sourceRefs} />
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
            {visibleOpinions.map(opinion => (
              <article key={opinion.opinionId} className="collab-result-opinion">
                <header>
                  <b>{opinion.author}</b>
                  <span className="muted">{positionLabel(opinion.position)}</span>
                </header>
                <MarkdownBody text={opinion.statement} />
                {opinion.rationale && <p className="muted">理由：{opinion.rationale}</p>}
                <SourceRefList refs={[...opinion.sourceRefs, ...opinion.evidenceRefs]} />
              </article>
            ))}
            {hiddenOpinionCount > 0 && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => setOpinionsExpanded(open => !open)}
              >
                {opinionsExpanded
                  ? '收起意见'
                  : `展开全部意见（另有 ${String(hiddenOpinionCount)} 条）`}
              </button>
            )}
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
                {dispute.exchanges.length > 6 && (
                  <p className="muted">另有 {String(dispute.exchanges.length - 6)} 条交锋，见完整轨迹。</p>
                )}
                {dispute.verdict && <p><b>裁决：</b>{dispute.verdict}</p>}
                {dispute.unresolvedReason && (
                  <p className="collab-result-open">未解决：{dispute.unresolvedReason}</p>
                )}
                <SourceRefList refs={dispute.sourceRefs} />
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
                        {issue.rationale && <div className="muted">依据：{issue.rationale}</div>}
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
                        <SourceRefList refs={[...issue.sourceRefs, ...issue.evidenceRefs]} />
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
                <SourceRefList refs={item.sourceRefs} />
              </article>
            ))}
          </div>
        </details>
      )}

      {/* 04 协作过程（默认收起） */}
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

function SourceRefList(props: { refs: readonly SourceReference[] }) {
  const labels = [...new Set(
    props.refs
      .map(item => item.label ?? item.messageId ?? item.participantId ?? item.eventType ?? item.kind)
      .filter((item): item is string => Boolean(item && item.trim()))
  )].slice(0, 8);
  if (labels.length === 0) return null;
  return (
    <p className="muted collab-result-sources">
      来源：{labels.join(' · ')}
    </p>
  );
}

function positionLabel(position: string): string {
  switch (position) {
    case 'support': return '支持';
    case 'oppose': return '反对 / 对照';
    case 'supplement': return '补充摘要';
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

function fitLabel(fit: string): string {
  switch (fit) {
    case 'met': return '已满足';
    case 'gap': return '有缺口';
    case 'pending': return '待验证';
    default: return '未知';
  }
}

function stageLabel(stage: string): string {
  switch (stage) {
    case 'goal_reasoning': return '目标理解';
    case 'analysis': return '分析';
    case 'design': return '设计';
    case 'design_debate': return '方案辩论';
    case 'planning': return '计划';
    case 'implementation': return '实现';
    case 'review': return '审核';
    case 'review_debate': return '审核辩论';
    case 'conclusion': return '结论';
    case 'done': return '完成';
    default: return stage;
  }
}

function conclusionLabel(type: string): string {
  switch (type) {
    case 'accepted': return '已通过';
    case 'accepted_with_risks': return '带风险接受';
    case 'needs_fix': return '需修复';
    case 'needs_review': return '需补充审核';
    case 'needs_redesign': return '需重新设计';
    case 'needs_analysis': return '需再分析';
    case 'unresolved': return '争议未决';
    case 'blocked': return '阻塞';
    case 'aborted': return '已终止';
    default: return '进行中';
  }
}
