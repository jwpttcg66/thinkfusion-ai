# 阶段 A 真机验收：定位轨与「执行中 · N 秒」

- 时间：2026-11-26T03:54:16.908Z → 2026-11-26T03:55:33.607Z
- 任务：`bb3f98b3-1cb0-481d-9e84-210d544ca133`（隔离 userData `/tmp/tf-stage-a-userdata`，工作区 `/tmp/tf-stage-a-workspace`）
- 模型：["opencode-go:deepseek-v4.1-flash"]，权限档 `danger-full-access`（/tmp 一次性工作区；完全权限下计划自动批准、步骤不再逐次弹审批，否则模型那条 `npm test | head` 会被 shell 组合符规则拒掉）
- 真实 store：`/Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json` sha256 前后一致（`d3f40ebd501a`）

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| real-store-readable | PASS | /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json |
| renderer-ready | PASS | http://localhost:5173/ |
| model-configured | PASS | ["opencode-go:deepseek-v4.1-flash"] |
| task-terminal | PASS | completed |
| locate-rail-visible | PASS | rail=true grid=true |
| locate-rail-has-ticks | PASS | ticks=10 labels=["提问","计划 · 运行 npm test 并汇报输出开头","开始执行","方案评审","表态","轮间依据","执行前依据","验证通过","独立评审 · 通过","结论 · 目标物 1"] |
| each-tick-targets-a-real-anchor | PASS | targets=["stream-user-prompt","stream-plan-5467a073-32f5-4cf9-a074-f3fbc1a35296","stream-step-step-1:step-1","stream-debate-5467a073-32f5-4cf9-a074-f3fbc1a35296","stream-review:497454e0-4365-4a36-a845-374c9dadcc8e::0:opencode-go:deepseek-v4.1-flash","stream-review-bridge-5467a073-32f5-4cf9-a074-f3fbc1a35296-1-stop","stream-exec-bridge-5467a073-32f5-4cf9-a074-f3fbc1a35296-1795665297133","stream-verification-1795665305365-8","stream-review-1795665316805-9","stream-conclusion"] |
| tick-highlight-present | PASS | active=1 |
| running-step-shot | PASS | metas=["执行中 · 不到 1 秒"] |
| live-seconds-shown | PASS | 第一次 0 秒 |
| live-seconds-increase | PASS | 0 秒 → 2 秒 |
| no-stale-running-after-finish | PASS | running=0 |
| click-tick-scrolls-to-anchor | PASS | {"ok":true,"top":579,"inViewport":true} |
| real-store-untouched | PASS | d3f40ebd501a → d3f40ebd501a |

## 截图

- `01-run-in-progress.png`
- `02-run-in-progress-later.png`
- `03-completed.png`
- `04-jump-to-conclusion.png`

> 截图来自真实 Electron 渲染进程（CDP `Page.captureScreenshot`）。
> 这个任务是真的跑了一遍 `npm test`（脚本里故意睡 8 秒），不是摆拍的假事件。