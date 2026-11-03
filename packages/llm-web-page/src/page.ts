/**
 * The page surface this adapter drives.
 *
 * Everything the adapter knows about the web page is in here: it never sees a
 * DOM, a selector, or an Electron object. The Electron shell implements this
 * interface over a `WebContentsView`; the tests implement it over a plain
 * object. That split is what makes the ownership logic testable without a
 * logged-in browser.
 *
 * @module @desktop-agent/llm-web-page/page
 */

/** One observation of the page's conversation state. */
export interface PageProbe {
  /**
   * How many assistant messages are currently rendered.
   *
   * The transport requires this to grow after sending: a re-rendered old
   * answer, a regenerated one, or a page that never accepted the prompt all
   * look like "no new message", and silently returning the previous answer is
   * the worst failure this adapter could have.
   */
  readonly messageCount: number
  /** Full text of the most recently rendered assistant message. */
  readonly lastText: string
  /** Whether the page is still streaming a response. */
  readonly generating: boolean
  /** Whether the composer exists and will accept input (i.e. the user is signed in). */
  readonly ready: boolean
}

/**
 * A driveable chat page.
 *
 * Implementations must be safe to call repeatedly while the page is busy;
 * {@link PageProbe} is a read and must not disturb generation.
 */
export interface WebPage {
  /** Read the current conversation state. */
  probe(): Promise<PageProbe>
  /** Put `prompt` in the composer and submit it. Resolves once the click has been dispatched. */
  send(prompt: string): Promise<void>
  /** Press the stop-generation control, if the page is generating. */
  stop(): Promise<void>
}
