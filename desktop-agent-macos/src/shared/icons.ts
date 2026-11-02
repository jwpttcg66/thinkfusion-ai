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

/**
 * A ring, a hub, and eight teeth: 设置.
 *
 * The ring is what makes it a gear. A hub with radial ticks — which is what the
 * first attempt drew — reads as a sun at 13px, and the sun is already taken by
 * "brightness". Teeth on the outside of a circle read as machinery at any size.
 */
export const ICON_GEAR_PATHS = [
  'M8 3.4a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2',
  'M8 6.1a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8',
  'M8 3.4V1.6M8 12.6v1.8M3.4 8H1.6M12.6 8h1.8M4.75 4.75 3.47 3.47M11.25 11.25l1.28 1.28M11.25 4.75l1.28-1.28M4.75 11.25l-1.28 1.28'
];

/**
 * A dial with a needle: 页面诊断.
 *
 * A full circle rather than an open arc. At 13px the arc's gap closes up and
 * the whole thing reads as a hook; the closed circle with a needle survives the
 * size, and it is the shape the app this was modelled on uses.
 */
export const ICON_GAUGE_PATHS = ['M8 2.6a5.4 5.4 0 1 0 0 10.8 5.4 5.4 0 0 0 0-10.8', 'M8 8l3.4-3.8'];

/** One `<svg>` for a path list, so both surfaces draw byte-identical glyphs. */
export function iconSvg(paths: readonly string[], size = 13): string {
  const body = paths
    .map(path => `<path d="${path}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('');
  return `<svg viewBox="0 0 16 16" width="${String(size)}" height="${String(size)}" aria-hidden="true" focusable="false">${body}</svg>`;
}
