# P1 整改执行计划（2026-11-25 审计）

基线：`main`（P0 已合入）。每项独立 worktree/分支，typecheck + 回归测试 + 真机证据后合入，不推送。

## 1. 长任务默认启用与恢复联动

现状：`src/main/index.ts` 的 `CONTEXT_MANAGER_ACTIVE` 只认环境变量，默认关闭；
`eco.ts` 的 `buildEcoCheckpointRef / parseEcoEvidenceRef / isEcoRefCompatible` 有纯函数但**恢复链路零调用**。

改动点：
- `src/main/context/manager.ts` / `contextManagerFor()`：开关改为可配置（设置页读写的 store），环境变量保留为覆盖；
- `src/main/context/recovery/task-recovery.ts`：恢复前读取检查点 evidenceRefs 里的 `eco-context:`，调 `isEcoRefCompatible`；不兼容 → 要求重新读取工程，不静默继续；
- 事件：恢复结果写 `context.restore` 详情（兼容/不兼容原因），可观测；
- 测试：`check-context-recovery` 增加三条（兼容、版本落后、目标版本变化）。

验收：真机暂停/继续一次工程任务，检查点能读回 ECO 版本；不兼容时任务状态可见且不被标成已验证。

## 2. Goal ↔ WorkTask 持久化

现状：seed 写入 `goalId/goalVersion`，`applyGoalVersionBump` 仅测试使用；`work.breakdown.replanned` 契约存在但无生产发送点。

改动点：
- 目标变更入口（工程任务 goal 更新处）调 `classifyGoalChange + applyGoalVersionBump`；
- 新版本落地时发 `work.breakdown.replanned`（impactedIds 用 `impactedByReplan` 计算），并重算分母；
- 测试：目标缩小（change）→ 版本 +1、受影响任务进 replanned；优化/澄清 → 版本不变。

验收：真机改一次目标成功标准，任务树出现 replanned 记录，UI 分母随之变化。

## 3. Workflow Definition / Plugin

约束：复用 TDL 的 WorkTask + GDC 的 cycle，不新建 Runtime；插件只能声明能力组合与顺序，不接收模型/提示词。

最小可交付：
- `shared/workflow.ts`：`WorkflowDefinition { id, nodes[], edges[] }`，节点只引用现有能力 id；
- 校验：未知能力、环、孤立节点拒绝；
- 执行：在现有 orchestrator 内把节点映射为步骤，仍走审批与事件；
- 测试：定义校验 + 拓扑顺序 + 单步失败中止。

验收：一个两节点工作流（读文件 → 跑测试）真机执行，事件链完整。
