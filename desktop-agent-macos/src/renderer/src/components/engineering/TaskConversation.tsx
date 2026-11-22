import React, { useEffect, useMemo, useState } from 'react';
import type { AgentEvent, AgentTask } from '../../../../shared/contracts';
import type { StepCard } from '../../../../shared/execution-timeline';
import { duration, statusText, target, toolLabel } from '../../../../shared/execution-timeline';
import {
  buildTaskConversation,
  protocolSummary,
  type ConversationEntry,
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
 * 只画真的发生过的东西：没有结论文本就不要编一句，协议 JSON 原文照留但明确
 * 标注「机器读的协议对象」。
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

function MemberMessage(props: { entry: Extract<ConversationEntry, { kind: 'member' }>; now: number }) {
  const { entry } = props;
  const [openRaw, setOpenRaw] = useState(false);
  const live = entry.status === 'streaming';
  const elapsed = entry.durationMs ?? (live && entry.at ? props.now - entry.at : null);
  const summary = entry.protocol ? protocolSummary(entry.text) : null;
  const protocolLabel =
    entry.protocol === 'plan'
      ? '计划'
      : entry.protocol === 'execution_report'
        ? '执行报告'
        : entry.protocol === 'clarification_required'
          ? '澄清请求'
          : entry.protocol === 'task_complete'
            ? '完成报告'
            : '协议对象';

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
            {` · ${entry.text.length} 字符`}
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
            {/* 协议对象不是给我的答复：先给一句人话，原文折叠在下面。 */}
            <p className="chat-protocol-note">
              这一路返回的是{protocolLabel}（机器读的 JSON），不是最终答复；
              执行结果与结论见本页下方。
            </p>
            {summary && <p className="chat-protocol-summary">{summary}</p>}
            <button className="btn ghost" type="button" onClick={() => setOpenRaw(value => !value)}>
              {openRaw ? '收起原文' : '看协议原文'}
            </button>
            {openRaw && <pre className="chat-member-text">{entry.text}</pre>}
          </>
        ) : (
          <pre className="chat-member-text">{entry.text || (live ? '等待模型输出…' : '这次没有输出正文。')}</pre>
        )}
        {entry.reasoningSupported && (
          <details className="chat-reasoning">
            <summary>思考（{entry.reasoning.length} 字符）</summary>
            {entry.reasoning ? <pre>{entry.reasoning}</pre> : <p className="muted">这个来源本次没有返回思考内容。</p>}
          </details>
        )}
      </div>
    </article>
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
          : <p className="muted">这一步没有可展示的输出。</p>}
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
        if (entry.kind === 'conclusion') {
          return (
            <section key={entry.key} className={`chat-conclusion ${ToneClass(entry.tone)}`}>
              <div className="chat-conclusion-head">
                <b>结论</b>
                <span className="muted">{timeText(entry.at)}</span>
              </div>
              <p>{entry.text}</p>
              {entry.facts.length > 0 && (
                <ul>
                  {entry.facts.map(fact => <li key={fact}>{fact}</li>)}
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
