/**
 * Deprecated shim kept so older imports keep working.
 *
 * All DeepSeek DOM logic now lives in deepseek-adapter.ts (probe, send,
 * answer attribution). This file only re-exports the URL allowlist check.
 */
export { isAllowedDeepSeekUrl } from './deepseek-adapter';
