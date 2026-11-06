# 窗口大小、位置与分栏的保存（2026-11-06）

## 问题

用户原话：「可以保存我调整的大小，每次都会变回去，有点烦人」。

窗口开在 1560×960，分栏（右侧网页那一侧）固定占窗口的 42%，**两者都是常量**：
拖过分隔条、拉过窗口边框，下次启动全部归位。这不是「默认值」，是改动没有被记住。

## 存在哪、由谁管

`userData/window-state.json`（`~/Library/Application Support/thinkfusion-ai/`）：

```json
{ "width": 1300, "height": 820, "x": 80, "y": 70, "maximized": false, "split": 520 }
```

- 写：`saveWindowState()`，走 `atomic-write.ts`（先写临时文件再 rename）。窗口的
  `resize` / `move` / `maximize` / `unmaximize` 都只是**防抖 400ms** 后再写，
  拖动时不会每帧落盘；`close` 时立刻写一次，因为退出路径上那个 400ms 可能来不及跑。
- 读：`readWindowState()` → `restoreWindowPlacement()`（`src/shared/window-state.ts`，
  纯函数，有单测）。`preferredSplit` 在第一次 `layout()` 之前就定好，否则第一帧会
  按默认比例画出来再跳一下。
- 最大化时记的是 `getNormalBounds()`：要的是「还原以后多大」，否则下次启动会先
  出现一个铺满屏幕的窗口再被 `maximize()` 一次。

## 读回来的值必须能用

记不住只是烦，**记住一个用不了的值**才是事故：窗口开到一块已经拔掉的显示器上，
或者宽度被存成 30000。所以：

- 大小夹在最小值（1180×720）与**当前最大那块屏**之间——在 5K 上拉大的窗口，换到
  笔记本上打开不会越过屏幕边缘；
- 位置只在一块屏上还看得见时才用（要求至少 120×60 落在某块屏里；往左上角拖出去
  一半这种常见用法仍然算看得见），否则交给系统居中；
- 分栏只做正向校验（> 0），真正的夹取留给 `computeSplit`——它知道窗口现在多宽、
  两侧的最小宽度是多少；
- 文件读坏 / 是数组 / 根本不是对象 → 出厂大小，和以前完全一样。

## 验证

- 单测：`scripts/check-window-state.mjs`（8 例：默认值、原样恢复、屏幕外的位置被
  丢掉、部分露出仍保留、比屏幕大的尺寸被夹、坏值退回、分栏只收正数、最大化标记）。
- 真机：写入 `{"width":1300,"height":820,"x":80,"y":70,"split":520}` 后重启 →
  `window.outerWidth/outerHeight = 1300×820`、`innerWidth 1300 / innerHeight 788`、
  `getLayout().split = 520`；再调 `setSplit(660)` → 被夹到 580（窗口 1300 宽，
  应用列最少 720）并**写进文件**，证明写盘这条路是通的。
- `check-app-layout`：10 项全过（分栏恢复成最小值 380 时，输入框仍在可视区内）。
