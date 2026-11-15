/**
 * 右侧栏的终端按钮：一个会话一个按钮，和网页按钮并列。
 *
 * 用 React 服务端渲染检查标记，不启动 Electron：这条断言的要点是
 * 「N 个会话 → N 个按钮」「选中态只落在一个按钮上」「已退出的有标记」，
 * 都是 DOM 结构，不需要真实 PTY。
 *
 * Run with: npm run test:terminal-rail
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'out-test');
const entry = path.join(outDir, 'rail-check.cjs');

function render(props) {
  mkdirSync(outDir, { recursive: true });
  esbuild.buildSync({
    stdin: {
      contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { SourceRail } from ${JSON.stringify(path.join(root, 'src/renderer/src/components/SourceRail.tsx'))};
        const props = ${JSON.stringify(props)};
        process.stdout.write(renderToStaticMarkup(React.createElement(SourceRail, {
          ...props,
          sources: props.sources,
          onSelect: () => {},
          onToggleCollapse: () => {},
          onToggleTerminal: () => {},
          onToggleCli: () => {}
        })));
      `,
      resolveDir: root,
      loader: 'tsx'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: entry,
    external: ['react', 'react-dom', 'react-dom/server'],
    logLevel: 'silent'
  });
  return execFileSync(process.execPath, [entry], { encoding: 'utf8' });
}

const source = {
  id: 'chatgpt',
  label: 'ChatGPT',
  glyph: 'G',
  url: 'https://chatgpt.com/',
  hosts: ['chatgpt.com'],
  planning: false,
  enabled: true
};

test('N 个终端 → N 个侧栏按钮，各带自己的状态', () => {
  const html = render({
    sources: [source],
    activeId: 'chatgpt',
    planningId: null,
    loading: false,
    collapsed: false,
    terminals: [
      { sessionId: 'term-aaaa1111', label: 'repo-one', exited: false },
      { sessionId: 'term-bbbb2222', label: 'repo-two', exited: true }
    ],
    openTerminalIds: ['term-bbbb2222']
  });

  assert.equal((html.match(/rail-btn terminal/g) ?? []).length, 2, '两个终端应有两个按钮');
  assert.equal((html.match(/rail-btn terminal active/g) ?? []).length, 1, '只有一个终端窗口处于打开态');
  assert.match(html, /repo-two/);
  assert.match(html, /2222/);
  assert.match(html, /（已退出）/);
  assert.match(html, /（运行中）/);
  assert.match(html, /ChatGPT/, '网页按钮仍然保留');
});

test('没有终端时不渲染终端按钮，也不多画分隔线', () => {
  const html = render({
    sources: [source],
    activeId: 'chatgpt',
    planningId: null,
    loading: false,
    collapsed: false,
    terminals: [],
    openTerminalIds: []
  });
  assert.equal((html.match(/rail-btn terminal/g) ?? []).length, 0);
});

test('已启用的 CLI 各有一个按钮，开着的显示为打开态', () => {
  const html = render({
    sources: [source],
    activeId: 'chatgpt',
    planningId: null,
    loading: false,
    collapsed: false,
    terminals: [],
    openTerminalIds: [],
    cliAgents: [
      { id: 'qoder', label: 'Qoder CLI', glyph: 'Q', running: true, open: true },
      { id: 'claude', label: 'Claude CLI', glyph: 'C', running: true, open: false }
    ]
  });
  assert.equal((html.match(/rail-btn cli/g) ?? []).length, 2);
  assert.equal((html.match(/rail-btn cli active/g) ?? []).length, 1);
  assert.match(html, /Qoder CLI/);
  assert.match(html, /Claude CLI/);
});

test.after(() => {
  rmSync(entry, { force: true });
});
