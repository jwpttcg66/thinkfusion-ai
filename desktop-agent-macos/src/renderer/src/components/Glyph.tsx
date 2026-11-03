import React from 'react';

/**
 * One icon, drawn from path data in `shared/icons.ts`.
 *
 * It lives in its own file because three surfaces now draw the same glyphs —
 * the page bar, the sidebar's account row, and the settings panel — and a
 * component defined inside `App.tsx` cannot be imported by any of them without
 * a circular import.
 *
 * 13px is the size the page bar uses, and the sidebar buttons are the same
 * weight, so one size covers both. Colour comes from `currentColor`, which is
 * what lets hover states work without a second copy of the drawing.
 */
export function Glyph({
  paths,
  size = 13,
  filled = []
}: {
  paths: readonly string[];
  size?: number;
  /** Paths drawn solid rather than stroked — see `iconSvg`. */
  filled?: readonly string[];
}) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      {paths.map(path => (
        <path
          key={path}
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {filled.map(path => (
        <path key={path} d={path} fill="currentColor" stroke="none" />
      ))}
    </svg>
  );
}
