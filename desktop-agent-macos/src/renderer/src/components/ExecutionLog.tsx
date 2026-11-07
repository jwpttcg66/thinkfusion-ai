import React, { useEffect, useRef } from 'react';
import type { AgentEvent } from '../../../shared/contracts';

interface Line {
  key: string;
  text: string;
  tone: 'info' | 'ok' | 'warn' | 'error' | 'muted';
}

export function formatEvent(event: AgentEvent, index: number): Line | null {
  const key = `${event.at}-${index}`;
  switch (event.type) {
    case 'round.started':
      return { key, text: `第 ${event.roundNumber} 轮 · ${roundType(event.inputType)} 已发送`, tone: 'muted' };
    case 'round.answer':
      return { key, text: `收到回答（${event.text.length} 字符）`, tone: 'info' };
    case 'plan.ready':
      return { key, text: `计划已就绪：${event.plan.title}（${event.plan.steps.length} 步），等待确认`, tone: 'info' };
    case 'plan.invalid':
      return { key, text: `计划被拒绝：${event.error}`, tone: 'error' };
    case 'clarification.required':
      // "模型", not a site name: which page is driving the plan is a setting
      // (`planningSource`), and an event carries no site id to look a name up
      // by. A hardcoded name here is simply wrong once the setting changes.
      return { key, text: `模型需要澄清：${event.questions.join(' / ')}`, tone: 'warn' };
    case 'step.started':
      return { key, text: `执行 ${event.tool}`, tone: 'muted' };
    case 'step.completed':
      return { key, text: `完成 ${event.tool}`, tone: 'ok' };
    case 'step.failed':
      return { key, text: `失败 ${event.tool}：${event.error}`, tone: 'error' };
    case 'report.ready':
      return {
        key,
        text: `执行报告：${event.report.status}（成功 ${event.report.results.filter(r => r.status === 'completed').length} 步）`,
        tone: event.report.status === 'completed' ? 'ok' : 'warn'
      };
    case 'review.ready':
      return {
        key,
        text: `独立评审（${event.backend === 'rules' ? '规则版' : event.reviewer}）：${event.needsFix ? '需修复' : '通过'} · ${event.verdict.slice(0, 120)}`,
        tone: event.needsFix ? 'warn' : 'ok'
      };
    case 'plan.debated':
      // 「没辩」也要出现在日志里：审批的人需要知道这份计划有没有被评审过。
      return event.debate.status === 'skipped'
        ? { key, text: `方案评审未进行：${event.debate.skippedReason ?? '没有可用成员'}`, tone: 'muted' }
        : {
            key,
            text: `方案评审已辩完（${event.debate.participants.join('、')}）：${event.debate.topics.length} 个辩题`,
            tone: 'ok'
          };
    case 'report.sent':
      return { key, text: '执行报告已回传给模型', tone: 'muted' };
    case 'task.completed':
      return { key, text: `任务完成${event.summary ? `：${event.summary}` : ''}`, tone: 'ok' };
    case 'task.failed':
      return { key, text: `任务失败：${event.error}`, tone: 'error' };
    case 'task.cancelled':
      return { key, text: '任务已取消', tone: 'warn' };
    case 'log':
      return { key, text: event.message, tone: event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'muted' };
    case 'task.updated':
      return null;
    default:
      return null;
  }
}

function roundType(inputType: string) {
  if (inputType === 'user_prompt') return '任务';
  if (inputType === 'execution_report') return '执行报告';
  if (inputType === 'plan_repair') return '计划修正';
  return '澄清回答';
}

export function ExecutionLog(props: { events: AgentEvent[] }) {
  // Oldest first: a transcript reads downwards, and the line you want is the
  // one that just happened — at the bottom, where your eye already is.
  const lines = props.events.map((event, index) => formatEvent(event, index)).filter((line): line is Line => line !== null);

  // Follow the tail. Without this the newest line lands below the fold of a
  // fixed-height box, which is the same problem as reversing the order.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [lines.length]);

  return (
    <section className="card log">
      <div className="row">
        <h2>执行日志</h2>
        <span className="muted">{lines.length} 条</span>
      </div>
      {lines.length === 0 ? (
        <p className="muted">暂无事件。</p>
      ) : (
        <div className="log-lines" ref={listRef}>
          {lines.map(line => (
            <div key={line.key} className={`log-line t-${line.tone}`}>
              {line.text}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
