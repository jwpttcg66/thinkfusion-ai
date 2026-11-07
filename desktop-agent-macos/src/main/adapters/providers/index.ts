import type { SelectorProfile } from '../../../shared/selectors';
import { DEEPSEEK_PROFILE, DEEPSEEK_SELECTORS } from './deepseek';
import { CHATGPT_PROFILE } from './chatgpt';
import { GEMINI_PROFILE } from './gemini';
import { KIMI_PROFILE } from './kimi';
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
  chatgpt: CHATGPT_PROFILE,
  kimi: KIMI_PROFILE,
  gemini: GEMINI_PROFILE
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

/**
 * Subtrees to cut out of an assistant bubble before its text becomes an answer.
 *
 * Empty for a site that has no answer-shaped noise of its own. This is not part
 * of `SelectorProfile` because it is not a role the page has to expose: a
 * profile with no reasoning is complete, not incomplete.
 */
export function reasoningFor(sourceId: string): readonly string[] {
  return providerFor(sourceId)?.reasoning ?? [];
}

/**
 * Selectors that mean "this page is showing a sign-in offer".
 *
 * Empty for a site whose signed-out state already has a password field, which
 * is most of them. Passing an empty list is not a missing answer — it means the
 * password-field check is the whole story for this site.
 */
export function signedOutFor(sourceId: string): readonly string[] {
  return providerFor(sourceId)?.signedOut ?? [];
}

/**
 * The words a site puts on its sign-in control, for sites whose control carries
 * no hook to select it by.
 *
 * Empty for every site that exposes a marker or a password field. Gemini has
 * neither on its guest page: the only visible affordance is a `button` whose
 * class list is Material's, so the label is the only thing to match on.
 */
export function signedOutTextFor(sourceId: string): readonly string[] {
  return providerFor(sourceId)?.signedOutText ?? [];
}

/**
 * Paths that mean the site has moved the page into its sign-in flow.
 *
 * Empty for every site that keeps one address while signed out. Gemini is the
 * one that does not: `/app` either renders a guest-usable page or redirects to
 * `/signin?continue=…`, and the redirect has no composer — which the status
 * check would otherwise report as "页面结构可能已变化".
 */
export function signedOutPathsFor(sourceId: string): readonly string[] {
  return providerFor(sourceId)?.signedOutPaths ?? [];
}

/**
 * The site's own wording for 「this thread has run out of context」.
 *
 * Empty for every site whose banner has not been seen, which is the honest
 * answer: an empty list means "the driver cannot recognise this state here",
 * not "this never happens". Recognising it is what turns a thread that can no
 * longer answer into a fresh thread instead of a question that waits out its
 * whole timeout.
 */
export function contextLimitFor(sourceId: string): readonly string[] {
  return providerFor(sourceId)?.contextLimit ?? [];
}

/**
 * Whether a signed-out page is still worth asking.
 *
 * Off unless the site says so, because for most of them "signed out" means the
 * composer is gone or the answer never comes. Gemini measured otherwise.
 */
export function guestUsableFor(sourceId: string): boolean {
  return providerFor(sourceId)?.guestUsable === true;
}

/**
 * 关闭站点纯提示弹层的按钮文案。
 *
 * 空列表是完整答案：这个站点没有见过会挡住发送的提示层，驱动不该去猜按钮。
 */
export function dismissTextFor(sourceId: string): readonly string[] {
  return providerFor(sourceId)?.dismissText ?? [];
}

/** 登录着也用不了的路径（付费墙 / 排队拦截页）。空列表是完整答案。 */
export function challengeTextFor(sourceId: string): readonly string[] {
  return providerFor(sourceId)?.challengeText ?? [];
}

export function blockedPathsFor(sourceId: string): readonly string[] {
  return providerFor(sourceId)?.blockedPaths ?? [];
}

/** Hosts a source is allowed to be, when the source itself does not say. */
export function hostsFor(sourceId: string): ReadonlySet<string> {
  return providerFor(sourceId)?.hosts ?? new Set<string>();
}
