# ThinkFusion AI

**Many Minds. One Intelligent Workflow.**

ThinkFusion 是一个多模型协作工作平台：用户提出目标，系统按任务组织网页、本地、云端模型、工具与知识，记录执行事实并交付可检查的结果。辩论、评审和交叉验证是按需行为，不是所有任务的固定流程。

## 当前能力

产品愿景与当前实现分开维护：

- **产品方向**：[docs/PRODUCT.md](docs/PRODUCT.md)
- **当前实现、测试和已知缺口（唯一状态来源）**：[docs/implementation/STATUS.md](docs/implementation/STATUS.md)
- **代码架构与调用边界**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **完整文档地图**：[docs/README.md](docs/README.md)

ThinkFusion 提供通用协作、知识学习和工程工作空间。工程执行由单独的 UtilityProcess Runtime 处理；网页文本作为不可信输入，执行报告和验证结果保留来源。上下文检查点能力存在，但默认关闭，受运维配置控制。具体支持范围与限制以状态板为准。

## 快速开始

要求：macOS、Node.js `>=22.12`、npm `>=10`。

```bash
cd desktop-agent-macos
npm install --no-audit --no-fund
npm run typecheck
npm test
npm run dev
```

真实应用测试和限制见 [desktop-agent-macos/docs/TEST_PLAN.md](desktop-agent-macos/docs/TEST_PLAN.md)。

## 仓库结构

```text
desktop-agent-macos/  Electron 主进程、Preload、React Renderer 与隔离 Runtime
packages/            可复用组件
scripts/             仓库维护脚本
docs/                产品、架构、契约、ADR、实施状态与验收证据
```

## 重要边界

- 用户问题不套固定话术；Web 保持原话输入，CLI 不伪造 system turn。
- 工程进度必须能回到真实事件、工具结果、测试或文件改动。
- 摘要不是执行事实；未知的窗口、Token 或费用不补造数字。
- 代码变更与对应契约/测试同一任务更新；禁止未经授权推送。

开发约定见 [AGENTS.md](AGENTS.md)。
