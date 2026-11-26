# ThinkFusion 应用测试与真实任务验收

测试分为离线断言和真实应用验收。离线通过不等于真机通过；每次验收报告必须记录代码基线、配置、任务/会话标识和可核对证据。

## 1. 离线验证

```bash
npm run typecheck
npm test
npm run build
```

重点测试族按功能组织在 `scripts/check-*.mjs`，`package.json` 中的 `test:*` 脚本是入口。不要在文档里固定测试数量；测试项会随版本变化。

主要覆盖：

- `protocol` / `prompt-policy`：计划/报告 schema、原话与协议边界；
- `runner` / `routing-model` / `execution`：空间路由、参与者选择、计划与执行；
- `task-*` / `task-view` / `task-events`：状态转换、事件流、历史恢复和 UI 投影；
- `providers` / `memory-*` / `context-*`：Provider 适配、Memory 和长任务上下文；
- `debate` / `dmoca` / `tdl` / `eco`：协作行为和投影的专项回归。

某项测试是否存在以 `package.json` 和 `scripts/` 为准；文档不保留易过期的断言总数。

## 2. 真实应用验收

依照根目录 [AGENTS.md §10](../../AGENTS.md) 使用 OpenIDEA 的 **ThinkFusion Dev**；等价终端配置是 `npm run dev:local`。真机任务必须走真实 Electron 主进程和 UtilityProcess，不以 UI mock 或报告模拟代替。

```bash
npm run dev:local
```

验收前确认没有另一个 ThinkFusion Electron 实例占用同一用户数据/窗口。只使用默认目录 `~/Library/Application Support/thinkfusion-ai`；未经用户明确同意不设置隔离 userData，不并行启动第二实例。

按本次改动选择相关场景：

- Web/Provider：问答输入原话、请求中止/静默超时、模型流式输出；
- Engineering：模型分流、计划、工具准备/审批、执行结果、文件变化、测试、评审、最终交付；
- 多模型：较慢参与者仍在输出时不得提前进入评审；真正连续静默后才停止；
- 长任务：压缩检查点、中断恢复、side-effect reconciliation；
- UI/投影：历史打开和实时事件得到相同结果，最终交付列出所有轮次产出文件与目录。

实时检查脚本用 CDP 读取真实 UI / 事件，不代表每个系统权限或像素行为都已覆盖。具体脚本以 `npm run` 列表为准。

## 3. 验收记录

专项真实验收证据集中在 `../../docs/implementation/acceptance/` 和 `../../docs/implementation/evidence/`；当前能力状态及未完成项只看 `../../docs/implementation/STATUS.md`。

每份新验收记录写明：

1. 启动配置和代码基线；
2. 使用现有任务还是新任务，任务/会话/运行 ID；
3. 观察到的原始事件和交付路径；
4. 通过项、失败项和未验证项。

没有真实证据时用 `TESTED`（仅自动化）或 `IMPLEMENTED`，不得标 `VERIFIED`。
