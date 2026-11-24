# LT-P1 · Context Manager 基础

状态：未开始  
阶段目标：建立上下文准备层，不改模型请求行为。  
依赖：LT-P0 完成  
上游：[契约](../spec/LONG_TASK_CONTEXT_CONTRACTS.md) · [任务书](LONG-TASK-CONTEXT-TASK-BOOK.md)

## 1. 阶段出口

- `src/main/context/` 模块可编译；
- ContextBuilder 稳定、可重复；
- TokenEstimator 可解释，未知不伪造；
- BudgetManager 按模型独立；
- Provider 能力适配返回统一结构；
- 开关关闭时现有行为零变化；
- 不调用模型、不压缩、不写检查点。

## 2. 任务

### LT-P1-01 模块骨架与 Manager

| 项 | 内容 |
| --- | --- |
| 目标 | 建立目录与 `ContextManager` 空实现 |
| 依赖 | P0-02 |
| 接触 | `src/main/context/manager.ts`、`types.ts`、`index.ts` |
| 验收 | 现有测试全绿；开关关闭零变化 |
| 测试 | `test:context-manager` |
| 回滚 | 删除模块导出 |

要点：

- `prepare` 原样透传；
- `finalize` 只记录 Usage；
- `recover` 返回 null；
- 不接入 ExecutionPool。

### LT-P1-02 ContextBuilder

| 项 | 内容 |
| --- | --- |
| 目标 | 固定顺序组装上下文，用户原话不变 |
| 依赖 | P1-01 |
| 接触 | `context/builder.ts`、`memory/context.ts`、`memory/inject.ts` |
| 验收 | 原话逐字不变；同输入同输出；Memory/Evidence 分离 |
| 测试 | Builder 单测；`test:prompt-policy` |
| 回滚 | 关闭开关，回退原组装 |

顺序：

```text
目标 → 系统/工具契约 → 任务状态 → 摘要 → 未压缩历史
→ 当前步骤 → Evidence → Memory → 当前问题
```

约束：

- Memory 只进 system；
- Web/CLI 不强制 system；
- 生成 `contextId`、`includedEventIds`、`retainedEventIds`；
- 稳定排序，不因 Map 顺序抖动。

### LT-P1-03 TokenEstimator

| 项 | 内容 |
| --- | --- |
| 目标 | 可解释的 Token 估算与校准 |
| 依赖 | P1-01 |
| 接触 | `context/estimator.ts` |
| 验收 | 已知样本误差可接受；未知保持 null |
| 测试 | 固定样本；误差回归 |
| 回滚 | 关闭估算，用保守预算 |

要点：

- 返回估算与 confidence；
- 不联网、不读 Provider；
- 真实 usage 只在 finalize 校准；
- 不把估算写成 Provider 实际值。

### LT-P1-04 BudgetManager

| 项 | 内容 |
| --- | --- |
| 目标 | 每模型独立预算与 65/75/85 阈值 |
| 依赖 | P1-03 |
| 接触 | `context/budget.ts` |
| 验收 | 不同模型不同预算；未知窗口不崩溃；没有分母时不计算 65/75/85%，只显示未提供/保守上限 |
| 测试 | 预算单测；未知窗口 |
| 回滚 | 只记录预算，不触发压缩 |

计算：

```text
inputLimit = contextWindow - outputReserve - safetyMargin
level = normal / warning / compaction / overflow
```

- 65% warning；
- 75% 后台摘要候选；
- 85% 强制压缩；
- 窗口未知用 `configuredInputLimit` 或保守输入上限，`confidence=unknown`；
- 保守上限不能标成 Provider 窗口；没有可靠分母时 `usageRatio=null`，不显示百分比。

### LT-P1-05 Provider 上下文能力适配

| 项 | 内容 |
| --- | --- |
| 目标 | 统一读取窗口、输出限制、usage 能力 |
| 依赖 | P0-02 |
| 接触 | `context/adapters/provider-context.ts`、`providers/types.ts`、`ollama.ts`、`openai-compatible.ts` |
| 验收 | 各 Provider 返回统一结构；未知不换 Provider |
| 测试 | Provider 适配；现有 `test:providers` |
| 回滚 | 适配层返回 unknown |

要点：

- `contextTokens=null` 保留 null；
- Ollama 读实际模型信息；
- OpenAI 兼容按配置/元数据；
- Web/CLI 标 unknown；
- 不改变 Provider 选择。

## 3. PR 切片

| PR | 内容 |
| --- | --- |
| LT-P1-A | P1-01 模块 + P1-02 Builder |
| LT-P1-B | P1-03 Estimator + P1-04 Budget |
| LT-P1-C | P1-05 Provider 适配 + 阶段回归 |

## 4. 测试

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:context-manager
npm run test:context-builder
npm run test:context-budget
npm run test:providers
npm run test:prompt-policy
```

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| 上下文顺序改变回答 | 开关关闭零变化；灰度 |
| Memory 被塞进 question | Builder 断言原话不变 |
| 估算偏差大 | 只做预警；真实 usage 校准 |
| 未知窗口被当默认 | 显式 `unknown` + UI |
| Provider 适配影响路由 | 只读能力，不改选择 |

## 6. 状态清单

- [ ] P1-01 模块骨架
- [ ] P1-02 Builder
- [ ] P1-03 Estimator
- [ ] P1-04 Budget
- [ ] P1-05 Provider 适配
- [ ] 阶段回归通过
