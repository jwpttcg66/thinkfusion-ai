import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AgentTask, DiffFileStat } from '../../../../shared/contracts';
import type { StepCard } from '../../../../shared/execution-timeline';
import { duration, statusText, target, toolLabel } from '../../../../shared/execution-timeline';
import { MarkdownBody } from '../MarkdownBody';
import {
  activeLandmarkId,
  agentRoleLabel,
  buildStreamLandmarks,
  buildTaskConversation,
  clusterSteps,
  landmarkTone,
  liveElapsedText,
  memberBodyView,
  needsLiveTimer,
  noteEmphasisOf,
  protocolDerivation,
  protocolSummary,
  shouldShowLandmarkRail,
  stepElapsedMs,
  streamAnchorId,
  type ConversationEntry,
  type ConversationEntryView,
  type ConversationProtocol,
  type ConversationTone,
  type DiffSummary,
  type StepCluster,
  type StreamLandmark
} from '../../../../shared/task-conversation';
/**
 * 对话流（工程空间主界面）。
 *
 * 默认整条时序流：提问 / 计划 / 执行 / 评审 / 结论都是流式短记，按事件时间排列。
 * **只有多模型辩论里实际发言的一方**才出 Member 卡片；单模型、主导五段、终态协议
 * 一律不出卡。左侧只留一条**定位轨**（重点节点的短记列表），贴底结果大卡不进主会话。
 *
 * 只画真的发生过的东西：没有结论文本就不要编一句。协议 JSON 原文去「输出」页。
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
  // C4：流式画 pre、完成后画 Markdown div，两个元素各用独立 ref，效果里读当前可见的那个。
  const preRef = useRef<HTMLPreElement | null>(null);
  const mdRef = useRef<HTMLDivElement | null>(null);
  const activeRef = (): HTMLElement | null => preRef.current ?? mdRef.current;
  const live = entry.status === 'streaming';
  const elapsed = entry.durationMs ?? (live && entry.at ? props.now - entry.at : null);
  const summary = entry.protocol ? protocolSummary(entry.text) : null;
  const derivation = entry.protocol ? protocolDerivation(entry.text) : null;
  // 正文默认只露 5 行，和思考折叠一样点开才看全文。短正文不出现按钮。
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  // 用户往上翻看前文时不要被流式输出拽回底部；滚回底部附近才继续跟随。
  const stickRef = useRef(true);
  const followScroll = () => {
    const el = activeRef();
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  // 正文框与思考折叠的分工统一由 shared 层决定：流式期间只有一处展示内容，
  // 不让同一份 thinking 在正文框和折叠里各铺一遍。
  // waitMs：deepseek 一类会先内部想很久才吐首字，空「等待模型输出」像卡死。
  const view = memberBodyView({ ...entry, waitMs: elapsed });
  // 流式期间自动跟到底部（露最新几行）；结束后回到顶部，别停在流式的最后一屏。
  useEffect(() => {
    const el = activeRef();
    if (!el) return;
    if (!live) {
      el.scrollTop = 0;
      stickRef.current = true;
      return;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [live, entry.text, entry.reasoning]);
  // 5 行以外还有内容才给「展开全文」；展开后按钮保留，用于收起。
  useEffect(() => {
    const el = activeRef();
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
            {/* C4：流式期间按纯文本画（半成品表格/代码块自然降级，不做每字符重排）；
                这条回答结束后再用 MarkdownBody 完整排版。两种画法用的是同一份原文，
                不改模型输出一个字，展开/收起只改呈现。 */}
            {live ? (
              <pre className={`chat-member-text${expanded ? '' : ' is-clamped'}`} ref={preRef} onScroll={followScroll}>
                {view.bodyText || view.placeholder}
              </pre>
            ) : (
              <div className="chat-member-md" ref={mdRef}>
                <MarkdownBody text={view.bodyText ?? view.placeholder ?? ''} />
              </div>
            )}
            {live && (overflowing || expanded) && (
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

/** 计划：流式短记；步骤列表进详情，不占整张卡。 */
function PlanStreamNote(props: { entry: Extract<ConversationEntry, { kind: 'plan' }> }) {
  const { entry } = props;
  const head = `计划 · ${entry.title} · ${timeText(entry.at)} · ${String(entry.steps.length)} 步`;
  const detail = [
    entry.description?.trim() || '',
    entry.completion ? `执行目标：${entry.completion}` : '',
    entry.steps.length > 0
      ? entry.steps.map((step, index) => {
          const targetText = target(step.tool, step.args);
          return `${String(index + 1)}. ${toolLabel(step.tool)}${step.description ? ` — ${step.description}` : ''}${targetText ? ` · ${targetText}` : ''}`;
        }).join('\n')
      : '',
    entry.warnings.length > 0 ? `注意：\n${entry.warnings.join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  return (
    <div className="chat-note is-focus">
      <span className="chat-stream-badge">重点</span>
      <span className="chat-note-text">{head}</span>
      {detail ? (
        <details className="chat-note-detail">
          <summary>展开计划步骤</summary>
          <pre>{detail}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** 轮间 / 执行前桥接：流式短记。 */
function BridgeStreamNote(props: { entry: Extract<ConversationEntry, { kind: 'bridge' }> }) {
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
  const head = `${entry.title} · ${timeText(entry.at)} · ${actionLabel}`;
  const detailParts = [entry.message?.trim() || ''];
  if (entry.targets.length > 0) {
    detailParts.push(entry.targets.map((item, index) => (
      `${String(index + 1)}. ${item.left} ↔ ${item.right}\n依据：${item.reason}${item.agents ? `\n成员：${item.agents.join(' · ')}` : ''}`
    )).join('\n\n'));
  }
  if (entry.steps && entry.steps.length > 0) {
    detailParts.push(entry.steps.map(step => (
      `${String(step.index)}. ${toolLabel(step.tool)} — ${step.description}${step.target ? ` · ${step.target}` : ''}`
    )).join('\n'));
  }
  const detail = detailParts.filter(Boolean).join('\n\n');
  return (
    <div className={`chat-note is-aside ${ToneClass(entry.tone)}`}>
      <span className="chat-note-text">{head}</span>
      {detail ? (
        <details className="chat-note-detail">
          <summary>展开桥接详情</summary>
          <pre>{detail}</pre>
        </details>
      ) : null}
    </div>
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

/** 流式层级：重点正文 vs 旁注里程碑。判定收在 shared 的 noteEmphasisOf（C1）。 */
type StreamEmphasis = 'focus' | 'aside';

function wrapAnchor(entryKey: string, node: React.ReactNode): React.ReactNode {
  return (
    <div
      key={entryKey}
      className="chat-stream-anchor"
      data-stream-anchor={entryKey}
      id={streamAnchorId(entryKey)}
    >
      {node}
    </div>
  );
}

/**
 * 左侧定位轨：只列重点节点，点一下跳到对应短记。
 *
 * 颜色档与锚点 id 都来自投影层的纯函数（`landmarkTone` / `streamAnchorId`），
 * 这里不判断「这个类型该是什么颜色」，也不自己拼 id——拼错了就是点了没反应。
 */
function LocateRail(props: {
  landmarks: readonly StreamLandmark[];
  activeId: string | null;
  onJump: (entryKey: string) => void;
}) {
  return (
    <nav className="chat-locate-rail" aria-label="对话定位">
      <ul className="chat-locate-list">
        {props.landmarks.map(item => (
          <li key={item.id}>
            <button
              type="button"
              className={`chat-locate-tick is-${landmarkTone(item.kind)}${item.id === props.activeId ? ' is-active' : ''}`}
              data-landmark-target={streamAnchorId(item.entryKey)}
              onClick={() => props.onJump(item.entryKey)}
              title={`${item.label} · ${timeText(item.at)}`}
            >
              <span className="chat-locate-dot" aria-hidden />
              <span className="chat-locate-label">{item.label}</span>
              <span className="chat-locate-time">{timeText(item.at)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
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
          {/* C4：普通成员回答也走 MarkdownBody。流式期间保留 pre（半成品降级、
              不逐字符重排），结束后用同一份原文做完整排版。 */}
          {live ? (
            <pre className={`chat-stream-body${expanded ? '' : ' is-clamped'}`}>
              {view.bodyText || view.placeholder}
            </pre>
          ) : (
            <div className="chat-member-md">
              <MarkdownBody text={view.bodyText ?? view.placeholder ?? ''} />
            </div>
          )}
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

function StepMessage(props: { entry: Extract<ConversationEntry, { kind: 'step' }>; now: number }) {
  const { card } = props.entry;
  const output = useMemo(() => stepOutput(card), [card]);
  const head = target(card.tool, card.args);
  // 运行中的那一步要能看见秒数在走：数据早就在 `step.startedAt` 里，只是没人算。
  const live = card.status === 'running' ? stepElapsedMs(card, props.now) : null;
  const meta = [
    // 运行中直接用「执行中 · 8 秒」替掉状态词，免得同一行出现两次「执行中」。
    live !== null ? `执行中 · ${liveElapsedText(live)}` : statusText(card),
    duration(card.durationMs)
  ].filter(Boolean).join(' · ');
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

/**
 * D1 子 Agent 卡：数据全部来自 `code.team.run` 的真实 proposals。
 *
 * 状态/耗时/输出/身份都是那次执行的原文，卡片不新造 AgentRun，也不把普通
 * step 改名冒充。没有真实输出时不编一句，只画真实可用的字段。
 */
function AgentCard(props: { entry: Extract<ConversationEntry, { kind: 'agent' }> }) {
  const { entry } = props;
  const failed = entry.status === 'failed';
  const meta = [
    agentRoleLabel(entry.role),
    entry.stepStartedAt !== null ? `${timeText(entry.stepStartedAt)} 起` : '',
    entry.durationMs !== null ? duration(entry.durationMs) : '',
    entry.patchCount !== undefined ? `${String(entry.patchCount)} 个补丁` : ''
  ].filter(Boolean).join(' · ');
  return (
    <article className={`chat-agent is-${entry.status} is-role-${entry.role}`}>
      <header className="chat-agent-head">
        <span className="chat-agent-dot" aria-hidden />
        <div className="chat-agent-title">
          <b>{entry.label}</b>
          <span className="chat-agent-id">{entry.agentId}</span>
        </div>
        <span className={`chat-agent-pill is-${entry.status}`}>
          {failed ? '失败' : '子 Agent 已完成'}
        </span>
      </header>
      <div className="chat-agent-meta">{meta}</div>
      {entry.task && (
        <div className="chat-agent-task">
          <span className="chat-agent-task-label">承担任务</span>
          <span>{entry.task}</span>
        </div>
      )}
      {entry.workTask && (
        <div className="chat-agent-worktask">
          对应 WorkTask · {entry.workTask.title}
          <code>{entry.workTask.workTaskId}</code>
        </div>
      )}
      {entry.error && <pre className="chat-agent-error">{entry.error}</pre>}
      {entry.text ? (
        <details className="chat-agent-output" open={failed}>
          <summary>真实输出（{String(entry.text.length)} 字符）</summary>
          <div className="chat-member-md"><MarkdownBody text={entry.text} /></div>
        </details>
      ) : (
        <p className="muted">{failed ? '这次运行失败，没有返回输出。' : '这次运行没有返回文本输出。'}</p>
      )}
      {entry.context.length > 0 && (
        <details className="chat-agent-context">
          <summary>上游交接（{String(entry.context.length)} 条）</summary>
          <ol>
            {entry.context.map((line, index) => <li key={index}>{line}</li>)}
          </ol>
        </details>
      )}
    </article>
  );
}

/** 路径过长只留尾段，title 里保留完整路径（逐文件明细看得到、点得到）。 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}

/**
 * C3a 会话聚合胶囊：inline 压缩计数，原地改写，不追加消息。
 * 只有汇总数字，没有也不展示逐文件明细——那是 C3b 的事。
 */
function DiffCapsule(props: { diff: DiffSummary }) {
  const { diff } = props;
  const working = diff.available !== false && typeof diff.insertions === 'number';
  const body = diff.available === false
    ? '改动量统计不可用'
    : working
      ? `+${String(diff.insertions)} / -${String(diff.deletions)}`
      : '';
  return (
    <div className="chat-diff-capsule" title={diff.available === false ? '取 diff 失败，未填 0' : '改动量汇总'}>
      {working && <span className="spinner" aria-hidden />}
      <span>{String(diff.files)} 个文件已修改</span>
      {body && <span className="chat-diff-capsule-num">{body}</span>}
    </div>
  );
}

/**
 * C3b 独立文件变更块：不是胶囊的展开态。带外框、标题、逐文件增删、审阅入口、收起。
 * 逐文件数字只取 `diff.fileStats`，绝不按总数平均分配；明细不完整就不出这个块。
 */
function DiffChangeBlock(props: {
  diff: DiffSummary;
  files: readonly DiffFileStat[];
  onReview?: () => void;
}) {
  const { diff, files } = props;
  const [collapsed, setCollapsed] = useState(false);
  const hasNumbers = diff.available !== false && typeof diff.insertions === 'number';
  return (
    <div className="chat-diff-block">
      <div className="chat-diff-head">
        <span className="chat-diff-icon" aria-hidden>▤</span>
        <div className="chat-diff-title">
          <b>已编辑 {String(diff.files)} 个文件</b>
          {hasNumbers && (
            <span className="chat-diff-total">
              <span className="is-plus">+{String(diff.insertions)}</span>
              <span className="is-minus">-{String(diff.deletions)}</span>
            </span>
          )}
        </div>
        {/* 审阅是独立动作入口；没有真实面板就不塞空按钮，等有 IPC 再接。 */}
        {props.onReview && (
          <button className="chat-diff-review" type="button" onClick={props.onReview}>审阅</button>
        )}
      </div>
      {!collapsed && (
        <ul className="chat-diff-files">
          {files.map(file => (
            <li key={file.path} title={file.path}>
              <code className="chat-diff-file-path">{shortPath(file.path)}</code>
              {file.binary
                ? <span className="chat-diff-file-num is-binary">二进制</span>
                : <span className="chat-diff-file-num">
                    <span className="is-plus">+{String(file.insertions)}</span>
                    <span className="is-minus">-{String(file.deletions)}</span>
                  </span>}
            </li>
          ))}
        </ul>
      )}
      <button className="chat-diff-collapse" type="button" onClick={() => setCollapsed(value => !value)}>
        {collapsed ? `展开文件（${String(files.length)}）⌄` : '收起文件 ⌃'}
      </button>
    </div>
  );
}

/** C3c 交付产物卡片：只展示真实路径，没有就不出卡片。 */
function DeliverableCards(props: { paths: readonly string[] }) {
  if (props.paths.length === 0) return null;
  return (
    <ul className="chat-deliverables">
      {props.paths.map(path => {
        const name = path.split(/[\\/]/u).filter(Boolean).slice(-1)[0] ?? path;
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : 'FILE';
        return (
          <li key={path} className="chat-deliverable" title={path}>
            <span className="chat-deliverable-icon" aria-hidden>▤</span>
            <span className="chat-deliverable-name">{name}</span>
            <span className="chat-deliverable-tag">{ext.slice(0, 6)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** C2：一组连续工具步骤，压成一行；展开后仍逐条画原 steps，失败输出照旧可看。 */
function StepClusterMessage(props: {
  cluster: StepCluster;
  entries: readonly ConversationEntryView[];
  now: number;
}) {
  const { cluster } = props;
  const members = cluster.memberKeys
    .map(key => props.entries.find(entry => entry.key === key))
    .filter((entry): entry is Extract<ConversationEntryView, { kind: 'step' }> => Boolean(entry && entry.kind === 'step'));
  return (
    <details className="chat-step-cluster">
      <summary className="chat-step-cluster-head">
        <span className="chat-step-dot" aria-hidden />
        <b>执行工具 {String(cluster.total)} 次</b>
        {cluster.failed > 0 && <span className="is-bad">，其中 {String(cluster.failed)} 次失败</span>}
        <span className="chat-step-meta">{timeText(cluster.firstAt)}</span>
      </summary>
      <div className="chat-step-cluster-body">
        {members.map(entry => <StepMessage key={entry.key} entry={entry} now={props.now} />)}
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
  // 有流式成员、或有步骤在跑，都要每秒重画：只盯成员会让执行中的秒数停住。
  const hasLive = needsLiveTimer(entries);
  const [now, setNow] = useState(Date.now());
  const feedRef = useRef<HTMLElement | null>(null);
  const landmarks = useMemo(() => buildStreamLandmarks(entries), [entries]);
  // C2：连续工具步骤的聚合分组。分组只影响呈现，原始 entries 一个都不删。
  const { clusters, clusterByEntry } = useMemo(() => clusterSteps(entries), [entries]);
  const showRail = shouldShowLandmarkRail(landmarks);
  const [activeLandmark, setActiveLandmark] = useState<string | null>(null);
  const visibleAnchors = useRef(new Set<string>());
  // 观察器只关心「锚点集合变没变」：流式吐字时 entries 每次都是新数组，
  // 但 key 不变就不该重挂 observer，否则每个 token 都 disconnect 一次。
  const anchorSignature = useMemo(() => entries.map(entry => entry.key).join('|'), [entries]);
  const landmarksRef = useRef(landmarks);
  landmarksRef.current = landmarks;
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

  // 只有「哪些锚点在可视区」由渲染层看；该高亮谁交给投影层的纯函数算。
  useEffect(() => {
    if (!showRail) return;
    const nodes = feedRef.current?.querySelectorAll<HTMLElement>('[data-stream-anchor]');
    if (!nodes || nodes.length === 0) return;
    const visible = visibleAnchors.current;
    visible.clear();
    const observer = new IntersectionObserver(
      records => {
        for (const record of records) {
          const key = record.target.getAttribute('data-stream-anchor');
          if (!key) continue;
          if (record.isIntersecting) visible.add(key);
          else visible.delete(key);
        }
        const next = activeLandmarkId(landmarksRef.current, [...visible]);
        // 可视区里没有轨道节点时保留上一次高亮，不闪回顶部。
        if (next) setActiveLandmark(next);
      },
      // 只把视口上半部分算「当前读到」；否则一屏内所有节点都算可见，高亮乱跳。
      { rootMargin: '-8px 0px -55% 0px', threshold: 0 }
    );
    nodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [anchorSignature, showRail]);

  const jumpTo = (entryKey: string) => {
    const node = document.getElementById(streamAnchorId(entryKey));
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <section
      className={`chat-feed-layout is-stream-only${showRail ? ' has-locate-rail' : ''}`}
      aria-label="任务对话"
    >
      {showRail && (
        <LocateRail landmarks={landmarks} activeId={activeLandmark} onJump={jumpTo} />
      )}
      <section className="chat-feed" aria-label="任务对话" ref={feedRef}>
      {entries.length === 0 ? (
        <div className="chat-stream-placeholder" aria-live="polite">
          <b>这一轮还没有可展示的内容</b>
          <p className="muted">模型开始输出后，问题、回答、执行过程和结论都会按顺序出现在这里。</p>
        </div>
      ) : null}
      {entries.map((entry, index) => {
        if (entry.kind === 'user') {
          return wrapAnchor(entry.key, (
            <div key={entry.key} className="chat-row is-user is-focus">
              <div className="chat-user-bubble">
                <span className="chat-who">你 · {timeText(entry.at)}</span>
                <p>{entry.text}</p>
              </div>
            </div>
          ));
        }
        if (entry.kind === 'member') {
          const useCard = hasMultiModelDebate && isDebatePeerLabel(entry.label);
          return wrapAnchor(
            entry.key,
            useCard
              ? <MemberMessage key={entry.key} entry={entry} now={now} />
              : <MemberStreamNote key={entry.key} entry={entry} now={now} emphasis="focus" />
          );
        }
        if (entry.kind === 'step') {
          const clusterKey = clusterByEntry.get(entry.key);
          if (clusterKey) {
            const cluster = clusters.find(item => item.key === clusterKey);
            // 组的后续成员不单独画：只在第一个成员处出一张聚合卡，展开后逐条显示。
            if (!cluster || cluster.memberKeys[0] !== entry.key) return null;
            return wrapAnchor(entry.key, (
              <div key={entry.key} className="chat-stream-block is-focus">
                <StepClusterMessage cluster={cluster} entries={entries} now={now} />
              </div>
            ));
          }
          return wrapAnchor(entry.key, (
            <div key={entry.key} className="chat-stream-block is-focus">
              <StepMessage entry={entry} now={now} />
            </div>
          ));
        }
        if (entry.kind === 'agent') {
          return wrapAnchor(entry.key, <AgentCard key={entry.key} entry={entry} />);
        }
        if (entry.kind === 'plan') {
          return wrapAnchor(entry.key, <PlanStreamNote key={entry.key} entry={entry} />);
        }
        if (entry.kind === 'debate') {
          return wrapAnchor(entry.key, <DebateStreamNote key={entry.key} entry={entry} />);
        }
        if (entry.kind === 'bridge') {
          return wrapAnchor(entry.key, <BridgeStreamNote key={entry.key} entry={entry} />);
        }
        if (entry.kind === 'verification') {
          const label = entry.fullyVerified
            ? '已通过'
            : entry.verified
              ? '部分通过'
              : '未通过';
          return wrapAnchor(entry.key, (
            <div className={`chat-note is-aside ${ToneClass(entry.verified ? 'ok' : 'warn')}`}>
              <span className="chat-note-text">
                第 {String(entry.index)} 次验证 · {label} · {timeText(entry.at)}
              </span>
            </div>
          ));
        }
        if (entry.kind === 'review') {
          return wrapAnchor(entry.key, (
            <div className={`chat-note is-aside ${ToneClass(entry.needsFix ? 'warn' : 'ok')}`}>
              <span className="chat-note-text">
                第 {String(entry.index)} 次独立评审 · {entry.needsFix ? '需修复' : '通过'}
                {' · '}{timeText(entry.at)}
              </span>
              {entry.verdict ? (
                <details className="chat-note-detail">
                  <summary>展开评审</summary>
                  <pre>{entry.verdict}</pre>
                </details>
              ) : null}
            </div>
          ));
        }
        if (entry.kind === 'conclusion') {
          const deliverables = entry.deliverables ?? [];
          // 目标物已从纯文本详情里拆出独立卡片（C3c），详情里不再重复列一遍。
          const detail = [
            entry.text?.trim() || '',
            entry.executionGoal ? `执行目标：${entry.executionGoal}` : '',
            entry.executionResults && entry.executionResults.length > 0
              ? `执行结果：\n${entry.executionResults.join('\n')}`
              : '',
            entry.facts.length > 0 ? entry.facts.join('\n') : ''
          ].filter(Boolean).join('\n\n');
          return wrapAnchor(entry.key, (
            <div className={`chat-note is-focus ${ToneClass(entry.tone)}`}>
              <span className="chat-stream-badge">重点</span>
              <span className="chat-note-text">
                结论 · {timeText(entry.at)}
                {deliverables.length > 0 ? ` · 目标物 ${String(deliverables.length)} 项` : ''}
              </span>
              {detail ? (
                <details className="chat-note-detail" open>
                  <summary>展开结论</summary>
                  <pre>{detail}</pre>
                </details>
              ) : null}
              <DeliverableCards paths={deliverables} />
            </div>
          ));
        }
        if (entry.kind === 'note' && entry.subtype === 'diff' && entry.diff) {
          const diff = entry.diff;
          // 有完整逐文件明细 → 独立变更块（C3b）；只有汇总/统计不可用 → 胶囊（C3a）。
          // 两者是独立组件，变更块不是胶囊的展开态（不变量 18）。
          const node = Array.isArray(diff.fileStats) && diff.filesAvailable && diff.fileStats.length > 0
            ? <DiffChangeBlock diff={diff} files={diff.fileStats} />
            : <DiffCapsule diff={diff} />;
          return wrapAnchor(entry.key, node);
        }
        const emphasis = noteEmphasisOf(entry.kind === 'note' ? entry.subtype : undefined);
        return wrapAnchor(entry.key, (
          <div className={`chat-note is-${emphasis} ${ToneClass(entry.tone)}`}>
            {emphasis === 'focus' && <span className="chat-stream-badge">重点</span>}
            <span className="chat-note-text">{entry.text}</span>
            {entry.detail && (
              <details className="chat-note-detail">
                <summary>详情</summary>
                <pre>{entry.detail}</pre>
              </details>
            )}
          </div>
        ));
      })}
      </section>
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
    (entry): entry is Extract<ConversationEntryView, { kind: 'member' }> =>
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
