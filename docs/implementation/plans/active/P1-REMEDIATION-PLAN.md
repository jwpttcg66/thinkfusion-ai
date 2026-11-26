# P1 整改执行计划（基于 2026-11-25 审计，已按 main@63ae383 校正）

本文只记录仍未闭合的整改项。当前状态总表见 [STATUS.md](../../STATUS.md)。已落地部分从剩余计划中剥离，避免旧审计的“未开始”被误读成当前事实。

## 1. 长任务恢复与 ECO 兼容门禁

**已有：** Context Manager 开关按环境变量 > `context-manager.json` > 默认关闭解析；恢复会读检查点 ECO 引用并计算兼容性结果；恢复结果会带回 side-effect ledger。

**剩余：** `AgentOrchestrator.resume()` 尚未依据 ECO 不兼容结果阻断继续或要求重新采集工程上下文；当前恢复结果仍可能作为普通 recovered 继续。

**完成条件：**
- 兼容时恢复并发出可追溯的恢复结果；
- ECO 目标/版本不兼容时任务停在可解释状态，不把旧摘要当当前工程事实；
- 测试覆盖兼容、目标变化、关键工程上下文版本落后；
- 真机走一次暂停/重启/恢复，确认事件、UI 状态和新请求携带的数据一致。

## 2. Goal ↔ WorkTask 版本变更闭环

**已有：** 新计划替换已有分解时，`AgentOrchestrator` 会发 `work.breakdown.replanned`，并将未完成 WorkTask 标记为受影响；`shared/goal-driven-cycle.ts` 提供目标变化分类和版本递增纯函数。

**剩余：** 用户修改成功标准/目标的生产入口没有统一调用目标变化分类与版本更新，不能保证 Goal 版本、受影响 WorkTask 和进度分母原子一致。

**完成条件：**
- 用户明确改目标时只递增一次版本，并记录变更类型和来源；
- 澄清/措辞优化不递增版本；
- 仅受影响的未完成 WorkTask 进入 replanned，已完成任务保留真实事实；
- 新旧 Goal 版本、事件和 UI 进度可恢复；
- 真机修改目标后，事件和进度树与实际任务一致。

## 3. Workflow Definition / Plugin 闭环

**已有：** `src/shared/workflow.ts` 可定义节点/边并检查未知节点、环和拓扑顺序；它目前是纯定义/验证能力。

**剩余：** 没有将 Workflow Definition 接入用户入口与 `AgentOrchestrator` 的生产执行闭环，不能宣称存在可运行的 Workflow Plugin 产品能力。

**完成条件：**
- 仅组合已有能力 ID；不接收模型/提示词，不建第二套 Runtime；
- 执行仍复用现有审批、TaskGrant、Journal、事件和报告；
- 单节点失败按现有执行规则收敛；
- 集成测试覆盖拓扑、权限、失败/取消；
- 真机执行“读文件 → 跑测试”两节点任务，事件与交付证据完整。

## 顺序与回退

1. 先完成 Goal ↔ WorkTask 生产入口及恢复门禁；验收后再做 Workflow 接线。
2. 任一步不通过时回退对应入口接线，保留旧状态和已落库事件；不删除已完成能力。
3. 每一项依照 `AGENTS.md` 使用独立 worktree，提交前完成 typecheck、专项测试和相关真机验证；不推送远程。
