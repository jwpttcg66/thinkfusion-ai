# 全局记忆 · 四态验收矩阵

> 对应 `docs/spec/GLOBAL_MEMORY.md`。四态是**单向证据链**，不许跳级：
> 已定义（契约冻结）→ 已实现（单测绿）→ 已接线（真实入口调用）→ 已验证（E2E 绿）。
>
> 审计基线：`main @ 1e8d5ec9`（本地 `1e8d5ec`）。
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

## 3. 未完成项与原因（不谎称完成）

### 1. Debate 入口注入（未接线）

- **现状**：池层 `attachFromTask()` 已具备能力；`DebateOrchestrator` 的 `deps.ask` 也能拿到 `SubAgentTask`。
- **为什么没做**：编排器是**单例**（`index.ts` 只构造一次），存一个可变的 `memory` 作用域会让不同会话的辩论串记忆——最坏的情况是把 A 项目的记忆注进 B 项目的辩论，这是隐私事故。要把 scope 透传进 `askWithDeadline` 的整条调用链（`debate/completeness.ts`、`standard-rubric.ts`、`orchestrator.ts` 多处），改动面比 P4 其它三个入口加起来还大。
- **建议**：单独一个 PR，把 `MemoryTaskScope` 作为 `DebateRun` 的参数（而不是实例状态）透传。验收同 MEM-07/MEM-11。

### 2. `code-index:remember` 写入路由切换（未做）

- **现状**：`code-index:remember` 仍写 `code-index.sqlite` 的 `code_memory_facts`；新库只**读**（迁移已把历史搬过来）。
- **为什么没做**：`CodeIndexPanel.tsx` 依赖它的返回形状，`check-code-index.mjs` 有 20+ 条断言绑定旧表写入。切换要同时改 UI、旧测试与 `retrieval.ts`，属于独立重构。贸然双写又违反「旧表只读」。
- **影响**：不阻断新链路——用户在「设置 · 全局记忆」里的写入走新库；`CodeIndexPanel` 的旧入口仍写旧表，但**新库召回不到这些新写入**（只有迁移前的历史）。
- **建议**：P1 收尾 PR，切 IPC 路由 + 同步改 UI 与测试，并加「旧表行数不变」断言。

### 3. 真机 CDP 留档（未做）

- **现状**：`npm run verify` 全绿、`MemoryPanel` / `MemoryTraceCard` typecheck 通过，但没有在真机上点过设置页与对话页。
- **原因**：本轮的验收主体是离线门禁（任务书 §7 明确「真机仅留档」）。真机需要重启 Electron + CDP 端口 + 造数据 + 截图，且会写真实 `userData/memory.sqlite`（需事后清理）。
- **建议**：下一次真机窗口一次跑完：确认设置页四类操作、对话页注入卡、`degraded` 红字，并把截图存进 `docs/spec/evidence/`。

---

## 4. 与定稿的差异

`GLOBAL_MEMORY.md` §8 记录了 6 处实施期校准（三哈希统一对象、乘性评分、长度归一化、
阈值 0.12、拆唯一索引、注入收口点）。这些是评审 R2 授权范围内的公式校准与自身矛盾修正，
不是架构重开。
