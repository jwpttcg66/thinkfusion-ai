# ThinkFusion V3 分层任务分解（TDL）实施任务书

版本：V1.0 · 基线：`main@6a15b9a` · 分支：`feat/v3-task-decomposition`  
架构：[`V3-TASK-DECOMPOSITION-LAYER.md`](../architecture/V3-TASK-DECOMPOSITION-LAYER.md)  
进度：[`V3-TDL-PROGRESS.md`](../implementation/V3-TDL-PROGRESS.md)  
相关：GDC [`V3-GOAL-DRIVEN-CYCLE-TASK-BOOK.md`](./V3-GOAL-DRIVEN-CYCLE-TASK-BOOK.md)、过程可见性 [`PROGRESS_VISIBILITY.md`](./PROGRESS_VISIBILITY.md)

> **约束：** 薄协调 + 投影；不另建 Runtime；不套任务提示词；不冻结流程基线；进度只投影真实状态。  
> **清理：** 合并验证后不自动删 worktree；仅用户明确要求时清理（`AGENTS.md` §5.1）。

---

## 1. 目标

落地 **Task Decomposition Layer**：让 Engineering 长任务具备父子分解、依赖、验收、进度汇总与可绘制面板，并与 GDC Cycle / PlanStep / Journal 明确边界。

## 2. 非目标

- 第二套 Orchestrator / Journal / Approval / Verifier  
- 用 Markdown Checklist 冒充权威进度  
- 重写 Collaboration Engine 或 Computer Use  
- 自动清理已合并 worktree  

## 3. 复用边界（对照最新 main）

| 现有资产 | 复用方式 | 禁止 |
| --- | --- | --- |
| `AgentTask` / TaskManager | Work 锚定；可选子 task 绑定 `agentTaskId` | 改成树形破坏现有指针语义而不迁移 |
| `AgentPlan.steps` | L3 执行步骤 | 把 PlanStep 当成 WorkTask |
| `goal-driven-cycle.ts` | Cycle/Goal/Artifact 投影；WorkTask 绑定 `cycleId` | 第二套 cycle 状态机权威库 |
| `ConversationTeamTask` | 借鉴 dependsOn / revision / evidence 形状 | 与 WorkTask 混用同一权威表 |
| `deriveProgress` / ProgressPanel | 计划内五段进度保留 | 用五段替代分解面板 |
| Journal / AgentEvent | 新增 `work.*` 事件并重放 | 旁路写库假装完成 |
| EventInspector / 活动流 | 按 `workTaskId` 过滤展开 | 伪造 reasoning / 假完成 |

## 4. 阶段

| ID | 内容 | 验收 |
| --- | --- | --- |
| **TDL-P0** | 审计：AgentTask / Plan / GDC / TeamTask / Progress 边界清单；确认缺口 | 本任务书 + 架构文档合入分支；审计表写入进度文档 |
| **TDL-P1** | 契约：`WorkTask` / `WorkBreakdownSnapshot` 类型；状态机；事件名 | `test:tdl-contract`（或等价 node:test）；无运行时行为也要通过类型与 schema 测试 |
| **TDL-P2** | 投影：`projectWorkBreakdownFromEvents`；汇总 `completed/total`；ready 依赖计算 | `test:tdl-project`：重放事件得到与输入一致的面板数据；禁止无事件变 completed |
| **TDL-P3** | 写入路径：分解创建/状态迁移/验收证据（主进程或 Runtime 插件，走 Journal） | 单测：CAS 冲突、依赖未满足不能 running、done 无证据拒绝 |
| **TDL-P4** | 与 GDC/Orchestrator 挂钩：子任务可选 cycle；complexity → debate/review 策略挂钩点 | 单测：low 不强制辩论；high_risk 策略字段可读；不改默认提示词 |
| **TDL-P5** | UI：工程主活动区 **WorkBreakdownPanel**（截图式清单 + 当前任务 + 分数） | typecheck；面板只消费 `WorkBreakdownView`；点击过滤活动流 |
| **TDL-P6** | 局部重规划与暂停/恢复单个子任务 | 单测 + 文档用例；范围变更只影响依赖闭包 |
| **TDL-P7** | 自动化全绿 + Engineering 真机：面板 0/N→k/N，展开可见真实步骤 | STATUS 更新；真机证据路径写入进度文档 |

### 4.1 建议实施顺序依赖

```text
TDL-P0 → TDL-P1 → TDL-P2 → TDL-P3 → TDL-P5
                ↘ TDL-P4 ↗
TDL-P3 → TDL-P6 → TDL-P7
```

P5 可在 P3 有最小写入后并行打磨 UI（用夹具事件）。

## 5. 进度面板验收（产品形态）

必须能绘制并随事件更新，至少包含：

1. 主标题 + 状态文案（执行中/已完成/阻塞）  
2. 分数 `completed/total`（非模型百分比）  
3. 子任务列表：优先级标签、标题、状态点（待执行/执行中/完成/阻塞/失败）  
4. 当前执行任务高亮（→）  
5. 展开后看到该子任务关联的真实计划步骤/工具/测试/审核事件  

示意（与架构 §5.2 一致）：

```text
专项任务书 + STATUS 写入                     1 / 6
→ 专项任务书 + STATUS 写入
○ P0: auto 按计划风险跳过五段/辩论
○ P0: 普通任务降低方案评审轮次上限
○ P0: 执行后模型审核门禁
○ P1: 核心意见去重/重要性上限
○ 测试 + typecheck + 提交
```

## 6. 测试命令（落地时登记到 package.json）

| 脚本（拟定） | 覆盖 |
| --- | --- |
| `test:tdl-contract` | 类型/状态机/非法迁移 |
| `test:tdl-project` | 事件重放投影与汇总 |
| `test:tdl-write` | 写入闸门与证据 |
| `test:tdl` | 上述聚合 |

未落地前不得在 STATUS 标 TESTED。

## 7. 文档与状态板义务

每阶段完成时更新：

- [`STATUS.md`](../implementation/STATUS.md) 能力行  
- [`V3-TDL-PROGRESS.md`](../implementation/V3-TDL-PROGRESS.md)  
- 必要时交叉引用 GDC 说明书 §七「多任务与多层循环」：指向本架构为 WorkTask 正式落点  

## 8. 回滚

- Feature flag（建议 `taskDecomposition.v1`）：关闭则隐藏面板，忽略 `work.*` 写入，投影返回空分解。  
- 事件保留在 Journal，不影响旧任务回放。  
- 不删除用户数据；不自动删 worktree。  

## 9. 本分支当前交付（DESIGN）

本提交只交付：

1. 架构说明书  
2. 本实施任务书  
3. 进度板 `V3-TDL-PROGRESS.md`（P0 文档审计）  
4. `AGENTS.md` §5.1：不自动清理 worktree  

运行时实现从 **TDL-P1** 起在本 worktree 继续，或按并发规则另开阶段提交。
