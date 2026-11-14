# 标准答案 V1 重跑：3 道 redo 题

- 日期：2026-11-14
- 数据集：`debate-dataset.json` v1.0.0
- 标准答案：`DEBATE_TECH_FACT_BASELINE_V1.md`
- 命令：

```bash
cd desktop-agent-macos
./node_modules/.bin/electron scripts/regression/run-debate-regression.cjs --no-sandbox \
  --only=cache-invalidation,mq-delivery,distributed-lock --suffix=standard-v1
```

- 明细：`docs/implementation/regression/debate-regression-standard-v1-latest.json`
- 自动生成表：`docs/implementation/regression/debate-regression-standard-v1-latest.md`

## 1. 重跑目的

V1 复核发现 3 道题被裁判判成 `inconclusive`，但按人工标准，它们不是
“信息不足”，而是 `CONTEXTUAL`：没有普适最优，但有成熟方案、适用边界和
条件性推荐。

这次重跑要确认：

1. 裁判是否输出 `questionType = CONTEXTUAL`；
2. 是否还标 `undetermined: true`；
3. 是否给出实质结论，而不是继续 `inconclusive`；
4. `factualAccuracy` 是否仍然保持在 `model-assessed`，没有被冒充成事实正确。

## 2. 重跑结果

| 题目 | 旧质量 | 新质量 | 旧结论 | 新结论 | 裁判 | questionType | undetermined |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cache-invalidation` | `inconclusive` | `passed` | `insufficient_evidence` / `hold` | `partially_supported` / `accept_with_caveats` | kimi | `CONTEXTUAL` | `false` |
| `mq-delivery` | `inconclusive` | `passed` | `insufficient_evidence` / `hold` | `partially_supported` / `accept_with_caveats` | gpt | `CONTEXTUAL` | `false` |
| `distributed-lock` | `inconclusive` | `passed` | `insufficient_evidence` / `hold` | `partially_supported` / `accept_with_caveats` | kimi | `CONTEXTUAL` | `false` |

三题都：

- `COMPLETED`；
- 裁判后端 `model`；
- 裁判独立，`sharedWith = null`；
- `judgeAttempts = 1`；
- `factualAccuracy = model-assessed`；
- 没有出现事实维度 `supported`。

## 3. 新结论摘要

### 3.1 缓存一致性

裁判现在明确区分 CPU 缓存一致性和应用层缓存一致性，并给出条件性方案：

- 没有普遍最优的失效策略；
- 选择取决于不一致窗口、一致性语义、写入频率、缓存层级、故障模型和运维能力；
- 读多写少且可容忍短暂陈旧：Cache-Aside + TTL 是常见起点；
- 多写路径或多级缓存：可靠事件通知/CDC + 幂等重试；
- 强一致：不能依赖普通异步失效，需要版本校验、租约、分布式锁或绕过缓存读权威源。

这不是“无法判断”，而是把“没有普适最优”转换成“按条件给方案”。

### 3.2 消息队列不丢消息

裁判给出三阶段结论：

- 没有脱离故障模型和配置的绝对“不丢消息”；
- 生产端：等待 Broker 确认、失败重试、Outbox/CDC 补业务写库与发消息的缺口；
- 存储端：多副本、持久化、确认策略、避免落后副本接管、保留期覆盖最长消费延迟；
- 消费端：处理成功后 ACK/offset、幂等或 Inbox 去重、死信和对账；
- 不丢消息不等于不重复，至少一次 + 幂等是常见工程目标。

### 3.3 分布式锁

裁判给出可操作机制：

- 基础要求：互斥、无死锁、所有权可识别、可续期/可释放、可观测；
- Redis 锁：`SET key token NX PX`，唯一 token；
- 释放/续期用 Lua 原子比较 token 后再执行；
- 只解决误删，不解决锁过期后旧持有者继续写；
- 强一致性资源需要 fencing token 或资源端 CAS/版本号校验；
- Redis 异步主从切换、网络分区下不能宣称绝对严格互斥。

## 4. V1 必答主张人工核对

这一节是按 `DEBATE_TECH_FACT_BASELINE_V1.md` 的 requiredClaims 做的人工语义
核对，不是自动评分。

| 题目 | 必答主张覆盖 | 说明 |
| --- | --- | --- |
| `cache-invalidation` | c1 ✅ c2 ✅ c3 ✅ c4 ✅ | 明确说没有普适最优；给了 Cache-Aside/TTL、CDC/事件、强一致兜底；提到可接受不一致窗口和双写/通知问题。 |
| `mq-delivery` | c1 ✅ c2 ✅ c3 ✅ c4 ⚠️ | 三阶段、至少一次 + 幂等、不丢≠不重复都覆盖；但没有显式写“不要承诺端到端 Exactly-once”，只以“至少一次”隐含。 |
| `distributed-lock` | c1 ✅ c2 ✅ c3 ✅ c4 ✅ c5 ✅ | SET NX PX + token、Lua 比较后删除/续期、fencing token/下游校验、异步复制风险都覆盖。 |

`mq-delivery` 的 c4 是“不要轻易承诺端到端 Exactly-once”。回答没有出现
Exactly-once 这个词，但明确采用至少一次语义，并说“没有绝对不丢”。按语义
可以算覆盖，按严格字面则不够显式；这正好说明 V1 评分应该按语义，不按关键词。

## 5. 结论

这次重跑确认了 V1 的核心修正：

> `CONTEXTUAL` 不等于 `INSUFFICIENT`。  
> 没有普适最优答案，不代表裁判可以拒绝给任何结论。

三道题现在都从 `inconclusive` 变成 `passed`，并给出条件、边界和推荐方案。
但 `passed` 仍然只是“评估流程通过”，不是事实正确；`factualAccuracy` 仍是
`model-assessed`。

## 6. 限制

- 只重跑了这 3 道 redo 题，另外 21 题仍使用旧提示词的记录；
- 每题只跑了一次，不是稳定性重复实验；
- 没有外部事实核验，不能把 `passed` 读成事实准确率；
- 新结论仍保留未解决问题，这是正常的：条件性结论不等于所有细节都确定。
