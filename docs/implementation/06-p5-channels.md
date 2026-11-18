# P5 模型与通道

目标：Web / Local / Cloud / CLI 作为同一类参与者接入；新增通道不改主流程。
前置：P1 引擎稳定、P4 证据统一。
出口：新增一个来源只加 Adapter 与能力描述。

---

## 1. 能力模型

```ts
export interface AgentCapabilities {
  kind: 'web' | 'local' | 'cloud' | 'cli';
  canSystemPrompt: boolean;
  canUseTools: boolean;
  canStream: boolean;
  canSeeOtherAgents: boolean;
  maxConcurrency: number;
  costClass: 'low' | 'medium' | 'high';
  /** 新增：是否需要人工登录/授权。 */
  requiresLogin?: boolean;
}
```

| 类型 | system | 工具 | 流式 | 看他人 | 并发 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| Web | ✗ | ✗ | 轮询增量 | ✗ | 1/页面 | 只收原话或系统转述的数据块 |
| Local | ✓ | ✓ | ✓ | ✓ | 1–2 | 本机模型 |
| Cloud | ✓ | 视模型 | ✓ | ✓ | 2–4 | API 模型 |
| CLI（只读） | ✗ | ✗ | ✗ | ✗ | 1 | 回答源，临时目录 |
| CLI（执行） | — | ✓ | ✗ | — | 1 | 走 TaskGrant/审批，不在本能力表 |

规则：

- 能力由 Adapter 声明，调度器只读声明，不猜。
- 网页通道 `canSystemPrompt=false`、`canUseTools=false`；任何需要工具的任务不得分配。
- 降级（模型不可用、LSP 不可用、页面结构变化）必须显式记录。

---

## 2. 路由与降级

顺序：

1. **第一手**：所有已开启且可用通道，全部参与（AGENTS 第 2 条）。
2. **后续任务**：按能力过滤 → 按负载/成本排序 → 写 `Assignment.reason`。
3. **降级阶梯**（每级都要说出来）：
   - 首选模型不可用 → 次选同能力模型；
   - 本地不可用 → 云端（若允许且有 Key）；
   - 工具不可用 → 文本搜索，并标 `degraded`；
   - 全部不可用 → 任务 `skipped`，交付物写缺口。

禁止：静默改用低质量模型、静默减少参与者、把降级结果标成正常。

---

## 3. 新增一个通道

步骤固定，不允许改主流程：

1. 在 `providers/` 或 `adapters/` 加 Adapter（选择器/接口/错误归一）；
2. 声明 `AgentCapabilities`；
3. 加来源配置（`shared/sources.ts` 或设置页默认值）；
4. 加单测（取回答、失败、超时）；
5. 加 live 检查（可选，登录态下）；
6. 不改 Planner/Scheduler/Verifier。

验收：新增一个 mock 通道，只需 Adapter + 能力声明；第一手覆盖率仍为 100%。

---

## 4. 配置与可观察

- 每个通道显示：启用/可用/健康/最近失败原因；
- 模型选择理由可读（谁、为什么、降级了吗）；
- 费用/延迟按通道记录，不混淆网页（无 token）与 API（有 token）。

---

## 5. 场景与测试

- `check-channel-capabilities.mjs`：能力声明与调度过滤一致；
- `check-channel-fallback.mjs`：四级降级都有记录；
- `check-new-channel.mjs`：mock 通道只加 Adapter 即可跑通第一手；
- live：真实登录态至少一个网页 + 一个 API 模型。

---

## 6. 任务清单

| ID | 任务 | 文件 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| P5-01 | 能力声明 | `src/main/agents/capabilities.ts` | P1 | 能力测试 |
| P5-02 | 路由降级 | `scheduler/routing.ts` | P5-01 | 降级测试 |
| P5-03 | 新通道模板 | 文档 + mock | P5-02 | new-channel 测试 |
| P5-04 | 观测与费用 | 事件增量 | P5-02 | 观测测试 |

---

## 7. 出口清单

- [ ] 四类参与者能力声明齐全，网页边界类型化
- [ ] 第一手全覆盖；后续选择有理由
- [ ] 四级降级都有记录，不静默
- [ ] 新增通道只改 Adapter + 能力声明
- [ ] 费用/延迟按通道可观察
- [ ] 简单问题不会被能力路由过度拆分
