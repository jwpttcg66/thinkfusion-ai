# P1 统一协作引擎

目标：让任务图、观测、重规划真正跑起来，并把辩论降级为按需行为。
前置：P0 出口全绿。
出口：shadow 指标达标并切到 active；简单问题不被拆成流水线。

---

## 1. 目标模块（基于现有目录，不机械新建）

```text
src/main/collaboration/
  engine.ts          # 入口：run(goal) / stop(goalId)
  domain/            # P0 已建
  planner/planner.ts
  scheduler/scheduler.ts
  runner/runner.ts
  runner/observation.ts
  adapt/replanner.ts
  behaviors/
    independent.ts
    parallel.ts
    progressive.ts
    cross-check.ts
    counterexample.ts
    review.ts
    debate.ts
  participants/manager.ts   # 从 MasterAgent 抽出的参与者管理
  synthesize/deliver.ts
```

规则：

- **先复用**：`collaboration/strategy.ts` 的并行/递进计划、`runner.ts` 的记录结构、
  `master-agent.ts` 的参与者与失败记录，能搬就搬。
- 不新建 `Runtime / Journal / TaskGrant / Verifier / EvidenceStore`。
- 新目录只放编排与纯逻辑；I/O 仍走既有 Store、Agent、EvidencePack。

### 1.1 单一状态 CollaborationState（P1.0 第一件事）

所有模块只操作一份状态，**不允许 Planner / Scheduler / Runner 各存一份任务列表**：

```ts
interface CollaborationState {
  goal: Goal;
  tasks: Array<TaskSpec & { status: ... }>;
  assignments: Assignment[];
  observations: Observation[];
  evidence: EvidenceRef[];
  budget: { maxCalls: number; maxMs: number; usedCalls: number; startedAt: number };
  replans: ...;          // P1.0 恒为空，P1.1 才写
  stop?: { reason: StopReason; at: number };
  deliverable?: Deliverable;
}
```

- 每次转移都是纯函数：`(state, event) -> state`；
- 落盘复用 `AgentStore`（P1.0 接线，不新建 Journal）；
- 事件由转移函数产生，Runner 不再自己拼状态。

---

## 2. M1.1 ParticipantManager

从 `master-agent.ts` 抽出，不改 legacy 行为：

```ts
export interface ParticipantManager {
  list(): ParticipantView[];                 // 可用性、健康、类型
  ask(input: { question: string; participants: string[] }): Promise<Observation[]>;
  failures(): ParticipantFailure[];
}
```

- **问几个由 Planner 决定**（AGENTS 第 2 条，2026-11-18 裁决）：Manager 只执行名单，
  不再默认全部参与。
- 简单事实/单点核对可 1 个；有争议、高风险、用户要求多视角时至少 2 个。
- 每个参与者写入 `reason`；被跳过的通道写清原因，对用户可见。
- 网页 / 本地 / 云端 / CLI（只读）都实现同一 `SubAgent` 接口，不新增协议。
- `MasterAgent.research()` 在 legacy 模式下保持原样；新代码只调用 Manager。
- 删除条件：见 00 文档 5.3；在此之前两套并存但只由 flag 决定走哪套。

验收：`check-collaboration-participants.mjs` 覆盖「按名单执行」「1 个也能跑」「跳过有原因」「高风险至少 2 个」。

---

## 3. M1.2 Planner MVP

输入 `Goal`，输出 `CollaborationPlan`（P0 契约），**默认尽量小**：

| 任务类型 | 计划规模 | 说明 |
| --- | --- | --- |
| 简单事实/解释 | 1 个 fan-out 任务 | 所有通道独立作答 + 综合，不拆子任务 |
| 比较 / 选型 | 2–4 个任务 | 按维度拆，或按来源拆 |
| 研究 / 调查 | 3–6 个任务 | 含至少一个验证任务 |
| 工程理解 | 2–5 个任务 | 搜索、读取、取证 |
| 工程修改 | 见 P3 | P1 只做只读计划 |

硬性限制（初始值，可调）：

- 单计划最多 **8** 个任务，深度最多 **3**；
- 每个任务必须有 `acceptance`，否则拒绝生成；
- 计划必须写明 `stopWhen`；
- **不允许**把所有任务都拆成「独立 → 质疑 → 修订 → 裁判」。

策略选择：

- 默认 `independent`；问题长或依赖前序结论才 `progressive`；
- 只有计划里出现「验证某条 Claim」才生成 `cross-check`；
- 规则可解释（写进 `plan.reason`），不依赖模型分类。

验收：`check-collaboration-plan.mjs`：简单问题 1–2 任务；研究题不超过上限；每个任务有验收；无固定阶段链。

---

## 4. M1.3 Scheduler

### 4.1 选人

1. **数量来自 Planner**：计划里已有参与者数量与名单；Scheduler 不自作主张增删。
2. **后续任务**：按 `requiredCapabilities` 过滤（工具、system、stream、并发、成本），
   再按当前负载与成本排序；每次分配写 `Assignment.reason`。
3. 简单任务允许只有 1 个参与者；有争议/高风险/多视角要求时，Scheduler 拒绝降到 1 个。
4. 网页通道不分配需要工具或需要看他人输出的任务（除系统转述数据）。
5. 跳过、降级、失败都进 Observation，不静默。

### 4.2 并发与依赖

- 按 DAG 分层：无依赖并行，有依赖串行；单通道并发上限与全局上限取小。
- 网页页面一次只操作一个；同通道任务串行化。
- 超时是任务属性；超时标 `failed`，不无限重试。
- 取消：用户取消 → 停止派发新任务 → 对运行中任务发取消信号（网页「停止生成」/ CLI kill）。

验收：`check-collaboration-scheduler.mjs`：依赖顺序、并发上限、网页串行、超时、取消。

---

## 5. M1.4 Runner / Observation

- Runner 只做三件事：派发、收集、记录；不做规划、不做综合。
- 每个任务产出 `Observation`：`done / failed / skipped`，失败也是结果。
- 证据引用立即落 `EvidenceRef[]`（P4 做统一映射，P1 先存 Pack id + 位置）。
- 事件按 P0 契约发；不新增事件总线。

验收：`check-collaboration-runner.mjs`：失败记录、跳过原因、事件顺序、取消后不再派发。

---

## 6. M1.5 Replanner（P1.1，P1.0 不做）

**P1.0 不实现自动重规划**；先让 Goal → DAG → Run → Observation → Deliver 跑通，
再单独加这一节。以下规则在 P1.1 生效。

### 6.1 关键阶段的模型审核（P1.1）

允许在「计划生成后 / 重规划前 / 辩论触发前」调用一个模型做审核：

- 输入：结构化计划、Observation、Dispute；输出：`{verdict: approve|adjust|reject, reason, changes}`；
- 不含角色、阶段、挑战话术；只是数据 + 输出 schema；
- 只允许能接收 system 的 local/cloud；网页通道不参与审核；
- 默认关闭；预算上限；输出不合法或超时 → 回退规则，不阻塞交付；
- 审核记录写进 `CollaborationState.replans` 或事件，能回答「谁审的、改了什么」。

每波结束调用一次，输入 `TaskGraphState`，输出「继续 / 加任务 / 停」。

触发规则（按优先级）：

1. `acceptance` 有未覆盖项 → 加任务（补证据 / 补验证）；
2. 存在 `matters=true` 且 `unverified` 的 Dispute → 允许 `cross-check`，仍不解决才 `debate`；
3. 连续两波无新增信息 → 停（`no_new_information`）；
4. 预算耗尽 / 用户取消 / 被阻塞 → 停并写原因。

护栏：

- 最多重规划 **2** 次；
- 新增任务不得超过初始上限；
- 同一 `taskId` 不重复派发；
- **没有新证据时禁止为了「更全面」再加一轮**。

验收：`check-collaboration-replan.mjs`：缺口驱动、无新增即停、辩论门槛、护栏生效。

---

## 7. M1.6 行为目录

**P1.0 只做四个**：independent / parallel / progressive / cross-check。
counterexample、review、debate 放 P1.1（review 可在 P3 工程任务只读场景提前用）。

| 行为 | 触发 | 产出 | 成本 | 停止 |
| --- | --- | --- | --- | --- |
| independent | 默认 | 多通道独立回答 | 低 | 全部返回/超时 |
| parallel | 任务彼此独立 | 多任务并行 | 中 | 依赖满足 |
| progressive | 后任务依赖前序 | 带上下文的回答 | 中 | 无新增信息 |
| cross-check | 有 `matters` 争议 | Verdict | 中 | 争议收敛/证据耗尽 |
| counterexample | 结论过于一致或用户要求审计 | 反例与条件 | 高 | 找到反例/确认没有 |
| review | 工程计划/改动 | 评审意见 | 中 | 风险项有结论 |
| debate | 交叉验证后仍未定论 | Verdict + 证据 | 高 | 无新证据/预算耗尽 |

`test` 必须证明：**没有争议时不会启动 debate**；简单问答不会生成 cross-check。

---

## 8. M1.7 网页通道边界

- 第一手：只发用户原话，`system` 为空。
- 后续：只发「问题 + 已有观点」数据块，标注为系统转述；**不写「请指出」「说明是否修改」**。
- 不把 `TaskEnvelope` 的 scope/acceptance 拼进网页消息。
- 需要看他人输出的递进任务，若通道不支持转述，则跳过并记录。

验收：`check-web-boundary.mjs`：第一手无前缀；后续无指令词；跳过有原因。

---

## 9. M1.8 辩论降级（P1.1）

### 9.1 触发

同时满足才调用：

1. 存在 `matters=true` 的 Dispute；
2. 已尝试 `cross-check` 且仍 `unresolved`；
3. 该争议被交付物引用；
4. 预算允许。

### 9.2 适配器

```ts
export interface DebateBehaviorInput {
  goalId: string;
  question: string;
  claims: Claim[];
  disputes: Dispute[];
  participants: string[];
}
export interface DebateBehaviorOutput {
  observation: Observation;
  verdicts: Verdict[];
  evidence: EvidenceRef[];
}
```

- 复用 `DebateOrchestrator`，不复制其逻辑；
- 不传 `repository`（不再创建基线）；
- seed 只放已有 Observation/Claim，不生成角色提示词；
- 输出映射成 Verdict/Evidence，回到任务图。

### 9.3 入口

- UI 移除「辩论 / 策略」选择；
- 保留调试开关（仅开发模式）用于手动触发；
- 旧会话里的 `debateMode` 字段读时兼容，不再写新值。

验收：`check-debate-adapter.mjs`：触发条件、无基线、输出映射、UI 入口消失。

---

## 10. M1.9 可观察性（不做产品 UI 改版）

**P1 不改产品界面。** 只做内部可观察：

- 把 CollaborationState 与事件写到日志/调试文件（`out-test/collaboration/<goalId>.json`）；
- 设置页保留一个只读调试入口（开发者模式），显示当前计划与停止原因；
- 产品 UI 的正式改造放在 P3/P4 之后（见 07-ui.md）。

验收：不登录、不打开新页面，也能从日志判断「谁在做什么、为什么停」。

> 若确实需要一个最小界面，只允许在现有进度区加只读文本，不做布局重排。

---

## 11. M1.10 Shadow 协议

### 11.1 P1.0：plan-only

- `shadow`：旧路径执行；新 Planner 只算计划，**不调用模型、不执行任务**。
- 若规划必须模型参与：标 `unrated`，不估算成本。
- 输出：`out-test/shadow/<goalId>.json` + 汇总报告：
  - 任务数、fan-out、依赖深度；
  - 是否覆盖 acceptance；
  - 参与者覆盖（是否所有通道）；
  - 风险（任务过多、固定链、网页越界）。
- 切 active 的门槛（初始建议）：
  - 20 个真实问题：计划覆盖率 ≥ 90%；无固定阶段链；无网页越界；
  - 简单问题平均任务数 ≤ 2；
  - 人工抽检 5 个计划，理由可读。

### 11.2 不做双跑

2026-11-18 裁决：暂不引入第二份真实调用成本。需要对照真实结果时，先用录制回放
（fixture）验证；回放也不做，就只保留 plan-only。

---

## 12. 任务清单

| ID | 阶段 | 任务 | 文件 | 依赖 | 验收 |
| --- | --- | --- | --- | --- | --- |
| P1-00 | P1.0 | 单一状态 + 落盘 | `domain/state.ts` + `engine.ts` | P0 | 状态转移测试 |
| P1-01 | P1.0 | 参与者管理 | `participants/manager.ts` | P0 | participants 测试 |
| P1-02 | P1.0 | Planner | `planner/planner.ts` | P1-00/01 | plan 测试 |
| P1-03 | P1.0 | Scheduler | `scheduler/scheduler.ts` | P1-02 | scheduler 测试 |
| P1-04 | P1.0 | Runner/Observation | `runner/*` | P1-03 | runner 测试 |
| P1-05 | P1.0 | Deliver | `synthesize/deliver.ts` | P1-04 | deliver 测试 |
| P1-06 | P1.1 | Replanner | `adapt/replanner.ts` | P1.0 | replan 测试 |
| P1-07 | P1.0 | 行为 MVP（四个） | `behaviors/*` | P1-04 | 行为测试 |
| P1-08 | P1.0 | 网页边界 | `adapters/*` 增量 | P1-07 | web-boundary 测试 |
| P1-09 | P1.1 | 辩论适配 | `behaviors/debate.ts` | P1-06/07 | adapter 测试 |
| P1-13 | P1.1 | 关键阶段模型审核 | `adapt/reviewer.ts` | P1-06 | reviewer 测试 |
| P1-10 | P1.0 | 日志/调试可观察 | `engine.ts` 增量 | P1-04 | 日志场景 |
| P1-11 | P1.0 | Shadow plan-only | `engine.ts` 分支 | P1-02..04 | shadow 报告 |
| P1-12 | P1.0 | 切 active（可先保持 shadow） | flag | P1-11 | 回滚演练 |

---

## 13. 出口清单

### P1.0（现在）

- [ ] 简单问题 1–2 个任务，不生成固定阶段链
- [ ] 参与者数量由 Planner 决定；1 个能跑；跳过有原因；高风险不单点
- [ ] 任务图支持依赖、并发上限、超时、取消
- [ ] 失败与跳过都是 Observation，不静默
- [ ] 单一 CollaborationState 落盘，模块不另存状态
- [ ] 停止原因可解释（P1.0 允许只有 acceptance / budget / cancel）
- [ ] 网页后续轮只收数据，不含指令
- [ ] 日志能解释「谁在做什么、为什么停」
- [ ] shadow plan-only 报告可复跑；flag 回滚演练通过
- [ ] typecheck + P1.0 测试全绿；legacy 行为无回归

### P1.1（之后）

- [ ] Replanner 有护栏，能解释停止原因
- [ ] 辩论只在满足 §9.1 时触发，且不再创建基线
- [ ] counterexample / review 行为可用
- [ ] 关键阶段模型审核可开关、有预算、失败回退规则
