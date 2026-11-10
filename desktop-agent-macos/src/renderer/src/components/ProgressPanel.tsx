import React, { useEffect, useState } from 'react';
import type { AgentEvent } from '../../../shared/contracts';
import { deriveProgress } from '../../../shared/progress';

/**
 * 「现在在做什么」——一条会走的进度条。
 *
 * 为什么需要它：一轮研究里，提问、汇总、执行是三种完全不同的等待，界面上原来
 * 只有会话状态（思考中/收集中/综合中），看不出卡在哪一段、等了多久。用户看到
 * 的就是「什么都没有」。
 *
 * 这里不新造状态：阶段从已有事件投影（见 shared/progress.ts），秒数由渲染层
 * 自己走，主进程不需要每秒发事件。
 */
export function ProgressPanel(props: {
  conversationStatus: string;
  taskStatus?: string | null;
  events: readonly AgentEvent[];
  startedAt: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  const view = deriveProgress({
    conversationStatus: props.conversationStatus,
    taskStatus: props.taskStatus ?? null,
    events: props.events,
    startedAt: props.startedAt
  });

  const live = view.current !== null;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  // 只有真的在跑才出现：任务结束后进度条留在页面上，会把「已完成」说成「进行中」。
  if (!live) return null;

  const waited = view.current?.at ? Math.max(0, Math.round((now - view.current.at) / 1000)) : 0;

  return (
    <section className="progress-strip" aria-label="执行进度" aria-live="polite">
      <ol className="progress-stages">
        {view.stages.map(stage => (
          <li key={stage.stage} className={`progress-stage is-${stage.state}`}>
            <span className="progress-dot" aria-hidden="true" />
            <span className="progress-name">{stage.label}</span>
          </li>
        ))}
      </ol>
      <div className="progress-now">
        <span className="progress-spinner" aria-hidden="true" />
        <b>{view.current?.label}</b>
        <span className="progress-detail">{view.current?.detail}</span>
        <span className="progress-elapsed">{formatWaited(waited)}</span>
      </div>
    </section>
  );
}

/** 秒 → 12s / 1:05，和通道条上的计时同一种写法。 */
function formatWaited(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)}:${String(rest).padStart(2, '0')}`;
}
