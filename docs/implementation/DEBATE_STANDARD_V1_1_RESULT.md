# V1.1 标准：当前模型池全量 24 题结果

- 日期：2026-11-14
- 模型池：`deepseek-v4.1-flash` / `gpt-6-luna` / `claude-haiku-5-5`
- 数据集：`debate-dataset.json` v1.0.0
- 标准：`DEBATE_TECH_FACT_BASELINE_V1.md`
- Prompt 版本：`1.1.0`（system 增加“覆盖适用边界、失败模式和常见误区”）
- must 复核：csrf-xss c2、index-generation c4、compression c4、process-thread c2 降为 should
- 明细：`docs/implementation/regression/debate-regression-current-pool-v1-1-latest.json`
- 评分修正重跑：mq-delivery, process-thread

## 0. 运行方式

- 单进程 worker 池：同一个 Electron 进程里 3 个异步 worker；
- 每个 worker 从题目队列取一题，独立完成辩论、裁判和 V1 评分；
- Provider 并发由 providerConcurrency 控制，默认 workers × 2；
- 完整 worker 池运行墙钟约 18 分 24 秒，串行旧运行约 2 小时；
- 这是修复评分器后的完整 24 题 worker 池运行；
- mq-delivery、process-thread 因 claude 连接失败/403 单题重跑，合并后执行层为 24/24 COMPLETED。

## 1. 总结

| 项 | 结果 |
| --- | --- |
| 题目数 | 24 |
| 执行 | COMPLETED 24 / PARTIAL 0 |
| 主裁判 | model 24 / rules 0 |
| 独立裁判 | 24 / 24 |
| 质量 | passed 24 / inconclusive 0 |
| 事实维度 | model-assessed 24 / unknown 0 |
| V1 | passed 17 / failed 7 / unavailable 0 |
| 平均分 | 90 |
| 分类匹配 | 24 / 24 |
| 结构化通过 | 否 |

> `score` 是代码按 missing/wrong/boundary/classification 算出的门槛分。

## 2. 逐题结果

| # | 题目 | 执行 | 主裁判 | 质量 | V1 | score | 缺失 must | 旧池/串行 V1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `float-equality` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 2 | `array-map` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 3 | `http-methods` | COMPLETED | model | passed | PASS | 100 | - | FAIL |
| 4 | `tcp-udp` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 5 | `btree-index` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 6 | `acid` | COMPLETED | model | passed | FAIL | 69 | c3 | FAIL |
| 7 | `jwt-revoke` | COMPLETED | model | passed | FAIL | 69 | c4 | PASS |
| 8 | `csrf-xss` | COMPLETED | model | passed | PASS | 100 | - | FAIL |
| 9 | `cache-invalidation` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 10 | `index-generation` | COMPLETED | model | passed | FAIL | 69 | c3 | FAIL |
| 11 | `mq-delivery` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 12 | `distributed-lock` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 13 | `schema-migration` | COMPLETED | model | passed | FAIL | 60 | c2, c3 | FAIL |
| 14 | `feature-flag` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 15 | `rate-limit` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 16 | `observability` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 17 | `testing-pyramid` | COMPLETED | model | passed | PASS | 100 | - | PASS |
| 18 | `unicode-utf8` | COMPLETED | model | passed | FAIL | 60 | c2, c3 | FAIL |
| 19 | `timezone` | COMPLETED | model | passed | FAIL | 65 | c4 | FAIL |
| 20 | `compression` | COMPLETED | model | passed | FAIL | 65 | c2 | FAIL |
| 21 | `git-rebase` | COMPLETED | model | passed | PASS | 100 | - | FAIL |
| 22 | `process-thread` | COMPLETED | model | passed | PASS | 100 | - | FAIL |
| 23 | `memory-leak` | COMPLETED | model | passed | PASS | 100 | - | FAIL |
| 24 | `monolith-microservices` | COMPLETED | model | passed | PASS | 100 | - | PASS |

## 3. V1 未通过

共 7 题。

### `acid`

- score：69，modelScore：82
- 缺失 must：c3
- 错误主张：无
- 边界：覆盖
- 理由：回答准确解释 ACID 四字母，说明一致性涉及应用定义的不变量而非仅数据库约束，覆盖隔离性解决的并发异常及锁、MVCC、重试、分布式协调等代价，且无错误主张；但未明确说明数据库默认隔离级别不一定是可串行化，因此 c3 未完整覆盖。

### `jwt-revoke`

- score：69，modelScore：4
- 缺失 must：c4
- 错误主张：无
- 边界：覆盖
- 理由：给出了条件性推荐和撤销延迟、存储故障等边界；核心事实基本覆盖，但遗漏刷新令牌撤销对已签发访问令牌的影响。

### `index-generation`

- score：69，modelScore：4
- 缺失 must：c3
- 错误主张：无
- 边界：覆盖
- 理由：明确说明完整旧代继续服务、校验后原子发布和回滚；覆盖磁盘、旧代回收、读者生命周期、发布竞争及崩溃相关风险，并给出适用与不适用场景。也要求固定源码版本以保证构建输入一致。但未明确要求索引代只读，也未提出明确的旧代保留与清理策略。

### `schema-migration`

- score：60，modelScore：8
- 缺失 must：c2, c3
- 错误主张：无
- 边界：覆盖
- 理由：给出了完整的 expand/contract 顺序，并说明 DDL 行为需结合数据库、版本、表结构和负载验证；也提供了限时、退避、分批回填和演练等条件性建议。未明确点出短暂元数据锁及新旧版本实例并存时的一致性要求。

### `unicode-utf8`

- score：60，modelScore：55
- 缺失 must：c2, c3
- 错误主张：无
- 边界：覆盖
- 理由：正确说明 Unicode 是字符集/码点标准、UTF-8 是其一种编码方式，并通过示例体现 UTF-8 字节编码；但未明确 UTF-8 是 1 到 4 字节的变长编码，乱码原因只部分覆盖（错误解码、截断、有损替换），未提重复编码、字符集声明错误，也未说明诊断需原始字节和编码声明、乱码不一定可逆。未出现所列重大错误主张。

### `timezone`

- score：65，modelScore：0.8
- 缺失 must：c4
- 错误主张：无
- 边界：未覆盖
- 理由：按时间语义区分绝对时刻与墙上时钟约定，并给出相应存储和展示建议；也指出无时区本地时间不能单独表示绝对时刻。未说明夏令时切换可能造成当地时间不存在或重复，以及未来预约需要定义歧义处理规则。

### `compression`

- score：65，modelScore：60
- 缺失 must：c2
- 错误主张：无
- 边界：未覆盖
- 理由：正确给出了静态资源 Brotli + gzip 回退、动态响应按 CPU/延迟/带宽实测选择的主框架，且无重大错误。但未明确已压缩文件通常无需再压缩、极小响应可能不值得压缩；也未明确 Accept-Encoding 协商与 Vary 缓存变体要求，且遗漏秘密信息与攻击者可控内容下的压缩侧信道风险。

## 4. 执行 PARTIAL

共 0 题。


## 5. 结论

- 当前模型池执行 COMPLETED 24/24；
- V1 通过 17/24，失败 7；
- 分类匹配 24/24；
- 失败原因以必答主张缺失为主；没有把 major 错误主张、执行失败和事实未核验混成一个通过状态；
- `structuralOk` 以逐题硬门槛为准，不是平均分；
- worker 池运行 24/24 COMPLETED、24/24 独立模型裁判，执行层没有 PARTIAL；
- 主要失败仍是必须主张缺失，不是执行失败；
- 评分器仍有噪声：标准外“错误”默认按 minor，不再是 major。

## 6. 限制

- 单次样本，不是稳定性重复实验；
- V1 评分是模型应用人工标准，不是外部事实核验；
- 评分模型原始分可能异常，门槛分由代码计算并保留 modelScore 审计；
- 仍然只有一个 Provider，故障域独立性未验证。
