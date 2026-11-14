# Debate V2.0 实施状态

- 分支：`0.2.5`
- 日期：2026-11-15
- 质量基线：`60ada0e` 的 18/24，未修改

## 1. P0：单模型完整辩论

已完成：

- 单模型启动；
- 单模型角色轮转 proposer -> critic/evidence_reviewer -> responder；
- 六种策略单模型角色测试；
- Judge 自评/参与者复评/独立裁判元数据；
- 失败后的降级记录；
- `npm run test:p0-gaps`：10/10 通过。

## 2. P1：多模型增强

已完成：

- 双模型 pair_debate；
- 三模型两位辩论 + 独立 Judge；
- 四模型以上确定性角色分工；
- `resolveJudge` 统一选择逻辑；
- `npm run test:p1-multi-model`：9/9 通过。

限制：

- 三模型全部参辩时没有独立第三方；
- 4+ 分工是确定性分配，不是模型自动规划；
- CLI 侧降级后重选 Judge 仍需单独验证。

## 3. P2：策略与组织

现状：

- 六种策略 profile 已存在：truth / adversarial / expert / assumption /
  solution / discovery；
- focus、disputeOrder、roles 已接入 DebateOrchestrator；
- 多轮 position/question/revision、Revision、少数派保留已存在；
- 单模型和多模型角色测试均覆盖六种策略。

结论：P2 没有新增第二套策略运行时；策略能力已存在并由现有测试验证。
本轮只补了 4+ 模型的确定性角色分工，不重写策略。

## 4. P3：内容质量

定向 9 题结果：

- 6 COMPLETED / 3 FAILED（连接）；
- V1 6/9；
- mq-delivery、schema-migration、unicode-utf8、memory-leak 通过；
- acid、jwt-revoke 仍缺 must；
- 3 道连接失败单独重跑后 3/3 V1 通过，array-map 仍 PARTIAL；
- 结果不合并进 18/24 主结果。

18/24 历史基线不变，也没有降低 must。

## 5. P4：Evidence Pack 工程辩论

未完成，且不能声称完成：

- 当前没有独立 Evidence Pack 实现；
- `code-index` 里只有“Evidence Pack 接入后”的 future 注释；
- 冻结证据快照、代码事实/调用关系/测试证据的统一输入尚未建设；
- 因此工程辩论 Gate 5 仍不能提前关闭。

## 6. 最终状态

| 阶段 | 状态 |
| --- | --- |
| P0 单模型 | 完成并测试 |
| P1 多模型 | 核心完成，CLI 降级链路待专项 |
| P2 策略 | 现有能力，未新建 Runtime |
| P3 内容 | 定向改善，acid/jwt 仍失败 |
| P4 Evidence Pack | 未完成，依赖未满足 |

不能写“V2.0 全部完成”；可以写“P0/P1 核心和 P3 定向回归完成，P4 仍被 Evidence Pack 阻塞”。
