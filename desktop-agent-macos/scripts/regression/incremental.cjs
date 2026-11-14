/**
 * 增量回归的 fingerprint 与复用判定。
 *
 * 这里故意做成纯函数，便于单测：
 * - 旧结果没有 fingerprint 时绝对不能复用；
 * - 不能拿当前配置反算一个“旧指纹”；
 * - 只有 fingerprint 完全一致、执行 COMPLETED、V1 通过才复用。
 */
const crypto = require('node:crypto');

function fingerprintFor({ runnerVersion, promptVersion, item, standardItem, models, completeness }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    runnerVersion,
    promptVersion,
    question: item.question,
    strategy: item.strategy,
    anchor: item.anchor ?? null,
    standard: standardItem ?? null,
    models,
    completeness: completeness === true
  })).digest('hex');
}

function canReuseResult(oldResult, currentFingerprint) {
  return Boolean(
    oldResult &&
    typeof oldResult.fingerprint === 'string' &&
    oldResult.fingerprint.length > 0 &&
    oldResult.fingerprint === currentFingerprint &&
    oldResult.debate?.outcome === 'COMPLETED' &&
    oldResult.standard?.passed === true
  );
}

module.exports = { fingerprintFor, canReuseResult };
