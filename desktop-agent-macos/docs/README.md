# 应用层文档

此处只记录 Electron 应用本身的接口、运行手册和测试约束。产品/领域层文档从
[`../../docs/README.md`](../../docs/README.md) 进入。

| 文档 | 唯一职责 |
| --- | --- |
| [PROTOCOL.md](PROTOCOL.md) | `desktop-agent/v1` 计划/报告解析协议 |
| [IPC.md](IPC.md) | Preload 与主进程 IPC 通道、来源校验 |
| [CLI_AGENTS.md](CLI_AGENTS.md) | Qoder/Claude CLI 接入和能力验证 |
| [TEST_PLAN.md](TEST_PLAN.md) | 离线测试、真机测试及测试不能证明的内容 |
| [HARNESS_COMPARISON-2026-11-07.md](archive/research/HARNESS_COMPARISON-2026-11-07.md) | 外部 Harness 调研参考；不是产品运行时依赖 |

已落地的任务规划胶囊设计/实施记录位于
[`features/task-plan-capsule/`](features/task-plan-capsule)。
