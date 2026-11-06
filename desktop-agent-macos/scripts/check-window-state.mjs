/**
 * 窗口状态读回来的规则。
 *
 * 这个功能最容易造成的坏结果不是「没记住」，是**记住了一个用不了的值**：把窗口
 * 开到一块已经拔掉的显示器上，或者把宽度存成 30000——下次启动就是一个够不着、
 * 也缩不回来的窗口。所以读回来的每一步都要能退回默认值，而这几条都在这里断言。
 *
 * Usage: node --test scripts/check-window-state.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  restoreWindowPlacement
} = await import(path.join(root, 'out/adapter/shared/window-state.js'));

const LAPTOP = { x: 0, y: 0, width: 1512, height: 900 };

test('没有记录时就是默认大小，位置交给系统', () => {
  for (const raw of [null, undefined, 'x', 42, []]) {
    const placement = restoreWindowPlacement(raw, [LAPTOP]);
    assert.equal(placement.width, DEFAULT_WINDOW_WIDTH);
    assert.equal(placement.height, DEFAULT_WINDOW_HEIGHT);
    assert.equal(placement.x, undefined);
    assert.equal(placement.y, undefined);
    assert.equal(placement.split, undefined);
  }
});

test('记下来的大小、位置、分栏原样用回来', () => {
  const placement = restoreWindowPlacement(
    { width: 1320, height: 880, x: 120, y: 60, split: 640, maximized: false },
    [LAPTOP]
  );
  assert.deepEqual(placement, { width: 1320, height: 880, x: 120, y: 60, split: 640 });
});

test('位置落在屏幕外就丢掉位置，大小仍然用', () => {
  // 上次在右边那台显示器上（x=2000），现在只剩笔记本。
  const placement = restoreWindowPlacement({ width: 1320, height: 880, x: 2000, y: 120 }, [LAPTOP]);
  assert.equal(placement.width, 1320);
  assert.equal(placement.height, 880);
  assert.equal(placement.x, undefined, '屏幕外的位置不能让窗口开到看不见的地方');
});

test('只露出一部分也算找得回来', () => {
  const placement = restoreWindowPlacement({ width: 1320, height: 880, x: -200, y: -100 }, [LAPTOP]);
  assert.equal(placement.x, -200, '往左上角拖出去一半是常见用法');
  assert.equal(placement.y, -100);
});

test('比现在这块屏还大的窗口，缩到屏幕大小', () => {
  // 在 5K 上拉到 3000 宽，换到 1512 的笔记本上打开。
  const placement = restoreWindowPlacement({ width: 3000, height: 2000, x: 0, y: 0 }, [LAPTOP]);
  assert.equal(placement.width, 1512);
  assert.equal(placement.height, 900);
});

test('小于最小值或不是数字，退回安全值', () => {
  const placement = restoreWindowPlacement(
    { width: 400, height: Infinity, x: 'left', y: null, split: NaN },
    [LAPTOP]
  );
  assert.equal(placement.width, MIN_WINDOW_WIDTH);
  // 高度本身坏了，用出厂值 960；但这块屏只有 900 高，所以再夹到 900。
  assert.equal(placement.height, LAPTOP.height);
  assert.ok(placement.height >= MIN_WINDOW_HEIGHT);
  assert.equal(placement.x, undefined);
  assert.equal(placement.split, undefined);
});

test('分栏宽度只做正向校验，夹取交给 computeSplit', () => {
  assert.equal(restoreWindowPlacement({ split: 0 }, [LAPTOP]).split, undefined);
  assert.equal(restoreWindowPlacement({ split: -40 }, [LAPTOP]).split, undefined);
  assert.equal(restoreWindowPlacement({ split: 900 }, [LAPTOP]).split, 900);
});

test('最大化记的是「还原以后多大」', () => {
  const placement = restoreWindowPlacement({ width: 1200, height: 800, maximized: true }, [LAPTOP]);
  assert.equal(placement.maximized, true);
  assert.equal(placement.width, 1200);
});
