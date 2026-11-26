# M3 · CodeIndex 记忆写入路由切换任务书

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


> **目标**：让 `CodeIndexPanel` 新建的记忆进入**独立记忆库**（`memory.sqlite`），
> 旧表 `code_memory_facts` 从此**零新增**，只作为迁移来源与只读历史。
> 完成后，全局记忆只剩一个正式写入体系；`code_memory_link` 仍留在
> `code-index.sqlite`，只读解析。
>
> **基线**：`main @ 111fba5`（M2 可并行，但本 PR 不依赖 M2）。
> **前置**：M1 已签（471 项全绿）。
> **不做**：不搬 `code_memory_link` 表；不改 `question`；不引入向量库 / Graphiti；
> 不动 Debate（那是 M4）。

---

## 1. 现状与问题（为什么要改）

| 事实 | 位置 |
|---|---|
| `code-index:remember` 直接写旧表 | `src/main/index.ts` 的 `ipcMain.handle('code-index:remember')` → `CodeIndexService.remember()` |
| `CodeIndexService.remember` 调 `retrieval.remember(store, …)` | `src/main/code-index/service.ts:366` |
| `retrieval.remember` 执行 `INSERT INTO code_memory_facts` | `src/main/code-index/retrieval.ts:154` → `store.saveMemory()`（`store.ts:1195`） |
| `listCodeMemories` 读旧表 | `service.ts:406` → `store.listMemory()`（`store.ts:1219`） |
| 工程上下文/检索的 MEMORY 分支读旧表 | `retrieval.ts:51 retrieve()`、`:110 assembleContext()` |
| 界面状态里的记忆数读旧表 | `store.ts:824` |
| 删工程会截断旧表（含记忆） | `store.ts:832` |

**后果**：`memory.sqlite` 只能看到迁移进来的历史；用户在 `CodeIndexPanel`
新建的记忆永远进不了新库，也就不会被跨会话召回。这正是 M3 要收掉的缺口。

---

## 2. 目标契约（冻结）

### 2.1 写入映射（旧 → 新）

`code-index:remember` 的**入参不变**（UI 零改动）：

```ts
{ root, kind, title, content, source, sourceRef?, status: 'candidate'|'confirmed', confidence? }
```

内部改为调 `MemoryService.remember`：

| 旧字段 | 新记录 |
|---|---|
| `root` | `projectRoot`；`scope='PROJECT'`；`scopeId = projectIdFor(root)`（**必须**用 `shared/project-id`） |
| `kind` | `fact→fact`、`decision→decision`、`constraint→constraint`、`issue→open_question`、`solution→problem_solution`、`debate→decision` + `tags+=debate` |
| `status` | `candidate→candidate`、`confirmed→active` |
| `source` / `sourceRef` | `sourceRefs=[source, sourceRef?]`（过滤空串，顺序固定） |
| `confidence` | 原样；缺失或非法记 `0.5` |
| `title` | 原样 trim；`normalizedKey = normalizeKey(title)` |

### 2.2 返回映射（新 → 旧视图，UI 零改动）

`rememberCodeMemory` / `listCodeMemories` 仍返回 `MemoryFact`：

| 新记录 | `MemoryFact` |
|---|---|
| `memoryId` | `factId`（迁移时旧 `fact_id` 原样保留，链接继续可解析） |
| `scopeId` | `projectId` |
| `kind` 反向映射 | `open_question→issue`、`problem_solution→solution`、带 `debate` tag 的 `decision→debate` |
| `status` 反向映射 | `active→confirmed`、`candidate→candidate`、`archived/superseded/refuted/expired→deprecated` |
| `sourceRefs[0]` / `sourceRefs[1]` | `source` / `sourceRef?` |
| `createdAt` / `updatedAt` / `confidence` | 原样 |

> 反向映射集中在一个 `memoryRecordToFact()` 里，**只此一处**；不要在 IPC、UI、
> 测试里各写一份，否则三处漂移。

### 2.3 读取与检索

- `CodeIndexService.memories(root)` → `MemoryService.listRecords({ scope:'PROJECT', scopeId: projectIdFor(root), limit })` → map。
- `retrieval.retrieve()` / `assembleContext()` 的 MEMORY 分支：**保持纯函数**，
  但数据来源换成新库——给它们加一个 `memoryFacts?: MemoryFact[]` 入参（默认 `[]`），
  由 `CodeIndexService` 注入新库查询结果。这样 `retrieval.ts` 仍可离线单测，
  也不用 import `MemoryService`（避免 main ↔ code-index 循环）。
- `code-index:status` 里的 `memory` 计数改为新库 `listRecords` 的 `PROJECT` 计数。
- `code-index:search` 的 `MEMORY` 结果同样来自新库。

### 2.4 旧表与链接

- `store.saveMemory()` 与 `INSERT INTO code_memory_facts` **保留但不再被业务调用**
  （迁移代码与旧单测仍可用）。加注释：`@deprecated 仅迁移/历史读取`。
- `code_memory_link` 不动；`MemoryStore.linksForMemory(memoryId)` 已能只读解析。
- `deleteProject` 仍只截 `code-index.sqlite` 的四张表；**新库的 PROJECT 记忆不删**
  （任务书 §P1 DoD「删工程索引后项目记忆仍在」）。加断言。
- `memory.enabled=false` 时：`remember` 返回明确错误（不静默写旧表），
  在 UI 上提示「记忆已关闭」；不要自动回落旧表（回落等于又变成两套）。

---

## 3. 改动文件清单（预估）

新增：
```
src/main/code-index/memory-adapter.ts     # memoryRecordToFact / kind 双向映射 / 写读适配
```

修改：
```
src/main/code-index/service.ts            # remember / memories / status / search 走适配器
src/main/code-index/retrieval.ts          # MEMORY 分支接受 memoryFacts 入参（纯函数不变）
src/main/code-index/store.ts              # saveMemory 标 @deprecated；memory 计数改由 service 覆盖
src/main/index.ts                         # code-index:remember / memories 的 IPC 校验与错误提示
scripts/check-code-index.mjs              # 见 §4
docs/spec/GLOBAL_MEMORY_STATUS.md         # M3 行签字
```

删除：无（旧表保留只读）。

---

## 4. 测试改造（这是本任务的主要工作量）

`scripts/check-code-index.mjs` 现有 **122 条 `assert`**，其中与记忆写入相关的有
`retrieval.remember(store, …)`（128/138/151 行）与 `service.remember(…)`（237/407 行）、
`service.memories(…)`（421 行）。

分两类处理：

1. **`retrieval.remember` 纯函数单测（128/138/151）**：保留。它测的是旧表的写入语义，
   迁移代码仍需要它；但文件顶部加一行注释「legacy：仅迁移路径使用」。
2. **`service.remember / service.memories`（237/407/421）**：改成新库断言：
   - 返回的 `factId` 能在 `MemoryService.getRecord()` 里查到；
   - `status:'confirmed'` → 记录 `active`；`candidate` → `candidate`；
   - `service.memories(root)` 能列出刚写的记录；
   - **旧表零新增**：写前/写后 `SELECT COUNT(*) FROM code_memory_facts WHERE project_id=?` 相等。

新增断言（建议放进 `check-code-index.mjs` 或新 `check-memory-codeindex-route.mjs`）：

| # | 断言 |
|---|---|
| R1 | 一轮 `service.remember` 后旧表行数不变 |
| R2 | 新写入能被 `MemoryService.recall({projectId})` 命中（跨会话召回的最小证据） |
| R3 | `service.memories(root)` 返回新记录，`kind` 反向映射正确（issue/solution/debate 各一条） |
| R4 | `sourceRefs` 顺序与旧 `source/sourceRef` 一致 |
| R5 | `linksForMemory(memoryId)` 能解析迁移前的 `code_memory_link`（不带外键也不报错） |
| R6 | `deleteProject` 后旧表记忆清零，但 `MemoryService` 里该 project 的记录仍在 |
| R7 | `memory.enabled=false` 时 `remember` 明确报错，旧表也不新增 |
| R8 | `searchCodeIndex` 的 MEMORY 结果来自新库（写一条唯一标题，检索得到） |

`package.json` 若新增脚本，挂在 `verify` 与 `test:all` 末尾；`test:code-index` 原有的
122 条断言一条都不许删（只能改语义或新增），删断言要在 PR 说明里逐条解释。

---

## 5. 验收命令与 DoD

```bash
npm run typecheck
npm run test:code-index
npm run test:memory-store && npm run test:memory-recall && npm run test:memory-inject
npm run verify
```

DoD：

- [ ] `CodeIndexPanel` 新建一条记忆 → 出现在「设置 · 全局记忆」的记录里（同一 `memoryId`）
- [ ] 该记忆能被对话/工程链路跨会话召回（离线：`MemoryService.recall` 命中即可）
- [ ] 旧表 `code_memory_facts` 在 R1 里零新增
- [ ] `check-code-index.mjs` 全绿，且旧断言减少数为 0
- [ ] `npm run verify` 全绿（不低于 471 项）
- [ ] `GLOBAL_MEMORY_STATUS.md` M3 行改 ✅ 并链接 PR

---

## 6. 回滚

- 单 PR revert：旧表与旧代码都没删，`service.remember` 回到 `retrieval.remember` 即可。
- 数据层无需回滚：切换后新写入在 `memory.sqlite`，旧表本来就没变；
  revert 后新写入的那几条只在 `memory.sqlite` 里，不影响旧路径。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| `scopeId` 与旧 `project_id` 算法不一致 → 历史记忆查不到 | 只用 `shared/project-id.projectIdFor`；加 R5 用迁移数据断言 |
| `retrieval.ts` 被 `engineering` 直接调用，切换后拿不到新记忆 | 加 `memoryFacts` 入参并在 `CodeIndexService` 注入；`engineering` 侧只走 service |
| 反向映射散落多处导致 UI 显示 `open_question` 等新枚举 | 只允许 `memory-adapter.ts` 一个出口；UI 不改 |
| `deleteProject` 顺手删了新库记忆 | R6 断言；新库删除只走 `MemoryService.deleteRecord` |
| 关闭记忆时静默回落旧表 | 明确报错，不加回落分支 |
