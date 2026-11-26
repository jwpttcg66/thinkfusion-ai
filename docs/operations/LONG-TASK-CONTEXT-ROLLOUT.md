# 长任务上下文管理器：启用、诊断与回退

当前实现状态见 [STATUS.md](../implementation/STATUS.md)。这份手册只描述**现行开关**；早期 `off/shadow/active` 多阶段灰度提案已归档，当前代码没有 `shadow` 模式。

## 开关优先级

1. 环境变量 `THINKFUSION_CONTEXT_MANAGER`；
2. userData 中的 `context-manager.json`，格式 `{ "enabled": true }`；
3. 未配置时默认关闭。

环境变量支持 `active` / `1` / `on` 开启，`off` / `0` 关闭。其它值不覆盖配置文件。
配置文件是运维配置，不是 UI 设置项；修改后建议重启应用并核对实际事件。

## 启用步骤

1. 先备份默认 userData 目录，尤其是 `agent-store.json` 与 `context-checkpoints/`。
2. 设置 `THINKFUSION_CONTEXT_MANAGER=active`，或在 `context-manager.json` 写入 `{ "enabled": true }`。
3. 重启 ThinkFusion，确认请求能正常响应。
4. 观察 `context.prepared`、`context.compaction.*`、`context.recovered` 事件；详情和上下文统计在工程工作台/轨迹中查看。
5. 窗口、Token、Usage 未知时应保持“未提供”，不得以 `0` 或估算百分比冒充真实值。

上下文事件和 payload 唯一规范见 [LONG_TASK_CONTEXT_CONTRACTS.md](../spec/LONG_TASK_CONTEXT_CONTRACTS.md)。

## 关闭与回退

- 设置 `THINKFUSION_CONTEXT_MANAGER=off`；环境变量优先级最高。
- 或将配置文件设为 `{ "enabled": false }`，再重启。
- 关闭只停止新的上下文准备/压缩，不自动删除已提交检查点；不要手动删除 `context-checkpoints/` 来“回滚”。
- 如果检查点缺失、hash 不匹配或归档不完整，任务应停在 stale/interrupted 并要求人工核对，不得继续使用半成品摘要。
- 摘要生成或提交失败时应回退到未压缩上下文并记录失败事件。

## 备份要求

需要迁移或恢复 userData 时，`agent-store.json` 和整个 `context-checkpoints/` 必须来自同一份备份；只恢复其中一侧可能令活动指针变为 stale。备份/恢复工具是否自动包含该目录，以当前发布检查清单为准；未确认前不得宣称自动备份已覆盖。
