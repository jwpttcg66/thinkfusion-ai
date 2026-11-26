# P0-06 回滚演练记录

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


日期：2026-11-19。
基线：`main@8d937a4` + 本次 P0-04 实现。
目标：验证 `collaboration-mode.json` 在升级、降级、损坏、非法值下的行为。

## 1. 演练项

| 场景 | 动作 | 期望 | 结果 |
| --- | --- | --- | --- |
| 升级 | 写入 `active`，新实例读取 | 读到 `active` | 通过 |
| 未知字段 | 文件含 `future` 字段 | 仍读 `active`，不崩 | 通过 |
| 降级 | 删除模式文件 | 回 `legacy` | 通过 |
| 损坏 | 写入非 JSON | 回 `legacy`，不抛 | 通过 |
| 恢复 | 损坏后再写 `shadow` | 读到 `shadow` | 通过 |
| 非法值 | 写入 `nope` | 规范为 `legacy`，文件不被污染 | 通过 |

## 2. 执行方式

```bash
cd desktop-agent-macos
npm run build:test
node --test scripts/check-collaboration-rollback.mjs
```

结果：**4/4 通过**（每个用例含多个断言）。

## 3. 回滚触发条件

- 切 `active` 后出现任务丢失/重复执行/状态不可恢复 → 立即切回 `legacy`；
- 模式文件损坏 → 自动 `legacy`，不需要人工修文件；
- 用户升级后降级 → 旧版本忽略未知字段，读不到模式文件即 `legacy`。

## 4. 结论

P0-06 演练完成；回滚路径可用。正式集成到 UI/CLI 时仍需在真实会话上再演练一次。
