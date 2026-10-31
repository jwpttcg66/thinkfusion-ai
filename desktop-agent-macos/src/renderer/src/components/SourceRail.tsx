import React from 'react';
import type { PageSource } from '../../../shared/sources';
import { RAIL_WIDTH } from '../../../shared/layout';

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
 */
export function SourceRail(props: {
  sources: PageSource[];
  activeId: string;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="source-rail" style={{ width: RAIL_WIDTH }} aria-label="内嵌网页">
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
