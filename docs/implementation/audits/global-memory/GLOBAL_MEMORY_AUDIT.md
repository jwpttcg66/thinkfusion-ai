# 全局记忆系统 · 审计证据（P0 归档）

> 审计基线：`main @ 1e8d5ec9bdd1fffbdc6a6c15b9b396c6d6b16916`（本地 `1e8d5ec`）。
> 检查范围：`desktop-agent-macos/src` 全仓引用、主进程装配、对话/工程/协作/辩论入口、`package.json` 测试链。
> 方法：逐符号 grep + 读实现 + 追调用。归档时复核过行号未漂移。

## 1. 事实清单

| 结论 | 证据 |
|---|---|
| `KnowledgeStore`/`KnowledgeIndex`/`gap` 生产零调用 | 全仓仅 `knowledge/page-extract`、`knowledge/map` 被引（`conversation-runner.ts`、`collaboration/details.ts`）；`store.ts`(98)/`index.ts`(57)/`gap.ts`(85) 无外部引用 |
| 这三个文件有测试在跑 | `check-knowledge-{store,recall,scenarios,gap}.mjs`；经 `test:core`／`test:features` 进 `verify` |
| 主进程无 Knowledge 装配 | `src/main/index.ts` 无 `knowledge/` 引用；有 `codeIndexService`（`userData/code-index.sqlite`） |
| 项目记忆是活的 | `code-index:remember`（`index.ts`）、`CodeIndexPanel.tsx`、`retrieval.ts`（candidate 默认、confirmed 必须有 source） |
| 召回是整句匹配 | `knowledge/index.ts` `statement.includes(q)`；`code-index/store.ts` `LIKE '%q%'` |
| 损坏即覆盖 | `knowledge/store.ts` catch → `empty()`；`addCard` 后 `save()` 整文件重写 |
| 删工程会删记忆 | `code-index/store.ts` `deleteProject` 截断表含 `code_memory_facts` |
| 链接无外键 | `code-index/store.ts` `code_memory_link.memory_entity_id` 无 REFERENCES |
| Provider 支持 system/context | `providers/types.ts`；`ollama.ts`/`openai-compatible.ts` 的 `messages()` |
| CLI 无 system 轮次 | `cli-answer-agent.ts` 拼文本前缀；第一轮逐字原话 |
| 对话事件族无请求 id | `shared/conversation.ts` 只有 channelId/message/trace；`modelCallId` 仅在 `round.*` |
| 工程 system 的"只依据这些证据" | `research/engineering-round.ts` `engineeringAnswerSystem()` |
| 网页原话直发 | `master-agent.ts` 注释即规则；`askOne` 构造 `{question, stage}` |

## 2. P0 复核结果（本次执行）

| 检查 | 结果 |
|---|---|
| 基线 HEAD | `1e8d5ec9bdd1fffbdc6a6c15b9b396c6d6b16916` |
| 工作区 | 干净，无未提交改动 |
| 四入口是否仍成立 | 成立：`master-agent.ts::askOne`、`collaboration/runner.ts::runTask` 的 `pool.ask`、`conversation-runner.ts` 工程/辩论分支、`SubAgentRegistry.ask/askStream` 为共同收口 |
| `projectIdFor` 是否唯一实现 | 是唯一实现，但在 `code-index/service.ts` 内私有（`p_` + sha256(root) 前 24 位）→ P1 提到 `shared/project-id.ts` |
| Provider 是否已透传 `requestId` | `ModelRequest.requestId` 已存在（用于 cancel），但 `SubAgentTask` 没有 → P1 冻结契约 |
| 死代码范围 | `knowledge/{store,index,gap}.ts` 与 4 个测试脚本；`types/freshness/map/page-extract` 仍被使用，保留 |

## 3. 七处 V2 修正（实现时不得采用 V2 措辞）

| V2 说法 | 事实 | 影响 |
|---|---|---|
| "知识存储未证明构成应用级链路" | 是零调用死代码，且有 4 个测试在跑 | 退役，不是接线 |
| "KnowledgeIndex 支持规则匹配" | 整句 `includes`，近乎不命中 | 召回重写 |
| "CodeIndex 记忆属可选增强" | 唯一在用的项目记忆，已有 candidate/confirmed | 提为 P1 迁移源 |
| "P0 再明确 MemoryRecord 与 KnowledgeCard 关系" | 已定：MemoryRecord 独立，KnowledgeCard 只留知识地图 | 不留到 P0 |
| "本地/云端/CLI 结构化注入" | CLI 无 system 轮次 | CLI 不注入 |
| "验收按 modelCallId" | 对话事件族无此 id | 先补 requestId（P1 冻结、P4 接线） |
| "引用路线图 P2" | ROADMAP P2 是知识学习空间，不含跨会话记忆 | 单独挂实施索引 |

## 4. 数据契约归属（冻结）

| 结构 | 归属 | 说明 |
|---|---|---|
| `KnowledgeCard` | 知识地图（`knowledge/map.ts`），不承担长期记忆 | 保留，不改 |
| `code_memory_facts` | 旧项目记忆，P1 迁入 `memory_records` 后只读 | 不改名、不删表 |
| `code_memory_link` | 代码索引产物，留原库 | 只读解析 |
| `MemoryRecord` | 新建 `userData/memory.sqlite` | 唯一长期记忆表 |
