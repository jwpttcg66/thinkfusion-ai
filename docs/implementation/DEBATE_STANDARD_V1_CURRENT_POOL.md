# V1 标准：当前模型池全量 24 题结果

- 日期：2026-11-14
- 模型池：`deepseek-v4.1-flash` / `gpt-6-luna` / `claude-haiku-5-5`
- 数据集：`debate-dataset.json` v1.0.0
- 标准：`DEBATE_TECH_FACT_BASELINE_V1.md`
- 明细：`docs/implementation/regression/debate-regression-current-pool-final-latest.json`

## 0. 运行方式

- 3 路并行：把 24 题拆成 3 组，每组一个独立 Electron 进程；
- 每个子进程内部仍然一题一题串行；并发发生在组之间；
- 完整并行运行墙钟约 20 分 18 秒，串行旧运行约 2 小时；
- 这是修复评分器后的完整 24 题并行运行，没有把单题重跑结果混进来；
- 之前的 git-rebase、schema-migration、process-thread 重跑只用于验证评分器修正。

## 1. 总结

| 项 | 结果 |
| --- | --- |
| 题目数 | 24 |
| 执行 | COMPLETED 24 / PARTIAL 0 |
| 主裁判 | model 24 / rules 0 |
| 独立裁判 | 24 / 24 |
| 质量 | passed 24 / inconclusive 0 |
| 事实维度 | model-assessed 24 / unknown 0 |
| V1 | passed 14 / failed 10 / unavailable 0 |
| 平均分 | 86 |
| 分类匹配 | 24 / 24 |
| 结构化通过 | 否 |

> `score` 是代码按 missing/wrong/boundary/classification 算出的门槛分。

## 2. 逐题结果

| # | 题目 | 执行 | 主裁判 | 质量 | V1 | score | 缺失 must | 旧池/串行 V1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `float-equality` | COMPLETED | model | passed | FAIL | 69 | c2 | PASS |
| 2 | `array-map` | COMPLETED | model | passed | FAIL | 69 | c2 | PASS |
| 3 | `http-methods` | COMPLETED | model | passed | FAIL | 69 | c2 | FAIL |
| 4 | `tcp-udp` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 5 | `btree-index` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 6 | `acid` | COMPLETED | model | passed | PASS | 100 | - | FAIL |
| 7 | `jwt-revoke` | COMPLETED | model | passed | FAIL | 69 | c3 | PASS |
| 8 | `csrf-xss` | COMPLETED | model | passed | FAIL | 69 | c2 | FAIL |
| 9 | `cache-invalidation` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 10 | `index-generation` | COMPLETED | model | passed | FAIL | 60 | c3, c4 | FAIL |
| 11 | `mq-delivery` | COMPLETED | model | passed | FAIL | 60 | c1, c3 | PASS |
| 12 | `distributed-lock` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 13 | `schema-migration` | COMPLETED | model | passed | PASS | 100 | - | FAIL |
| 14 | `feature-flag` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 15 | `rate-limit` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 16 | `observability` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 17 | `testing-pyramid` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 18 | `unicode-utf8` | COMPLETED | model | passed | PASS | 100 | - | FAIL |
| 19 | `timezone` | COMPLETED | model | passed | PASS | 100 | - | FAIL |
| 20 | `compression` | COMPLETED | model | passed | FAIL | 60 | c2, c4 | FAIL |
| 21 | `git-rebase` | COMPLETED | model | passed | PASS | 100 | - | FAIL |
| 22 | `process-thread` | COMPLETED | model | passed | FAIL | 60 | c2, c3 | FAIL |
| 23 | `memory-leak` | COMPLETED | model | passed | PASS | 100 | - | FAIL |
| 24 | `monolith-microservices` | COMPLETED | model | passed | FAIL | 69 | c4 | PASS |

## 3. V1 未通过

共 10 题。

### `float-equality`

- score：69，modelScore：0.5
- 缺失 must：c2
- 错误主张：无
- 边界：覆盖
- 理由：明确给出了 false 和实际显示值，但没有说明这是二进制浮点/IEEE 754 精度导致，也未提供精确比较的推荐方法。

### `array-map`

- score：69，modelScore：85
- 缺失 must：c2
- 错误主张：无
- 边界：覆盖
- 理由：候选回答正确说明 map 自身不修改原数组、返回新数组，forEach 返回 undefined，回调可能通过副作用修改原数组或其元素，并指出 map 不深拷贝；但没有明确说明 forEach 本身不修改原数组，因此 c2 不完整。未出现重大错误主张。

### `http-methods`

- score：69，modelScore：85
- 缺失 must：c2
- 错误主张：无
- 边界：覆盖
- 理由：回答正确覆盖了 PUT/POST 方法语义、REST 设计选择、应用层幂等 POST 以及 PATCH 需看契约和实现的条件性结论，并给出推荐方案。未明确说明幂等不等于每次响应完全相同这一关键边界，因此扣分。

### `jwt-revoke`

- score：69，modelScore：4
- 缺失 must：c3
- 错误主张：无
- 边界：覆盖
- 理由：说明了无状态校验无法感知单令牌撤销、实现主动失效需引入服务端状态，并准确说明短访问令牌、刷新令牌和黑名单的作用及代价；也给出了按场景选择的条件性建议。未提及密钥轮换只能使一批令牌失效，不能单独撤销一个令牌。

### `csrf-xss`

- score：69，modelScore：85
- 缺失 must：c2
- 错误主张：无
- 边界：覆盖
- 理由：回答准确区分了 XSS 与 CSRF，并覆盖了输出编码/CSP 和 CSRF Token/SameSite/Origin 校验等防御重点；但未说明 XSS 成功后可能读取 CSRF token 或以用户身份发起同源请求，从而绕过部分 CSRF 防御。

### `index-generation`

- score：60，modelScore：8
- 缺失 must：c3, c4
- 错误主张：无
- 边界：覆盖
- 理由：清楚说明完整代可见、原子发布与回滚的收益，以及磁盘占用、旧代回收、读者生命周期和发布/恢复复杂度；也给出有条件的采用建议。还列出只读代、指针切换、保留清理和磁盘预算等条件，但没有说明必须保证构建快照的一致性。

### `mq-delivery`

- score：60，modelScore：55
- 缺失 must：c1, c3
- 错误主张：无
- 边界：覆盖
- 理由：回答覆盖了至少一次投递加消费端幂等、Outbox，以及不能仅靠参数保证端到端不丢，并给出配置取决于故障模型和产品版本的条件性结论。但未分别说明生产、Broker、消费三个环节的具体丢失点；未说明不丢消息不等于不重复，以及重试和ACK丢失会造成重复；也未明确不要轻易承诺端到端Exactly-once。没有出现错误主张。

### `compression`

- score：60，modelScore：55
- 缺失 must：c2, c4
- 错误主张：无
- 边界：未覆盖
- 理由：候选回答正确给出静态预压缩 Brotli + gzip 回退、动态文本按 CPU/延迟/大小选择或不压缩，覆盖 c1 的核心条件性方案；但未明确已压缩文件通常无需再压缩、小响应可能不值得，也未提 Accept-Encoding/Vary，更未覆盖秘密信息与攻击者可控内容的压缩侧信道风险。无重大错误主张，但边界和安全条件不完整。

### `process-thread`

- score：60，modelScore：6
- 缺失 must：c2, c3
- 错误主张：无
- 边界：覆盖
- 理由：准确说明了进程与线程的核心区别，并给出多进程、多线程的条件性适用场景。未说明 Linux 中二者均由 task_struct 表示且可调度；未明确将 GIL 限定为默认带 GIL 的 CPython 构建；提及异步 I/O 和协程，但未说明是否更快应实测。

### `monolith-microservices`

- score：69，modelScore：90
- 缺失 must：c4
- 错误主张：无
- 边界：覆盖
- 理由：候选覆盖了拆分与不拆条件、模块化单体、分布式成本和渐进试点，边界与推荐方案清晰，且无错误主张；但未明确说明不存在普适的代码行数或团队人数阈值，缺少必须主张 c4。

## 4. 执行 PARTIAL

共 0 题。


## 5. 结论

- 当前模型池执行 COMPLETED 24/24；
- V1 通过 14/24，失败 10；
- 分类匹配 24/24；
- 失败原因以必答主张缺失为主；没有把 major 错误主张、执行失败和事实未核验混成一个通过状态；
- `structuralOk` 以逐题硬门槛为准，不是平均分；
- 并行运行 24/24 COMPLETED、24/24 独立模型裁判，执行层没有 PARTIAL；
- 主要失败仍是必须主张缺失，不是执行失败；
- 评分器仍有噪声：标准外“错误”默认按 minor，不再是 major。

## 6. 限制

- 单次样本，不是稳定性重复实验；
- V1 评分是模型应用人工标准，不是外部事实核验；
- 评分模型原始分可能异常，门槛分由代码计算并保留 modelScore 审计；
- 仍然只有一个 Provider，故障域独立性未验证。
