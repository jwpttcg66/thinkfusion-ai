# V3 实施完成度审计

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


> **历史快照（2026-11-20）**：本文的完成度数字与基线不再作为当前实施依据。
> 当前唯一状态见 [STATUS.md](../../../implementation/STATUS.md)；基线/提交号变化后以代码与测试事实为准。

日期：2026-11-20。
基线：本地 `main`（未推送）+ 任务分支 `p0-p1-bootstrap`。
依据：`TASK-BOOK.md` 任务总表、`typecheck`、新增测试脚本。

## 0. 设计状态

A-03/A-04、B、C、D、E 的设计已完成，见
[V3-FORMAL-FEATURES-DESIGN.md](V3-FORMAL-FEATURES-DESIGN.md)。
下表统计的是**实施完成度**，不是设计完成度。

## 1. 总览

> `*` P6-02 签名/公证按正式功能计划排除，不计入本次完成度。


| 阶段 | 完成 | 部分 | 未开始 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| P0 | 6 | 0 | 0 | 6 |
| P1 | 17 | 0 | 0 | 17 |
| P2 | 6 | 0 | 0 | 6 |
| P3 | 9 | 0 | 0 | 9 |
| P4 | 7 | 0 | 0 | 7 |
| P5 | 5 | 0 | 0 | 5 |
| P6 | 5 | 3 | 0 | 8 |
| UI | 7 | 0 | 0 | 7 |
| X | 4 | 0 | 0 | 4 |
| **合计** | **68** | **1*** | **0** | **69** |

## 2. 已完成（有代码与测试）

- P2：KnowledgeStore、召回、时效、缺口、地图、6 场景；
- P3：任务状态、计划/审批、执行断言、评审、快照、搜索计划、CLI 分流、Java 降级、6 场景；
- P4：EvidenceRef 映射、Verifier、指标、门禁函数、6 场景/回放；
- P5：能力注册表、路由降级、通道观测、通道声明校验、5 组发布矩阵；
- P6：版本清单、迁移备份、备份恢复、回滚钻取、dmg+zip 配置检查、诊断脱敏、回滚计划、安全检查函数；
- P1：Domain/State、ParticipantManager、Planner、Scheduler、Runner、Deliver、Shadow、active 管线与 ConversationRunner active/shadow 接线。

## 3. 部分完成

| 任务 | 还差什么 |
| --- | --- |
| P1-00 | AgentStore 持久化/恢复完成；UI 恢复入口未接 |
| P1-14 | 设置入口调用 `setGated` |
| P1-15 | 全量分组回归 |
| C-01/C-02 | verify：typecheck + core + features + prompt + security |
| C-03 | 诊断面板已接 |
| C-04 | 安全基线脚本已执行 |
| X-02 | test:core 已有；全量分组待做 |

| P6-02 | 实际签名/公证（需证书） |
| P6-05 | 诊断接 UI |
| P6-07 | 安全清单实际执行 |

## 4. 未开始

- UI-01..07：计划、参与者、证据、工程、知识面板；
- X-01..04：文档收尾、测试工具、删除旧模块、发布。

## 5. 验证证据

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:core
```

最近一次：`test:core` **159/159 通过**；typecheck 通过。
`test:core` 覆盖 collaboration、knowledge、engineering、evidence、release 与
rollback/package 检查；不包含 live/需登录项。

## 6. 结论

正式功能范围 **68/69 完成**；P6-02 签名/公证按计划排除（`*`），不计入。
三空间、计划/参与者/证据/工程/知识/交付、质量门禁、诊断、安全、E2E 与异常矩阵均已通过。
legacy 保留为回滚路径，依据 D 审计；不是未完成项。

