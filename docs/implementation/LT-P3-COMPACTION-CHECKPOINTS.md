# LT-P3 · 摘要与检查点

状态：未开始  
阶段目标：在裁剪不足时生成结构化摘要，并以检查点安全提交。  
依赖：LT-P1、LT-P2（P0 存储 ADR）  
上游：[契约](../spec/LONG_TASK_CONTEXT_CONTRACTS.md) · [存储](../architecture/CONTEXT_CHECKPOINT_STORAGE.md) · [任务书](LONG-TASK-CONTEXT-TASK-BOOK.md)

## 1. 阶段出口

- 摘要 Schema/Validator 可拒绝无证据的完成声明；
- 后台摘要可超时/取消；
- 检查点 prepared → committed 原子提交；
- 崩溃后恢复旧检查点或完整新检查点；
- stale 摘要不被使用；
- 原始事件与 Evidence 不丢。

## 2. 任务

### LT-P3-01 摘要 Schema 与 Validator

| 项 | 内容 |
| --- | --- |
| 目标 | 定义结构化摘要与完整性校验 |
| 依赖 | P0-02 |
| 接触 | `context/compaction/summary.ts`、`validator.ts` |
| 验收 | 缺证据的“测试通过”被拒绝；摘要可哈希 |
| 测试 | Validator 单测；伪造证据 |
| 回滚 | 停用摘要，保留裁剪 |

摘要字段：

```text
goal / constraints / completed / decisions / evidence
openIssues / currentStep / nextActions / risks / stopConditions
```

规则：

- `completed` 必须区分 `verified` 与 `claim`；
- `decisions` 必须标 `active/superseded`；
- `evidence` 必须引用真实 EvidenceRef/事件；
- `sourceEventIds` 保存完整来源；事件 payload/UI 只带 `sourceEventIdsPreview`；
- 不把缺失解释成成功。

### LT-P3-02 Summarizer

| 项 | 内容 |
| --- | --- |
| 目标 | 后台生成摘要，不提前删除旧上下文 |
| 依赖 | P3-01、P1-04 |
| 接触 | `context/compaction/summarizer.ts`、Provider |
| 验收 | 失败/超时/取消不提交；费用可追溯 |
| 测试 | 失败/超时/取消 |
| 回滚 | 关闭摘要 |

要点：

- 只总结 `sourceStartSeq..sourceEndSeq`；
- 摘要期间新事件不进入；
- 记录模型、费用、耗时；
- 允许配置摘要模型；
- Web/CLI 是否参与由配置决定。

### LT-P3-03 检查点存储与提交

| 项 | 内容 |
| --- | --- |
| 目标 | 按存储设计落 `prepared → committed` |
| 依赖 | P0-03、P3-01 |
| 接触 | `context/checkpoint/store.ts`、`commit.ts`、`store.ts`（按 ADR） |
| 验收 | 中断恢复旧检查点；未提交摘要不用 |
| 测试 | 半提交、孤儿、旧数据 |
| 回滚 | 删除检查点，回退未压缩 |

顺序：

```text
摘要校验通过
→ 写 <ownerType>/<ownerId>.json（status=prepared）
→ fsync 文件 + 父目录
→ 同一次 Journal persist：更新 contextId/checkpointId/activeRunId + committed 事件
→ 确认指针文件存在且 hash 匹配
→ 异步清理旧检查点
```

补充：

- Journal 指针是提交权威，文件 prepared 不等于活动检查点；
- 同一 owner 串行写；
- 多 runId 活动指针不互相覆盖；
- 被压缩引用的事件先归档，再允许 Journal 裁剪；
- 删除任务/会话先清指针再清理文件。

### LT-P3-04 Recovery 与 Stale

| 项 | 内容 |
| --- | --- |
| 目标 | 校验摘要范围、证据、版本 |
| 依赖 | P3-03 |
| 接触 | `context/compaction/recovery.ts` |
| 验收 | stale 不用；新事件保留 |
| 测试 | 事件变化、证据缺失、过期 |
| 回滚 | 回退未压缩 |

检查：

1. 完整 `sourceEventIds` 是否仍可从 Journal 或归档段追溯；
2. `evidenceRefs` 是否仍有效；
3. 生成后是否有新事件；
4. `summaryHash` 是否匹配；
5. 活动指针是否存在。

### LT-P3-05 Context Events 与 Trace

| 项 | 内容 |
| --- | --- |
| 目标 | 压缩过程进现有事件/Trace |
| 依赖 | P3-03 |
| 接触 | `shared/task-events.ts`、`main/trace/*`、`shared/observability.ts` |
| 验收 | 事件顺序、刷新恢复、去重 |
| 测试 | 事件投影 |
| 回滚 | 只留日志 |

事件只带 `checkpointId` 与计数，不放大段摘要。

## 3. PR 切片

| PR | 内容 |
| --- | --- |
| LT-P3-A | P3-01 Schema/Validator |
| LT-P3-B | P3-02 Summarizer |
| LT-P3-C | P3-03 Checkpoint Store |
| LT-P3-D | P3-04 Recovery + P3-05 Events |

## 4. 测试

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:context-summary
npm run test:context-checkpoint
npm run test:context-recovery
npm run test:task-events
```

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| 摘要幻觉 | Validator + Evidence 引用 |
| 半提交 | 文件先写、Journal 后写 |
| 摘要过期 | stale 检测 |
| 事件膨胀 | 事件只带 checkpointId |
| 摘要成本 | 只在高阈值；费用单独统计 |

## 6. 状态清单

- [ ] P3-01 Schema/Validator
- [ ] P3-02 Summarizer
- [ ] P3-03 Checkpoint
- [ ] P3-04 Recovery
- [ ] P3-05 Events
- [ ] 阶段回归通过
