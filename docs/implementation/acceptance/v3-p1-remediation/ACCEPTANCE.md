# V3 架构一致性整改：P1 批次验收记录

**批次：** P1-01 ~ P1-05（2026-11-26）
**基线：** P0 批次 `14331d4` → 本批次 `7727abb`
**范围：** ECO 按需工程探索、子任务独立 Cycle、三场景 DMOCA 统一、Workflow 生产闭环、
长任务版本一致性。
**不包含：** P2-01 Java 结构化理解、P2-02 Knowledge 产品化、P2-03 发布。

> 本记录只声明 `IMPLEMENTED / TESTED`。这批新增分支（工作流运行入口、会话决策快照、
> 子任务循环面板、版本链恢复提示）**没有**真机样本，因此一律不标 `VERIFIED`。

## 1. 运行环境与命令

| 项 | 值 |
| --- | --- |
| 平台 | macOS（本机），Node 22 |
| 类型检查 | `npm run typecheck`（tsconfig / agent / renderer 三个工程） |
| 全量自动化 | `npm run verify`（40 个测试 suite，含本批次新增 4 个） |
| 结果 | 全绿，`fail 0` |
| 输入 | 纯函数 fixture + 临时工作区（`mkdtemp`），不触网、不读真实 userData |

## 2. 逐项验收

| 交付 | 状态 | 验证方式 | 覆盖点 | 未覆盖 |
| --- | --- | --- | --- | --- |
| P1-01 ECO 按需探索 | `IMPLEMENTED / TESTED` | `test:eco-explore`（7）、`test:eco`（10） | 六类请求产出顺序与优先级；FILE_READ / DIRECTORY_DISCOVERY / SYMBOL_LOOKUP / CALL_RELATION / TEST_DISCOVERY 真读临时工作区；越界路径跳过；DIFF_READ 非仓库如实失败；`fulfillContextRequest` 盖 provenance/sources 并抬版本；提交/目标变化判过期；`PlanSchema` 接受 `contextRequests` 且拒绝未知类型 | 符号定位是正则级，不是 AST；没有真机看模型主动发起请求后的评审材料 |
| P1-02 子任务独立 Cycle | `IMPLEMENTED / TESTED` | `test:subtask-cycle`（8） | 每个 L2 独立 cycleId、L3 跟随；依赖未满足标 blocked；阶段推进与失败隔离；依赖闭包阻塞；跨子任务写冲突只认不同子任务；集成计数；事件重放（含「步骤全完成但 L2 无终态」）；迟到事件不把已通过拉回 | 仍是一次 runPlan，不是物理并行；未真机看进度树 |
| P1-03 三场景 DMOCA | `IMPLEMENTED / TESTED` | `test:dmoca`（25） | 会话决策钉最后一版、旧稿 superseded；单模型 `singleModel=true` 且不假装交叉验证；失败/超时进 unresolvedIssues 但不阻塞；无正文不造决策；投影与工程同一视图结构、完整性可复核 | 会话界面尚未展示决策快照；未真机跑多轮辩论 |
| P1-04 Workflow 生产闭环 | `IMPLEMENTED / TESTED` | `test:workflow`（10） | 条件不成立连带跳过依赖者；count 循环展开成真实步骤；`until` 明确拒绝；parallel 如实串行并写 note；approval 抬人工批准且不产生步骤；注册表能力全部存在于 `TOOL_NAMES`；按目标选择与同分不硬选；`workflowToPlan` 缺参数整份拒绝 | `workflow:run` 只有 IPC，无界面入口；没有真机跑「读文件 → 跑测试」样本 |
| P1-05 版本一致性 | `IMPLEMENTED / TESTED` | `test:version-consistency`（7）、`test:context-recovery`（8） | 四层一致；目标变更整链作废并 `requiresReplan`；任务树绑旧目标也重规划；ECO 过期只要求刷新且可继承 Goal/WorkTask；决策钉错快照只作废决策；缺字段不误判；恢复时目标版本不一致 → `needs_replan` 且提示「不得沿用旧分解」 | 未真机走「改目标 → 暂停 → 恢复」全链；目标变更仍无界面确认 |

## 3. 已知边界（与 P1 执行计划一致）

1. ECO 符号/调用是正则级定位，扫不到如实跳过；深度 Java 结构理解仍在 P2-01。
2. 子任务循环复用主任务执行轮次（硬性约束：不得新建调度器），失败隔离体现在
   WorkTask 状态与修复轮范围。
3. Workflow 的 `until` 运行时循环不支持；parallel 串行；入口只有 IPC。
4. 会话决策快照已落事件，界面尚未展示。
5. Goal 修订仍只有 IPC，没有界面确认流程。

## 4. 复现方式

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:eco-explore && npm run test:subtask-cycle && npm run test:version-consistency
npm run test:workflow && npm run test:dmoca && npm run test:context-recovery
# 或全量
npm run verify
```
