# P3 工程空间契约

状态：**设计完成（2026-11-18）**。
设计分支：`product-v3`。代码基线：`cd30be3`。
上游：[P1-002 领域与运行时契约](../implementation/P1-002-DOMAIN-RUNTIME-CONTRACT.md)、
[ENGINEERING_WORKSPACE.md](ENGINEERING_WORKSPACE.md)。

工程空间是 `CollaborationEngine` 的任务类型 + 能力 + 状态 + 交付协议，
**不是 EngineeringEngine**。

---

## 1. 领域类型

`EngineeringContext` 的权威定义见
[P1-002 §3.4](../implementation/P1-002-DOMAIN-RUNTIME-CONTRACT.md)，这里不重复。
本文件补充 P3 专用的状态与报告类型；字段名冲突时以 P1-002 为准。

```ts
export interface Snapshot {
  snapshotId: string;
  commit: string;
  dirty: boolean;
  dirtyFiles: string[];
  fingerprint: string;
  createdAt: number;
}

export interface TestReport {
  command: string;
  exitCode: number;
  status: 'passed' | 'failed' | 'skipped';
  durationMs?: number;
  attestationId?: string;
}

export interface BuildReport {
  command: string;
  exitCode: number;
  status: 'passed' | 'failed' | 'skipped';
  durationMs?: number;
}

export interface ReviewVerdict {
  verdict: 'approved' | 'changes_requested' | 'unknown';
  blockers: string[];
  notes: string[];
  reviewerParticipantId?: string;
}

/** 工程任务状态：由任务持有，不是流程基线。 */
export interface EngineeringTaskState {
  taskId: string;
  context: EngineeringContext;   // 见 P1-002 §3.4
  start?: Snapshot;
  end?: Snapshot;
  testReports: TestReport[];
  build?: BuildReport;
  review?: ReviewVerdict;
  worktree?: { dir: string; branch: string };
}
```

规则：

- `Snapshot` 是证据/回退依据，不叫 baseline；
- `EngineeringTaskState` 挂在任务上，不塞进 `TaskSpec`；
- 写操作必须有 `start`；`done` 前必须有 `end` 与测试结果（或明确 skipped）。

## 2. 生命周期

```text
Intake → Understand → Evidence → Plan → Review → Approve
      → Worktree → Implement → Test → Verify → Review → Deliver
```

| 阶段 | 输出 | 失败处理 |
| --- | --- | --- |
| Intake | 目标、仓库、权限、验收 | 目录/权限不明先问 |
| Understand | 事实清单（`路径:行号`） | 读不到就停，不猜 |
| Evidence | `EvidenceRef[]`（code） | 记录不可用原因 |
| Plan | 改动文件、影响面、测试、回退 | 不过评审就修 |
| Review（计划） | `ReviewVerdict` | 阻断项必须解决 |
| Approve | 审批记录 + TaskGrant | 拒绝即停 |
| Worktree | 独立分支/目录 | 创建失败不开工 |
| Implement | diff | 失败回 S1 |
| Test | `TestReport` + attestation | 失败标 failed |
| Verify | Verdict | 未验证标 unverified |
| Review（diff） | `ReviewVerdict` | 意见回计划 |
| Deliver | diff、测试、风险、回退 | 缺证据显式列出 |

---

## 3. 工具与能力

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 搜索 | `fs.search` / `fs.find` / `fs.tree` | 文本/名称/目录 |
| 读取 | `fs.readFile` 分页 + 行号 | 大文件可控 |
| 符号 | `code-index` / `lsp` | 可用则用，不可用降级文本 |
| 影响面 | `code-index.impact` / `engineering.analysis` | 引用/依赖 |
| Git | `shell.run` 只读 | status/diff/log |
| 测试 | `test.run` | 固定命令 → argv |
| 构建 | `shell.run` 构建类 | Maven/Gradle |
| 执行 | `agent.exec` 链 | TaskGrant + 审批 |

原则：**工具给事实，模型做理解**；不预建全图、不启动全仓扫描。

---

## 4. CLI Executor

CLI 有两种角色，不能混：

| 角色 | 链路 | 权限 |
| --- | --- | --- |
| CLI Participant（只读） | `execution/cli-answer-agent.ts` | 临时目录、无 grant、只回答 |
| CLI Executor（写） | `agent.exec` + TaskGrant | worktree、白名单、审批 |

规则：

- Executor 必须在 worktree 内；不共享工作区；
- 输出、退出码、diff、失败原因进 Observation 与证据；
- 不自动重试写操作；失败回 S1；
- 不允许把 Executor 塞进 `SubAgent` 通道。

---

## 5. Java

| 能力 | 当前/计划 |
| --- | --- |
| 文件识别 | `code-index` 轻量 Java 解析 |
| 搜索 | 文本 + 索引 |
| 符号/引用 | LSP 可选；无 Java LSP 时降级 |
| 编译/测试 | Maven/Gradle 经 `test.run`/`shell.run` |
| 精确语义 | 按需 JDT/Javac，不进核心 |

不把「完整 Java 语义引擎」作为 P3 阻塞。Java 8/11/17/21 以源码阅读 + 工具 + 模型理解覆盖。

---

## 6. 证据与安全

- 测试/构建结果经 `ExecutionReport` → attestation → `EvidenceRef`；
- 篡改 attestation 可发现；
- 未跑过的测试不能写成通过；
- 写操作必须审批；只读不产生写；
- 工具白名单、路径校验、sha256 复验沿用 Runtime；
- 不自动 merge、不自动 push。

---

## 7. 验收

| 场景 | 期望 |
| --- | --- |
| 理解 Java 登录流程 | Controller → Service → Repository → 配置，带 `路径:行号` |
| 修改小仓库 | S1 → 计划 → 评审 → 审批 → worktree → diff → 测试 → 评审 → 交付 |
| 测试失败 | failed + 回退路径；不冒充通过 |
| 权限不足 | 审批阶段拒绝；零写盘 |
| 并发任务 | 各自 worktree，不共享目录 |

---

## 8. 风险

| 风险 | 对策 |
| --- | --- |
| 工程引擎化 | 任务类型 + 能力 + 状态，不另建 Engine |
| 开场基线化 | 用 `EngineeringTaskState`，不叫 baseline |
| 语义引擎膨胀 | 工具 + 模型；JDT 按需 |
| CLI 越权 | Executor 走 TaskGrant/worktree |
| 回退靠记忆 | S1/S2 + diff 一等能力 |
