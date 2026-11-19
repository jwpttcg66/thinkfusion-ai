# P3 工程工作空间

目标：让 ThinkFusion 真正**理解、修改、验证**一个工程，而不是围绕代码辩论。
前置：P1 active（DAG/重规划可跑）。
**工程空间不是独立 Engine**：它是 CollaborationEngine 上的一类任务、能力与工具集合，
不新建 EngineeringEngine；审批与执行仍复用现有 Runtime。
出口：一次真实改动走完「理解 → 计划 → 审批 → 执行 → 验证 → 评审」，可复验、可回退。

---

## 1. 工程任务状态（不是基线）

`EngineeringTaskState` 的唯一权威定义见
[ENGINEERING_CONTRACT §1](../architecture/ENGINEERING_CONTRACT.md)；本节不重复字段。

- 状态由**工程任务**创建并持有；辩论、知识空间只能引用。
- S1/S2 是快照，不是「开场基线」；不进入任何流程前提。
- 每次执行前后都必须有 S1/S2；缺失时任务不能标 `done`。

---

## 2. 生命周期

```text
Intake → Understand → Evidence → Plan → Review → Approve
      → Worktree → Implement → Test → Verify → Review → Deliver
```

| 阶段 | 产物 | 失败处理 |
| --- | --- | --- |
| Intake | 目标、仓库、权限、验收 | 目录/权限不明先问 |
| Understand | 事实清单（`路径:行号`） | 读不到就停，不猜 |
| Evidence | `EvidenceRef[]`（code） | 记录不可用原因 |
| Plan | 步骤、影响面、测试策略、回退 | 不过评审就修 |
| Review | 独立评审意见 | 阻断项必须解决 |
| Approve | 审批记录 | 拒绝即停 |
| Worktree | 独立分支/目录 | 创建失败则不开工 |
| Implement | diff | 失败回滚到 S1 |
| Test | `ExecutionReport` + attestation | 失败标 failed，不冒充通过 |
| Verify | Verdict | 未验证标 unverified |
| Review | 对 diff 的独立评审 | 意见回到计划 |
| Deliver | diff、测试、风险、回退 | 缺证据项显式列出 |

---

## 3. Agentic Search

原则：**工具给事实，模型做理解。**

第一版工具（复用现有，不新建语义引擎）：

| 能力 | 现有入口 | 说明 |
| --- | --- | --- |
| 搜索内容 | `fs.search` | 文本/正则，返回位置 |
| 查找文件 | `fs.find` | 按名称/glob |
| 目录树 | `fs.tree` | 限深、限条目 |
| 读取 | `fs.readFile` | 分页 + 行号 |
| 符号 | `code-index` / `lsp` | 可用则用，不可用降级文本 |
| 引用 / 定义 | LSP | 按需，不预建全图 |
| Git | `shell.run` 只读命令 | commit / diff / status |

约束：

- 不启动即扫描全仓库、不预建完整调用图、不依赖 Neo4j。
- 每次搜索都要说明「为什么搜这里」（Planner 记录）。
- 结果标注识别方法：`text` / `symbol` / `lsp`；降级要显示。

### Java 策略

- 第一阶段：文本搜索 + 轻量结构解析 + 可选 LSP/JDT；支持 Java 8/11/17/21 源码阅读。
- 只有任务需要精确类型、definition/references、diagnostics、编译验证时才调用更重的工具。
- 不以「完整 Java 编译器级语义引擎」作为阻塞条件。

---

## 4. 计划与审批

- 计划必须包含：改动文件、影响面、测试选择理由、回退方式、风险。
- 审批复用现有 `AgentOrchestrator` / `TaskGrant`，**不新建审批系统**。
- 写操作默认 `workspace-write`；越权路径直接拒绝。
- 审批过期、计划过期沿用现有策略。

---

## 5. Worktree 与并发

- 一个任务一个 worktree/分支；并发任务不共享目录（AGENTS 第 5 条）。
- 命名：`<branch>-<taskId>`；创建前检查目录不存在。
- 合并前必须：相关测试、typecheck、已合入功能不回归。
- 不自动 merge、不自动 push；合并由用户执行。
- 任务完成后按用户确认清理 worktree；清理前先保留 diff 与测试报告。

---

## 6. CLI Agent：两种角色，不能混

| 角色 | 现有实现 | 权限 | 用途 |
| --- | --- | --- | --- |
| **CLI Participant** | `execution/cli-answer-agent.ts` | 只读、临时目录、无 TaskGrant | 作为回答源参与分析 |
| **CLI Executor** | `agent.exec` 执行链 | TaskGrant + 审批 + worktree | 真正改代码 |

规则：

- 不得把 Executor 塞进 `SubAgent` 通道复用；
- Executor 必须在 worktree 内、受工具白名单与审批约束；
- 每个 Executor 任务的输入、输出、diff、退出码都进 Observation 与证据；
- 失败/超时/权限拒绝显式记录，不静默换人。

---

## 7. 验证与证据

- 测试必须真实执行：`test.run` → `ExecutionReport` → attestation → Item Hash。
- 「已通过」只能来自 attestation；没有跑过就写「未验证」。
- 命令、退出码、commit、快照指纹进入证据；篡改可发现。
- 评审独立于实现者；评审意见回到计划，不直接改代码。

---

## 8. 回退

- S1 快照 + diff 是回退依据；
- 失败时优先 `git restore` / 删除 worktree；
- 不允许「永久删除」作为默认回退；
- 回退后必须重跑受影响测试，并把结果写进交付物。

---

## 9. 场景与验收

### 场景 A：理解

输入：「帮我理解这个 Java 项目的登录流程」。
期望：Controller → Service → Repository → 配置 → 相关调用，全部带 `路径:行号`；不需要预建全图。

### 场景 B：修改

输入：「把这个 Redis 连接池问题修掉」。
期望：S1 → 计划 → 评审 → 审批 → worktree → 改动 → 测试 → attestation → diff 评审 → 交付；失败可回 S1。

### 场景 C：权限

只读权限下请求写操作 → 审批阶段拒绝；不产生任何写盘。

测试：

- `check-engineering-state.mjs`：S1/S2、缺失快照、diffHash；
- `check-engineering-worktree.mjs`：隔离、清理、不共享目录；
- `check-cli-executor.mjs`：TaskGrant、worktree、失败记录；
- `check-engineering-closed-loop.mjs`：真实小仓库端到端。

---

## 10. 任务清单

| ID | 任务 | 文件 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| P3-01 | 工程任务状态 | `src/main/engineering/task-state.ts` | P1 | state 测试 |
| P3-02 | 理解/取证 | `engineering/analysis.ts` 增量 | P3-01 | 场景 A |
| P3-03 | 计划与评审接线 | `engineering/plan-review.ts` | P3-01 | 计划测试 |
| P3-04 | worktree 管理 | `coding/team.ts` 增量 | P3-01 | 隔离测试 |
| P3-05 | 执行与断言 | `agent/` + attestation | P3-03 | 闭环测试 |
| P3-06 | CLI Executor | `execution/cli-*` | P3-04 | grant 测试 |
| P3-07 | 回退 | 复用快照 | P3-05 | 场景 B 失败分支 |

---

## 11. 出口清单

- [ ] 工程任务自己持有 S1/S2、commit、dirty、diff、测试报告
- [ ] 理解结论带 `路径:行号`，识别方法可解释
- [ ] 计划含影响面、测试理由、回退
- [ ] 写操作必须审批；只读不产生写操作
- [ ] 测试真实执行，attestation 进哈希
- [ ] CLI Executor 走 TaskGrant 与 worktree，不复用回答源
- [ ] 失败能回 S1，并重跑受影响测试
- [ ] 一次真实改动全链路通过
