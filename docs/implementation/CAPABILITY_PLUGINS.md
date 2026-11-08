# 所有本地能力与保存都是插件

> 2026-11-08，分支 `0.1.3`。用户裁决：「所有本地能力和保存，都看齐 deepseek harness 都是插件」。
> 形态确认：自研轻量插件注册表，覆盖全部本地能力与全部保存；不引入 cordis、不开放第三方包。

## 1. 原来错在哪

应用里其实一直有 29 个本地工具、一次工程证据读取、两种保存动作，但设置页的
「内置插件」写着「还没有插件」。这不是文案写错，是架构上它们确实不是插件：

| 位置 | 原来的形态 | 后果 |
| --- | --- | --- |
| `src/agent/index.ts` | 一整段 `switch (step.tool)`，29 个 case 直接调实现函数 | 加一个能力要改主循环；能力没有统一清单、权限说明、开关 |
| `src/main/engineering/project.ts` | `conversation-runner` 直接 import `scanProject` | 工程空间「读本机文件」游离在能力体系之外 |
| `src/main/index.ts` 的两个 IPC | `document:export` / `page:save-document` 各自组装 deps 再调实现函数 | 保存能力是两段散装代码，界面和宿主都不知道它们存在 |
| `SettingsPanel` 的「内置插件」 | 「还没有插件」 | 用户看到的能力与应用真正能做的事对不上 |

DeepSeek Harness 里这些能力都是插件：挂到 `ctx.tools` 之类的服务上，声明依赖，
宿主按 id 查表分派，注册可逆、清单可见。我们抄这个形状，不抄它的依赖链
（[HARNESS_BASELINE](../desktop-agent-macos/docs/HARNESS_BASELINE.md) 的既有决定仍成立：
不装 cordis、不要求 node ≥24.9、不引入 232 MB monorepo）。

## 2. 一套契约、一份清单、两个宿主

```
src/shared/capabilities.ts        契约 + 全量清单（32 条）+ CapabilityRegistry
        │
        ├── src/agent/local-plugins.ts        Runtime：29 个本地工具
        │        └── src/agent/index.ts       只剩 localCapabilities.execute(step.tool, …)
        │
        └── src/main/capabilities/index.ts    主进程：project.scan / document.export / page.save-document
                 ├── src/main/conversation-runner.ts  工程证据改走 project.scan 插件
                 └── src/main/index.ts                两个保存 IPC 改成查表执行
```

- `CapabilityPlugin` 只有 `run(args, context)` 是必须实现的，其余是登记信息
  （`id` / `kind` / `host` / `title` / `description` / `permission`）。参数与环境由宿主给，
  插件不抓全局状态——对应 harness 的 `inject`。
- `CapabilityRegistry.register()` 返回 disposer，注册是可逆的副作用（对应 `ctx.effect()`）。
  重复注册、清单外的 id、没有 `run` 都直接拒绝。
- `execute(id, args, context)` 是唯一执行入口。未装载、被停用都**明确报错**，不静默跳过。
- 清单是共享的，两个宿主和设置页读的是同一份 `CAPABILITY_CATALOG`，不会各抄一份名字。

两个宿主不是两套体系：本地工具必须在 Runtime 进程跑（权限、工作区边界、执行日志），
保存与页面探针必须在主进程跑（会话存盘、保存对话框、`WebContentsView`）。
dsh 自己也有 `cordis-host-runner` / `cordis-client-runner` 这种双半包。

### 清单

| 宿主 | 类别 | 数量 | 例子 |
| --- | --- | --- | --- |
| `runtime` | 本地能力 | 29 | `fs.readFile` / `fs.edit` / `shell.run` / `web.fetch` / `code.run` … |
| `main` | 本地能力 | 1 | `project.scan`（工程证据读取） |
| `main` | 保存 | 2 | `document.export`（会话 md/docx）、`page.save-document`（网页文档与计划） |

权限也进了清单：只读 10 个（`READ_ONLY_TOOLS`）、工作区可写、`process.kill` 是完全权限。
`project.scan` 只读，两个保存是工作区可写。这层是清单展示；真正的强制仍由
`assertGrant` / `resolveGrantedPath` 在每一步执行时做，没有因为插件化而放宽。

## 3. 执行链路改了什么

**Runtime**：`agent/index.ts` 里的 29 个 case 全部删掉，实现函数一个字没动，只是
挪进 `local-plugins.ts` 注册。插件返回 `LocalStepOutcome`，把原来散在 switch 里的
后置判断收进插件自己：

- `test.run` / `shell.run` / `code.run` 的非零退出码算「失败」而不是异常，
  并带上 `TEST_FAILED` / `COMMAND_FAILED`；后台作业没有退出码，不算失败；
- `fs.writeFile` 写完回读验证，`app.open` 回读进程确认；
- `web.search` 搜到 0 条不算失败（没资料不是操作失败）。

宿主只剩「验证计划与授权 → 查插件 → 记日志 → 推进」，不再认识任何具体工具。

**主进程**：`document:export` 与 `page:save-document` 的 IPC 现在只校验输入，然后
`mainCapabilities.execute(...)`。会话存盘、`dialog.showSaveDialog`、页面探针
（`PROBE_SCRIPT(..., true)`、页面未打开/加载中/登录页的报错）都收进
`MainCapabilityContext` 由宿主注入。工程空间的两处 `scanProject(...)` 调用改成
`mainCapabilities.execute<ProjectScan>('project.scan', ...)`。

内容侧与格式规则一个字没改：导出仍是本机拼稿、默认 md、只有点名 `doc/docx/word`
才动态加载 docx 模板；网页文档仍是页面回答原文 + 规则识别的计划条目。

## 4. 开关

- 设置 → 内置插件：按「本地能力 / 保存」分组列出 32 条，每条有名字、id、说明、
  权限与开关，分组标题显示 `已启用 / 总数`。
- 状态存 `userData/capabilities.json`，只记「被停用的 id」——新增插件默认就是开的。
  文件坏了按全启用处理，不猜半截 JSON。
- `capabilities:set` 更新磁盘后同步 `mainCapabilities`；Runtime 读不到 userData，
  由 `agent-manager.runPlan()` 把 `disabledCapabilities` 随每次 `task.run` 下发。
  因此开关对**下次执行**生效，不会中途改掉正在跑的计划。
- 停用的能力执行时抛「能力插件已停用：xxx」，主进程与 Runtime 各守一道。

## 5. 验证

- `scripts/check-capabilities.mjs`（15 条）：清单与权限、注册表可逆与报错、
  两个宿主的注册集合、四类插件真干活（读目录、扫工程、导出会话 md、
  保存网页文档都落盘回读）、开关落盘与下发、防回归断言（源码里没有
  `switch (step.tool)`、设置页不再写「还没有插件」）。
- 全量 `npm test` 在原有 739 条之外叠加这 15 条；`npm run typecheck` 三套通过。
- 既有验收脚本对导出的格式默认值、页面探针开关、工程证据统计都继续全绿，
  说明插件化没有改变这些能力的对外行为。
- **真机 s29**（2026-11-08，最新 `npm run build` 重启应用后，用应用自己的
  preload API 核对，`/tmp/tf21/s29-capabilities.mjs`）**13/13**：
  清单 32 条 / 本地 30 + 保存 2 / Runtime 29 + 主进程 3 / 权限分层正确；
  停用 `document.export` 后导出明确报「能力插件已停用：导出会话文档」，
  重新启用后走到「这条会话已经不在了，没法导出」（证明确实又执行了插件）；
  设置页 DOM 里 32 行插件、32 个开关，分组标题「本地能力 30/30 已启用」
  「保存 2/2 已启用」，不再有「还没有插件」；测完开关全部恢复，
  `capabilities.json` 为 `{"disabled":[]}`，没有留下测试状态。

## 6. 刻意不做

- **不引入 cordis / dsh 运行时**：一次注册与一次查表用不了整个插件框架。
- **不加载第三方插件、不做插件市场**：ROADMAP 里「接口还没稳定，开放出去就是负债」
  这条仍然成立；这里做的是把**内置**能力收进插件契约。
- **开关不卸载实现**：卸载了就没法一眼看出少的是谁；停用只拦截执行。
- **不给插件发模型、发提示词**：能力插件只在本机干活，回答仍由提问链路产生。
