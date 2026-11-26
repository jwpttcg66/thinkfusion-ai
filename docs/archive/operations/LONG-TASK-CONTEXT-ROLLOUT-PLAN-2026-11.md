# 长任务与上下文压缩 · 灰度、回滚与运维

> 文档状态：HISTORICAL。本文是早期分阶段灰度方案；其中 `contextManagerMode/shadow` 等不是当前代码配置。当前开关见 [现行运维手册](LONG-TASK-CONTEXT-ROLLOUT-PLAN-2026-11.md)。


状态：设计冻结，未实施  
基线：`main` · `e336ae4` · 2026-11-24  
相关：[架构快照](../architecture/LONG_TASK_AND_CONTEXT_COMPACTION-2026-11-24.md) · [存储快照](../architecture/CONTEXT_CHECKPOINT_STORAGE-2026-11-24.md) · [历史测试计划](../implementation/long-task-context/LONG-TASK-CONTEXT-TEST-PLAN.md) · [历史任务书](../implementation/long-task-context/LONG-TASK-CONTEXT-TASK-BOOK.md)

## 1. 目标

- 新能力可分阶段开启，关闭后回到当前行为；
- 压缩/恢复失败不会破坏任务与工作区；
- 数据迁移、备份、回滚可执行；
- 运维能看出压缩、恢复、失败与成本；
- 不在未验证阶段默认影响所有用户。

## 2. 开关

建议使用现有设置存储新增：

```ts
interface LongTaskContextSettings {
  /** off | shadow | active */
  contextManagerMode: 'off' | 'shadow' | 'active';
  /** off | on，默认 on（仅在 contextManagerMode=active 时生效） */
  compactionEnabled: boolean;
  /** off | shadow | active */
  resumeMode: 'off' | 'shadow' | 'active';
  /** 保留多少检查点 */
  checkpointRetention: number;
  /** 摘要模型；空表示使用当前模型 */
  summaryModelId?: string;
}
```

语义：

| 模式 | 行为 |
| --- | --- |
| off | 完全走现有路径 |
| shadow | 只构建/记录预算与候选压缩，不发摘要、不改请求 |
| active | 真正裁剪/摘要/提交/恢复 |

默认值：

- P1–P3 期间 `off`；
- P4 先 `shadow`，验证后 `active`；
- P5 `resumeMode=shadow`，真机验证后 `active`；
- 发布版本可按用户组灰度。

## 3. 灰度阶段

| 阶段 | 开关 | 观察 |
| --- | --- | --- |
| P1 | off | 类型/构建无变化 |
| P2 | shadow | 裁剪候选、预算、原始结果可查 |
| P3 | shadow | 摘要生成但不提交；校验失败率 |
| P4 | shadow → active | 请求上下文、Usage、边界 |
| P5 | resume shadow → active | 中断识别、恢复不重复副作用 |
| P6 | active | 长任务 E2E、UI |

任何阶段出现以下情况立即回退：

- 用户原话被改动；
- Web/CLI 边界被破坏；
- 摘要被当执行事实；
- 恢复重复写文件/命令；
- Journal 或检查点损坏；
- 任务无法完成/频繁误判。

## 4. 数据迁移

### 4.1 旧任务

- 无 `contextId/checkpointId/activeRunId`：按未压缩；
- 无 `context/owners/<ownerType>/<ownerId>.json`：不创建空文件；
- 旧报告无检查点：不补造；
- 旧事件不迁移；
- 旧 AgentTask 与 Conversation 都可继续；Conversation 不伪造 AgentTask。

### 4.2 新任务

首次压缩时创建检查点文件；失败不阻塞任务。

### 4.3 回滚

1. `contextManagerMode=off`；
2. 停止使用新检查点；
3. 保留 `context/` 目录（不删，便于排查）；
4. 任务指针可忽略；
5. 如需恢复旧行为，不修改 `agent-store.json` 事件。

检查点文件不参与任务状态机；关闭后任务仍可继续。

## 5. 备份与恢复

现有备份需要加入：

- `context/owners/` 与 `context/archive/`；
- 备份清单记录检查点数量/大小；
- 恢复顺序：Journal → context 文件；
- 缺失 context 文件：按未压缩恢复；
- 缺失检查点：记录 stale，回退上一个或未压缩；
- 不把检查点写入项目工作区。

## 6. 监控与诊断

### 事件

- `context.budget.warning`
- `context.compaction.started`
- `context.compaction.summary.ready`
- `context.compaction.committed`
- `context.compaction.failed`
- `context.compaction.stale`
- `context.recovered`

### 指标

| 指标 | 用途 |
| --- | --- |
| 压缩次数/失败率 | 稳定性 |
| 压缩前/后 Token | 效果 |
| 摘要费用 | 成本 |
| 溢出恢复次数 | 预算算法 |
| 估算误差 | 校准 |
| 恢复次数/失败 | 长任务可靠性 |
| 重复副作用拦截 | 安全 |

### 诊断入口

- 轨迹页：压缩/恢复事件；
- 统计页：成本与效果；
- 事件详情：checkpointId、范围、模型、失败原因；
- 日志：不输出摘要全文与敏感信息。

## 7. 故障处置

| 现象 | 处置 |
| --- | --- |
| 摘要失败 | 关闭摘要，保留裁剪；任务继续 |
| 检查点损坏 | 回退未压缩；记录 stale |
| Journal 指针丢失 | 忽略孤儿检查点；任务用旧上下文 |
| 归档段缺失 | 不裁剪该段；记录 stale |
| 检查点 prepared 未提交 | 不当作活动上下文 |
| 恢复重复副作用 | 立即停恢复；人工核对；关闭 resume |
| 上下文仍溢出 | 降低请求信息量；停止并说明 |
| 任务卡在 interrupted | 提供“检查并继续 / 放弃” |
| 成本异常 | 关闭摘要；检查模型与触发阈值 |

## 8. 发布门禁

进入默认 active 前必须：

1. P0–P4 全部测试通过；
2. P5 真机恢复通过；
3. P6 30 步 E2E 通过；
4. 回滚演练通过；
5. 旧数据兼容验证；
6. 备份/恢复验证；
7. 文档与状态板一致；
8. 无未处理的高风险问题。

## 9. 回滚演练

每次发布前执行：

1. 开启 active 执行一次带压缩任务；
2. 关闭开关；
3. 用旧路径继续任务；
4. 验证任务历史、文件、证据未丢；
5. 删除测试检查点；
6. 记录耗时与问题。

## 10. 支持与已知限制

已知限制（实施时更新）：

- Provider 窗口未知时只能保守预算；
- Web/CLI 可能没有 usage；
- 摘要模型可能产生 claim，必须标 certainty；
- 恢复不能自动判断所有外部副作用；
- 检查点保留数量有限，旧摘要会被清理；
- 旧任务不回溯生成检查点。

## 11. 运维检查清单

- [ ] 开关可关闭
- [ ] 检查点目录可备份
- [ ] 旧 Journal 可读
- [ ] 轨迹/统计可见
- [ ] 恢复失败有出口
- [ ] 回滚演练通过
- [ ] 文档更新
- [ ] 未推送远程（除非用户授权）
