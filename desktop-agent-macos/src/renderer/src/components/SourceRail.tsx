import React from 'react';
import type { PageSource } from '../../../shared/sources';
import { RAIL_WIDTH } from '../../../shared/layout';
import { ICON_PANEL_FILL_PATHS, ICON_PANEL_PATHS } from '../../../shared/icons';
import { Glyph } from './Glyph';

/**
 * The strip on the window's right edge that decides which embedded page is on
 * screen.
 *
 * It sits in the last 46px of the window because the page is a native view
 * painted above the DOM: the only way to keep buttons clickable next to it is
 * to leave that much room out of the view's bounds, which `computePageBounds`
 * does with the same constant.
 *
 * One page at a time is deliberate. Two chat pages side by side would halve the
 * width each one gets, and a chat UI squeezed to half a window is worse than
 * one you can switch to in a click.
 *
 * 收起 lives here, at the top, rather than at the end of the page bar. Two
 * reasons, and the second is the one that decided it:
 *
 * - The bar is inside the pane, so folding removed the bar and the button with
 *   it — the only way back was a 24px chevron in the 30px stub, which is a small
 *   target for the action that undoes the thing you just did.
 * - The pane is a *window-level* thing, and this column is the window's right
 *   edge. A control that folds a pane belongs where the pane ends, not in a
 *   toolbar that the fold itself deletes.
 */
export function SourceRail(props: {
  sources: PageSource[];
  activeId: string;
  loading: boolean;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onToggleCollapse: () => void;
}) {
  return (
    <nav className="source-rail" style={{ width: RAIL_WIDTH }} aria-label="内嵌网页">
      {/* The same drawing in both states, on purpose: this is one switch, and a
          switch that redraws itself is a second thing to read. What changes is
          the label and what the window looks like behind it. Bigger than the
          page buttons below, because it is not one of them. */}
      <button
        type="button"
        className="rail-toggle"
        data-action="collapse"
        aria-pressed={props.collapsed}
        aria-label={props.collapsed ? '展开网页' : '收起网页'}
        title={props.collapsed ? '展开：把网页放回来' : '收起：把网页折起来，让应用占满窗口'}
        onClick={props.onToggleCollapse}
      >
        <Glyph paths={ICON_PANEL_PATHS} filled={ICON_PANEL_FILL_PATHS} size={20} />
      </button>
      {/* A hairline, not a gap: the toggle acts on the window, the buttons below
          switch pages, and without the line the first page button reads as part
          of the same control. */}
      <span className="rail-sep" aria-hidden="true" />
      {props.sources.map(source => {
        const active = source.id === props.activeId;
        return (
          <button
            key={source.id}
            type="button"
            className={`rail-btn ${active ? 'active' : ''}`}
            title={
              source.planning
                ? `${source.label}（Agent 通过这个页面规划）`
                : `${source.label}（仅供查看，Agent 不通过它规划）`
            }
            aria-pressed={active}
            onClick={() => props.onSelect(source.id)}
          >
            <span className="rail-glyph">{source.glyph}</span>
            {active && props.loading && <span className="rail-spinner" />}
            {source.planning && <span className="rail-dot" />}
          </button>
        );
      })}
    </nav>
  );
}
