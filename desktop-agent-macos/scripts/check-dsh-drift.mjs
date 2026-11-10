/**
 * dsh 工具目录漂移检查（开发期用，不进构建、不进 test 链）。
 *
 * `src/shared/dsh-tools.ts` 冻结了 dsh 0.2.2-alpha.2 的 76 条 schema。升 dsh 版本时，
 * 先跑这个脚本看上游加了/删了哪些工具，再补 `family / ours / layer / note`。
 *
 * 按 `(packageName, tool)` 集合比对，不按数组下标：`DSH_TOOLS` 按族分组，顺序与
 * dsh 目录不同，按下标对会全表错位。
 *
 * 用法：
 *   npm run build:test
 *   node scripts/check-dsh-drift.mjs                 # 默认读 ~/data/dsh-src
 *   DSH_CATALOG=/path/to/tool-catalog.zh.md node scripts/check-dsh-drift.mjs
 *
 * 退出码：0 一致；1 有新增/删除；2 找不到目录或解析失败。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DSH_TOOLS } from '../out-test/shared/dsh-tools.js';

const catalogPath = process.env.DSH_CATALOG
  ?? join(homedir(), 'data', 'dsh-src', 'docs', 'tool-catalog.zh.md');

function parseCatalog(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`读不到 dsh 目录：${path}（${error.message}）`);
    console.error('设置 DSH_CATALOG 指向 tool-catalog.zh.md，或先 clone dsh-src。');
    process.exit(2);
  }

  let pkg = '';
  const rows = [];
  for (const line of text.split('\n')) {
    const p = line.match(/^## `@deepseek-ai\/([^`]+)`/);
    if (p) {
      pkg = p[1];
      continue;
    }
    const t = line.match(/^### `([^`]+)`/);
    if (t) rows.push({ packageName: pkg, tool: t[1] });
  }
  if (rows.length === 0) {
    console.error(`${path} 里没有解析到 \`### \\\`tool\\\`\` 段落，目录格式可能变了。`);
    process.exit(2);
  }
  return rows;
}

const key = item => `${item.packageName}\t${item.tool}`;
const catalog = parseCatalog(catalogPath);
const ours = new Set(DSH_TOOLS.map(key));
const upstream = new Set(catalog.map(key));

const added = catalog.filter(item => !ours.has(key(item)));
const removed = DSH_TOOLS
  .map(item => ({ packageName: item.packageName, tool: item.tool }))
  .filter(item => !upstream.has(key(item)));

console.log(`目录：${catalogPath}`);
console.log(`上游 ${catalog.length} 条，本仓库冻结 ${DSH_TOOLS.length} 条。`);

if (added.length === 0 && removed.length === 0) {
  console.log('一致。');
  process.exit(0);
}

if (added.length > 0) {
  console.log(`\n上游新增 ${added.length} 条（要补 family/ours/layer/note）：`);
  for (const item of added) console.log(`  + ${item.packageName}\t${item.tool}`);
}
if (removed.length > 0) {
  console.log(`\n上游已删除或改名 ${removed.length} 条（本仓库还登记着）：`);
  for (const item of removed) console.log(`  - ${item.packageName}\t${item.tool}`);
}
process.exit(1);
