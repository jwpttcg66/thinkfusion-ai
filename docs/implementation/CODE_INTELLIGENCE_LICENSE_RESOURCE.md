# Code Intelligence：许可证与资源核查（2026-11-12）

## 1. 组件许可证

| 组件 | 许可证 | 当前用法 | 结论 |
| --- | --- | --- | --- |
| CodeGraphContext 0.6.13 | MIT | Podman PoC；可选 Adapter 只读 Neo4j | 可随应用分发（仍需保留版权声明） |
| Graphiti / graphiti-core 0.31.2 | Apache-2.0 | Podman PoC；可选 Adapter 只读 Neo4j | 可分发；保留 NOTICE/LICENSE |
| Neo4j Community 5.26 | GPLv3 | Podman PoC；未随应用打包 | **未做法律结论**；不能把独立进程当成自动免责 |
| FalkorDB 服务端 | SSPLv1 | 未采用 | 非 OSI；不能视为与 MIT/Apache 同等 |
| FalkorDB Lite (Python) | BSD | CGC 默认后端；PoC 中卡住，改用 Neo4j | 可用，但需锁定版本 |
| Kuzu | MIT | 未采用（Graphiti 已标 deprecated） | 不作为长期后端 |

## 2. 分发边界

当前实现：

- 应用默认只用本地 SQLite + AST + FTS5 + VectorStore；
- CGC / Graphiti 是**环境变量启用的可选只读 Adapter**：
  `THINKFUSION_NEO4J_HTTP` / `_USER` / `_PASSWORD`；
- 未配置时完全不连接 Neo4j，不依赖 Python/Podman；
- 不随 DMG 捆绑 Neo4j、Python、CGC、Graphiti。

因此当前发布不引入新的 GPL/SSPL 分发义务；一旦要把 Podman/Neo4j 作为正式运行前提，必须先做法律评估和安装包方案。

## 3. 资源实测/观察

| 项目 | 观察 |
| --- | --- |
| Podman machine | applehv / arm64 / 12 GiB / 16 CPU |
| Neo4j 5.26 容器 | 可启动，`cypher-shell RETURN 1` 通过 |
| CGC 索引样本 | 3 文件、5 CALLS、31.2s（容器） |
| Graphiti | 3 Episode、gpt-oss:20b 抽取、all-minilm 384 维；单条事实检索通过 |
| 本地索引 | 212 文件、1.8s、21.7MB（SQLite） |
| 本地向量 | 500 条 all-minilm、HYBRID 结果含 Vector 来源 |

未完成：双实例/并发压测、长时间内存曲线、DMG 打包体积、代码签名/公证、无 Podman 的正式安装路径。

## 4. 发布前必须补

1. Neo4j GPLv3 的分发方式（用户自装/应用下载/DMG 捆绑）法律结论；
2. Python 3.12 + CGC/Graphiti 的运行时打包或明确“用户可选安装”；
3. Neo4j/Graphiti 不可用时的 UI 降级提示（当前只有检索 warning）；
4. 资源上限：Neo4j heap/page cache、Worker 并发、Ollama 并发；
5. 项目删除时同步清理本地/外部两套数据。
