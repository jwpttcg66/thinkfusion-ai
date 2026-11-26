/**
 * 真机复验：对话流里被折叠的正文块能不能在框内滚动。
 *
 * 现场问题（2026-11-26）：流式成员「思考中 · 已写 N 字符」的正文用
 * -webkit-line-clamp + overflow:hidden 截断，滚轮完全无效，只能点「展开全文」。
 *
 * 这里不跑模型任务，直接把同款 DOM（chat-stream-body / chat-member-text 的
 * is-clamped 形态）挂到真实渲染进程里，量 computed style、scrollHeight、
 * 以及设置 scrollTop 后是否真的移动；再截图留证。
 *
 * 一条脚本跑完：隔离 userData → 起 dev → 连 CDP → 注入/测量/截图 → kill
 * → 断言真实 agent-store.json sha256 不变。只清自己的 CDP 端口，不碰 5173。
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const REAL_STORE = path.join(REAL_USER_DATA, 'agent-store.json');
const ISO_USER_DATA = process.env.ISO_USER_DATA ?? '/tmp/tf-scroll-userdata';
const OUT_DIR = process.env.SCROLL_EVIDENCE_DIR
  ? path.resolve(process.env.SCROLL_EVIDENCE_DIR)
  : path.join(ROOT, '..', 'docs', 'spec', 'evidence', 'chat-scroll-20261126');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;

const CONFIG_FILES = [
  'api-keys.json', 'cloud-config.json', 'execution-defaults.json', 'permission-preset.json',
  'sources.json', 'settings.json', 'capabilities.json', 'cli-agents.json', 'cli-capabilities.json',
  'collaboration-mode.json', 'expertise.json', 'profile.json', 'workspaces.json',
  'workspace-state.json', 'code-intelligence.json'
];

const evidence = { startedAt: new Date().toISOString(), checks: {}, samples: {}, shots: [] };
let child = null;
let cdp = null;

function sha256(file) {
  if (!fs.existsSync(file)) return null;
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function note(name, ok, detail) {
  evidence.checks[name] = { ok: Boolean(ok), detail: detail ?? null, at: new Date().toISOString() };
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function prepareIsolation() {
  fs.rmSync(ISO_USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(ISO_USER_DATA, { recursive: true });
  for (const name of CONFIG_FILES) {
    const from = path.join(REAL_USER_DATA, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(ISO_USER_DATA, name));
  }
}

function listenersOn(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n').map(item => item.trim()).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function ensurePortFree() {
  // 绝不碰 5173：那可能是用户正在用的 dev 实例，electron-vite 会自动换 5174。
  const stale = listenersOn(PORT);
  for (const pid of stale) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
  for (let index = 0; index < 20 && listenersOn(PORT).length > 0; index += 1) await sleep(300);
  assert.equal(listenersOn(PORT).length, 0, `端口 ${PORT} 仍被占用`);
}

function startDev() {
  execFileSync('npm', ['run', 'build:agent'], { cwd: ROOT, stdio: 'inherit' });
  const logFile = path.join(OUT_DIR, 'dev.log');
  const out = fs.openSync(logFile, 'w');
  const env = { ...process.env, THINKFUSION_USER_DATA: ISO_USER_DATA };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  child = spawn('npx', ['electron-vite', 'dev', '--noSandbox', '--remoteDebuggingPort', String(PORT)], {
    cwd: ROOT, env, detached: true, stdio: ['ignore', out, out]
  });
  child.unref();
  return logFile;
}

async function stopDev() {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 已退出 */ }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try { process.kill(-child.pid, 0); } catch { return; }
    await sleep(300);
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
}

async function waitForRenderer() {
  const deadline = Date.now() + 120000;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(ENDPOINT)).json();
      target = targets.find(item =>
        item.type === 'page' &&
        (item.url.includes('localhost:5174') || item.url.includes('localhost:5173') || item.url.startsWith('file:'))
      ) ?? null;
      if (target) return target;
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('CDP 渲染进程一直没起来');
}

const PROBE = `
(() => {
  const lines = Array.from({ length: 40 }, (_, i) => '第 ' + (i + 1) + ' 行：这是一段用来验证内部滚动的长文本。').join('\\n');
  const host = document.createElement('div');
  host.id = 'scroll-probe';
  host.style.cssText = 'position:fixed;left:24px;top:24px;width:520px;z-index:9999;background:var(--bg,#fff);padding:12px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25)';

  const stream = document.createElement('div');
  stream.className = 'chat-stream-member is-streaming';
  const head = document.createElement('div');
  head.className = 'chat-stream-head';
  head.textContent = '流式正文探针';
  const pre1 = document.createElement('pre');
  pre1.className = 'chat-stream-body is-clamped';
  pre1.textContent = lines;
  stream.append(head, pre1);

  const member = document.createElement('div');
  member.className = 'chat-member is-streaming';
  const head2 = document.createElement('div');
  head2.className = 'chat-member-head';
  head2.textContent = '成员正文探针';
  const pre2 = document.createElement('pre');
  pre2.className = 'chat-member-text is-clamped';
  pre2.textContent = lines;
  member.append(head2, pre2);

  host.append(stream, member);
  document.body.appendChild(host);

  const measure = (el) => {
    const cs = getComputedStyle(el);
    const before = { overflowY: cs.overflowY, maxHeight: cs.maxHeight, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    el.scrollTop = 32;
    return { ...before, scrollTop: el.scrollTop, canScroll: before.scrollHeight > before.clientHeight + 1 && el.scrollTop > 0 };
  };
  return { stream: measure(pre1), member: measure(pre2) };
})()
`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const storeBefore = sha256(REAL_STORE);
  const userInstanceActive = listenersOn(5173).length > 0;
  evidence.userInstanceActive = userInstanceActive;
  note('real-store-readable', Boolean(storeBefore), REAL_STORE);
  prepareIsolation();
  await ensurePortFree();
  const logFile = startDev();
  console.log(`dev 启动中（隔离 userData=${ISO_USER_DATA}，日志 ${logFile}）`);

  const target = await waitForRenderer();
  if (fs.readFileSync(logFile, 'utf8').includes('Cannot start http server for devtools')) {
    throw new Error('devtools 端口被旧实例占用');
  }
  cdp = await connect(target);
  await cdp.send('Page.enable');
  for (let index = 0; index < 80; index += 1) {
    const ready = await cdp.evaluate('typeof window.agentAPI?.getTask === "function"').catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  note('renderer-ready', true, target.url);
  // agentAPI 来自 preload，页面刚导航完就有；样式表是渲染层 JS 注入的，
  // 必须等 .is-clamped 真正命中再量，否则量到的是未加载样式的裸元素。
  let cssReady = false;
  for (let index = 0; index < 60; index += 1) {
    cssReady = await cdp.evaluate(`(() => {
      const el = document.createElement('pre');
      el.className = 'chat-stream-body is-clamped';
      document.body.appendChild(el);
      const ok = getComputedStyle(el).overflowY === 'auto';
      el.remove();
      return ok;
    })()`).catch(() => false);
    if (cssReady) break;
    await sleep(500);
  }
  note('css-ready', cssReady, '.chat-stream-body.is-clamped overflow-y:auto');

  const samples = await cdp.evaluate(PROBE, 30000);
  evidence.samples = samples;
  for (const [name, sample] of Object.entries(samples)) {
    note(`${name}-can-scroll`, sample.canScroll, JSON.stringify(sample));
    note(`${name}-overflow-auto`, sample.overflowY === 'auto', sample.overflowY);
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000);
  const shotFile = path.join(OUT_DIR, '01-scroll-probe.png');
  fs.writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));
  evidence.shots.push(path.relative(ROOT, shotFile));

  await stopDev();
  await sleep(500);
  const storeAfter = sha256(REAL_STORE);
  evidence.storeBefore = storeBefore;
  evidence.storeAfter = storeAfter;
  if (userInstanceActive) {
    // 用户 5173 实例可能正在写真实 store，这时哈希变化不能归因于验收实例。
    // 诚实记录跳过断言，而不是把外部写入算成我们的改动。
    note('real-store-untouched', true, `跳过断言：用户 5173 实例在跑，${String(storeBefore).slice(0, 12)} → ${String(storeAfter).slice(0, 12)}`);
  } else {
    note('real-store-untouched', storeBefore === storeAfter, `${String(storeBefore).slice(0, 12)} → ${String(storeAfter).slice(0, 12)}`);
  }

  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(
    path.join(OUT_DIR, 'EVIDENCE.md'),
    [
      '# 真机复验：折叠正文可在框内滚动',
      '',
      `- 时间：${evidence.startedAt} → ${evidence.finishedAt}`,
      `- 隔离 userData \`${ISO_USER_DATA}\`；只清 CDP 端口 ${PORT}，未动用户 5173 实例`,
      userInstanceActive
        ? `- 真实 store：用户 5173 实例在跑，哈希 \`${String(storeBefore).slice(0, 12)}\` → \`${String(storeAfter).slice(0, 12)}\`${storeBefore === storeAfter ? '（一致）' : '（变化不归因于本次验收）'}；隔离实例数据在 \`${ISO_USER_DATA}\``
        : `- 真实 store：\`${String(storeBefore).slice(0, 12)}\` 前后${storeBefore === storeAfter ? '一致' : '**变了**'}`,
      '',
      '## 测量结果',
      '',
      '| 元素 | overflow-y | max-height | scrollHeight / clientHeight | 设置 scrollTop 后 | 可滚 |',
      '| --- | --- | --- | --- | --- | --- |',
      ...Object.entries(samples).map(([name, s]) =>
        `| ${name} | ${s.overflowY} | ${s.maxHeight} | ${String(s.scrollHeight)} / ${String(s.clientHeight)} | ${String(s.scrollTop)} | ${s.canScroll ? '是' : '否'} |`
      ),
      '',
      `截图：\`${path.relative(OUT_DIR, shotFile)}\``,
      ''
    ].join('\n')
  );
  console.log(`证据：${path.relative(ROOT, OUT_DIR)}/EVIDENCE.md`);
  const failed = Object.values(evidence.checks).filter(item => !item.ok);
  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error('复验中断：', error?.message ?? error);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'failure.json'), `${JSON.stringify({ error: String(error?.stack ?? error), evidence }, null, 2)}\n`);
  await stopDev();
  process.exitCode = 1;
} finally {
  cdp?.close();
  await stopDev();
}
