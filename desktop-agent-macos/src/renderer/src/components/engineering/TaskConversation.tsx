import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AgentTask } from '../../../../shared/contracts';
import type { StepCard } from '../../../../shared/execution-timeline';
import { duration, statusText, target, toolLabel } from '../../../../shared/execution-timeline';
import {
  buildTaskConversation,
  memberBodyView,
  protocolDerivation,
  protocolSummary,
  type ConversationEntry,
  type ConversationProtocol,
  type ConversationTone
} from '../../../../shared/task-conversation';
import { splitSummarySections } from '../../../../shared/text';

/**
 * 对话流（工程空间主界面）。
 *
 * 这里是「一次协作的完整记录」，不是状态面板：我问了什么、每个成员怎么答的、
 * 中间真跑了哪些命令、每一轮的评审说了什么、最后的结论是什么。状态面板回答
 * 「现在到哪一步」，它回答「这件事到底发生过什么」——两件事都要有，但主界面
 * 只能是后者，否则一轮新回答就会把上一轮挤掉。
 *
 * 只画真的发生过的东西：没有结论文本就不要编一句。协议 JSON 原文去「输出」页，
 * 但主界面必须留下可读推导与思考过程——不能整段推走。
 */

function timeText(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function elapsedText(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${String(Math.round(value))}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

/** 把一步的真实结果压成几行能读的东西；压不出来就留 JSON 原文。 */
function stepOutput(card: StepCard): { text: string; language: 'text' | 'json' } {
  const data = card.result as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== 'object') {
    return { text: card.result === undefined ? '' : String(card.result), language: 'text' };
  }
  const pick = (key: string): string => (typeof data[key] === 'string' ? String(data[key]) : '');
  const stdout = pick('stdout');
  const stderr = pick('stderr');
  const command = pick('command');
  if (stdout || stderr || command) {
    const exit = typeof data.exitCode === 'number' ? `（退出码 ${String(data.exitCode)}）` : '';
    const body = [
      command ? `$ ${command}${exit}` : '',
      stdout.trim(),
      stderr.trim() ? `[stderr]\n${stderr.trim()}` : ''
    ].filter(Boolean).join('\n\n');
    return { text: body.slice(0, 4000), language: 'text' };
  }
  if (typeof data.content === 'string') {
    return { text: data.content.slice(0, 4000), language: 'text' };
  }
  if (typeof data.patch === 'string') return { text: data.patch.slice(0, 4000), language: 'text' };
  if (typeof data.before === 'string' && typeof data.after === 'string') {
    return { text: `改之前\n${data.before.slice(0, 1500)}\n\n改之后\n${data.after.slice(0, 1500)}`, language: 'text' };
  }
  let json = '';
  try {
    json = JSON.stringify(data, null, 2);
  } catch {
    json = String(data);
  }
  return { text: json.slice(0, 4000), language: 'json' };
}

function ToneClass(tone: ConversationTone): string {
  return `t-${tone}`;
}

function protocolLabel(protocol: ConversationProtocol): string {
  switch (protocol) {
    case 'plan':
      return '计划';
    case 'execution_report':
      return '执行报告';
    case 'clarification_required':
      return '澄清请求';
    case 'task_complete':
      return '完成报告';
    default:
      return '协议对象';
  }
}

function MemberMessage(props: {
  entry: Extract<ConversationEntry, { kind: 'member' }>;
  now: number;
}) {
  const { entry } = props;
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const live = entry.status === 'streaming';
  const elapsed = entry.durationMs ?? (live && entry.at ? props.now - entry.at : null);
  const summary = entry.protocol ? protocolSummary(entry.text) : null;
  const derivation = entry.protocol ? protocolDerivation(entry.text) : null;
  // 正文默认只露 5 行，和思考折叠一样点开才看全文。短正文不出现按钮。
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  // 正文框与思考折叠的分工统一由 shared 层决定：流式期间只有一处展示内容，
  // 不让同一份 thinking 在正文框和折叠里各铺一遍。
  const view = memberBodyView(entry);
  // 流式期间自动跟到底部（露最新几行）；结束后回到顶部，别停在流式的最后一屏。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = live ? el.scrollHeight : 0;
  }, [live, entry.text, entry.reasoning]);
  // 5 行以外还有内容才给「展开全文」；展开后按钮保留，用于收起。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || entry.protocol) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [entry.text, entry.protocol, expanded, view.bodyText]);

  return (
    <article className={`chat-member is-${entry.status}`}>
      <header className="chat-member-head">
        <span className="chat-avatar" aria-hidden>{entry.label.slice(0, 1)}</span>
        <div className="chat-member-title">
          <b>{entry.label}</b>
          <span className="chat-meta">
            {entry.roundNumber ? `第 ${String(entry.roundNumber)} 轮 · ` : ''}
            {timeText(entry.at)}
            {elapsed !== null ? ` · ${elapsedText(elapsed)}` : ''}
            {` · ${String(view.displayLength)} 字符`}
          </span>
        </div>
        <span className={`member-pill is-${entry.status}`}>
          {live && <span className="spinner" />}
          {live ? '输出中' : entry.status === 'completed' ? '已完成' : entry.status === 'failed' ? '失败' : '已取消'}
        </span>
      </header>
      {entry.error && <p className="chat-member-error">{entry.error}</p>}
      <div className="chat-member-body">
        {entry.protocol ? (
          <>
            {/* 协议 JSON 原文去输出页；主页面必须留下可读推导与思考，不能整段推走。 */}
            <p className="chat-protocol-note">
              这一路返回的是{protocolLabel(entry.protocol)}（机器协议）；下方是可读摘要与思考，完整 JSON 在「输出」页。
            </p>
            {summary && <p className="chat-protocol-summary">{summary}</p>}
            {derivation && (
              <pre className="chat-member-text chat-protocol-derivation">{derivation}</pre>
            )}
          </>
        ) : (
          <>
            {/* 思考也是输出。很多模型先写几十秒推理再出正文，只显示「等待模型
                输出…」会让这一分钟看起来像卡死；正文没来之前就把推理摊开，
                字一行行长，等正文到了再切换过去。此时底部折叠收掉，同一份
                内容只出现一次。 */}
            {view.showLiveThinking && (
              <p className="chat-reasoning-live">思考中 · 已写 {entry.reasoning.length} 字符</p>
            )}
            <pre className={`chat-member-text${expanded ? '' : ' is-clamped'}`} ref={bodyRef}>
              {view.bodyText || view.placeholder}
            </pre>
            {(overflowing || expanded) && (
              <button className="chat-member-more" type="button" onClick={() => setExpanded(value => !value)}>
                {expanded ? '收起全文' : '展开全文'}
              </button>
            )}
          </>
        )}
        {view.showReasoningDetails && (
          <details className="chat-reasoning" open={Boolean(entry.protocol && entry.reasoning)}>
            <summary>思考过程{entry.reasoning ? `（${entry.reasoning.length} 字符）` : ''}</summary>
            {entry.reasoning ? <pre>{entry.reasoning}</pre> : <p className="muted">这个来源本次没有返回思考内容。</p>}
          </details>
        )}
      </div>
    </article>
  );
}

/** 计划树：8 步就写 8 步，不让人对着一句「计划就绪」猜。 */
function PlanMessage(props: { entry: Extract<ConversationEntry, { kind: 'plan' }> }) {
  const { entry } = props;
  return (
    <section className="card chat-plan">
      <div className="review-head">
        <b>计划 · {entry.title}</b>
        <span className="muted">{timeText(entry.at)} · {String(entry.steps.length)} 步</span>
      </div>
      {entry.description && <p className="chat-plan-desc">{entry.description}</p>}
      <ol className="chat-plan-steps">
        {entry.steps.map((step, index) => {
          const targetText = target(step.tool, step.args);
          return (
            <li key={step.id}>
              <span className="chat-plan-index">{String(index + 1)}</span>
              <div className="chat-plan-step-body">
                <b>{toolLabel(step.tool)}</b>
                {step.description && <span className="chat-plan-desc">{step.description}</span>}
                {targetText && <code>{targetText}</code>}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="chat-plan-goal">
        <span className="muted">执行目标：</span>{entry.completion || '未写明'}
      </p>
      {entry.warnings.length > 0 && (
        <ul>
          {entry.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
        </ul>
      )}
    </section>
  );
}

/** 轮间 / 执行前桥接：先画出对象，再开质疑、回应或执行。 */
function BridgeMessage(props: { entry: Extract<ConversationEntry, { kind: 'bridge' }> }) {
  const { entry } = props;
  const actionLabel = entry.action === 'execute'
    ? '将执行'
    : entry.action === 'stop'
      ? '已收尾'
      : entry.nextPhase === 'response'
        ? '将回应'
        : entry.nextPhase === 'challenge'
          ? '将质疑'
          : '将继续';
  const targetLabel = entry.action === 'continue' && entry.nextPhase === 'response'
    ? '待答复的质疑对象'
    : entry.action === 'continue' && entry.nextPhase === 'challenge'
      ? '将质疑的分歧'
      : '相关分歧';
  return (
    <section className={`card chat-bridge is-${entry.action} ${ToneClass(entry.tone)}`}>
      <div className="review-head">
        <b>{entry.title}</b>
        <span className="muted">{timeText(entry.at)} · {actionLabel}</span>
      </div>
      <p className="chat-bridge-message">{entry.message}</p>
      {entry.targets.length > 0 && (
        <div className="chat-bridge-targets">
          <p className="chat-debate-label">{targetLabel}（{String(entry.targets.length)}）</p>
          <ol className="chat-bridge-list">
            {entry.targets.map((target, index) => (
              <li key={index}>
                <p><span className="muted">一方：</span>{target.left}</p>
                <p><span className="muted">另一方：</span>{target.right}</p>
                <p className="muted">依据：{target.reason}</p>
                {target.agents && (
                  <p className="muted">成员：{target.agents.join(' · ')}</p>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {entry.steps && entry.steps.length > 0 && (
        <div className="chat-bridge-targets">
          <p className="chat-debate-label">将执行的步骤（{String(entry.steps.length)}）</p>
          <ol className="chat-bridge-list">
            {entry.steps.map(step => (
              <li key={step.index}>
                <p>
                  <b>{String(step.index)}. {toolLabel(step.tool)}</b>
                  {' · '}
                  {step.description}
                </p>
                {step.target && <p className="muted"><code>{step.target}</code></p>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {entry.action === 'continue' && entry.targets.length === 0 && (
        <p className="muted">本轮判定要继续，但没有抽出可展示的主张原文；下一轮仍会按引擎规则进行。</p>
      )}
    </section>
  );
}

/** 与知识问答综合卡同一套底色：结论 / 一致 / 分歧 / 存疑 / 辩题一眼可分。 */
function leadSectionClass(title: string): string {
  switch (title) {
    case '结论': return ' is-conclusion';
    case '一致': return ' is-agreement';
    case '分歧': return ' is-dispute';
    case '存疑': return ' is-doubt';
    case '辩题': return ' is-topic';
    default: return '';
  }
}

/** 方案评审：五段结论一出就分段画出；辩题原文直接列出，等待时也能知道在辩什么。 */
function DebateMessage(props: { entry: Extract<ConversationEntry, { kind: 'debate' }> }) {
  const { entry } = props;
  const label = entry.status === 'running'
    ? '进行中'
    : entry.status === 'completed'
      ? '已辩完'
      : entry.status === 'skipped'
        ? '未进行'
        : '已停止';
  const leadSections = entry.leadSummary ? splitSummarySections(entry.leadSummary) : [];
  return (
    <section className={`card chat-debate is-${entry.status}`}>
      <div className="review-head">
        <b>方案评审 · {label}</b>
        <span className="muted">
          {timeText(entry.at)}
          {entry.elapsedMs > 0 ? ` · 已等 ${String(Math.round(entry.elapsedMs / 1000))} 秒` : ''}
          {typeof entry.rounds === 'number'
            ? ` · 实际 ${String(entry.rounds)} 轮${typeof entry.maxRounds === 'number' && entry.rounds !== entry.maxRounds ? `（最多 ${String(entry.maxRounds)}）` : ''}`
            : typeof entry.maxRounds === 'number' ? ` · 最多 ${String(entry.maxRounds)} 轮` : ''}
        </span>
      </div>
      {entry.leadSummary && (
        <div className="chat-debate-brief">
          <p className="chat-debate-label">主导五段结论</p>
          {leadSections.length > 0 ? (
            <div className="summary-sections">
              {leadSections.map((section, index) => (
                <section
                  key={index}
                  className={`summary-section${leadSectionClass(section.title)}${section.title ? '' : ' no-title'}`}
                >
                  {section.title && <h4 className="summary-section-title">{section.title}</h4>}
                  <p className="summary-section-body">{section.body || '没有'}</p>
                </section>
              ))}
            </div>
          ) : (
            <pre className="chat-debate-lead-summary">{entry.leadSummary}</pre>
          )}
        </div>
      )}
      {(entry.expressTarget || entry.expressGoal) && (
        <div className="chat-debate-brief">
          <p className="chat-debate-label">表态</p>
          {entry.expressTarget && (
            <p><span className="muted">对象：</span>{entry.expressTarget}</p>
          )}
          {entry.expressGoal && (
            <p><span className="muted">目标：</span>{entry.expressGoal}</p>
          )}
        </div>
      )}
      {entry.topics.length > 0 ? (
        <>
          <p className="chat-debate-label">议题（{String(entry.topics.length)}）</p>
          <p className="muted chat-debate-topic-source">
            来源：主导模型五段结论中的【辩题】（与知识问答同一套）；系统不按步数或工具名编造辩论。
          </p>
          <ol className="chat-debate-topics">
            {entry.topics.map((topic, index) => (
              <li key={index}>
                <div>{topic}</div>
                {entry.topicGoals?.[index] && (
                  <p className="muted chat-debate-topic-goal">目标：{entry.topicGoals[index]}</p>
                )}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="muted">还没有拿到议题文本；这里只记录评审已开始。</p>
      )}
      {entry.participants.length > 0 && (
        <p className="muted">参与者：{entry.participants.join('、')}</p>
      )}
      {entry.reason && <p className="muted">为什么评审：{entry.reason}</p>}
      <p className="muted">
        轮次规则：第 1 轮表态；有未解决争议才进入第 2 轮质疑；质疑需要被答复才进入第 3 轮回应；任何一轮收敛就结束。
      </p>
      {entry.roundsReason && <p className="muted">本场依据：{entry.roundsReason}</p>}
      {entry.summary && <p className="chat-debate-summary">{entry.summary}</p>}
      {entry.skippedReason && <p className="muted">未评审原因：{entry.skippedReason}</p>}
    </section>
  );
}

function checkStatus(value: 'passed' | 'failed' | 'skipped'): string {
  return value === 'passed' ? '通过' : value === 'failed' ? '未通过' : '未执行';
}

/**
 * 第 N 次验证。
 *
 * 每次 `report.ready` 的验证结论各占一条：后来一次验证不该把前一次覆盖掉，
 * 也不该只在页面底部留一张「最新状态」的卡——时间线里发生过几次就是几条。
 */
function VerificationMessage(props: { entry: Extract<ConversationEntry, { kind: 'verification' }> }) {
  const { entry } = props;
  const checks = entry.checks;
  const ran = checks
    ? [checks.compile, checks.run, checks.tests, checks.diagnostics].some(item => item && item.status !== 'skipped')
    : true;
  const label = entry.fullyVerified
    ? '已通过'
    : entry.verified
      ? '部分通过'
      : ran ? '未通过' : '未执行';
  const missing = checks
    ? [
        ['编译', checks.compile.status],
        ['运行', checks.run?.status ?? 'skipped'],
        ['测试', checks.tests.status],
        ['诊断', checks.diagnostics.status]
      ].filter(([, status]) => status !== 'passed').map(([text]) => text)
    : [];
  return (
    <section className={`card review-card chat-verification${entry.fullyVerified ? '' : ' needs-fix'}`}>
      <div className="review-head">
        <b>第 {String(entry.index)} 次验证 · {label}</b>
        <span className="muted">
          {timeText(entry.at)} · {String(entry.changedFiles)} 个文件改动
          {` · 执行报告 ${entry.reportStatus}（${String(entry.completedSteps)}/${String(entry.totalSteps)} 步完成）`}
        </span>
      </div>
      {entry.reasons.length > 0 && (
        <ul>
          {entry.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
        </ul>
      )}
      {checks && (
        <div className="verify-checks">
          {([
            ['compile', '编译'],
            ['run', '运行'],
            ['tests', '测试'],
            ['diagnostics', '诊断']
          ] as const).map(([key, text]) => {
            if (key === 'diagnostics') {
              const check = checks.diagnostics;
              return (
                <div key={key} className={`verify-check is-${check.status}`}>
                  <b>{text}</b>
                  <span>{checkStatus(check.status)}</span>
                  <em>
                    {String(check.errors)} error / {String(check.warnings)} warn
                    {check.source ? ` · ${check.source}` : ''}
                  </em>
                </div>
              );
            }
            const check = key === 'run' ? checks.run : checks[key];
            if (!check) return null;
            const detail = check.command
              ? `${check.command}${typeof check.exitCode === 'number' ? ` · 退出码 ${String(check.exitCode)}` : ''}${key === 'run' && check.output ? ` · 输出 ${check.output}` : ''}`
              : (check.detail ?? '');
            return (
              <div key={key} className={`verify-check is-${check.status}`}>
                <b>{text}</b>
                <span>{checkStatus(check.status)}</span>
                {detail && <em>{detail}</em>}
              </div>
            );
          })}
        </div>
      )}
      {entry.diagnostics.length > 0 && (
        <details className="chat-note-detail">
          <summary>诊断问题（{String(entry.diagnostics.length)} 个文件）</summary>
          {entry.diagnostics.map(item => (
            <div key={item.path} className="research-message">
              <span className="research-tag">
                {item.source} · {item.path} · {String(item.errors)} error / {String(item.warnings)} warn
              </span>
              {item.issues.map((issue, index) => (
                <p key={index} className="muted">{issue.line}:{issue.column} {issue.message}</p>
              ))}
            </div>
          ))}
        </details>
      )}
      {entry.verified && !entry.fullyVerified && missing.length > 0 && (
        <p className="muted">部分通过：{missing.join('、')}未通过/未执行；四项检查齐全才算完成。</p>
      )}
      {!entry.verified && (
        <p className="muted">「未通过」是事实，不是失败提示：补一次测试或诊断，或明确接受未验证。</p>
      )}
    </section>
  );
}

/** 第 N 次独立评审：同样按事件时间落进时间线，不放到页面底部。 */
function ReviewMessage(props: { entry: Extract<ConversationEntry, { kind: 'review' }> }) {
  const { entry } = props;
  const details = entry.issueDetails && entry.issueDetails.length > 0
    ? entry.issueDetails
    : entry.issues.map((text, index) => ({
        issueId: `legacy:${String(index)}`,
        title: text.slice(0, 80),
        description: text,
        severity: 'unknown' as const,
        disposition: 'pending' as const
      }));
  return (
    <section className={`card review-card chat-review${entry.needsFix ? ' needs-fix' : ''}`}>
      <div className="review-head">
        <b>第 {String(entry.index)} 次独立评审 · {entry.needsFix ? '需修复' : '通过'}</b>
        <span className="muted">
          {timeText(entry.at)} · {entry.backend === 'rules' ? '本机规则版' : entry.reviewer}
        </span>
      </div>
      <p>{entry.verdict}</p>
      {details.length > 0 && (
        <ul>
          {details.map(issue => (
            <li key={issue.issueId}>
              <b>{issue.title}</b>
              {issue.description !== issue.title && <div>{issue.description}</div>}
              <div className="muted">
                风险：{issue.severity === 'high' ? '高' : issue.severity === 'medium' ? '中' : issue.severity === 'low' ? '低' : '未分级'}
                {' · '}处理：{issue.disposition === 'pending' ? '待决定' : issue.disposition}
              </div>
            </li>
          ))}
        </ul>
      )}
      {entry.rawVerdict && entry.rawVerdict !== entry.verdict && (
        <details>
          <summary>完整评审原文</summary>
          <pre>{entry.rawVerdict}</pre>
        </details>
      )}
      <p className="muted">评审只给结论，不会改文件。未处理的问题保持待决定，不会自动关闭。</p>
    </section>
  );
}

function StepMessage(props: { entry: Extract<ConversationEntry, { kind: 'step' }> }) {
  const { card } = props.entry;
  const output = useMemo(() => stepOutput(card), [card]);
  const head = target(card.tool, card.args);
  const meta = [duration(card.durationMs), statusText(card)].filter(Boolean).join(' · ');
  return (
    <details className={`chat-step is-${card.status}`}>
      <summary className="chat-step-head">
        <span className="chat-step-dot" aria-hidden />
        <b>{toolLabel(card.tool)}</b>
        {head && <code className="chat-step-target">{head}</code>}
        <span className="chat-step-meta">{meta}</span>
      </summary>
      <div className="chat-step-body">
        {card.approval === 'rejected' && <p className="chat-note-line is-bad">已拒绝：{card.approvalReason ?? '用户拒绝'}</p>}
        {card.error && <pre className="chat-step-error">{card.error}</pre>}
        {card.args && (
          <details className="chat-step-sub">
            <summary>参数</summary>
            <pre>{JSON.stringify(card.args, null, 2).slice(0, 3000)}</pre>
          </details>
        )}
        {output.text
          ? <pre className="chat-step-output">{output.text}</pre>
          : <p className="muted">
              {card.status === 'running' ? '正在执行，还没有返回输出。'
                : card.status === 'waiting' ? '等待处理中。'
                  : card.status === 'failed' ? '这一步失败，没有返回输出。'
                    : '这一步没有可展示的输出。'}
            </p>}
      </div>
    </details>
  );
}

export function TaskConversation(props: {
  task: AgentTask;
  events: readonly AgentEvent[];
  live: {
    roundId: string | null;
    text: string;
    reasoning: string;
    providerId: string | null;
    modelId: string | null;
  } | null;
}) {
  const entries = useMemo(
    () => buildTaskConversation(props.events, {
      prompt: props.task.userPrompt,
      summary: props.task.summary,
      status: props.task.status,
      live: props.live
    }),
    [props.events, props.task, props.live]
  );
  const hasLive = entries.some(entry => entry.kind === 'member' && entry.status === 'streaming');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!hasLive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasLive]);

  if (entries.length === 0) {
    return (
      <section className="card chat-empty">
        <b>这一轮还没有可展示的内容</b>
        <p className="muted">模型开始输出后，问题、回答、执行过程和结论都会按顺序出现在这里。</p>
      </section>
    );
  }

  return (
    <section className="chat-feed" aria-label="任务对话">
      {entries.map((entry, index) => {
        if (entry.kind === 'user') {
          return (
            <div key={entry.key} className="chat-row is-user">
              <div className="chat-user-bubble">
                <span className="chat-who">你 · {timeText(entry.at)}</span>
                <p>{entry.text}</p>
              </div>
            </div>
          );
        }
        if (entry.kind === 'member') {
          return <MemberMessage key={entry.key} entry={entry} now={now} />;
        }
        if (entry.kind === 'step') {
          return <StepMessage key={`${entry.key}-${String(index)}`} entry={entry} />;
        }
        if (entry.kind === 'plan') {
          return <PlanMessage key={entry.key} entry={entry} />;
        }
        if (entry.kind === 'debate') {
          return <DebateMessage key={entry.key} entry={entry} />;
        }
        if (entry.kind === 'bridge') {
          return <BridgeMessage key={entry.key} entry={entry} />;
        }
        if (entry.kind === 'verification') {
          return <VerificationMessage key={entry.key} entry={entry} />;
        }
        if (entry.kind === 'review') {
          return <ReviewMessage key={entry.key} entry={entry} />;
        }
        if (entry.kind === 'conclusion') {
          const metaFacts = entry.executionResults && entry.executionResults.length > 0
            ? entry.facts.filter(fact => !entry.executionResults!.includes(fact))
            : entry.facts;
          return (
            <section key={entry.key} className={`chat-conclusion ${ToneClass(entry.tone)}`}>
              <div className="chat-conclusion-head">
                <b>结论</b>
                <span className="muted">{timeText(entry.at)}</span>
              </div>
              <p>{entry.text}</p>
              {entry.executionGoal && (
                <div className="chat-conclusion-block">
                  <p className="chat-debate-label">执行目标</p>
                  <p>{entry.executionGoal}</p>
                </div>
              )}
              {entry.executionResults && entry.executionResults.length > 0 && (
                <div className="chat-conclusion-block">
                  <p className="chat-debate-label">执行结果</p>
                  <ul className="chat-conclusion-results">
                    {entry.executionResults.map(item => (
                      <li key={item}>
                        <pre>{item}</pre>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {entry.deliverables && entry.deliverables.length > 0 && (
                <div className="chat-conclusion-block">
                  <p className="chat-debate-label">目标物（{String(entry.deliverables.length)}）</p>
                  <ul className="chat-conclusion-results">
                    {entry.deliverables.map(path => (
                      <li key={path}><code>{path}</code></li>
                    ))}
                  </ul>
                </div>
              )}
              {metaFacts.length > 0 && (
                <ul>
                  {metaFacts.map(fact => <li key={fact}>{fact}</li>)}
                </ul>
              )}
            </section>
          );
        }
        return (
          <div key={`${entry.key}-${String(index)}`} className={`chat-note ${ToneClass(entry.tone)}`}>
            <span className="chat-note-text">{entry.text}</span>
            {entry.detail && (
              <details className="chat-note-detail">
                <summary>详情</summary>
                <pre>{entry.detail}</pre>
              </details>
            )}
          </div>
        );
      })}
    </section>
  );
}

/**
 * 协议原文归档（「输出」页）。
 *
 * 主界面只留摘要，但原文不能丢：这里按轮次列出每一路返回的机器协议 JSON，
 * 用户点开就能看到完整原文。数据直接来自同一份对话投影，不另存一份。
 */
export function ProtocolArchive(props: {
  task: AgentTask;
  events: readonly AgentEvent[];
}) {
  const entries = useMemo(
    () => buildTaskConversation(props.events, {
      prompt: props.task.userPrompt,
      summary: props.task.summary,
      status: props.task.status
    }),
    [props.events, props.task]
  );
  const protocols = entries.filter(
    (entry): entry is Extract<ConversationEntry, { kind: 'member' }> =>
      entry.kind === 'member' && entry.protocol !== null
  );
  if (protocols.length === 0) return null;

  return (
    <details className="card protocol-archive" id="protocol-archive" open>
      <summary>协议原文（{protocols.length} 条 · 机器读的 JSON）</summary>
      <p className="muted">
        主界面只显示摘要；每一路返回的完整原文都在这里，按轮次排列。
      </p>
      {protocols.map(entry => (
        <details key={entry.key} className="protocol-archive-item">
          <summary>
            {entry.label}
            {entry.roundNumber ? ` · 第 ${String(entry.roundNumber)} 轮` : ''}
            {` · ${protocolLabel(entry.protocol)} · ${String(entry.text.length)} 字符`}
          </summary>
          <pre className="chat-member-text">{entry.text}</pre>
        </details>
      ))}
    </details>
  );
}
