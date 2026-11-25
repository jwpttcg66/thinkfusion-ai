import React, { useEffect, useMemo, useState } from 'react';
import type { AgentEvent } from '../../../shared/contracts';
import type { ConversationMessage } from '../../../shared/conversation';
import { PROGRESS_STAGES, deriveProgress } from '../../../shared/progress';

export interface UserMsgTick {
  messageId: string;
  /** 短预览，只给 title/aria，不进胶囊上半。 */
  preview: string;
}

/**
 * 工作计划胶囊：贴在输入框正上方居中，和正文滚动区分开。
 *
 * - 上半：工作计划摘要（绝不用用户原话；完成态绝不用「正在理解…」）
 * - 下半：圆环 + 当前步骤 + n/m
 * - 左侧细短杠：只定位「用户以前发给这个任务的消息」
 */
export function TaskPlanCapsule(props: {
  goalText: string | null;
  conversationStatus: string;
  taskStatus?: string | null;
  events: readonly AgentEvent[];
  startedAt: number | null;
  messages?: readonly ConversationMessage[];
  userTicks: readonly UserMsgTick[];
  activeUserMsgId: string | null;
  onJumpUserMsg: (messageId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const view = deriveProgress({
    conversationStatus: props.conversationStatus,
    taskStatus: props.taskStatus ?? null,
    events: props.events,
    startedAt: props.startedAt
  });

  const terminal =
    ['answered', 'failed', 'cancelled'].includes(props.conversationStatus) ||
    ['completed', 'failed', 'cancelled'].includes(props.taskStatus ?? '');

  useEffect(() => {
    if (terminal) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [terminal]);

  const terminalLabel =
    props.conversationStatus === 'failed' || props.taskStatus === 'failed'
      ? '已失败'
      : props.conversationStatus === 'cancelled' || props.taskStatus === 'cancelled'
        ? '已取消'
        : '已完成';

  const liveCurrent = view.current ?? {
    stage: 'synthesis' as const,
    label: '处理中',
    state: 'active' as const,
    at: props.startedAt,
    detail: '正在收尾，稍后给出结论'
  };
  const current = terminal
    ? {
        ...liveCurrent,
        label: terminalLabel,
        state: 'done' as const,
        detail: liveCurrent.detail || '结论见上方正文'
      }
    : liveCurrent;

  const doneCount = view.stages.filter(stage => stage.state === 'done').length;
  const stageIndex = terminal
    ? Math.max(doneCount, PROGRESS_STAGES.length)
    : Math.max(1, PROGRESS_STAGES.indexOf(current.stage) + 1);
  const stageTotal = PROGRESS_STAGES.length;
  const fraction = Math.min(1, stageIndex / stageTotal);
  const waited = current.at ? Math.max(0, Math.round((now - current.at) / 1000)) : 0;

  const banned = props.userTicks.map(item => item.preview);
  const planText = resolveWorkPlanText({
    goalText: props.goalText,
    events: props.events,
    messages: props.messages ?? [],
    bannedUserTexts: banned,
    terminal,
    stageLabel: current.label,
    stageDetail: current.detail
  });

  const stepLine = [current.label, current.detail].filter(Boolean).join(' · ');

  return (
    <div className={`task-plan-capsule${terminal ? ' is-terminal' : ''}`} aria-label="工作计划">
      {props.userTicks.length > 0 && (
        <nav className="task-plan-ticks" aria-label="历史提问定位">
          {props.userTicks.map(tick => (
            <button
              key={tick.messageId}
              type="button"
              className={`task-plan-tick${props.activeUserMsgId === tick.messageId ? ' is-active' : ''}`}
              title={tick.preview}
              aria-label={`定位到：${tick.preview}`}
              onClick={() => props.onJumpUserMsg(tick.messageId)}
            />
          ))}
        </nav>
      )}

      <div className="task-plan-card">
        <div className="task-plan-goal">{planText}</div>
        <div className="task-plan-step" aria-live="polite">
          <span
            className={`task-plan-ring${terminal ? ' is-done' : ''}`}
            style={{ ['--task-plan-frac' as string]: String(fraction) }}
            aria-hidden="true"
          />
          <span className="task-plan-step-text">
            <b>{current.label}</b>
            <span className="task-plan-step-detail">
              {current.detail ?? ''}
              {!terminal && waited > 0 ? ` · ${formatWaited(waited)}` : ''}
            </span>
          </span>
          <span className="task-plan-nm" aria-label={`第 ${stageIndex} 步，共 ${stageTotal} 步`}>
            {stageIndex}/{stageTotal}
          </span>
        </div>
        <span className="sr-only">{stepLine}</span>
      </div>
    </div>
  );
}

/** 从 messages 投影短杠列表：只收用户发给任务的话。 */
export function userTicksFromMessages(messages: readonly ConversationMessage[]): UserMsgTick[] {
  return messages
    .filter(item => item.role === 'user')
    .map(item => ({
      messageId: item.messageId,
      preview: (item.text ?? '').trim().slice(0, 80) || item.messageId
    }));
}

/**
 * 上半只写「工作计划」：计划标题 / 判定后的执行方针 / 综合收口一句。
 * 完成态绝不能再显示「正在理解任务目标…」。
 */
function resolveWorkPlanText(input: {
  goalText: string | null;
  events: readonly AgentEvent[];
  messages: readonly ConversationMessage[];
  bannedUserTexts: readonly string[];
  terminal: boolean;
  stageLabel: string;
  stageDetail?: string;
}): string {
  const accept = (value?: string | null): string | null => {
    const text = value?.trim();
    if (!text) return null;
    if (isBannedUserText(text, input.bannedUserTexts)) return null;
    if (/^正在理解任务目标/.test(text)) return null;
    return text;
  };

  const fromGoal = accept(input.goalText);
  if (fromGoal) return fromGoal.startsWith('工作计划') ? fromGoal : `工作计划：${fromGoal}`;

  const fromPlan = accept(planTitleFromEvents(input.events, input.bannedUserTexts));
  if (fromPlan) return fromPlan.startsWith('工作计划') ? fromPlan : `工作计划：${fromPlan}`;

  const fromRouting = accept(routingPlanFromMessages(input.messages));
  if (fromRouting) return fromRouting;

  const fromSynthesis = accept(synthesisPlanFromMessages(input.messages));
  if (fromSynthesis) return fromSynthesis;

  if (input.terminal) {
    if (input.stageLabel === '已失败') return '工作计划：本轮未完成';
    if (input.stageLabel === '已取消') return '工作计划：本轮已取消';
    return '工作计划：本轮问答已收口';
  }

  // 进行中：用当前阶段写成「计划在做什么」，而不是空喊理解目标。
  const detail = (input.stageDetail ?? '').trim();
  if (input.stageLabel === '判定') {
    return detail ? `工作计划：先判定任务类型（${detail}）` : '工作计划：先判定任务类型与参与者';
  }
  if (input.stageLabel === '提问') {
    return detail ? `工作计划：并行提问各通道（${detail}）` : '工作计划：并行提问各通道并收集回答';
  }
  if (input.stageLabel === '汇总') {
    return detail ? `工作计划：${detail}` : '工作计划：汇总各家回答并给出结论';
  }
  if (input.stageLabel === '执行') {
    return detail ? `工作计划：执行中（${detail}）` : '工作计划：按计划执行';
  }
  if (input.stageLabel === '评审') {
    return detail ? `工作计划：评审中（${detail}）` : '工作计划：独立评审结果';
  }
  return detail ? `工作计划：${input.stageLabel} · ${detail}` : `工作计划：${input.stageLabel}`;
}

function routingPlanFromMessages(messages: readonly ConversationMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'channel' || message.channelId !== '__routing__') continue;
    const raw = `${message.reasoning ?? ''}\n${message.text ?? ''}`.trim();
    if (!raw) continue;
    // 常见落盘：判定：工程分析（…） / JSON kind
    const kindMatch = raw.match(/"kind"\s*:\s*"(analysis|implementation|engineering)"/i);
    const labelMatch = raw.match(/判定[：:]\s*([^\n（(]+)/);
    if (kindMatch?.[1]?.toLowerCase() === 'analysis' || /只读回答|纯算术|无需工程|工程分析/.test(raw)) {
      return '工作计划：按问答处理——汇总回答后给出结论，不改工程';
    }
    if (kindMatch?.[1] || /转入工程|implementation|engineering|读工程/.test(raw)) {
      return '工作计划：转入工程——生成计划并在目录内执行';
    }
    if (labelMatch?.[1]) {
      return `工作计划：${labelMatch[1].trim()}`;
    }
  }
  // 系统提示里也常有一句判定说明
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'system') continue;
    const text = (message.text ?? '').trim();
    if (/纯算术|只读回答无需工程|按问答/.test(text)) {
      return '工作计划：按问答处理——汇总回答后给出结论，不改工程';
    }
    if (/转入工程工作空间/.test(text) && /判定为工程/.test(text)) {
      return '工作计划：转入工程——生成计划并在目录内执行';
    }
  }
  return null;
}

function synthesisPlanFromMessages(messages: readonly ConversationMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'synthesis' || !message.synthesis) continue;
    const opinion = message.synthesis.finalOpinion?.trim();
    if (opinion) {
      const line = firstLine(opinion);
      if (line) return `工作计划收口：${line}`;
    }
    const rec = message.synthesis.recommendation?.trim();
    if (rec) {
      const line = firstLine(rec);
      if (line) return `工作计划收口：${line}`;
    }
  }
  return null;
}

function firstLine(text: string): string {
  return text
    .replace(/^【[^】]*】\s*/gm, '')
    .split(/\n+/)
    .map(line => line.trim())
    .find(Boolean)
    ?.slice(0, 120) ?? '';
}

function planTitleFromEvents(
  events: readonly AgentEvent[],
  bannedUserTexts: readonly string[] = []
): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== 'plan.ready') continue;
    const title = (event as { plan?: { title?: string; description?: string } }).plan?.title?.trim();
    if (title && !isBannedUserText(title, bannedUserTexts)) return title;
    const desc = (event as { plan?: { description?: string } }).plan?.description?.trim();
    if (desc) {
      const short = desc.slice(0, 120);
      if (!isBannedUserText(short, bannedUserTexts)) return short;
    }
  }
  return null;
}

function isBannedUserText(text: string, bannedUserTexts: readonly string[]): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  for (const user of bannedUserTexts) {
    const u = user.trim();
    if (!u) continue;
    if (u === trimmed) return true;
    if (u.startsWith(trimmed) || trimmed.startsWith(u.slice(0, Math.min(40, u.length)))) return true;
  }
  return false;
}

function formatWaited(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)}:${String(rest).padStart(2, '0')}`;
}

function escapeAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 供 App 计算工作计划文案：goal.text > workbench intent > null（组件内再补计划/判定/收口）。
 * 明确禁止把用户原话当成工作计划。
 */
export function resolvePlanGoalText(input: {
  goalText?: string | null;
  workbenchIntent?: string | null;
  userTexts?: readonly string[];
}): string | null {
  const banned = input.userTexts ?? [];
  const accept = (value?: string | null): string | null => {
    const text = value?.trim();
    if (!text) return null;
    if (isBannedUserText(text, banned)) return null;
    if (/^正在理解任务目标/.test(text)) return null;
    return text;
  };
  return accept(input.goalText) ?? accept(input.workbenchIntent) ?? null;
}

export function useUserMsgActiveId(
  messageIds: readonly string[],
  scrollRoot: HTMLElement | null
): string | null {
  const [activeId, setActiveId] = useState<string | null>(messageIds[messageIds.length - 1] ?? null);
  const key = useMemo(() => messageIds.join('|'), [messageIds]);

  useEffect(() => {
    if (!scrollRoot || messageIds.length === 0) {
      setActiveId(null);
      return;
    }
    const nodes = messageIds
      .map(id => scrollRoot.querySelector(`[data-user-msg="${escapeAttr(id)}"]`))
      .filter((node): node is Element => node !== null);
    if (nodes.length === 0) {
      setActiveId(messageIds[messageIds.length - 1] ?? null);
      return;
    }
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.userMsg;
          if (!id) continue;
          if (entry.isIntersecting) visible.set(id, entry.intersectionRatio);
          else visible.delete(id);
        }
        if (visible.size === 0) return;
        let best: string | null = null;
        let bestRatio = -1;
        for (const [id, ratio] of visible) {
          if (ratio >= bestRatio) {
            best = id;
            bestRatio = ratio;
          }
        }
        if (best) setActiveId(best);
      },
      { root: scrollRoot, threshold: [0.15, 0.4, 0.7] }
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [scrollRoot, key, messageIds]);

  return activeId;
}
