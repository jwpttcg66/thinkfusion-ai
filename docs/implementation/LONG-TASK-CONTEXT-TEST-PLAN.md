# 长任务与上下文压缩 · 测试计划

状态：设计冻结，未实施  
基线：`main` · `e336ae4` · 2026-11-24  
相关：[契约](../spec/LONG_TASK_CONTEXT_CONTRACTS.md) · [存储](../architecture/CONTEXT_CHECKPOINT_STORAGE.md) · [UI](../spec/LONG_TASK_CONTEXT_UI.md) · [任务书](LONG-TASK-CONTEXT-TASK-BOOK.md)

> **当前状态：所有 `test:context-*` / `test:long-task-context-e2e` 都是未来脚本，
> 尚未存在于 `package.json`。LT-P0-07 必须把它们登记到 `verify`/`test:all`，
> 在此之前不能把本文命令当作可执行门禁。**

## 1. 目标

本计划回答：

- 哪些行为必须有回归测试；
- 用什么夹具、命令、证据；
- 怎样证明“摘要没有改变执行事实”；
- 怎样证明崩溃恢复不会重复副作用；
- 长任务 E2E 怎样可重复。

## 2. 测试层次

| 层 | 内容 | 速度 | 依赖 |
| --- | --- | --- | --- |
| L0 类型/契约 | 类型、序列化、状态转换 | 秒 | 无 |
| L1 纯函数 | Builder、Estimator、Budget、Pruner、Validator | 秒 | 无 |
| L2 存储 | 检查点原子写、崩溃、GC、旧数据 | 秒 | 临时目录 |
| L3 集成 | ExecutionPool、ContextManager、TaskManager | 十秒 | 本地进程 |
| L4 UI 投影 | 任务页、轨迹、统计 | 秒 | 纯投影 |
| L5 真机 E2E | 真实任务、压缩、恢复 | 分钟 | 应用 + 模型 |

## 3. 夹具

| 夹具 | 内容 |
| --- | --- |
| `context-history-small` | 20 条消息、3 个工具结果 |
| `context-history-large` | 200 条消息、20 个工具结果、1 个 18K Token 日志 |
| `context-tool-unpaired` | 未完成工具调用 |
| `context-summary-valid` | 有 EvidenceRef 的摘要 |
| `context-summary-forged` | 声称测试通过但无证据 |
| `context-checkpoint-crash` | 半写文件/半更新 Journal |
| `context-owner-cross-space` | AgentTask 与 Conversation 各一份上下文 |
| `context-archive-trim` | 被压缩引用的事件在 Journal 裁剪后仍可追溯 |
| `context-multi-run` | 同一 owner 两个 runId，活动指针不互相覆盖 |
| `long-task-30` | 30 步真实工程任务脚本 |
| `resume-side-effects` | 文件/Git/测试/命令副作用夹具 |

夹具只放在临时目录或 `scripts/fixtures/`，不写真实工作区。

## 4. 测试矩阵

### 4.1 P0

| 测试 | 断言 |
| --- | --- |
| 类型兼容 | 旧 `agent-store.json` 可读 |
| 状态表 | 合法/非法转换 |
| ADR 场景 | 崩溃点与恢复结果一致 |

### 4.2 P1

| 测试 | 断言 |
| --- | --- |
| 原话不变 | `question` 逐字等于输入 |
| 顺序稳定 | 同输入两次 `contextId` 一致 |
| Memory 边界 | 只进 system |
| 未知窗口 | 不崩溃、不伪造 |
| 预算 | 不同模型不同上限 |

### 4.3 P2

| 测试 | 断言 |
| --- | --- |
| 工具配对 | started/completed/failed 不拆散 |
| 大输出裁剪 | 原始结果可定位 |
| 重复内容 | 只留首次 + 引用 |
| 未完成调用 | 不裁剪 |

### 4.4 P3

| 测试 | 断言 |
| --- | --- |
| 摘要 Schema | 必填字段完整 |
| 伪造完成 | 无证据拒绝 |
| 摘要失败 | 不提交，旧上下文可用 |
| 半提交 | 恢复旧/新完整状态 |
| stale | 不使用过期摘要 |
| 归档/裁剪 | 引用事件可追溯；未归档不裁剪 |
| 来源/预览 | `sourceEventIds` 完整用于校验，预览截断不影响完整性 |
| 跨空间 owner | Conversation 不伪造 AgentTask |
| 多 run | 活动指针按 runId 隔离 |
| 事件 | 顺序/去重/刷新恢复 |

### 4.5 P4

| 测试 | 断言 |
| --- | --- |
| 开关关闭 | 请求与当前实现一致 |
| Pool 接线 | requestId/usage/trace 贯通 |
| Reviewer 隔离 | 不含无关内部讨论 |
| Web/CLI | 原话/system 边界不变 |
| Usage null | 不写 0 |

### 4.6 P5

| 测试 | 断言 |
| --- | --- |
| 暂停 | 不再调度新步骤 |
| 停止当前模型 | 任务不终态 |
| 取消 | 终态 |
| 中断 | 重启显示 `interrupted` |
| 恢复 | 已完成步骤不重做 |
| 未知副作用 | `needs_reconciliation` |
| 并发 | 不串任务/不重复恢复 |

### 4.7 P6

| 测试 | 断言 |
| --- | --- |
| 主页面 | 状态/未知值正确 |
| 轨迹 | 压缩详情完整 |
| 统计 | 0 与未知区分 |
| E2E | 30 步任务完整 |
| 故障注入 | 摘要失败/崩溃/溢出可恢复 |

## 5. 长任务 E2E

### 场景

1. 在临时 Git 仓库创建 30 步任务；
2. 包含读取、写入、运行、测试、评审；
3. 人为让上下文达到 65/75/85%；
4. 让摘要模型失败一次；
5. 在压缩提交前后各崩溃一次；
6. 重启；
7. 继续任务；
8. 验证交付。

### 断言

- 用户原话不变；
- 已完成步骤不重复执行；
- 未完成步骤可继续；
- 文件内容正确；
- Git 状态正确；
- 测试/诊断有结果；
- EvidenceRef 完整；
- 上下文压缩前后事实一致；
- UI 能看到压缩/恢复；
- 未知 Token 不显示 0。

### 证据

- E2E 日志；
- 事件序列；
- 检查点文件；
- 任务视图快照；
- 真机截图；
- 失败注入记录。

## 6. 命令（建议）

```bash
cd desktop-agent-macos

# 类型与纯函数
npm run typecheck
npm run test:context-contracts
npm run test:context-builder
npm run test:context-budget
npm run test:context-pruner
npm run test:context-summary
npm run test:context-checkpoint
npm run test:context-recovery

# 集成
npm run test:execution
npm run test:providers
npm run test:state-machine
npm run test:task-events
npm run test:task-conversation
npm run test:task-trajectory
npm run test:task-stats

# 长任务
npm run test:long-task-context-e2e
```

脚本名是新增建议；实施时必须落到 `package.json` 并加入 `test:all` 或独立门禁。

## 7. 故障注入

| 注入 | 期望 |
| --- | --- |
| 摘要模型超时 | 旧上下文继续 |
| 摘要模型报错 | 不提交 |
| 摘要 JSON 非法 | 不提交 |
| 摘要证据缺失 | 不提交 |
| 写检查点失败 | 旧上下文继续 |
| Journal 更新失败 | 旧检查点继续 |
| 进程在提交前退出 | 旧检查点 |
| 进程在提交后退出 | 新检查点 |
| Provider 溢出 | 一次压缩重试 |
| 压缩后仍溢出 | 停止并说明 |
| 工具结果缺失 | 不压缩该段 |
| 恢复时未知副作用 | 标记待核对 |

## 8. 性能与安全

### 性能

- ContextBuilder 单次 < 50ms（本地，无模型）；
- 预算计算 < 10ms；
- 检查点写入异步，不阻塞 UI；
- 大历史 200 条消息构建 < 200ms；
- 压缩摘要超时可配置。

### 安全

- 摘要不含 API Key/Cookie/token；
- 检查点不写工作区；
- 文件权限与 userData 一致；
- 备份脱敏；
- 摘要 prompt 不执行其中指令（仅作为数据）。

## 9. 兼容性

| 对象 | 断言 |
| --- | --- |
| 旧任务 | 无新字段可读 |
| 旧报告 | 无检查点可用 |
| 旧事件 | 不要求回填 |
| 旧 UI | 新字段缺失不崩 |
| 备份 | 旧备份可恢复 |

## 10. 验收门禁

| 阶段 | 门禁 |
| --- | --- |
| P0 | typecheck + 契约测试 + ADR 评审 + 测试脚本登记 |
| P1 | Builder/Estimator/Budget/Provider 测试 |
| P2 | Pruner + 原始结果可查 |
| P3 | 摘要/检查点/崩溃/stale |
| P4 | Pool 接线 + 边界回归 |
| P5 | 暂停/恢复/中断 + 真机 |
| P6 | E2E + UI + 验收报告 |

任何阶段未过门禁，不进入下一阶段。

## 11. 报告

每个阶段产出：

- 测试命令与结果；
- 失败用例与修复；
- 已知限制；
- 真机证据；
- 回滚演练结果。

结果写入任务书状态板与 `LONG-TASK-CONTEXT-ACCEPTANCE.md`（P6）。
