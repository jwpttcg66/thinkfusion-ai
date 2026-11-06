/**
 * 追问恢复的判定：以页面最终地址为准。
 *
 * 真机上 Gemini / ChatGPT 已经回到原会话，却因为 12 秒内没派发
 * did-finish-load 被写成「导航回原会话超时或失败」，还白等满 12 秒。
 * 这几例把「事件没来但地址到了」和「地址真的没到」分开钉住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { isSameThread, navigateToThread } from '../out-test/main/adapters/browser/thread-navigation.js';

const TARGET = new URL('https://chatgpt.com/c/abc-123?x=1');

class FakeContents extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.destroyed = false;
    this.loads = [];
  }

  getURL() {
    return this.url;
  }

  isDestroyed() {
    return this.destroyed;
  }

  loadURL(href) {
    this.loads.push(href);
    // 模拟 SPA：地址立刻回显，但 loadURL 的 promise 一直不兑现，
    // did-finish-load 也永远不来 —— 这正是真机误报的那一类情况。
    this.url = href;
    this.emit('did-navigate');
    return new Promise(() => {});
  }
}

const fakeView = contents => ({ webContents: contents });

test('同一条会话按 origin + pathname 判定，query 差异不重载', () => {
  assert.equal(isSameThread('https://chatgpt.com/c/abc-123?y=2', TARGET), true);
  assert.equal(isSameThread('https://chatgpt.com/c/other', TARGET), false);
  assert.equal(isSameThread('https://gemini.google.com/c/abc-123', TARGET), false);
  assert.equal(isSameThread('', TARGET), false);
});

test('已经在原会话：不导航、立刻成功', async () => {
  const contents = new FakeContents('https://chatgpt.com/c/abc-123?y=2');
  const result = await navigateToThread(fakeView(contents), TARGET, 300, 10);
  assert.equal(result.ok, true);
  assert.equal(contents.loads.length, 0, '已经在这条会话上就不该重载页面');
});

test('SPA 只有 did-navigate、没有 did-finish-load 也算回到原会话', async () => {
  const contents = new FakeContents('https://chatgpt.com/');
  const started = Date.now();
  const result = await navigateToThread(fakeView(contents), TARGET, 300, 10);
  assert.equal(result.ok, true);
  assert.equal(contents.loads[0], TARGET.href);
  assert.ok(Date.now() - started < 250, '地址到了就不该白等满硬超时');
});

test('地址始终没到目标：如实失败并回报停在的地址', async () => {
  const contents = new FakeContents('https://chatgpt.com/');
  contents.loadURL = href => {
    contents.loads.push(href);
    contents.url = 'https://chatgpt.com/other';
    return new Promise(() => {});
  };
  const result = await navigateToThread(fakeView(contents), TARGET, 120, 10);
  assert.equal(result.ok, false);
  assert.match(result.url, /\/other/);
});

test('硬超时前最后复查一次地址：没派发任何事件也认', async () => {
  const contents = new FakeContents('https://chatgpt.com/');
  contents.loadURL = href => {
    contents.loads.push(href);
    return new Promise(() => {});
  };
  const pending = navigateToThread(fakeView(contents), TARGET, 260, 10);
  setTimeout(() => {
    contents.url = TARGET.href;
  }, 240);
  const result = await pending;
  assert.equal(result.ok, true);
});

test('loadURL 兑现时提前结束渲染宽限', async () => {
  const contents = new FakeContents('https://chatgpt.com/');
  contents.loadURL = href => {
    contents.loads.push(href);
    contents.url = href;
    return Promise.resolve();
  };
  const started = Date.now();
  const result = await navigateToThread(fakeView(contents), TARGET, 400, 300);
  assert.equal(result.ok, true);
  assert.ok(Date.now() - started < 200, '主文档加载完成就不必等满渲染宽限');
});
