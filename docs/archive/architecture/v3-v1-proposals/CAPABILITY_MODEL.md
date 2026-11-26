# P5 能力与通道路由设计

> 文档状态：HISTORICAL。本文属于 2026-11 V3 P0–P6 V1 方向设计；其对象模型、阶段计划和实现状态均不能作为当前接口或完成度依据。当前架构见 `docs/ARCHITECTURE.md`，状态见 `docs/implementation/STATUS.md`。


文档角色：能力与通道路由的目标设计；本文不声明实现状态。
当前实现见 [STATUS](../../../implementation/STATUS.md)；参与者/网页边界见 [ADR 0008](../../../adr/0008-participant-selection.md) 与 [ADR 0009](../../../adr/0009-web-roles.md)。

两个维度：

```text
来源：网页渠道（页面驱动） | 模型驱动（本地 / 远端 / CLI）
范围：local（只本地） | remote（只远端） | hybrid（两者）
网页：由 includeWeb 单独决定，不因 hybrid 自动加入
```

---

## 1. 能力

`CapabilityId` 与 `Capability` 的权威定义见
[P1-002 §3.2](../../implementation/audits/P1-002-DOMAIN-RUNTIME-CONTRACT.md)；这里只列任务到能力的映射。

| 任务 | 需要能力 |
| --- | --- |
| 事实问答 | reasoning / knowledge |
| 网页研究 | web-research |
| 代码理解 | code-search / code-read / symbols / impact |
| Java 理解 | java + code-search |
| 工程验证 | test-run / review / verification |

---

## 2. 参与者

`Participant` 的权威定义同样见 P1-002 §3.2。这里只记路由相关约束：

- 网页：`canSystemPrompt=false`、`canUseTools=false`、`canSeeOtherAgents=false`；
- 本地/远端：可收 system/工具，受 `ModelScope` 约束；
- CLI：只读参与者与执行者分开（执行者不在本表）。

角色：

| 空间 | 网页可担任 | 说明 |
| --- | --- | --- |
| 知识学习 / 通用 | answerer / questioner | 提问者只收 `QuestionerInput`（单条问题 + 数据） |
| 工程 | **仅 answerer** | 不得提问、不得规划、不得主导 |
| 执行规划 | 所有空间都由 local/cloud 承担 | 网页不得生成 `desktop-agent` 计划 |

> 四要素：第一轮只发原话；知识/通用可发单条追问；工程只回答；全空间不接收 `ContractInput`。

## 3. 路由

```ts
export interface RoutingDecision {
  taskId: string;
  selected: Array<{ participantId: string; reason: string }>;
  skipped: Array<{ participantId: string; reason: string }>;
  policy: {
    modelScope: 'local' | 'remote' | 'hybrid';
    includeWeb: boolean;
    /** 知识/通用可为 true；工程必须 false。 */
    allowWebQuestioner: boolean;
  };
}
```

顺序（不可调换）：

1. **范围**：`local` 去掉远端，`remote` 去掉本地；越界直接拒绝；
2. **网页**：`includeWeb=false` 去掉全部 `kind='web'`；即使启用，工程空间也只允许回答，
   网页 `questioner` 必须被拒绝；
3. **能力**：去掉缺少 `requiredCapabilities` 的参与者；
4. **可用性**：去掉 unavailable，记原因；
5. **风险下限**：高风险/有争议/多视角要求 → 至少 2 个；
6. **成本/负载**：同能力下按 `costClass`、并发、失败率排序；
7. **理由**：每个选中写 reason；跳过写 skipped。

禁止：

- 静默减员；
- `local` 因本地不可用改调远端；
- 网页通道参加需要工具或看他人输出的任务；
- 用「省成本」作为唯一理由。

---

## 4. 降级

| 级别 | 条件 | 行为 |
| --- | --- | --- |
| 1 | 首选同范围模型不可用 | 换同范围次选 |
| 2 | 工具/LSP 不可用 | 文本搜索，标 `degraded` |
| 3 | 范围内全部不可用 | 任务 `skipped`/`blocked`，不跨范围 |
| 4 | 无满足能力的参与者 | `skipped`，交付写缺口 |

降级必须写进 Observation/State；不能把降级结果标成正常。

---

## 5. 新通道

固定步骤：

1. Adapter（选择器/接口/错误归一）；
2. `AgentCapabilities` + `capabilities` 声明；
3. 来源配置；
4. 单测（回答、失败、超时）；
5. live 检查（可选，登录态）；
6. 不改 Planner/Scheduler/Verifier。

验收：mock 通道只加 Adapter + 声明即可跑通；主流程零改动。

---

## 6. 费用与延迟

```ts
export interface ChannelTelemetry {
  participantId: string;
  calls: number;
  failures: number;
  totalMs: number;
  /** 网页无 token，单独标记，不混算。 */
  billing: 'none' | 'tokens' | 'subscription';
}
```

- 网页计调用次数与耗时，不伪造 token；
- 远端按实际 usage；
- 汇总只用于观测与预算，不参与选人正确性判断。

---

## 7. 验收

- 能力声明与调度过滤一致；
- `local` 不越界，`remote` 不越界；
- 网页不参加工具任务；
- 高风险至少 2 个；
- 新增通道只改 Adapter；
- 费用/延迟按通道可读。

---

## 8. 风险

| 风险 | 对策 |
| --- | --- |
| 能力声明与实现不符 | 启动自检 + 测试 |
| 路由偷偷减员 | reason/skipped 必填 |
| 网页被塞指令 | Adapter 边界测试 |
| 降级越界 | 范围校验先于降级 |
| 费用混算 | billing 字段区分 |
