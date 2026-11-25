# V3 协作预算控制验收

基线：`main@6a15b9a` · 分支：`feat/v3-collab-budget-control`

## 自动化

| 命令 | 结果 |
| --- | --- |
| `npm run test:plan-review` | ✅ 22/22 |
| `npm run test:plan-debate` | ✅ 4/4 |
| `npm run test:collab-budget` | ✅ 4/4 |
| `npm run test:collaboration-result` | ✅ 9/9 |
| typecheck (json/agent/renderer) | ✅ |

## 行为对照

| 场景 | 期望 |
| --- | --- |
| `auto` + 只读 L0 | 不启动五段/方案评审 |
| `on` + 只读 | 仍走五段（用户显式开启） |
| L1 写入+测试 | 方案评审上限 1 轮 |
| L2 缺判据写入 | 上限 2 轮 |
| L3 设计 | 上限 3 轮 |
| L0 验证通过 | `reviewExecution` 不调模型 |
| 意见投影 | 去重 + 补充摘要 ≤ 6；UI 区分原始/展示/争议 |

## 未覆盖

- 真机复跑「88 意见」原任务（需 taskId 事件流核对调用次数）
- DebateBehavior 会话侧争议筛选深化（P1 后续）
