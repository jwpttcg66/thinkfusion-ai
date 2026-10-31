/**
 * Failure codes this adapter reports.
 *
 * Every one of these becomes a terminal `finish` chunk whose `failure.code`
 * consumers route on, so the strings are a contract: they are stable, and they
 * never carry page text (which can contain user content or a stray key).
 *
 * @module @desktop-agent/llm-deepseek-web/failures
 */
export const FAILURE = {
  /** No page has been registered under the configured name. */
  NO_PAGE: 'NO_PAGE',
  /** The page is not signed in, or the composer is missing. */
  NOT_READY: 'NOT_READY',
  /** Submitting the prompt threw. */
  SEND_FAILED: 'SEND_FAILED',
  /** Reading the page threw — a destroyed view, or a navigation mid-request. */
  PAGE_ERROR: 'PAGE_ERROR',
  /** The page settled but never produced a new message. */
  NO_ANSWER: 'NO_ANSWER',
  /** The answer did not contain a parsable reply object. */
  PROTOCOL: 'PROTOCOL',
  /** The caller aborted, or the wait exceeded its budget. */
  TIMEOUT: 'TIMEOUT',
} as const

/** One member of {@link FAILURE}. */
export type FailureCode = (typeof FAILURE)[keyof typeof FAILURE]
