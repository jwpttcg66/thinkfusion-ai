# 标准答案一致性与严格口径修复

- 日期：2026-11-14
- 审查对象：`debate-standard-answers-v1.json`、`standard-rubric.ts`
- 严格结果明细：`docs/implementation/regression/debate-regression-v1-1-strict-latest.json`

## 1. 确认的问题

`requiredClaims[].severity` 与 `judging.mustPass` 存在 6 处不一致：

| 题目 | severity=must 但不在 mustPass |
| --- | --- |
| `http-methods` | c4 |
| `cache-invalidation` | c3 |
| `mq-delivery` | c4 |
| `distributed-lock` | c3 |
| `schema-migration` | c4 |
| `timezone` | c5 |

评分器原逻辑是：只要 `mustPass` 非空，就完全忽略 `severity: must` 中未列入
`mustPass` 的项目。静态测试也只检查 `mustPass` 指向存在的 claim，没有检查
它是否完整覆盖所有 must。

结果：6 条必答要求被漏检，之前的 17/24 偏高。

## 2. 修复

采用“severity 唯一来源”：

- 删除 `judging.mustPass`；
- `standard-rubric.ts` 直接派生：
  `requiredClaims.filter(severity === 'must').map(id)`；
- 静态测试禁止再维护 `mustPass`；
- 每题至少要求一条 must；
- 数据集 SHA-256 重算：
  `27a08d1fa9ed22c7486305b22dec47e402b6dc94ce200d1b71269eabe9704c7a`。

## 3. compression 标准澄清

当前定义：

| Claim | severity | 内容 |
| --- | --- | --- |
| c1 | must | 没有普遍最优；静态资源 Brotli + gzip 回退，动态文本实测 |
| c2 | must | 已压缩文件、小响应通常不宜再压缩 |
| c3 | should | CPU 成本、Accept-Encoding/Vary |
| c4 | should | 压缩侧信道 |

结论：Keep-should。Accept-Encoding/Vary 是缓存协商和实现边界，不是
“什么情况下不应该压缩”的最低必答项；c2 已覆盖本题的核心边界。

## 4. 严格口径结果

用 `severity` 唯一 must 重新跑完整 24 题（3 worker 单进程）：

| 项 | 严格结果 |
| --- | --- |
| 执行 | COMPLETED 21 / PARTIAL 3 |
| 主裁判 | model 24 / rules 0 |
| 独立裁判 | 24 / 24 |
| 质量 | passed 24 / inconclusive 0 |
| 事实维度 | model-assessed 24 |
| V1 | **passed 10 / failed 14** |
| 平均分 | 77 |
| 分类匹配 | 24 / 24 |
| 结构化通过 | 否 |

PARTIAL 3 题都是 gpt/claude 连接失败：

- `float-equality`
- `array-map`（V1 仍通过）
- `http-methods`

## 4.1 增量复跑

严格基线跑完后，用同一份严格标准做了一次增量复跑：

- baseline：严格 10/24；
- 首次增量复用了 9 题，但检查发现这 9 题旧结果**没有原始 fingerprint**，
  是旧逻辑用当前配置反算的，不能证明配置一致；
- 因此这 9 题已全部重跑（全部 COMPLETED + V1 通过）；
- 最终可信结果：24/24 COMPLETED，V1 **16/24 passed / 8 failed**，平均分 88，
  分类匹配 24/24；24 题全部有真实执行产生的 fingerprint。

16/24 是“15 题增量重跑 + 9 题可信修复重跑”的结果，不是一次完整 24 题全量运行。

增量后仍未通过 8 题：

- `float-equality` c2
- `http-methods` c2, c4
- `jwt-revoke` c3
- `index-generation` c2, c3
- `mq-delivery` c1, c3
- `unicode-utf8` c3
- `process-thread` c3, c4
- `memory-leak` c2

## 5. 严格未通过 14 题

| 题目 | 缺失 must | 说明 |
| --- | --- | --- |
| `float-equality` | c2 | 浮点原因；同时 PARTIAL |
| `http-methods` | c2, c4 | 幂等≠同响应；PATCH 边界；同时 PARTIAL |
| `acid` | c3 | 默认隔离级别不一定可串行化 |
| `jwt-revoke` | c3, c4 | 密钥轮换批量失效；刷新令牌撤销不影响已签发 access token |
| `index-generation` | c2, c3 | 成本/条件不完整 |
| `mq-delivery` | c1, c3, c4 | 三阶段丢失点、不丢≠不重复、Exactly-once 边界 |
| `distributed-lock` | c5 | Redis 异步复制/故障转移边界 |
| `schema-migration` | c2, c3, c4 | 短暂元数据锁、新旧版本并存一致性、实测边界 |
| `unicode-utf8` | c2, c3 | 1–4 字节变长编码、完整乱码原因 |
| `timezone` | c4, c5 | 夏令时歧义、纯本地时间边界 |
| `compression` | 无缺失，但 CONTEXTUAL 边界未覆盖 | 最高 65 |
| `process-thread` | c3 | GIL 范围 |
| `memory-leak` | c2 | 监控指标 |
| `monolith-microservices` | c4 | 不存在普适阈值 |

没有出现 `major` 错误主张。

## 6. 结论

- 之前的 17/24 是因为评分器漏掉 6 条 must，不是模型真实通过数；
- 严格口径下是 **10/24**；
- 执行链路仍然可靠：24/24 模型裁判、24/24 独立裁判、质量 24/24 passed；
- 问题已经从“执行可靠性”转为“回答内容完整性”；
- 下一步不应该继续放宽 must，而应该增强答案完整性复核/修订。

## 7. 增量模式

已加入 `--incremental=<baseline.json>`：

- 每题独立 fingerprint；
- 只复用 COMPLETED 且 V1 通过的旧结果；
- 失败题、缺题、标准/prompt/模型池变化的题自动重跑；
- 改一条标准只失效对应题。

这用于缩短后续迭代时间，不改变严格门槛。
