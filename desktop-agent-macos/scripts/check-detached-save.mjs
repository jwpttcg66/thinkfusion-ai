import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';

import { detachedSaveDocument } from '../out-test/main/detached-save-document.js';

test('独立窗口保存面板可运行、保留三种保存动作且安全渲染页面内容', () => {
  const html = detachedSaveDocument();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

  assert.ok(script, '保存面板必须有初始化脚本');
  assert.doesNotThrow(() => new Script(script), '保存面板脚本必须可解析');
  assert.match(html, /<title>保存网页对话<\/title>/);
  assert.match(html, /id="selected-items"/);
  assert.match(html, /id="selected-merge"/);
  assert.match(html, /id="all-merge"/);
  assert.match(script, /api\.getPreview\(\)/);
  assert.match(script, /api\.save\(/);
  assert.match(script, /textContent\s*=\s*item\.title/);
  assert.match(script, /textContent\s*=\s*item\.excerpt/);
  assert.doesNotMatch(script, /innerHTML/);
});
