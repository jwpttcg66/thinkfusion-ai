/**
 * 真机自检：用 ThinkFusion 自己的 src 建立本地代码索引。
 * 不写入 userData，只写临时 DB；跑完删除。
 *
 * Run with: node scripts/check-code-index-live.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodeIndexStore } from '../out-test/main/code-index/store.js';
import { indexProject } from '../out-test/main/code-index/indexer.js';
import { retrieve } from '../out-test/main/code-index/retrieval.js';

const root = path.resolve('src');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-live-index-'));
const db = path.join(dir, 'index.sqlite');
const store = new CodeIndexStore(db);
try {
  const started = Date.now();
  const result = await indexProject(store, root, 'thinkfusion-live', { maxFiles: 1000 });
  const elapsed = Date.now() - started;
  const search = retrieve(store, 'thinkfusion-live', 'runCodingTeam', { mode: 'CODE', limit: 5 });
  console.log(JSON.stringify({
    files: result.files,
    nodes: result.nodes,
    edges: result.edges,
    docs: result.docs,
    generation: result.generation,
    indexMs: elapsed,
    queryHits: search.items.length,
    first: search.items[0]?.title ?? null,
    dbBytes: fs.statSync(db).size
  }, null, 2));
} finally {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
