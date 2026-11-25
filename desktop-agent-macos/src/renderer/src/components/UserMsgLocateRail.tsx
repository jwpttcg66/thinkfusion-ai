import React, { useEffect, useState } from 'react';
import type { UserMsgTick } from './TaskPlanCapsule';

type MsgMark = { id: string; preview: string; topPct: number };

/**
 * 正文侧边定位：一条会话只产生一根线。
 * 默认等长、水平居中；靠近当前视口时才轻微变长。
 */
export function UserMsgLocateRail(props: {
  ticks: readonly UserMsgTick[];
  activeUserMsgId: string | null;
  scrollEl: HTMLElement | null;
  onJump: (messageId: string) => void;
}) {
  const [marks, setMarks] = useState<MsgMark[]>([]);
  const [viewportPct, setViewportPct] = useState<number | null>(null);

  useEffect(() => {
    const scroll = props.scrollEl;
    if (!scroll || props.ticks.length === 0) {
      setMarks([]);
      setViewportPct(null);
      return;
    }

    function measure() {
      if (!scroll) return;
      const scrollRect = scroll.getBoundingClientRect();
      const contentHeight = Math.max(scroll.scrollHeight, 1);
      const mid = scroll.scrollTop + scroll.clientHeight * 0.4;
      setViewportPct(Math.min(97, Math.max(3, (mid / contentHeight) * 100)));

      const next = props.ticks.map((tick, index) => {
        const node = scroll.querySelector(
          `[data-user-msg="${escapeAttr(tick.messageId)}"]`
        ) as HTMLElement | null;
        let topPct: number;
        if (node) {
          const topInContent =
            node.getBoundingClientRect().top - scrollRect.top + scroll.scrollTop;
          topPct = Math.min(97, Math.max(3, (topInContent / contentHeight) * 100));
        } else {
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
      {marks.map(mark => {
        const dist = viewportPct === null ? 99 : Math.abs(viewportPct - mark.topPct);
        const near =
          dist <= 0.9 ? ' is-focus' : dist <= 2.2 ? ' is-closer' : dist <= 3.8 ? ' is-near' : '';
        const active = props.activeUserMsgId === mark.id ? ' is-active' : '';
        return (
          <button
            key={mark.id}
            type="button"
            className={`user-msg-locate-hit${near}${active}`}
            style={{ top: `${mark.topPct}%` }}
            title={mark.preview}
            aria-label={`定位到：${mark.preview}`}
            onClick={() => props.onJump(mark.id)}
          >
            <span className="user-msg-locate-hit-bar" aria-hidden="true" />
          </button>
        );
      })}
    </nav>
  );
}

function escapeAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
