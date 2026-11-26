import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AgentTask } from '../../../../shared/contracts';
import type { StepCard } from '../../../../shared/execution-timeline';
import { duration, statusText, target, toolLabel } from '../../../../shared/execution-timeline';
import {
  activeLandmarkId,
  buildStreamLandmarks,
  buildTaskConversation,
  landmarkTone,
  liveElapsedText,
  memberBodyView,
  needsLiveTimer,
  protocolDerivation,
  protocolSummary,
  shouldShowLandmarkRail,
  stepElapsedMs,
  streamAnchorId,
  type ConversationEntry,
  type ConversationEntryView,
  type ConversationProtocol,
  type ConversationTone,
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

/** 流式层级：重点正文 vs 旁注里程碑。 */
type StreamEmphasis = 'focus' | 'aside';

function noteEmphasis(text: string): StreamEmphasis {
  if (/^(任务分解|工程上下文|模型参与|循环决策|目标符合度|上下文|第 \d+ 轮 ·)/u.test(text.trim())) {
    return 'aside';
  }
  return 'focus';
}

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
          return wrapAnchor(entry.key, (
            <div key={`${entry.key}-${String(index)}`} className="chat-stream-block is-focus">
              <StepMessage entry={entry} now={now} />
            </div>
          ));
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
          const detail = [
            entry.text?.trim() || '',
            entry.executionGoal ? `执行目标：${entry.executionGoal}` : '',
            entry.executionResults && entry.executionResults.length > 0
              ? `执行结果：\n${entry.executionResults.join('\n')}`
              : '',
            deliverables.length > 0
              ? `目标物：\n${deliverables.join('\n')}`
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
            </div>
          ));
        }
        const emphasis = noteEmphasis(entry.text);
        // 改动量数据（B3）已经在投影里，胶囊样式属于阶段 C3；先不拿一行纯文本占位。
        if (entry.kind === 'note' && entry.subtype === 'diff') return null;
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
