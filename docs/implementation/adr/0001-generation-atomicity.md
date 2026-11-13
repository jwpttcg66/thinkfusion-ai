# ADR-0001：索引 Generation 的原子提交

- 状态：Proposed
- 日期：2026-11-12
- 适用：Gate 1

## 背景

当前 `generation` 只是 `code_generation` 表里的状态，不是读快照：

- `beginGeneration()` 只插入 `building` 记录；
- `replaceFileIndex()` 就地删除/写入当前文件的 nodes/edges/docs；
- `commitGeneration()` 只改状态，不切换数据；
- `failGeneration()` 不撤销已写入文件；
- 所有读查询只按 `project_id` 过滤，不过滤 generation。

因此构建失败/取消后，读路径会看到半新半旧的数据。V2 计划要求“任何阶段失败都不能破坏现有可用索引”，当前实现不满足。

## 决策

采用**写时复制（copy-on-write）的 Generation 快照**：

1. 每个 generation 的 nodes/edges/docs/FTS 行都带 `generation`，并进入唯一键：
   - `code_nodes(project_id, generation, node_id)`
   - `code_edges(project_id, generation, edge_id)`
   - `code_search_docs(project_id, generation, doc_id)`
   - `code_fts(project_id, generation, doc_id, ...)`
2. 新 generation 构建时：
   - 变更文件写新行；
   - 未变更文件用 `INSERT ... SELECT` 从上一 generation 复制到新 generation；
   - 不在新 generation 中原地修改旧行。
3. 构建完成后做完整性检查：
   - 每条边的 `source_node_id` / `target_node_id`（若非空）在新 generation 存在；
   - 没有 `target_node_id` 指向已删除符号而不标 `unresolved`；
   - 文件清单与 generation 对应。
4. 事务内把 `code_generation.status` 从 `building` 改为 `ready`，并标记旧 generation `superseded`；读路径只读 `current_generation`。
5. 旧 generation 在确认无 Pack 引用后清理；清理是独立的、可重试的任务。

## 为什么不选“就地写 + 读过滤”

就地写仍然会删除旧行；即使读查询过滤 generation，旧 generation 也已经被破坏。要保留旧快照，旧行必须存在。写时复制是唯一能同时满足“失败可回滚”和“旧数据可读”的简单方案。

## 代价

- 索引体积短期翻倍；需要清理策略。
- 未变更文件的复制成本；Gate 1 必须在 5k/10k 文件夹具上测量。
- FTS 行复制和查询过滤需要改 schema；FTS5 的 `generation` 列要作为 `UNINDEXED`。
- 现有 `promoteFileGeneration()` 不能再用；改为复制 + 新 generation。

## 迁移

1. Schema v4 增加 generation 到节点/边/文档/FTS 的唯一键。
2. 旧 v3 数据迁移为一个初始 generation（例如 1），`current_generation = 1`。
3. 迁移失败保留 v3 数据库备份；应用启动时只读旧库，不自动删。
4. `code_memory_link` 不按 generation 复制；提交后统一校验，无法确认的置 `needs_relink`。

## 验收

- 构建中途 `kill -9`：重启后 `current_generation` 仍是旧值，旧索引可查。
- 构建失败：新 generation 标 failed，读路径不可见；旧 generation 完整。
- 取消：同上。
- 10k 文件：复制 + 索引耗时可接受；磁盘增长可回收。
- 无悬空边；旧 generation 清理后 Pack 引用仍可解析或明确 stale。
