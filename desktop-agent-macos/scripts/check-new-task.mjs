/**
 * Checks that "新任务" actually does something you can see.
 *
 * The bug this exists for: on an already-empty screen the button changed
 * nothing visible — no draft cleared, no caret moved, nothing. A click that
 * leaves the screen byte-for-byte identical is indistinguishable from a dead
 * button, and that is exactly how it got reported ("新建任务没有响应").
 *
 * Pressing Enter in an empty composer had the same shape: the keystroke was
 * swallowed. It now answers "先写一句目标，再发送。".
 *
 * Usage: node scripts/check-new-task.mjs   (app must be running with CDP on)
 */
import { connect, createChecks, findAppTarget, listTargets, sleep } from './lib/cdp.mjs';

const targets = await listTargets();
const app = findAppTarget(targets);
if (!app) throw new Error('找不到应用渲染进程；请用 --remote-debugging-port=9222 启动');

const cdp = await connect(app);
const { check, checkTrue, summary } = createChecks();

const result = await cdp.evaluate(`(async () => {
  const out = {};
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const setText = (el, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const composer = () => document.querySelector('.dock textarea');

  // Start from a task, so "new task" has something to leave behind.
  const item = document.querySelector('.task-item');
  if (item) {
    item.click();
    await wait(500);
  }
  out.hadTask = document.querySelectorAll('.task-item.active').length === 1;

  // A draft that must not survive into the new task.
  setText(composer(), '这是一段草稿');
  await wait(200);
  out.draftBefore = composer().value;

  document.querySelector('.new-task').click();
  await wait(400);
  out.afterNew = {
    hero: !!document.querySelector('.hero'),
    active: document.querySelectorAll('.task-item.active').length,
    draft: composer().value,
    focused: document.activeElement === composer()
  };

  // Clicking again while already empty must still be felt.
  document.querySelector('.new-task').click();
  await wait(300);
  out.focusOnRepeatClick = document.activeElement === composer();

  // Enter with nothing typed.
  composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await wait(300);
  out.noticeEmpty = document.querySelector('.notice')?.textContent ?? null;

  // Typing must clear that notice and enable send.
  setText(composer(), '写一份 README');
  await wait(300);
  out.noticeAfterTyping = document.querySelector('.notice')?.textContent ?? null;
  out.sendEnabled = !document.querySelector('.dock .send').disabled;

  // Leave the composer as we found it.
  setText(composer(), '');
  await wait(150);
  return out;
})()`);

checkTrue('起始状态有一个被选中的任务', result.hadTask);
check('点「新任务」前草稿还在', result.draftBefore, '这是一段草稿');
checkTrue('点「新任务」后回到空状态', result.afterNew.hero);
check('点「新任务」后没有选中的任务', result.afterNew.active, 0);
check('点「新任务」后草稿被清空', result.afterNew.draft, '');
checkTrue('点「新任务」后光标落在输入框', result.afterNew.focused);
checkTrue('空状态下再点一次，光标仍在输入框', result.focusOnRepeatClick);
check('空输入按 Enter 有提示', result.noticeEmpty, '先写一句目标，再发送。');
check('开始输入后提示消失', result.noticeAfterTyping, null);
checkTrue('开始输入后发送按钮可用', result.sendEnabled);

const tally = summary();
cdp.close();
process.exit(tally.fail === 0 ? 0 : 1);
