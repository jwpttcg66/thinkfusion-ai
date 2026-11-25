import React, { useEffect, useState } from 'react'
import type { UserMsgTick } from './TaskPlanCapsule'

type MsgMark = { id: string; preview: string; topPct: number }

const RAIL_WIDTH = 32

/**
 * 正文侧边定位：
 * - 短杠放在主栏最左侧
 * - 一条会话一根等长短杠，水平居中在左侧轨内
 * - 竖直对准该条用户消息中部
 * - 热区加宽，方便点击
 * - 无连续粗黑竖线
 */
export function UserMsgLocateRail(props: {
  ticks: readonly UserMsgTick[]
  activeUserMsgId: string | null
  scrollEl: HTMLElement | null
  onJump: (messageId: string) => void
}) {
  const [marks, setMarks] = useState<MsgMark[]>([])
  const [viewportPct, setViewportPct] = useState<number | null>(null)
  const [railTop, setRailTop] = useState(0)
  const [railHeight, setRailHeight] = useState(0)

  useEffect(() => {
    const scroll = props.scrollEl
    if (!scroll || props.ticks.length === 0) {
      setMarks([])
      setViewportPct(null)
      return
    }

    function measure() {
      if (!scroll) return
      const wrap = scroll.parentElement
      if (!wrap) return
      const wrapRect = wrap.getBoundingClientRect()
      const scrollRect = scroll.getBoundingClientRect()
      const contentHeight = Math.max(scroll.scrollHeight, 1)

      // 固定在主栏最左侧
      setRailTop(Math.round(scrollRect.top - wrapRect.top))
      setRailHeight(Math.round(scrollRect.height))

      const mid = scroll.scrollTop + scroll.clientHeight * 0.4
      setViewportPct(Math.min(97, Math.max(3, (mid / contentHeight) * 100)))

      const next = props.ticks.map((tick, index) => {
        const node = scroll.querySelector(
          `[data-user-msg="${escapeAttr(tick.messageId)}"]`
        ) as HTMLElement | null
        let topPct: number
        if (node) {
          const topInContent =
            node.getBoundingClientRect().top -
            scrollRect.top +
            scroll.scrollTop +
            node.getBoundingClientRect().height / 2
          topPct = Math.min(97, Math.max(3, (topInContent / contentHeight) * 100))
        } else {
          topPct = ((index + 0.5) / props.ticks.length) * 100
        }
        return { id: tick.messageId, preview: tick.preview, topPct }
      })
      setMarks(next)
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(scroll)
    const wrap = scroll.parentElement
    if (wrap) ro.observe(wrap)
    const inner = scroll.querySelector('.inner')
    if (inner) ro.observe(inner)
    scroll.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    const mo = new MutationObserver(measure)
    mo.observe(scroll, { subtree: true, childList: true, characterData: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
      scroll.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [props.scrollEl, props.ticks])

  if (marks.length === 0) return null

  return (
    <nav
      className="user-msg-locate-rail"
      aria-label="正文历史提问定位"
      style={{
        left: 0,
        top: `${railTop}px`,
        height: `${Math.max(railHeight, 1)}px`,
        width: `${RAIL_WIDTH}px`,
      }}
    >
      {marks.map((mark) => {
        const dist = viewportPct === null ? 99 : Math.abs(viewportPct - mark.topPct)
        const near =
          dist <= 0.9 ? ' is-focus' : dist <= 2.2 ? ' is-closer' : dist <= 3.8 ? ' is-near' : ''
        const active = props.activeUserMsgId === mark.id ? ' is-active' : ''
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
        )
      })}
    </nav>
  )
}

function escapeAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
