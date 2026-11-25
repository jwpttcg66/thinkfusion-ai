#!/usr/bin/env node
/**
 * 真机核对：工作计划胶囊文案 + 正文贴底。
 * 用法：node scripts/verify-task-plan-capsule.mjs
 */
import WebSocket from 'ws';

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find(item => item.type === 'page' && /5173/.test(item.url || ''));
if (!page?.webSocketDebuggerUrl) {
  console.error('no page');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

let nextId = 1;
const pending = new Map();
ws.on('message', raw => {
  const msg = JSON.parse(String(raw));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function call(method, params = {}) {
  const id = nextId++;
  return new Promise(resolve => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function evaluate(expression) {
  return call('Runtime.evaluate', { expression, returnByValue: true }).then(msg => {
    if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails));
    return msg.result?.result?.value;
  });
}

await call('Runtime.enable');

const init = await evaluate(`(() => ({
  goal: document.querySelector('.task-plan-goal')?.textContent?.trim() || null,
  hasCapsule: !!document.querySelector('.task-plan-capsule'),
  empty: !!document.body.innerText.includes('探索未至之境')
}))()`);
console.log('INIT', init);

if (!init?.goal) {
  // 点开已有会话，或发一条新问。
  await evaluate(`(() => {
    const hit = [...document.querySelectorAll('div,button,span,p')].find(n =>
      n.childElementCount === 0 && n.textContent.trim() === '只回答：4+4等于几'
    );
    if (hit) { (hit.closest('[role],button,div') || hit).click(); return 'open-old'; }
    const ta = document.querySelector('textarea');
    if (!ta) return 'no-ta';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '只回答：5+5等于几');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '↑');
    btn?.click();
    return 'sent-new';
  })()`);

  for (let i = 0; i < 25; i += 1) {
    await new Promise(r => setTimeout(r, 800));
    const snap = await evaluate(`(() => {
      const scroll = document.querySelector('.scroll');
      const goal = document.querySelector('.task-plan-goal')?.textContent?.trim() || null;
      const step = document.querySelector('.task-plan-step')?.innerText?.replace(/\\s+/g, ' ').trim() || null;
      const gap = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight : null;
      return {
        goal,
        step,
        bad: /正在理解任务目标/.test(goal || ''),
        workPlan: /工作计划/.test(goal || ''),
        gap,
        stickish: gap !== null && gap < 140
      };
    })()`);
    console.log('T' + i, snap);
    if (snap?.workPlan && !snap?.bad) break;
  }
}

const finalSnap = await evaluate(`(() => {
  const scroll = document.querySelector('.scroll');
  const goal = document.querySelector('.task-plan-goal')?.textContent?.trim() || null;
  const step = document.querySelector('.task-plan-step')?.innerText?.replace(/\\s+/g, ' ').trim() || null;
  const nm = document.querySelector('.task-plan-nm')?.textContent?.trim() || null;
  const gap = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight : null;
  return {
    goal,
    step,
    nm,
    bad: /正在理解任务目标/.test(goal || ''),
    workPlan: /工作计划/.test(goal || ''),
    inDock: !!document.querySelector('.dock .task-plan-capsule'),
    liveBottom: !!document.querySelector('.conv-live-bottom'),
    gap,
    stickish: gap !== null && gap < 160
  };
})()`);
console.log('FINAL', finalSnap);

const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
const fs = await import('fs');
const path = new URL('../docs/ui/task-plan-capsule-fixed.png', import.meta.url);
fs.writeFileSync(path, Buffer.from(shot.result.data, 'base64'));
console.log('SHOT', path.pathname);

ws.close();
if (!finalSnap?.workPlan || finalSnap?.bad || !finalSnap?.inDock) process.exit(2);
