import React, { useEffect, useState } from 'react';
import type { UserMsgTick } from './TaskPlanCapsule';

/**
 * 正文侧边定位：贴在整段对话滚动区左侧，按历史用户消息在正文中的相对位置排布短杠。
 * 不挂在输入框上方的工作计划胶囊上。
 */
export function UserMsgLocateRail(props: {
  ticks: readonly UserMsgTick[];
  activeUserMsgId: string | null;
  scrollEl: HTMLElement | null;
  onJump: (messageId: string) => void;
}) {
  const [marks, setMarks] = useState<Array<{ id: string; preview: string; topPct: number }>>([]);

  useEffect(() => {
    const scroll = props.scrollEl;
    if (!scroll || props.ticks.length === 0) {
      setMarks([]);
      return;
    }

    function measure() {
      if (!scroll) return;
      const scrollRect = scroll.getBoundingClientRect();
      const contentHeight = Math.max(scroll.scrollHeight, 1);
      const next = props.ticks.map((tick, index) => {
        const node = scroll.querySelector(
          `[data-user-msg="${escapeAttr(tick.messageId)}"]`
        ) as HTMLElement | null;
        let topPct: number;
        if (node) {
          const topInContent =
            node.getBoundingClientRect().top - scrollRect.top + scroll.scrollTop;
          topPct = Math.min(96, Math.max(2, (topInContent / contentHeight) * 100));
        } else {
          // 锚点尚未挂上时按序均分，避免空轨。
          topPct = ((index + 0.5) / props.ticks.length) * 100;
        }
        return { id: tick.messageId, preview: tick.preview, topPct };
      });
      setMarks(next);
    }

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroll);
    const inner = scroll.querySelector('.inner');
    if (inner) ro.observe(inner);
    scroll.addEventListener('scroll', measure, { passive: true });
    const mo = new MutationObserver(measure);
    mo.observe(scroll, { subtree: true, childList: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      scroll.removeEventListener('scroll', measure);
    };
  }, [props.scrollEl, props.ticks]);

  if (marks.length === 0) return null;

  return (
    <nav className="user-msg-locate-rail" aria-label="正文历史提问定位">
      {marks.map(mark => (
        <button
          key={mark.id}
          type="button"
          className={`user-msg-locate-tick${props.activeUserMsgId === mark.id ? ' is-active' : ''}`}
          style={{ top: `${mark.topPct}%` }}
          title={mark.preview}
          aria-label={`定位到：${mark.preview}`}
          onClick={() => props.onJump(mark.id)}
        />
      ))}
    </nav>
  );
}

function escapeAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
