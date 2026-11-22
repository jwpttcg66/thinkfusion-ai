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
| **Debate 入口注入** | ✅ | ✅ | ❌ | ❌ | 见下方未完成项 1 |
| **`code-index:remember` 写入路由切换** | ✅ | ❌ | ❌ | ❌ | 见下方未完成项 2 |
| 真机 CDP 端到端留档 | ✅ | — | — | ❌ | 见下方未完成项 3 |

---

## 1.5 交付阶段门槛（M1–M5）

`471 ok / 0 not ok` 证明的是**当前测试范围内**的正确性，不等于三个缺口已结束。
交付按下面五个阶段签字，任何一阶段没签，都不能说「全局记忆已交付」。

| 阶段 | 完成标准 | 当前 | 任务书 |
|---|---|---|---|
| **M1** | 471 项测试全绿；记忆核心链路（存储/迁移/抽取/召回/注入/送达/治理）已验证 | ✅ | 本文件 §1、§2 |
| **M2** | 设置页与对话页**真机实际操作**通过（含降级场景），证据存 `docs/spec/evidence/` | ❌ | `GLOBAL_MEMORY_M2_ACCEPTANCE.md` |
| **M3** | `CodeIndexPanel` 新写入进入独立记忆库；旧 `code_memory_facts` 零新增；新写入可跨会话召回 | ❌ | `GLOBAL_MEMORY_M3_CODEINDEX_ROUTE.md` |
| **M4** | `MemoryTaskScope` 按 `DebateRun` 透传；两个不同项目并发辩论不串记忆；取消/超时/重试不污染下一次 | ❌ | 待建（M3 之后） |
| **M5** | 全部 MEM 用例 + 新增隔离/路由用例通过；三套写入（MemoryStore / 旧表 / Debate 缓存）收敛为一套 | ❌ | M2–M4 收口后 |

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

三项都已有**可执行任务书**，不再是「口头待办」。按 M2 → M3 → M4 顺序推进。

### 1. 真机 CDP 验收（M2，未做）

- **现状**：`npm run verify` 全绿、`MemoryPanel` / `MemoryTraceCard` typecheck 通过，但没在真机上点过。
- **任务书**：`docs/spec/GLOBAL_MEMORY_M2_ACCEPTANCE.md`
- **验收要点**：设置页 S1–S14、对话页 D1–D6、降级场景；每项必须有「点击 + 读回状态 + 截图」三样证据，只截图不算通过；证据存 `docs/spec/evidence/M2/`。
- **风险**：会写真实 `userData/memory.sqlite`，任务书 §6 要求按 `M2 ` 前缀精确清理并回读确认。

### 2. `code-index:remember` 写入路由切换（M3，未做）

- **现状**：`code-index:remember` 仍写 `code_memory_facts`；新库只读迁移过来的历史，
  `CodeIndexPanel` 的新写入召回不到。
- **任务书**：`docs/spec/GLOBAL_MEMORY_M3_CODEINDEX_ROUTE.md`
- **验收要点**：IPC 路由切到 `MemoryService`；`MemoryFact` 视图映射集中在一处；旧表零新增（R1）；
  新写入可跨会话召回（R2）；`check-code-index.mjs` 的 122 条断言一条都不许删。

### 3. Debate 入口注入（M4，未接线）

- **现状**：池层 `attachFromTask()` 已具备能力；`DebateOrchestrator` 的 `deps.ask` 也能拿到 `SubAgentTask`。
- **为什么没做**：编排器是**单例**（`index.ts` 只构造一次），存可变的 `memory` 作用域会让不同会话的
  辩论串记忆——最坏是把 A 项目的记忆注进 B 项目的辩论，这是隐私事故。
- **待建任务书**（M3 之后）：要求 `MemoryTaskScope` 按 **`DebateRun`** 透传（不是实例状态），
  验收必须包含「两个不同项目并发辩论、记忆不交叉」与「取消/超时/重试不污染下一次」。单独 PR，
  不与 M3 合并。

---

## 4. 与定稿的差异

`GLOBAL_MEMORY.md` §8 记录了 6 处实施期校准（三哈希统一对象、乘性评分、长度归一化、
阈值 0.12、拆唯一索引、注入收口点）。这些是评审 R2 授权范围内的公式校准与自身矛盾修正，
不是架构重开。
