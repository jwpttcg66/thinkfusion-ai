import type { SelectorProfile } from '../../../shared/selectors';

/**
 * What one AI site needs in order to be driven.
 *
 * This is the whole per-site surface: a name, the markup guesses, and the exact
 * hosts it is allowed to be. Everything else — the probe, the send path, waiting
 * for an answer, stripping our own echoed prompt — is shared, which is why
 * adding a site is a file in this directory rather than a fork of the driver.
 *
 * What it is deliberately *not*: an agent. A profile has no identity in a
 * research round, no session, and no opinion; the agent that speaks for this
 * site is a `ProviderSubAgent` built on top of it. Keeping the two apart is what
 * lets a site be swapped without changing who said what.
 */
export interface ProviderProfile {
  /** Stable id, shared with the source store and the message records. */
  id: string;
  label: string;
  /** Built-in selectors. A learned profile is merged on top of these at call time. */
  selectors: SelectorProfile;
  /** Exact hosts, never suffixes: `chat.deepseek.com.evil.test` must not match. */
  hosts: ReadonlySet<string>;
}
