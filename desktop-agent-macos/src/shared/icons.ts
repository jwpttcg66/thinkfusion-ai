/**
 * The two page-pane glyphs, as raw path data.
 *
 * They live in shared/ because two renderers draw them: the app window's page
 * bar, and the toolbar of a detached window — which is a `data:` URL assembled
 * in the main process and has no access to React components. When the paths were
 * written twice, the detached window kept a text button while the main window
 * had an icon, and the two windows disagreed about what the same action looks
 * like.
 *
 * Both are drawn for a 16x16 viewBox at 1.3 stroke, which stays legible at 13px
 * on a retina screen — the size the bar actually uses.
 */

/** Four corner brackets opening outward: "give this page more room". */
export const ICON_EXPAND_PATHS = ['M6 2.5H2.5V6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10'];

/**
 * An arrow returning to a wall: "put it back where it came from".
 *
 * Deliberately not the inverse of the expand glyph. Enter/exit-fullscreen icon
 * pairs read as one toggle, and these two actions are not a toggle: one moves a
 * live page into another window, the other moves it back.
 */
export const ICON_DOCK_BACK_PATHS = ['M2.5 3v10', 'M13 8H6.2M9 5.2 6.2 8 9 10.8'];

/**
 * A chevron pointing at the right edge: "fold the page away".
 *
 * A chevron rather than a second bracket pair, because this is a *third* action
 * on the same bar and must not read as another state of 放大. The direction is
 * the point: the pane lives on the right, so folding moves it right.
 */
export const ICON_FOLD_PATHS = ['M6 3.2 10.8 8 6 12.8'];

/** The same chevron turned around: "bring the folded pane back out". */
export const ICON_UNFOLD_PATHS = ['M10 3.2 5.2 8 10 12.8'];

/** One `<svg>` for a path list, so both surfaces draw byte-identical glyphs. */
export function iconSvg(paths: readonly string[], size = 13): string {
  const body = paths
    .map(path => `<path d="${path}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('');
  return `<svg viewBox="0 0 16 16" width="${String(size)}" height="${String(size)}" aria-hidden="true" focusable="false">${body}</svg>`;
}
