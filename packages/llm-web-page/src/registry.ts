/**
 * Where the shell hands a live page to the plugin.
 *
 * Cordis composition cannot pass a live Electron view through YAML config, and
 * M1 does not yet own a service definition, so the two sides meet here: the
 * shell calls {@link registerPage} once the view exists, and the adapter looks
 * the page up per request. Per-request lookup — rather than capturing it in
 * `apply()` — is deliberate: the plugin may be mounted before the view is
 * created, and a captured `undefined` would fail forever.
 *
 * @module @desktop-agent/llm-web-page/registry
 */
import type { WebPage } from './page.js'

const pages = new Map<string, WebPage>()

/** Name the Electron shell registers its view under by default. */
export const DEFAULT_PAGE_NAME = 'web-page'

/**
 * Publish a live page under `name`, replacing any previous one.
 * @param name - the name the plugin's `pageName` config selects.
 * @param page - the driveable view.
 */
export function registerPage(name: string, page: WebPage): void {
  pages.set(name, page)
}

/**
 * Retire a page. Requests that arrive afterwards fail with `NO_PAGE` instead
 * of driving a destroyed view.
 * @param name - the name passed to {@link registerPage}.
 */
export function unregisterPage(name: string): void {
  pages.delete(name)
}

/**
 * Look up a published page.
 * @param name - the name passed to {@link registerPage}.
 * @returns the page, or `undefined` when none is registered.
 */
export function resolvePage(name: string): WebPage | undefined {
  return pages.get(name)
}
