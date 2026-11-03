import type { SelectorProfile } from '../../../shared/selectors';
import { DEEPSEEK_PROFILE, DEEPSEEK_SELECTORS } from './deepseek';
import { CHATGPT_PROFILE } from './chatgpt';
import type { ProviderProfile } from './types';

/**
 * The built-in sites, by id.
 *
 * The list is the only place that knows which providers ship with the app. A
 * source whose id is not here is a page the user added themselves: it gets the
 * generic profile and the structural fallbacks in the probe, which is exactly
 * what it got before — the difference is that it is now a named default instead
 * of "whatever DeepSeek's selectors happened to be".
 */
export const PROVIDERS: Readonly<Record<string, ProviderProfile>> = {
  deepseek: DEEPSEEK_PROFILE,
  chatgpt: CHATGPT_PROFILE
};

export function providerFor(sourceId: string): ProviderProfile | null {
  return PROVIDERS[sourceId] ?? null;
}

/**
 * Selectors for a source, built-in or not.
 *
 * `DEEPSEEK_SELECTORS` is the fallback on purpose: it is the profile the probe's
 * structural heuristics were tuned against, so an unknown page does better with
 * it than with an empty object. The probe still prefers structure when a
 * selector misses, which is what makes that safe.
 */
export function profileFor(sourceId: string): SelectorProfile {
  return providerFor(sourceId)?.selectors ?? DEEPSEEK_SELECTORS;
}

/** Hosts a source is allowed to be, when the source itself does not say. */
export function hostsFor(sourceId: string): ReadonlySet<string> {
  return providerFor(sourceId)?.hosts ?? new Set<string>();
}
