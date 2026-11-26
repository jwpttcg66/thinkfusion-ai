# ThinkFusion macOS 应用

> 仓库整体产品方向与当前能力：[根目录 README](../README.zh-CN.md)；唯一当前实现状态：[STATUS](../docs/implementation/STATUS.md)。

此目录是 ThinkFusion 的 Electron 应用：主进程负责路由、协作和存储；Preload 暴露受限 IPC；Renderer 展示真实任务/会话事件；工程工具由独立 UtilityProcess Runtime 执行。

## 环境与启动

- macOS（Apple Silicon 为主要打包目标）
- Node.js `>=22.12`、npm `>=10`
- Electron 版本以本目录 `package.json` / lockfile 为准

```bash
npm install --no-audit --no-fund
npm run typecheck
npm test
npm run dev
```

`npm test` 运行离线测试集合。实时 DOM、TCC、外部 CLI、签名/公证不由普通离线测试代替；验收范围见 [docs/TEST_PLAN.md](docs/TEST_PLAN.md)。

## 核心请求路径

- **General / Knowledge**：ConversationRunner 按执行配置选择 Web、Local、Cloud、CLI 参与者，结果和运行事件持久化后投影到 UI。
- **Engineering**：模型路由 → 计划 schema 校验 → 审批/授权 → UtilityProcess 逐步执行 → ExecutionReport → 验证/评审/交付。
- Web 输出、模型回答和工具结果都是不可信数据；计划经 schema 校验、授权后才能交给 Runtime。
- 当前工程功能、限制和已知缺口统一见 [状态板](../docs/implementation/STATUS.md)，不在此复制工具数量或状态矩阵。

## 应用层文档

- [文档索引](docs/README.md)
- [Protocol](docs/PROTOCOL.md)：`desktop-agent/v1` 请求/计划/报告结构
- [IPC](docs/IPC.md)：Renderer 到主进程的可信调用边界
- [CLI Agents](docs/CLI_AGENTS.md)：Qoder / Claude 适配和验证
- [Test Plan](docs/TEST_PLAN.md)：离线与真实应用验收范围
- [Security](SECURITY.md)：权限模型、隔离和已知限制
- [Harness Comparison](docs/archive/research/HARNESS_COMPARISON-2026-11-07.md)：历史外部工具调研参考，不是运行时依赖

## 构建与打包

```bash
npm run build
npm run package:mac
```

签名与 notarization 是否完成请查根目录状态板/发布清单；未完成前产物只适用于本地测试。
