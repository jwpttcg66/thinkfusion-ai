/**
 * GCE：工程任务的目标契约卡。
 *
 * 只显示从事件派生的目标、Criterion、Goal Fit 与真实阶段；不在界面重算业务
 * 状态，也不把 task.completed 当作目标达成。目标修订必须显式提交，删减标准
 * 由用户再确认一次。
 */

import React, { useEffect, useState } from 'react';
import type { GoalDrivenWorkbenchView } from '../../../../shared/goal-driven-cycle';
import { cycleDecisionText, latestCycleDecision } from '../../../../shared/goal-driven-cycle';

const STAGE_LABEL: Record<string, string> = {
  goal_reasoning: '目标理解',
  analysis: '分析',
  design: '设计',
  design_debate: '方案辩论',
  planning: '计划',
  implementation: '实现',
  review: '审核',
  review_debate: '审核辩论',
  conclusion: '结论',
  done: '完成'
};

function fitLabel(fit: string | undefined): string {
  switch (fit) {
    case 'met': return '已满足';
    case 'gap': return '有缺口';
    case 'pending': return '待验证';
    case 'unknown': return '未验证';
    default: return '未验证';
  }
}

function gceFitLabel(fit: string | undefined): string {
  switch (fit) {
    case 'MET': return '已满足';
    case 'WITH_RISKS': return '带风险达成';
    case 'PARTIAL': return '部分满足';
    case 'GAP': return '未达成';
    case 'UNKNOWN': return '未验证';
    default: return '未验证';
  }
}

function criterionLabel(status: string): string {
  switch (status) {
    case 'MET': return '已满足';
    case 'PARTIAL': return '部分满足';
    case 'UNMET': return '未满足';
    case 'UNVERIFIED': return '未验证';
    case 'WAIVED': return '已豁免';
    default: return '待验证';
  }
}

export function GoalContractCard(props: {
  workbench?: GoalDrivenWorkbenchView | null;
  /** 提交新的成功标准；返回是否还需要用户确认。 */
  onReviseGoal?: (
    criteria: string[],
    userConfirmedChange: boolean
  ) => Promise<{ requiresUserConfirmation?: boolean } | void>;
  /** V4 M1-2：在当前目标下新建一条任务（沿用目标当前的版本与成功标准）。 */
  onCreateTaskInGoal?: (prompt: string) => Promise<void>;
}) {
  const { workbench } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [newText, setNewText] = useState('');
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [createError, setCreateError] = useState('');

  const criteria = workbench?.goal.criteria ?? [];
  const cycleDecisionLine = cycleDecisionText(latestCycleDecision(workbench?.decisions ?? []));
  const currentLines = criteria.length > 0
    ? criteria.map(item => item.description)
    : workbench?.goal.successCriteria ?? [];

  useEffect(() => {
    if (!editing) setText(currentLines.join('\n'));
  }, [editing, workbench?.goal.goalVersion, currentLines.join('\n')]);

  if (!workbench) return null;

  async function submit(): Promise<void> {
    if (!props.onReviseGoal) return;
    const next = text.split('\n').map(item => item.trim()).filter(Boolean);
    // M1-3：删标准属于重大变更，但不再在这里弹原生对话框——那只会问「确不确定」，
    // 说不出会牵动哪些任务。照常提交，让后端发 goal.revision.pending，由确认卡列影响面。
    setBusy(true);
    setError('');
    try {
      const result = await props.onReviseGoal(next, false);
      if (result && 'requiresUserConfirmation' in result && result.requiresUserConfirmation) {
        setError('这次变更需要确认影响面：目标版本未变，请在上方「目标变更待确认」里核对后确认。');
        return;
      }
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }


  async function createInGoal(): Promise<void> {
    if (!props.onCreateTaskInGoal) return;
    const prompt = newText.trim();
    if (!prompt) return;
    setCreatingBusy(true);
    setCreateError('');
    try {
      await props.onCreateTaskInGoal(prompt);
      setCreating(false);
      setNewText('');
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingBusy(false);
    }
  }

  return (
    <details className="card goal-contract-card" open>
      <summary>
        工程目标
        <span className="muted">
          {' '}· {workbench.goal.status}
          {' · '}符合度 {workbench.goal.gceFit
            ? gceFitLabel(workbench.goal.gceFit)
            : fitLabel(workbench.goal.fit)}
          {' · '}v{String(workbench.goal.goalVersion)}
        </span>
      </summary>
      <div className="goal-contract-body">
        <p>{workbench.goal.intent || workbench.goal.originalRequest}</p>
        {criteria.length > 0 ? (
          <ul className="collab-result-facts">
            {criteria.map(item => (
              <li key={item.criterionId}>
                {item.priority === 'MUST' ? '必须' : item.priority === 'SHOULD' ? '应当' : '可选'}
                {' · '}{item.description}
                {' · '}{criterionLabel(item.status)}
                {item.evidenceRefs.length > 0 ? `（${String(item.evidenceRefs.length)} 条证据）` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">还没有可验收的成功标准；执行完成不会自动算目标达成。</p>
        )}
        {workbench.goal.fitNotes.length > 0 && (
          <p className="muted">符合度说明：{workbench.goal.fitNotes.join('；')}</p>
        )}
        {workbench.goal.openQuestions.length > 0 && (
          <p className="collab-result-open">待澄清：{workbench.goal.openQuestions.join('；')}</p>
        )}
        <p className="muted">
          当前阶段：{STAGE_LABEL[workbench.cycle.currentStage] ?? workbench.cycle.currentStage}
          {' · '}下一步：{workbench.cycle.nextAction || '尚未确定'}
        </p>
        {/* M3-1：判定标签与实际落点摆在同一句里，用户看得到「系统打算做什么」而不是只有一句下一步。 */}
        {cycleDecisionLine && <p className="muted">{cycleDecisionLine}</p>}
        {props.onReviseGoal && (
          <div className="goal-contract-edit">
            {editing ? (
              <>
                <textarea
                  className="goal-contract-input"
                  value={text}
                  onChange={event => setText(event.target.value)}
                  rows={Math.max(3, currentLines.length + 1)}
                  aria-label="成功标准，每行一条"
                />
                <div className="goal-contract-actions">
                  <button className="btn" type="button" disabled={busy} onClick={() => void submit()}>
                    {busy ? '提交中…' : '保存目标'}
                  </button>
                  <button className="btn ghost" type="button" disabled={busy} onClick={() => setEditing(false)}>
                    取消
                  </button>
                </div>
                {error && <p className="collab-result-open">{error}</p>}
              </>
            ) : (
              <button className="btn ghost" type="button" onClick={() => setEditing(true)}>
                修改目标 / 成功标准
              </button>
            )}
          </div>
        )}
        {props.onCreateTaskInGoal && (
          <div className="goal-new-task">
            {creating ? (
              <>
                <textarea
                  className="goal-contract-input"
                  value={newText}
                  onChange={event => setNewText(event.target.value)}
                  rows={3}
                  aria-label="这条新任务要做什么"
                  placeholder="这条任务要做什么。它会挂在当前目标下，沿用目标当前的版本与成功标准。"
                />
                <div className="goal-contract-actions">
                  <button
                    className="btn"
                    type="button"
                    disabled={creatingBusy || newText.trim() === ''}
                    onClick={() => void createInGoal()}
                  >
                    {creatingBusy ? '提交中…' : '在目标下新建任务'}
                  </button>
                  <button className="btn ghost" type="button" disabled={creatingBusy} onClick={() => setCreating(false)}>
                    取消
                  </button>
                </div>
                {createError && <p className="collab-result-open">{createError}</p>}
              </>
            ) : (
              <button
                className="btn ghost"
                type="button"
                onClick={() => { setCreating(true); setNewText(''); setCreateError(''); }}
              >
                在此目标下新建任务
              </button>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
