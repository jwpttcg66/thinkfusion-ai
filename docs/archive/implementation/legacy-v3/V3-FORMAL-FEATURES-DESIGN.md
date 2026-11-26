# ThinkFusion V3 正式功能设计包

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


版本：V1.0（2026-11-20）
基线：`main` 已落地的 Collaboration Engine（A-01/A-02 已完成）。
范围：A-03/A-04、B（UI-01..07）、C、D、E 的完整设计。
不包含：签名、公证、DMG/ZIP、自动更新、正式发布。

本设计不重复 P1-002 的核心类型；只定义新增接口、数据流、组件边界与验收。

> **历史设计包（2026-11-20）**：当前状态见 [STATUS.md](../../../implementation/STATUS.md)；
> 长任务/上下文的后续设计见 `LONG_TASK_AND_CONTEXT_COMPACTION.md`。

## 设计状态

| 范围 | 设计 | 实施 |
| --- | --- | --- |
| A-01 持久化 | ✅ | ✅ |
| A-02 并发/取消/超时 | ✅ | ✅ |
| A-03 四种行为 | ✅ | ⏳ |
| A-04 Gate 设置 | ✅ | ⏳ |
| B UI-01..07 | ✅ | ⏳ |
| C 质量/诊断/安全 | ✅ | 🟡 部分 |
| D 旧架构退出 | ✅ | ⏳ |
| E 总验收 | ✅ | ⏳ |

**设计完成，实施未完成。** 后续按第 9 节顺序施工，不以设计完成代替验收。

---

## 0. 共同约束

- 一个 Collaboration Engine，三个工作空间；
- 复用 AgentStore / EvidencePackStore / AgentOrchestrator / DebateOrchestrator；
- 不建第二套 Runtime、Evidence Store、审批或 Journal；
- 用户界面不出现 DAG / Scheduler / Assignment 等内部术语；
- UI 只展示真实 Runtime 状态，不用模拟数据；
- 每个任务只审计涉及的文件与调用链（AGENTS §7）。

数据流：

```text
Renderer
  │  IPC: collaboration:view / action
  ▼
Main (ConversationRunner / CollaborationEngine)
  │  Plan → Assignments → Observations → Deliverable
  ▼
AgentStore（会话 + CollaborationState）
EvidencePackStore（证据正文）
事件：conversation.updated / message.added / collaboration.*
```

---

## 1. A-03：四种协作行为

### 1.1 类型

```ts
export type CollaborationBehavior =
  | 'independent'   // 单人回答 + 汇总
  | 'parallel'      // 多人独立回答 + 汇总
  | 'progressive'   // 分析 → 验证 → 汇总（有依赖）
  | 'crosscheck';   // 多人回答 → 交叉复核 → 汇总
```

`Plan` 增加可选字段：

```ts
interface Plan {
  // ...
  behavior?: CollaborationBehavior;
  behaviorReason?: string;
}
```

不新增 Runtime；行为只决定任务图。

### 1.2 Planner 选择规则

| 条件 | 行为 |
| --- | --- |
| 简单事实、单点核对、1 个参与者 | independent |
| 复杂问题、≥2 个参与者、无强制顺序 | parallel |
| 工程任务、或问题包含「先…再…/逐步/依赖」 | progressive |
| 高风险（写操作/执行）、比较/争议、用户要求复核 | crosscheck |

规则写入 `Plan.behaviorReason`，UI 必须可见。

### 1.3 任务图

| 行为 | 任务 |
| --- | --- |
| independent | 1 个 analyze + 1 个 synthesize |
| parallel | N 个 analyze（无依赖）+ 1 个 synthesize |
| progressive | analyze → verify（依赖 analyze）→ synthesize（依赖 verify） |
| crosscheck | N 个 analyze → N 个 review（每个依赖全部 analyze）→ synthesize |

`Runner` 已支持依赖/并发，不需要改执行模型。`review` 任务使用 `TaskKind='review'`，输出 Observation，证据进 EvidenceRef。

### 1.4 降级

- 参与者不足：crosscheck → parallel → independent；
- verify/review 失败：synthesize 仍可执行，但 Deliverable 标 `degraded` 与未核验项；
- 任何降级写入 `Plan.behaviorReason` 和 `stopReason`。

### 1.5 验收

- 四种行为各有任务图与执行测试；
- Planner 选择有理由；
- 依赖顺序、并发上限不变；
- 失败/降级不丢状态；
- 不出现无意义全模型参与。

---

## 2. A-04：Gate 设置入口

### 2.1 设置模型

```ts
interface CollaborationSettingsView {
  mode: 'legacy' | 'shadow' | 'active';
  gate: { ok: boolean; reasons: string[] };
  metrics: { questions: number; planned: number; covered: number; maxTasksSimple: number };
}
```

### 2.2 IPC

```text
collaboration:settings:get  -> CollaborationSettingsView
collaboration:settings:set  { mode } -> CollaborationSettingsView
collaboration:metrics:record { questionId, planned, covered, simpleTasks } -> void
```

`set active` 必须调用 `setGated(mode, metrics)`；失败返回 409 与 reasons。
`legacy/shadow` 不受门禁限制。

### 2.3 UI

设置页新增「协作引擎」区块：

- 当前模式；
- 门禁状态与原因；
- 指标（真实问题数/覆盖率/简单任务数）；
- 切 active 的确认框；
- 切回 legacy 的按钮。

不允许隐藏门禁原因，也不允许 UI 直接写文件。

### 2.4 验收

- 未达门禁切 active 被拒绝；
- legacy/shadow 可切；
- 设置与 Runtime 一致；
- 有权限/失败测试。

---

## 3. B：三个工作空间 UI

### 3.1 统一外壳

```text
AppShell
├── WorkspaceSwitcher（General / Knowledge / Engineering）
├── ConversationList
├── MainPane
│   ├── CollaborationPlanPanel   UI-01
│   ├── ParticipantPanel         UI-02
│   ├── EvidencePanel            UI-03
│   ├── WorkspaceContextPanel    UI-04/05/06
│   └── DeliverableView          UI-07
└── DiagnosticsDrawer            C-03
```

三个空间共享外壳与 Engine，仅 Context/Action 不同。

### 3.2 视图数据契约

新增 `collaboration/view.ts` 扩展（已有 PlanView）：

```ts
interface ParticipantView {
  participantId: string;
  label: string;
  kind: 'web' | 'local' | 'cloud' | 'cli';
  role: 'answerer' | 'questioner';
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  reason?: string;
  outputPreview?: string;
}

interface EvidenceView {
  evidenceId: string;
  kind: 'web' | 'code' | 'execution' | 'knowledge' | 'tool';
  summary: string;
  source: string;
  trust: 'verified' | 'unverified' | 'degraded';
  taskId?: string;
}

interface DeliverableView {
  content: string;
  stopReason: string;
  evidenceCoverage: number;
  openQuestions: string[];
  claims: Array<{ text: string; relation: 'supports' | 'contradicts' | 'context' | 'unverified' }>;
}

interface EngineeringView {
  repoRoot: string;
  branch: string;
  start?: { commit: string; dirty: boolean; snapshot: string };
  end?: { commit: string; dirty: boolean; snapshot: string; diffHash: string };
  tests: Array<{ command: string; status: string }>;
  build?: { status: string };
  review?: { verdict: string; issues: string[] };
}

interface KnowledgeView {
  confirmed: KnowledgeMapItem[];
  disputed: KnowledgeMapItem[];
  unanswered: KnowledgeMapItem[];
}
```

视图由 main 进程组装；Renderer 不直接读文件/DB。

### 3.3 UI-01 计划视图

- 显示目标、行为（用用户语言）、任务列表、状态、停止原因；
- 任务状态映射：pending「等待」、assigned「已分配」、running「进行中」、done「完成」、failed「失败」、blocked「受阻」、skipped「跳过」、cancelled「已取消」；
- 不显示 DAG 术语；
- 与 `PlanView` 一致；刷新/恢复后重拉。

### 3.4 UI-02 参与者

- 名单、角色、状态、为什么被选中/跳过；
- 输出摘要，不复制全文；
- 失败/超时/不可用原因；
- 不要求所有启用模型都出现。

### 3.5 UI-03 证据

- EvidenceRef 列表、来源、trust、关联任务/结论；
- 点击查看证据正文（EvidencePackStore）；
- 区分「模型推断」与「外部事实」；
- 未核验/降级必须显式标记。

### 3.6 UI-04 Engineering

- 工程上下文、分支、S1/S2、dirty、diff；
- Build/Test/Review 状态；
- 执行进度；
- 交付结果；
- 状态来自 `EngineeringTaskState`，不新建工程状态源。

### 3.7 UI-05 Knowledge

- 知识任务入口；
- 来源与阅读状态；
- 提取内容；
- 已确认/争议/未回答三块；
- 证据关联；
- 不新造 Memory 系统。

### 3.8 UI-06 General

- 通用入口；
- 自动识别任务类型；
- 计划/协作摘要；
- 按需 Debate；
- 最终交付。

### 3.9 UI-07 统一交付

- 结果、执行摘要、关键证据、验证结果、失败/限制；
- 「查看执行详情」跳转到计划/参与者/证据；
- 不把未核验内容标成已验证。

### 3.10 状态与恢复

- 会话切换不丢状态；
- 重启后从 AgentStore 恢复 CollaborationState；
- 恢复中 `running` 标「已中断」而不是假装仍在跑；
- 所有面板从同一 View 数据源刷新。

### 3.11 验收

- 三空间各自完成主任务；
- UI 只展示真实状态；
- 空/加载/失败/恢复四态；
- 组件测试 + 三空间 E2E；
- 不出现模拟数据。

---

## 4. C：质量、诊断与安全

### 4.1 C-01 P1 全量回归

测试分组：

```text
unit        domain/state/planner/scheduler/runner/behaviors
integration engine/active/shadow/persistence
boundary    web role/policy/gate/prompt policy
e2e         General/Knowledge/Engineering
```

入口：`npm run test:core` + `npm run test:features`；不包含 live/登录项。

### 4.2 C-02 CI 门禁

`npm run verify`：

```text
typecheck → test:core → test:features → prompt-policy → build
```

CI 失败条件：类型错误、核心测试失败、prompt policy 失败、构建失败。
不建设正式发布流水线。

### 4.3 C-03 诊断 UI

- 数据来自 `buildDiagnostics`；
- 展示通道异常、工具异常、失败/超时/取消原因；
- 脱敏路径、key、cookie；
- 不展示用户正文。

### 4.4 C-04 安全执行

把 `REQUIRED_SECURITY_CHECKS` 逐项映射到可执行检查：

| 检查 | 方法 |
| --- | --- |
| 无密钥入库 | grep/secret scan |
| Keychain | 代码审查 + 运行时检查 |
| 默认无遥测 | 配置检查 |
| 签名产物 | 发布阶段单独做 |
| 默认废纸篓 | 删除路径检查 |

输出实际结果，不只文档。

---

## 5. D：旧架构退出

### 5.1 退出顺序

1. active/shadow 稳定，legacy 仅回滚；
2. 统计旧入口调用（ConversationRunner 旧分支、Debate 主流程、strategy/runner）；
3. 逐文件确认调用方；
4. 迁移仍有价值的能力；
5. 删除无调用方代码；
6. 保留回滚开关与兼容测试。

### 5.2 禁止

- 未确认调用方直接删；
- 同时跑两套真实执行；
- 用 shadow 产生第二份模型调用成本；
- 为删旧代码重写稳定模块。

### 5.3 验收

- 新任务只走一个入口；
- 旧入口有调用链证据；
- 回滚可用；
- 删除前后回归通过。

---

## 6. E：总验收

### 6.1 E-01 三空间端到端

每个场景都要有：前置数据、操作步骤、预期状态、预期 UI、证据/交付断言。

#### General

| 编号 | 场景 | 步骤 | 预期 |
| --- | --- | --- | --- |
| G1 | 简单问答 | 输入单点问题 | 1 个参与者；independent；≤2 任务；交付含 stopReason |
| G2 | 复杂分析 | 输入比较/分析问题 | ≥2 参与者；parallel/crosscheck；计划与理由可见 |
| G3 | 按需 Debate | 构造未决争议 | 仅 matters && open 触发；无争议不触发 |
| G4 | 取消/重启 | 执行中取消；重启恢复 | 取消后不再提交；running 恢复为中断，不重跑 |

#### Knowledge

| 编号 | 场景 | 步骤 | 预期 |
| --- | --- | --- | --- |
| K1 | 资料输入 | 贴网页/文件 | 来源、提取内容、阅读状态可见 |
| K2 | 知识分析 | 生成结论 | 已确认/争议/未回答三块；一卡一结论 |
| K3 | 证据关联 | 点结论 | 追到 EvidenceRef 与来源；无来源条目不出现 |
| K4 | 复用/过期 | 二次提问旧卡 | fresh 可复用；stale/refuted 显式提示 |

#### Engineering

| 编号 | 场景 | 步骤 | 预期 |
| --- | --- | --- | --- |
| E1 | 只读分析 | 提代码问题 | 不写盘；结论带路径:行号 |
| E2 | 计划/审批 | 提修改任务 | 计划含影响面/测试/回退；写前审批 |
| E3 | 执行/worktree | 批准执行 | 独立 worktree；不污染主工作区 |
| E4 | 测试/评审 | 跑测试 | Build/Test/Review 状态来自 EngineeringTaskState |
| E5 | 回退 | 执行后回退 | S1/S2 可恢复；失败有原因 |

### 6.2 E-02 异常矩阵

| 场景 | 注入方式 | 预期 |
| --- | --- | --- |
| 本地不可用 | health=false | 不偷偷切 Remote；标记不可用 |
| 远端不可用 | 401/超时 | 降级/阻塞；原因可见 |
| Web 失败 | 页面错误 | 不影响其他参与者；记录失败 |
| 参与者失败 | ask reject | 任务 failed；依赖跳过 |
| 部分失败 | 1/3 失败 | 其余完成；交付列未完成 |
| 并发超时 | timeoutMs | 任务 failed=timeout；状态一致 |
| 用户取消 | AbortSignal | 不再提交；cancelled |
| 重启恢复 | 运行中重启 | running→blocked(restart_interrupted) |
| 权限不足 | 无审批 | 执行被拒绝；无写盘 |
| 证据缺失 | 无 EvidenceRef | unverified；不标已验证 |
| Reviewer 不通过 | verdict=fail | 不完成；列 issues |

每个场景必须同时断言：State、UI View、交付文案三者一致。

### 6.3 E-03 产品一致性

| 检查 | 断言 |
| --- | --- |
| 同一 Engine | 三空间都走 `runCollaboration`/ConversationRunner active |
| 策略/模式解耦 | `behavior` 与 `modelScope` 独立字段 |
| Local 不越界 | local 模式下无 remote 参与者 |
| Web 不是模型 | web 只回答/追问，不参与 modelScope 计数 |
| Debate 按需 | 无 matters && open 时不调用 |
| Evidence 可追溯 | 每条结论有 evidenceRefs 或显式 unverified |
| 状态一致 | PlanView/参与者/证据/交付同源 |
| 交付完整 | stopReason、openQuestions、evidenceCoverage 存在 |

### 6.4 E-04 完成报告模板

```md
# V3 正式功能验收报告
日期：
基线：
范围：A-03..E（不含发布）

## 功能清单
| 项 | 状态 | 证据 |

## 测试
- typecheck:
- test:core:
- test:features:
- E2E:

## 三空间 E2E
- General:
- Knowledge:
- Engineering:

## 异常场景
| 场景 | 结果 |

## 一致性
| 检查 | 结果 |

## 未解决问题 / 已知限制
## 架构退出
## 结论
```

### 6.5 E 完成门槛

- E-01 三空间全通过；
- E-02 至少 11 个异常场景通过；
- E-03 一致性检查全通过；
- E-04 报告完成并附测试输出；
- 任何未通过项必须列为已知限制，不能标记完成。

---

## 6A. 设计覆盖清单

| 任务 | 设计章节 |
| --- | --- |
| A-03 | §1 |
| A-04 | §2 |
| B-01..07 | §3.3–3.9 |
| C-01..04 | §4.1–4.4 |
| D（X-01/X-03） | §5 |
| E-01..04 | §6.1–6.4 |

A-03 到 E 均有设计；本文不代替实施与验收。

---

## 7. 文件与接口清单

| 文件 | 内容 |
| --- | --- |
| `collaboration/behaviors/strategy.ts` | 行为选择与任务图 |
| `collaboration/domain/types.ts` | `Plan.behavior` 扩展 |
| `collaboration/settings.ts` | 设置/指标 |
| `main/ipc/collaboration.ts` | settings/view/action IPC |
| `renderer/components/collaboration/*` | 7 个面板 |
| `renderer/pages/workspaces/*` | 三空间 |
| `collaboration/view.ts` | View 数据组装 |
| `release-ops/diagnostics.ts` | 诊断数据 |
| `scripts/check-*` | 行为/UI view/回归 |

---

## 8. 测试矩阵

| 层 | 覆盖 |
| --- | --- |
| 单元 | 行为选择、任务图、Gate、View |
| 集成 | Planner→Scheduler→Runner→Deliver |
| 边界 | Web 角色、modelScope、Gate、prompt policy |
| 恢复 | 持久化、重启、中断 |
| E2E | 三空间、异常场景 |

---

## 9. 实施顺序

1. A-03 行为；
2. A-04 Gate 入口；
3. B-01/02/03 基础面板；
4. B-04/05/06 三空间；
5. B-07 交付；
6. C 质量/诊断/安全；
7. D 退出；
8. E 总验收。

---

## 10. 风险

| 风险 | 对策 |
| --- | --- |
| 行为选择退化成固定流程 | 规则 + 理由可见 + 测试 |
| UI 伪造状态 | 只读 View，禁止 mock 数据进生产 |
| 新旧入口并存 | D 阶段调用链证据 + 删除 |
| 恢复重复执行 | running→blocked，不自动重跑 |
| Gate 被绕过 | IPC 只走 setGated |
| 诊断泄露 | 默认脱敏，不展示正文 |

---

## 11. 完成判定

- A-03/A-04 验收；
- UI-01..07 完成；
- 三空间 E2E 与异常场景通过；
- P1 全量回归、CI 门禁；
- 诊断/安全实际执行；
- 旧入口退出有证据；
- TASK-BOOK/AUDIT 一致；
- 发布项单独剥离。
