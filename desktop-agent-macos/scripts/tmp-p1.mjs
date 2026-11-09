import assert from 'node:assert/strict';
import test from 'node:test';
import { parseToolRequest } from '../out-test/main/research/project-tools.js';
test('t', () => {
  assert.deepEqual(parseToolRequest('{"tool":"fs.stat","args":{"path":"log.txt"}}'), { tool: 'fs.stat', args: { path: 'log.txt' } });
  assert.equal(parseToolRequest('【结论】共 {3} 行'), null);
  assert.equal(parseToolRequest('{"tool":"fs.writeFile","args":{}}'), null);
});
