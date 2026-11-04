/**
 * The prompt policy, enforced rather than remembered.
 *
 * A fixed wrapper was sent in front of every question — 「你是我在 ThinkFusion
 * 里的研究伙伴… 几点要求：1…4…」. It was removed once by hand. It came back
 * because nothing checked. This file is the check.
 *
 * Run with: npm run test:prompt-policy
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Phrases from the deleted wrapper. Each one is specific enough not to appear
 * in a legitimate comment about why it was deleted — those live in AGENTS.md.
 */
const BANNED = ['研究伙伴', '几点要求', '不要输出 JSON', '不要输出执行计划', '不允许输出'];

test('the wrapper module is gone', () => {
  assert.equal(
    existsSync(join(ROOT, 'src/shared/prompts.ts')),
    false,
    'src/shared/prompts.ts 又被加回来了：固定提示词不允许存在'
  );
});

test('no source file puts words in the user mouth', () => {
  for (const file of walk(join(ROOT, 'src'))) {
    // The comments in master-agent.ts quote the old wrapper to explain why it
    // is gone; they are lines beginning with *, //, or embedded in a block
    // comment. Strip comments before looking, so the rule checks code.
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const phrase of BANNED) {
      assert.equal(code.includes(phrase), false, `${file} 里出现了「${phrase}」`);
    }
  }
});

test('the question reaches the page verbatim', () => {
  const master = readFileSync(join(ROOT, 'src/main/master-agent.ts'), 'utf8');
  assert.match(
    master,
    /question:\s*request\.question/,
    'master-agent 必须把 request.question 原样交给通道'
  );
});

test('no stale build output keeps the deleted module alive', () => {
  // `tsc` does not remove the .js of a deleted .ts. The old wrapper sat in
  // out/shared/prompts.js long after the source was gone, which is exactly how
  // it can look like the app still sends it.
  for (const stale of ['out/shared/prompts.js', 'out/adapter/shared/prompts.js']) {
    assert.equal(existsSync(join(ROOT, stale)), false, `${stale} 是已删除模块的旧产物，清掉`);
  }
});
