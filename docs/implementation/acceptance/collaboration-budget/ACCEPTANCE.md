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

## 真机（L0 只读列目录）

| 项 | 结果 |
| --- | --- |
| 脚本 | `scripts/collab-budget-live.mjs` |
| 任务 | `eb977413-…` → `completed`（约 13s） |
| 方案评审 | `plan.debated status=skipped`；原因含 `L0 … 跳过方案评审`；`plan.review.progress=0` |
| 模型审核 | `review.ready backend=rules`；文案含「未调用模型」 |
| 意见面板 | 展示 1 · 主张 0 · 补充 1 · 争议 0（非 88 量级） |
| 证据 | [`evidence/V3-COLLAB-BUDGET-LIVE.json`](../../evidence/collaboration-budget/V3-COLLAB-BUDGET-LIVE.json) |

## 结论

专项 CB-P0～P2 + L0 真机全部完成。会话侧 DebateBehavior 更深筛选不在本专项范围（未另建第二套辩论引擎）。
