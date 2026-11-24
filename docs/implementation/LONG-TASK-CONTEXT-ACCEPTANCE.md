# 长任务与上下文压缩 · 验收报告（LT-P6-05 输出）

状态：未开始  
基线：`main` · `<commit>` · `<date>`  
上游：[任务书](LONG-TASK-CONTEXT-TASK-BOOK.md) · [测试计划](LONG-TASK-CONTEXT-TEST-PLAN.md)

> 本文是 `LT-P6-05` 的产出模板。每个任务必须给出真实证据，
> 不能用“代码看起来对”代替。

## 1. 总览

| 项 | 值 |
| --- | --- |
| 实施分支 | 待填 |
| 合并提交 | 待填 |
| 测试日期 | 待填 |
| 验证设备 | 待填 |
| 应用版本 | 待填 |

## 2. 任务状态

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| LT-P0-01 | 待填 | 待填 |
| LT-P0-02 | 待填 | 待填 |
| LT-P0-03 | 待填 | 待填 |
| LT-P0-04 | 待填 | 待填 |
| LT-P1-01 | 待填 | 待填 |
| LT-P1-02 | 待填 | 待填 |
| LT-P1-03 | 待填 | 待填 |
| LT-P1-04 | 待填 | 待填 |
| LT-P1-05 | 待填 | 待填 |
| LT-P2-01 | 待填 | 待填 |
| LT-P2-02 | 待填 | 待填 |
| LT-P2-03 | 待填 | 待填 |
| LT-P3-01 | 待填 | 待填 |
| LT-P3-02 | 待填 | 待填 |
| LT-P3-03 | 待填 | 待填 |
| LT-P3-04 | 待填 | 待填 |
| LT-P3-05 | 待填 | 待填 |
| LT-P4-01 | 待填 | 待填 |
| LT-P4-02 | 待填 | 待填 |
| LT-P4-03 | 待填 | 待填 |
| LT-P4-04 | 待填 | 待填 |
| LT-P5-01 | 待填 | 待填 |
| LT-P5-02 | 待填 | 待填 |
| LT-P5-03 | 待填 | 待填 |
| LT-P5-04 | 待填 | 待填 |
| LT-P5-05 | 待填 | 待填 |
| LT-P6-01 | 待填 | 待填 |
| LT-P6-02 | 待填 | 待填 |
| LT-P6-03 | 待填 | 待填 |
| LT-P6-04 | 待填 | 待填 |
| LT-P6-05 | 待填 | 待填 |

状态只允许：IMPLEMENTED / TESTED / VERIFIED / FAILED / BLOCKED。

## 3. 验收场景

### 3.1 长任务

| 项 | 结果 |
| --- | --- |
| 30 步任务完成 | 待填 |
| 文件内容正确 | 待填 |
| Git 状态正确 | 待填 |
| 测试/诊断结果 | 待填 |
| 证据引用完整 | 待填 |
| 无重复副作用 | 待填 |

### 3.2 压缩

| 项 | 结果 |
| --- | --- |
| 65% 预警 | 待填 |
| 75% 后台摘要 | 待填 |
| 85% 强制提交 | 待填 |
| 摘要失败回退 | 待填 |
| stale 检测 | 待填 |
| 检查点崩溃恢复 | 待填 |

### 3.3 恢复

| 项 | 结果 |
| --- | --- |
| 执行中暂停 | 待填 |
| 应用退出/重启 | 待填 |
| interrupted 显示 | 待填 |
| 已完成步骤不重做 | 待填 |
| 未知副作用标记 | 待填 |
| 继续执行 | 待填 |

### 3.4 UI

| 项 | 结果 |
| --- | --- |
| 上下文卡 | 待填 |
| 轨迹压缩详情 | 待填 |
| 统计未知值 | 待填 |
| 暂停/中断文案 | 待填 |

## 4. 测试命令

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:context-contracts
npm run test:context-builder
npm run test:context-budget
npm run test:context-pruner
npm run test:context-summary
npm run test:context-checkpoint
npm run test:context-recovery
npm run test:execution
npm run test:providers
npm run test:state-machine
npm run test:task-events
npm run test:long-task-context-e2e
```

实际结果：待填。

## 5. 真机证据

| 证据 | 路径 |
| --- | --- |
| 长任务截图 | 待填 |
| 压缩轨迹 | 待填 |
| 恢复截图 | 待填 |
| 检查点文件 | 待填 |
| 事件序列 | 待填 |

## 6. 已知限制

- 待填

## 7. 回滚演练

| 项 | 结果 |
| --- | --- |
| 关闭 contextManagerMode | 待填 |
| 旧路径继续任务 | 待填 |
| 历史/证据未丢 | 待填 |
| 检查点可清理 | 待填 |

## 8. 文档修正

| 文档 | 修正 |
| --- | --- |
| `UNIFIED-TASK-RUNTIME.md` | 待填 |
| 任务书状态板 | 待填 |
| 架构/契约 | 待填 |

## 9. 结论

- 是否达到 P6 出口：待填
- 未解决阻塞：待填
- 后续任务：待填
