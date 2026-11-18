# 文档索引

本仓库只保留**仍然约束当前实现**的文档。历史实现日志、审计报告、一次性评审已移除，
需要时用 `git log` 查看当时的提交与说明。

## 先读这三份

| 文档 | 回答什么问题 |
| --- | --- |
| [PRODUCT.md](PRODUCT.md) | 产品要成为什么、三个空间、按什么原则取舍、什么算成功 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 五层基础架构、三套协议、两条主链路、目录职责 |
| [ROADMAP.md](ROADMAP.md) | P0–P5：现在在哪、下一阶段是什么、每阶段的完成判据 |

## 产品与架构设计（V3，2026-11-18 冻结，未实施）

| 文档 | 内容 |
| --- | --- |
| [architecture/COLLABORATION_ARCHITECTURE.md](architecture/COLLABORATION_ARCHITECTURE.md) | 统一协作引擎：任务图、调度、异构 Agent、证据与验证契约 |
| [architecture/ENGINEERING_WORKSPACE.md](architecture/ENGINEERING_WORKSPACE.md) | 工程空间：能力地图、任务状态、Agentic Search、CLI 协作与安全 |
| [architecture/MIGRATION_PLAN.md](architecture/MIGRATION_PLAN.md) | Debate / Evidence / 工程代码的迁移顺序、保留与降级清单 |

> 方向冲突时，以这三份设计为准；[ARCHITECTURE.md](ARCHITECTURE.md) 保留为基础架构描述。

## 工作流

| 文档 | 内容 |
| --- | --- |
| [git-workflow.md](git-workflow.md) | 提交规范、钩子、分支与 worktree 模型、发版流程 |
| [publishing.md](publishing.md) | 发布与维护 |
| [../AGENTS.md](../AGENTS.md) | 不可回退的工程约定（提示词、通道、结论、分支） |

## 规格（spec）

| 文档 | 约束什么 |
| --- | --- |
| [spec/DEBATE_ENGINE_TASK_V1.0.md](spec/DEBATE_ENGINE_TASK_V1.0.md) | 多模型辩论引擎的任务书与验收标准 |
| [spec/DEBATE_RUNBOOK.md](spec/DEBATE_RUNBOOK.md) | 辩论的配置、迁移、测试与运行手册 |
| [spec/DEBATE_LEAD_MODES.md](spec/DEBATE_LEAD_MODES.md) | 三种主导方式与归属规则 |
| [spec/CODE_INTELLIGENCE.md](spec/CODE_INTELLIGENCE.md) | 代码理解与代码编写的落地方案 |
| [spec/GENERAL_ENGINEERING_CAPABILITIES.md](spec/GENERAL_ENGINEERING_CAPABILITIES.md) | 工程能力的整体设计 |
| [spec/LOCAL_HARNESS_TOOLS.md](spec/LOCAL_HARNESS_TOOLS.md) | 本地工具目录与「刻意不做」清单 |
| [spec/CAPABILITY_PLUGINS.md](spec/CAPABILITY_PLUGINS.md) | 本地、联网、保存能力的插件契约 |
| [spec/PROGRESS_VISIBILITY.md](spec/PROGRESS_VISIBILITY.md) | 过程可见性：思考、汇总、执行都要看得见 |
| [spec/WEB_ANSWER_STREAMING.md](spec/WEB_ANSWER_STREAMING.md) | 网页回答流式呈现的边界 |
| [spec/OPENCODE_GO.md](spec/OPENCODE_GO.md) | OpenCode Go 云端源的模型目录与限制 |

## 架构决策记录（ADR）

| 编号 | 主题 | 状态 |
| --- | --- | --- |
| [0001](adr/0001-generation-atomicity.md) | 索引 Generation 的原子提交 | Proposed |
| [0002](adr/0002-symbol-and-edge-identity.md) | 符号身份与边模型 | Proposed |
| [0003](adr/0003-evidence-refs.md) | Engineering Evidence 的引用与冻结 | Proposed |
| [0004](adr/0004-agentic-search-runtime.md) | Agentic Search 的运行时接入 | Proposed |
| [0005](adr/0005-build-trust.md) | 构建信任边界 | Proposed |
| [0006](adr/0006-tree-sitter-runtime.md) | Tree-sitter 运行时与打包 | Accepted（Gate 0 spike） |
| [0007](adr/0007-config-driven-cli-adapter.md) | 配置驱动的 CLI Adapter | Accepted |

状态说明见 [adr/README.md](adr/README.md)。

## 测试与安全

| 文档 | 内容 |
| --- | --- |
| [testing/TEST_PLAN.md](testing/TEST_PLAN.md) | 测什么、怎么验、证不了什么 |
| [testing/SECURITY_REPORT.md](testing/SECURITY_REPORT.md) | 安全与隐私边界 |
| [../desktop-agent-macos/SECURITY.md](../desktop-agent-macos/SECURITY.md) | 应用的安全模型与限制 |
| [../desktop-agent-macos/docs/TEST_PLAN.md](../desktop-agent-macos/docs/TEST_PLAN.md) | 应用层测试与实机检查 |

## 应用层

| 文档 | 内容 |
| --- | --- |
| [../README.zh-CN.md](../README.zh-CN.md) | 仓库总览、当前能力、快速开始 |
| [../desktop-agent-macos/README.md](../desktop-agent-macos/README.md) | Electron 应用的结构与构建 |
| [../desktop-agent-macos/docs/PROTOCOL.md](../desktop-agent-macos/docs/PROTOCOL.md) | `desktop-agent/v1` 协议与解析 |
| [../desktop-agent-macos/docs/IPC.md](../desktop-agent-macos/docs/IPC.md) | IPC 通道清单与信任检查 |
| [../desktop-agent-macos/docs/CLI_AGENTS.md](../desktop-agent-macos/docs/CLI_AGENTS.md) | 外部 CLI Agent 接入 |
| [../desktop-agent-macos/docs/HARNESS_BASELINE.md](../desktop-agent-macos/docs/HARNESS_BASELINE.md) | 借鉴了谁、不依赖谁 |

## 文档约定

1. 语言：正文中文；代码、协议名、字段名保留英文原样。
2. 规格变更必须与代码同一提交：`docs/spec/` 里的契约改了，对应测试也要改。
3. 一次性材料（评审、审计、阶段日志、回归产物）不留在仓库里，写进提交信息或 `git log`。
4. 新增文档先回答「它约束哪段代码」；回答不了就不要新增。
