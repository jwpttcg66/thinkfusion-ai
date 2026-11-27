# ThinkFusion 文档入口

本仓库的文档按**用途与权威层级**组织，不把愿景、运行时事实、实施计划和验收证据混写。

## 唯一事实来源

| 问题 | 权威位置 |
| --- | --- |
| 产品总目标与总体架构约束 | [PRODUCT_ARCHITECTURE_BASELINE_V4.md](PRODUCT_ARCHITECTURE_BASELINE_V4.md)（V4.0.0 基准） |
| 产品目标与取舍（V3 时期说明） | [PRODUCT.md](PRODUCT.md) |
| 当前代码架构 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 优先级顺序（不维护实现状态） | [ROADMAP.md](ROADMAP.md) |
| 当前实现、测试、已知缺口 | [implementation/STATUS.md](implementation/STATUS.md) |
| 领域架构与设计方向 | [architecture/README.md](architecture/README.md) |
| 机器可读契约与行为规范 | [spec/README.md](spec/README.md) |
| 技术决策及其状态 | [adr/README.md](adr/README.md) |
| 实施计划、验收记录 | [implementation/README.md](implementation/README.md) |
| 发布与运行维护 | [operations/](operations) |
| 测试与安全 | [testing/](testing) |
| 已完成工作的历史材料 | [archive/README.md](archive/README.md) |

**实现状态只以 `implementation/STATUS.md` 为准。** 架构/规格文档可以描述目标和不变量；
它们不代表对应能力已经上线。验收报告只证明报告中写明的场景，不替代当前状态板。

## 目录地图

```text
docs/
├── PRODUCT_ARCHITECTURE_BASELINE_V4.md      产品总目标与总体架构基准（V4.0.0）
├── PRODUCT.md, ARCHITECTURE.md, ROADMAP.md   产品、代码架构、优先级
├── architecture/                            领域设计与目标架构
├── spec/                                    契约、行为及技术规范
├── adr/                                     架构决策记录
├── implementation/
│   ├── STATUS.md                            唯一实现状态
│   ├── plans/                               当前实施计划
│   ├── features/                            能力专项说明
│   ├── acceptance/                          验收报告
│   ├── audits/                              现状审计
│   └── evidence/                            可核对的测试/真机证据
├── operations/                              发布、兼容、运维
├── testing/                                 测试和安全
└── archive/                                 明确标记为历史的材料
```

应用内部的 IPC、协议、CLI Agent 和测试手册位于
[desktop-agent-macos/docs/README.md](../desktop-agent-macos/docs/README.md)。

## 文档维护规则

1. 一个主题只保留一个规范性来源；其他页面只链接，不复制整段契约、状态表或类型定义。
2. 代码/测试事实改动时更新 `implementation/STATUS.md`；无需在产品介绍、架构说明和验收记录中复制同一状态表。
3. 实施计划不能冒充运行时事实；完成的任务书移入 `archive/` 或验收目录，并标明其历史范围。
4. 真机报告必须包含任务/运行配置/可核对证据；不把未执行的场景写成通过。
5. 新增文档先说明它约束的代码、行为或运维流程；否则应并入已有文档。
