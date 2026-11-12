# 工程智能产品形态：Core / Enhanced

日期：2026-11-12。依据：`制定辩论主题方案 (8)-20261112-1840-2.md`。

## 1. 决策

```
Core（默认）      本地 AST + SQLite + FTS5 + Vector + Project Memory
Enhanced（可选）  连接外部 CGC / Graphiti / Neo4j
Managed（后续）   ThinkFusion 自动管理 Python/Neo4j 生命周期
```

Core 必须永远可独立运行；Enhanced 是可选增强；Managed 暂不实现。

## 2. Core

- 安装即用，不要求 Python、Neo4j、Podman、Docker；
- 代码索引、中文 FTS、Vector（all-minilm）、工程记忆、Code-Memory Link；
- 外部组件不可用时自动留在 Core，检索 warning 说明降级原因。

## 3. Enhanced

设置 → 工程智能：

- 运行模式：本地回退 / 外部服务；
- CodeGraph（CGC）开关；
- Graphiti 开关；
- Neo4j HTTP 地址、用户、密码（密码走 ApiKeyStore，不落明文）；
- 连接测试 + 状态（CGC ready/error、Graphiti ready/error、最后检查时间）；
- 保存后热更新 Adapter，不需要重启。

环境变量仍可作为开发者覆盖：

```
THINKFUSION_NEO4J_HTTP
THINKFUSION_NEO4J_USER
THINKFUSION_NEO4J_PASSWORD
```

外部地址只要求 Neo4j HTTP 事务端点（默认 7474）。CGC/Graphiti 的 Python 运行时
仍由用户或后续 Managed 模式提供，不随 Core 安装。

## 3.1 Managed（本机 Neo4j 生命周期）

设置 → 工程智能增加：

- 「由 ThinkFusion 管理本机 Neo4j」；
- 启动应用时自动启动 / 退出时自动停止；
- Neo4j 安装目录（含 `bin/neo4j`）；
- 启动 / 停止 / 重启 / 检查版本；
- 健康检查走 Neo4j HTTP，不把「进程起来了」当成「服务可用」。

边界：Managed 只管理用户已有的 Neo4j 安装目录；不下载二进制、不静默升级。
升级 = 替换安装目录后重启。CGC/Graphiti 的 Python 运行时仍不在 Managed 内。

## 3.2 工程删除

工程索引面板「危险操作：删除工程索引」：

- 删除本地 nodes/edges/docs/FTS/vectors/memory/links/generations/outbox；
- 可选 `THINKFUSION_CGC_PROJECT_PATH` 清理外部 CGC 路径；
- Graphiti 未按 project group_id 建映射，不猜测删除范围，明确返回 warning。

## 4. 无 Podman 路径

| 路径 | 状态 |
| --- | --- |
| 外部 Neo4j/CGC/Graphiti 服务 | ✅ Adapter 已接，设置页可配 |
| ThinkFusion 管理 Python/Neo4j | 未做，Managed 后续 |
| Podman/Docker | 仅开发/PoC，不是用户前提 |

## 5. 尚未解决

1. Neo4j GPLv3 分发法律结论；
2. Python 3.12 + CGC/Graphiti 的签名/公证/打包；
3. 单实例 vs 双实例资源压测；
4. Managed 生命周期（启动/停止/升级/清理）；
5. 项目删除时外部数据同步清理。

这些是发布决策，不是 Core 功能阻塞项。
