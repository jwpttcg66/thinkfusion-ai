/**
 * 可选外部 Adapter：CGC / Graphiti → Neo4j HTTP。
 *
 * 需要 Podman 里的 tf-neo4j（默认 http://127.0.0.1:7474, neo4j/testpass）。
 * 不放进默认 npm test；单独跑：npm run test:code-index-external。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Neo4jHttpClient } from '../out-test/main/code-index/neo4j-http.js';
import { CgcAdapter, GraphitiAdapter } from '../out-test/main/code-index/external.js';
import { CodeIndexService } from '../out-test/main/code-index/service.js';

const baseUrl = process.env.THINKFUSION_NEO4J_HTTP ?? 'http://127.0.0.1:7474';
const client = new Neo4jHttpClient({
  baseUrl,
  user: process.env.THINKFUSION_NEO4J_USER ?? 'neo4j',
  password: process.env.THINKFUSION_NEO4J_PASSWORD ?? 'testpass'
});

test('CGC Adapter：符号搜索与 callers', async () => {
  const cgc = new CgcAdapter(client);
  const hits = await cgc.search('processOrder', 5);
  assert.ok(hits.some(hit => hit.title === 'processOrder'));
  const callers = await cgc.callers('processOrder', 5);
  assert.ok(callers.some(hit => hit.title === 'run'));
});

test('Graphiti Adapter：事实检索', async () => {
  const graphiti = new GraphitiAdapter(client);
  const hits = await graphiti.search('订单重复扣款', 5);
  assert.ok(hits.some(hit => hit.content.includes('幂等') || hit.content.includes('重复扣款')));
});

test('CodeIndexService 合并外部 CGC / Graphiti', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ext-index-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export function processOrder(id: string) { return id; }\n');
  const service = new CodeIndexService(path.join(dir, 'index.sqlite'), {
    external: { cgc: new CgcAdapter(client), graphiti: new GraphitiAdapter(client) }
  });
  try {
    await service.index(dir);
    const code = await service.retrieve(dir, 'processOrder', { mode: 'CODE', limit: 10 });
    assert.ok(code.items.some(item => item.source === 'CGC'), '没有合并 CGC 结果');
    const memory = await service.retrieve(dir, '订单重复扣款', { mode: 'MEMORY', limit: 10 });
    assert.ok(memory.items.some(item => item.source === 'Graphiti'), '没有合并 Graphiti 结果');
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
