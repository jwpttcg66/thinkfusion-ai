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
  // waitMs：deepseek 一类会先内部想很久才吐首字，空「等待模型输出」像卡死。
  const view = memberBodyView({ ...entry, waitMs: elapsed });
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

/** 参与者 ≥ 2 才算多模型辩论/审核。 */
function isMultiModelDebate(entry: Extract<ConversationEntry, { kind: 'debate' }>): boolean {
  const names = [...new Set(entry.participants.map(item => item.trim()).filter(Boolean))];
  return names.length >= 2;
}

/**
 * 只有实际在辩论轮次里发言的模型才出卡片（表态 / 质疑 / 回应）。
 * 主导写五段、普通规划回答、终态协议输出一律走流式，不因「同轮有辩论」整轮变卡。
 */
function isDebatePeerLabel(label: string): boolean {
  return /轮评审\s*·\s*(表态|质疑|回应)/u.test(label);
}

/** 流式层级：重点正文 vs 旁注里程碑。 */
type StreamEmphasis = 'focus' | 'aside';

function noteEmphasis(text: string): StreamEmphasis {
  if (/^(任务分解|工程上下文|模型参与|循环决策|目标符合度|上下文|第 \d+ 轮 ·)/u.test(text.trim())) {
    return 'aside';
  }
  return 'focus';
}

/** 方案评审总览：始终流式旁注；多模型时各辩论方另出 Member 卡。 */
function DebateStreamNote(props: { entry: Extract<ConversationEntry, { kind: 'debate' }> }) {
  const { entry } = props;
  const multi = isMultiModelDebate(entry);
  const label = entry.status === 'running'
    ? '进行中'
    : entry.status === 'completed'
      ? '已辩完'
      : entry.status === 'skipped'
        ? '未进行'
        : '已停止';
  const head = [
    `方案评审 · ${label}`,
    multi ? `多模型 ${String(entry.participants.length)} 方` : (entry.participants[0] || '单模型'),
    timeText(entry.at),
    entry.elapsedMs > 0 ? `已等 ${String(Math.round(entry.elapsedMs / 1000))} 秒` : '',
    typeof entry.rounds === 'number' ? `实际 ${String(entry.rounds)} 轮` : '',
    entry.skippedReason ? `跳过：${entry.skippedReason}` : ''
  ].filter(Boolean).join(' · ');
  const detail = [
    entry.leadSummary ? `主导五段：\n${entry.leadSummary}` : '',
    entry.topics.length > 0 ? `议题：\n${entry.topics.map((t, i) => `${String(i + 1)}. ${t}`).join('\n')}` : '',
    entry.summary || '',
    entry.roundsReason || '',
    entry.reason ? `为什么评审：${entry.reason}` : ''
  ].filter(Boolean).join('\n\n');
  const tone: ConversationTone = entry.status === 'completed'
    ? 'ok'
    : entry.status === 'running'
      ? 'info'
      : 'muted';
  return (
    <div className={`chat-note is-aside ${ToneClass(tone)}`}>
      <span className="chat-note-text">{head}</span>
      {detail ? (
        <details className="chat-note-detail">
          <summary>展开评审原文</summary>
          <pre>{detail}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** 流式成员输出：重点正文加粗层级，旁注更淡；协议/终态也走这条，不出辩论卡。 */
function MemberStreamNote(props: {
  entry: Extract<ConversationEntry, { kind: 'member' }>;
  now: number;
  emphasis?: StreamEmphasis;
}) {
  const { entry } = props;
  const emphasis = props.emphasis ?? 'focus';
  const live = entry.status === 'streaming';
  const elapsed = entry.durationMs ?? (live && entry.at ? props.now - entry.at : null);
  const view = memberBodyView({ ...entry, waitMs: elapsed });
  const [expanded, setExpanded] = useState(false);
  const summary = entry.protocol ? protocolSummary(entry.text) : null;
  const derivation = entry.protocol ? protocolDerivation(entry.text) : null;
  return (
    <div className={`chat-stream-member is-${entry.status} is-${emphasis}`}>
      <div className="chat-stream-head">
        {emphasis === 'focus' && <span className="chat-stream-badge">重点</span>}
        <span className="chat-note-text">
          {entry.label}
          {entry.roundNumber ? ` · 第 ${String(entry.roundNumber)} 轮` : ''}
          {' · '}{timeText(entry.at)}
          {elapsed !== null ? ` · ${elapsedText(elapsed)}` : ''}
          {live ? ' · 输出中' : entry.status === 'completed' ? ' · 已完成' : ''}
          {entry.protocol ? ` · ${protocolLabel(entry.protocol)}` : ''}
        </span>
        {live && <span className="spinner" />}
      </div>
      {entry.error && <p className="chat-member-error">{entry.error}</p>}
      {entry.protocol ? (
        <>
          <p className="chat-protocol-note">
            协议输出走流式阅读；完整 JSON 在「输出」页。
          </p>
          {summary && <p className="chat-protocol-summary">{summary}</p>}
          {derivation && (
            <pre className={`chat-stream-body${expanded ? '' : ' is-clamped'}`}>{derivation}</pre>
          )}
        </>
      ) : (
        <>
          {view.showLiveThinking && (
            <p className="chat-reasoning-live">思考中 · 已写 {entry.reasoning.length} 字符</p>
          )}
          <pre className={`chat-stream-body${expanded ? '' : ' is-clamped'}`}>
            {view.bodyText || view.placeholder}
          </pre>
        </>
      )}
      {(view.displayLength > 480 || expanded || (derivation && derivation.length > 480)) && (
        <button className="chat-member-more" type="button" onClick={() => setExpanded(value => !value)}>
          {expanded ? '收起全文' : '展开全文'}
        </button>
      )}
      {view.showReasoningDetails && entry.reasoning && (
        <details className="chat-reasoning">
          <summary>思考过程（{entry.reasoning.length} 字符）</summary>
          <pre>{entry.reasoning}</pre>
        </details>
      )}
    </div>
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
  /**
   * U7：上方已有 CollaborationResultPanel 时，结论 / 评审 / 验证只留时间序标记，
   * 完整结构化内容见结果面板；不删事件，只去重视觉重复。
   */
  omitResultSummaries?: boolean;
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
  // 场上是否存在多模型辩论：只给「表态/质疑/回应」发言方出卡，不按整轮 roundId 开卡。
  const hasMultiModelDebate = useMemo(
    () => entries.some(entry => entry.kind === 'debate' && isMultiModelDebate(entry)),
    [entries]
  );

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
            <div key={entry.key} className="chat-row is-user is-focus">
              <div className="chat-user-bubble">
                <span className="chat-who">你 · {timeText(entry.at)}</span>
                <p>{entry.text}</p>
              </div>
            </div>
          );
        }
        if (entry.kind === 'member') {
          const useCard = hasMultiModelDebate && isDebatePeerLabel(entry.label);
          return useCard
            ? <MemberMessage key={entry.key} entry={entry} now={now} />
            : <MemberStreamNote key={entry.key} entry={entry} now={now} emphasis="focus" />;
        }
        if (entry.kind === 'step') {
          return (
            <div key={`${entry.key}-${String(index)}`} className="chat-stream-block is-focus">
              <StepMessage entry={entry} />
            </div>
          );
        }
        if (entry.kind === 'plan') {
          return <PlanMessage key={entry.key} entry={entry} />;
        }
        if (entry.kind === 'debate') {
          // 方案评审总览始终流式短记；多模型时各辩论方另出 Member 卡。
          return <DebateStreamNote key={entry.key} entry={entry} />;
        }
        if (entry.kind === 'bridge') {
          return (
            <div key={entry.key} className="chat-stream-block is-focus">
              <BridgeMessage entry={entry} />
            </div>
          );
        }
        if (entry.kind === 'verification') {
          if (props.omitResultSummaries) {
            const label = entry.fullyVerified
              ? '已通过'
              : entry.verified
                ? '部分通过'
                : '未通过';
            return (
              <div key={entry.key} className={`chat-note is-aside ${ToneClass(entry.verified ? 'ok' : 'warn')}`}>
                <span className="chat-note-text">
                  第 {String(entry.index)} 次验证 · {label} · {timeText(entry.at)}
                  {' · '}详见上方「任务结果」
                </span>
              </div>
            );
          }
          return (
            <div key={entry.key} className="chat-stream-block is-focus">
              <VerificationMessage entry={entry} />
            </div>
          );
        }
        if (entry.kind === 'review') {
          if (props.omitResultSummaries) {
            return (
              <div key={entry.key} className={`chat-note is-aside ${ToneClass(entry.needsFix ? 'warn' : 'ok')}`}>
                <span className="chat-note-text">
                  第 {String(entry.index)} 次独立评审 · {entry.needsFix ? '需修复' : '通过'}
                  {' · '}{timeText(entry.at)} · 详见上方「任务结果」
                </span>
              </div>
            );
          }
          return (
            <div key={entry.key} className="chat-stream-block is-focus">
              <ReviewMessage entry={entry} />
            </div>
          );
        }
        if (entry.kind === 'conclusion') {
          // 终态在对话流里也按流式协议阅读；完整结构化收口在「任务结果」。
          if (props.omitResultSummaries) {
            return (
              <div key={entry.key} className={`chat-note is-focus ${ToneClass(entry.tone)}`}>
                <span className="chat-stream-badge">重点</span>
                <span className="chat-note-text">
                  结论已写入上方「任务结果」 · {timeText(entry.at)}
                  {entry.deliverables && entry.deliverables.length > 0
                    ? ` · 目标物 ${String(entry.deliverables.length)} 项`
                    : ''}
                </span>
              </div>
            );
          }
          const metaFacts = entry.executionResults && entry.executionResults.length > 0
            ? entry.facts.filter(fact => !entry.executionResults!.includes(fact))
            : entry.facts;
          return (
            <div key={entry.key} className={`chat-stream-conclusion is-focus ${ToneClass(entry.tone)}`}>
              <div className="chat-stream-head">
                <span className="chat-stream-badge">重点</span>
                <span className="chat-note-text">结论 · {timeText(entry.at)}</span>
              </div>
              <p className="chat-stream-conclusion-text">{entry.text}</p>
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
              <div className="chat-conclusion-block">
                <p className="chat-debate-label">
                  目标物{entry.deliverables && entry.deliverables.length > 0
                    ? `（${String(entry.deliverables.length)}）`
                    : ''}
                </p>
                {entry.deliverables && entry.deliverables.length > 0 ? (
                  <ul className="chat-conclusion-results">
                    {entry.deliverables.map(path => (
                      <li key={path}><code>{path}</code></li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">没有记录到交付文件。</p>
                )}
              </div>
              {metaFacts.length > 0 && (
                <ul>
                  {metaFacts.map(fact => <li key={fact}>{fact}</li>)}
                </ul>
              )}
            </div>
          );
        }
        const emphasis = noteEmphasis(entry.text);
        return (
          <div
            key={`${entry.key}-${String(index)}`}
            className={`chat-note is-${emphasis} ${ToneClass(entry.tone)}`}
          >
            {emphasis === 'focus' && <span className="chat-stream-badge">重点</span>}
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
