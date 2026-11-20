# V3 实施完成度审计

日期：2026-11-20。
基线：本地 `main`（未推送）+ 任务分支 `p0-p1-bootstrap`。
依据：`TASK-BOOK.md` 任务总表、`typecheck`、新增测试脚本。

## 0. 设计状态

A-03/A-04、B、C、D、E 的设计已完成，见
[V3-FORMAL-FEATURES-DESIGN.md](V3-FORMAL-FEATURES-DESIGN.md)。
下表统计的是**实施完成度**，不是设计完成度。

## 1. 总览

| 阶段 | 完成 | 部分 | 未开始 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| P0 | 6 | 0 | 0 | 6 |
| P1 | 14 | 3 | 0 | 17 |
| P2 | 6 | 0 | 0 | 6 |
| P3 | 9 | 0 | 0 | 9 |
| P4 | 6 | 1 | 0 | 7 |
| P5 | 5 | 0 | 0 | 5 |
| P6 | 5 | 3 | 0 | 8 |
| UI | 0 | 1 | 6 | 7 |
| X | 0 | 2 | 2 | 4 |
| **合计** | **51** | **10** | **8** | **69** |

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
| P4-06 | 质量门禁接 CI |
| UI-01 | 计划视图数据层已有；组件未做 |
| X-02 | test:core 已有；全量分组待做 |
| X-04 | 发布清单已有；实际发布未做 |
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

**未达到 69/69。** 核心引擎、知识、工程、证据、通道、发布模块已完成并有测试；
剩余集中在 UI、旧模块删除、发布签名与全量回归。不能标记 V3 完成。
