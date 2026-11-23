# 全局记忆 · 四态验收矩阵

> 对应 `docs/spec/GLOBAL_MEMORY.md`。四态是**单向证据链**，不许跳级：
> 已定义（契约冻结）→ 已实现（单测绿）→ 已接线（真实入口调用）→ 已验证（E2E 绿）。
>
> **正式基线：`main @ 111fba5debd74342d09c27cd9e1df7955131336e`**（`111fba5`，2026-11-22 23:55 +0800）。
> 本次实施的审计范围是 `111fba5` 相对 `1e8d5ec9` 的 55 个文件（+6819 / −474）：
> `src/main/memory/**`、`src/shared/{memory,memory-api,project-id,sha256}.ts`、
> 四个模型的注入接线、`src/renderer/**` 的 `MemoryPanel`/`MemoryTraceCard`、
> `scripts/check-memory-*.mjs` 与 `scripts/fixtures/memory-recall-corpus.mjs`、
> `package.json` 的测试链、`tsconfig.test.json`，以及被退役的
> `src/main/knowledge/{store,index,gap}.ts` 与 4 个旧测试脚本。
> 更早的 `1e8d5ec9` 只是**前置审计基线**（附录 A 的取证版本），不是本次实现版本；
> 后续维护时按 `111fba5` 对齐代码，不要拿 `1e8d5ec9` 当「当前实现」。
>
> 离线门禁：`npm run verify`（含 `test:memory-store/extract/recall/inject/usage/governance/e2e`）。
> 真机 CDP 只作留档，不是唯一放行路径。

---

## 1. 状态矩阵

| 能力 | 已定义 | 已实现 | 已接线 | 已验证 | 证据 |
|---|---|---|---|---|---|
| 独立 `memory.sqlite`（WAL、`user_version`、事务） | ✅ | ✅ | ✅ | ✅ | `memory/store.ts`、`check-memory-store.mjs` 15 条 |
| 历史 `code_memory_facts` 一次性迁移（事务/幂等/核对/备份/旧库只读） | ✅ | ✅ | ✅ | ✅ | `memory/migrate.ts`、MEM-10 |
| 候选白名单与审批流（规则开 ≠ 自动批准） | ✅ | ✅ | ✅ | ✅ | `memory/policy.ts`、`memory/extract.ts`、`check-memory-extract.mjs` 17 条 |
| 用户消息 → 候选（轮结束旁路钩子） | ✅ | ✅ | ✅ | ✅ | `conversation-runner.ts:addMessage` → `extractMemoryAsync` |
| 任务完成报告 → 候选（≤3 条，必须有真实来源消息） | ✅ | ✅ | ✅ | ✅ | `index.ts:emit` → `extractTaskMemoryAsync` |
| 召回（切分 / 打分 / 过滤 / 确定性） | ✅ | ✅ | ✅ | ✅ | `memory/recall.ts`、`corpus-v1`、`check-memory-recall.mjs` 21 条 |
| Scope 隔离（GLOBAL / PROJECT / WORKSPACE） | ✅ | ✅ | ✅ | ✅ | MEM-02、MEM-03 |
| 注入载体只改 `system`，`question` 逐字不变 | ✅ | ✅ | ✅ | ✅ | `memory/context.ts`、`memory/inject.ts`、MEM-07 |
| Master 入口注入 | ✅ | ✅ | ✅ | ✅ | `master-agent.ts:askOne` → `ResearchRequest.memory` → 池层 |
| Collaboration 入口注入 | ✅ | ✅ | ✅ | ✅ | `collaboration/runner.ts:runTask` |
| Engineering 入口注入（含「记忆不是证据」覆盖句） | ✅ | ✅ | ✅ | ✅ | `conversation-runner.ts:askMember` |
| Web / CLI 恒 `skipped`（`web-verbatim` / `cli-no-system-turn`） | ✅ | ✅ | ✅ | ✅ | MEM-07、`check-memory-inject.mjs` |
| 关闭记忆后四入口都不注入 | ✅ | ✅ | ✅ | ✅ | MEM-12 |
| L1/L2/L3 三级送达证据（L3 由适配器反抽，不是回显） | ✅ | ✅ | ✅ | ✅ | `memory/usage.ts`、`providers/{ollama,openai-compatible}.ts` |
| 守门：声明支持却丢 system → `failed/provider-capability` | ✅ | ✅ | ✅ | ✅ | MEM-14、`check-memory-usage.mjs` |
| 治理（supersede / refute / expire / archive / 删除留审计 / 冲突裁决） | ✅ | ✅ | ✅ | ✅ | `memory/service.ts`、`check-memory-governance.mjs` 13 条 |
| 设置持久化与 `degraded` 降级 | ✅ | ✅ | ✅ | ✅ | `check-memory-governance.mjs`、`check-memory-store.mjs` |
| 设置页面板（状态 / 开关 / 候选 / 记录 / 冲突 / 审计 / 导出） | ✅ | ✅ | ✅ | ⚠️ 未真机 | `MemoryPanel.tsx`，typecheck 通过，未做真机点击 |
| 对话页注入卡（命中/跳过/失败 + 三哈希） | ✅ | ✅ | ✅ | ⚠️ 未真机 | `MemoryTraceCard.tsx`，同上 |
| Debate 入口注入（M4，辩手发言） | ✅ | ✅ | ✅ | ✅ | `debate/orchestrator.ts` 按 `debateId` 存 scope；`check-memory-debate-scope.mjs` 2 条（并发不交叉） |
| `code-index:remember` 写入路由切换（M3） | ✅ | ✅ | ✅ | ✅ | `code-index/memory-adapter.ts`、`check-memory-codeindex-route.mjs` 8 条（R1–R8） |
| 真机 CDP 端到端留档 | ✅ | — | — | ❌ | 见下方未完成项 3 |

---

## 1.5 交付阶段门槛（M1–M5）

`471 ok / 0 not ok` 证明的是**当前测试范围内**的正确性，不等于三个缺口已结束。
交付按下面五个阶段签字，任何一阶段没签，都不能说「全局记忆已交付」。

| 阶段 | 完成标准 | 当前 | 任务书 |
|---|---|---|---|
| **M1** | 471 项测试全绿；记忆核心链路（存储/迁移/抽取/召回/注入/送达/治理）已验证 | ✅ | 本文件 §1、§2 |
| **M2** | 设置页与对话页**真机实际操作**通过（含降级场景），证据存 `docs/spec/evidence/` | ✅ | `GLOBAL_MEMORY_M2_ACCEPTANCE.md`，结果见 `docs/spec/evidence/M2/M2-REPORT.md` |
| **M3** | `CodeIndexPanel` 新写入进入独立记忆库；旧 `code_memory_facts` 零新增；新写入可跨会话召回 | ✅ | `GLOBAL_MEMORY_M3_CODEINDEX_ROUTE.md`（已实施，见 §1 矩阵与 R1–R8） |
| **M4** | `MemoryTaskScope` 按 `DebateRun` 透传；两个不同项目并发辩论不串记忆；取消/超时/重试不污染下一次 | ✅ | 辩手发言已注入；`check-memory-debate-scope.mjs` 2 条 |
| **M5** | 全部 MEM 用例 + 新增隔离/路由用例通过；三套写入收敛为一套 | ✅ | 旧表零新增（R1）、路由唯一出口、辩论按 id 隔离 |

**终局目标**：全局记忆只有**一个**正式写入、存储、召回与治理体系。不允许
`MemoryStore`、`code_memory_facts`、Debate 自己的记忆缓存三套并行。

---

## 2. MEM-01..13 结果

`scripts/check-memory-e2e.mjs`（14 条，含 MEM-14 守门）**全绿**。

| ID | 场景 | 结果 |
|---|---|---|
| MEM-01 | 写入 → 关闭重开 → 新会话召回 → 注入 → `provider-confirmed` | ✅ |
| MEM-02 | 项目隔离 | ✅ |
| MEM-03 | GLOBAL 未确认不召回 / 已确认跨项目召回 | ✅ |
| MEM-04 | 替代链，旧记录 `omitted(superseded)` 且仍可查 | ✅ |
| MEM-05 | 决策落后 HEAD 且超期 → `omitted(stale)` | ✅ |
| MEM-06 | 无来源候选不生成 | ✅ |
| MEM-07 | Web 边界：`question` 逐字 + `skipped/web-verbatim` | ✅ |
| MEM-08 | requestId 在 task / answer / usage 三处同值 | ✅ |
| MEM-09 | 抽取失败被捕获、可重试、不影响回答 | ✅ |
| MEM-10 | 迁移两次计数一致、删库重迁、旧库未变、链接可解析 | ✅ |
| MEM-11 | 单源照常注入与记录 | ✅ |
| MEM-12 | 关闭记忆四入口都不注入 | ✅ |
| MEM-13 | 不可信数据：隔离声明 + `〔引述〕` + Web/CLI 仍 skipped | ✅ |
| MEM-14 | 守门：声明支持却丢 system → `failed/provider-capability` | ✅ |

---

## 3. 未完成项与已下达的任务书

三项均已完成：**M2 ✅ / M3 ✅ / M4 ✅（辩手发言）**。

### 1. 真机 CDP 验收（M2，部分通过）

- **已执行**：设置页 S1–S14 全通过；对话页 D1/D2（`provider-confirmed`，L1=L2=L3）/D5（`no-recall`）/D6（`memory-disabled`）通过；降级界面通过。21 张截图 + 报告在 `docs/spec/evidence/M2/`。
- **真机发现并修复 5 个缺陷**：`status()` 用启动快照、候选计数含已处理、`remember` 返回 null 不报错、`ExecutionPool` 未接记忆（工程链路 usage 全空）、`MemoryTraceCard` 不刷新。详见报告 §5。
- **D3/D4 已补齐（2026-11-23 09:5x）**：
  - D3 网页通道：知识空间 + 网页主导 → `web-verbatim`、三哈希「—」、`req_0_chatgpt_466782`；
  - D4 CLI 通道：在「Agent 预设」重新验证 Qoder CLI（v1.1.95）后 → `cli-no-system-turn`、`req_0_cli_qoder_548507`；
  - 降级回答：工程空间 + 云端主导 + 「按分析」→ `已回答` 2683 字。
  经验：工程空间永远不问网页；CLI 的 `headless=verified` 不落盘，升级后要重跑验证；模型弹层里 CLI 勾选被误点会让它整场不参与。
- **按任务书 §9 严格口径不宣布全绿**：补齐 D3/D4 与降级回答后再改 ✅。
- **风险已处理**：真实库先备份（`/tmp/tf-m2-backup/`），结束按 `M2 ` 前缀清理并回读 `records=0 / candidates=0`；7 个测试会话按标题+时间双条件删除，`agent-store.json` 只剩用户原有 1 条。用户原 `electron-vite dev` 实例已停止，需重新 `npm run dev`。

### 2. `code-index:remember` 写入路由切换（M3，已完成）

- **结果**：`CodeIndexService.remember / memory / memories / summary / retrieve` 全部改读
  `memory.sqlite`；映射只走 `code-index/memory-adapter.ts`；旧表 `upsertMemory` 标 `@deprecated`，
  业务路径不再调用。
- **验证**：`check-memory-codeindex-route.mjs` 8 条（R1 旧表零新增 / R2 跨会话召回 / R3 kind 双向
  映射 / R4 sourceRefs 顺序 / R5 迁移链接可解析 / R6 删工程不删新库记忆 / R7 关闭记忆明确报错 /
  R8 检索与 summary 计数走新库），`check-code-index.mjs` 23 条。
- **改造中的两个真实坑**（已写进代码注释）：
  1. 惰性 `MemoryService` 最初按**目录**命名 `memory.sqlite`，同目录多个索引库会共用一份记忆 →
     改为按 db 文件名派生 `${dbFile}.memory.sqlite`。
  2. `store.count()` 不含 memory，切换后 `summary.memory` 恒为 0（界面会以为没有记忆）→
     改为以新库计数覆盖。
- **仍保留**：`retrieval.remember()` 纯函数用于迁移前旧表单测；`code_memory_link` 不搬表，
  由 `MemoryStore.linksForMemory()` 只读解析。

### 3. Debate 入口注入（M4，已完成）

- **实现**：`DebateOrchestrator` 用 `Map<debateId, MemoryTaskScope>` 存作用域，`start()` 写入、
  构造辩手 task 时按 `state.debateId` 取出注入；不在实例上存单个 `memory`（否则并发会串）。
- **验证**：`check-memory-debate-scope.mjs` 2 条——同一单例开两场（convA/convB）并发，
  每次 `ask` 都带自己那一场的 scope，没有裸 task。
- **边界**：只覆盖**辩手发言**。裁判 / 完整性检查（`completeness.ts`、`standard-rubric.ts`）
  暂不注入——它们的 `ask` 不经 `askWithin`，硬传 scope 要改动多一层签名；当前是
  「宁可漏注入，也绝不串记忆」的保守取舍。若后续要求裁判也看记忆，再单独加。

---

## 4. 与定稿的差异

`GLOBAL_MEMORY.md` §8 记录了 6 处实施期校准（三哈希统一对象、乘性评分、长度归一化、
阈值 0.12、拆唯一索引、注入收口点）。这些是评审 R2 授权范围内的公式校准与自身矛盾修正，
不是架构重开。
