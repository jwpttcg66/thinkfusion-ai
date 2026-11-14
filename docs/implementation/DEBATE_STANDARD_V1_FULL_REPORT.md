# V1 标准全量回归结果

> 模型池更新：用户后来换掉了 `kimi-k2.7-code`，当前设置为
> `deepseek-v4.1-flash` / `gpt-6-luna` / `claude-haiku-5-5`。本文记录的是
> **旧模型池**（deepseek / gpt / kimi）的全量结果；失败题用当前模型池重跑的
> 结果见 `DEBATE_STANDARD_V1_MODEL_UPDATE.md`。

- 日期：2026-11-14
- 数据集：`1.0.0` / `ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 标准：`DEBATE_TECH_FACT_BASELINE_V1.md`
- 明细：`docs/implementation/regression/debate-regression-standard-v1-full-latest.json`
- 命令：`run-debate-regression.cjs --suffix=standard-v1-full`

## 1. 总结

| 项 | 结果 |
| --- | --- |
| 题目数 | 24 |
| 执行 | COMPLETED 17 / PARTIAL 7 |
| 主裁判 | model 23 / rules 1 |
| 独立裁判 | 23 / 24 |
| 质量 | passed 23 / inconclusive 1 |
| 事实维度 | model-assessed 23 / unknown 1 |
| V1 门槛 | passed 13 / failed 11 / unavailable 0 |
| V1 平均分 | 84 |
| 分类匹配 | 24 / 24 |
| 结构化通过 | 否 |

> `score` 是代码按 missing/wrong/boundary/classification 算出的门槛分；`modelScore` 是评分模型原始分，只用于审计。

## 2. 逐题 V1 结果

| # | 题目 | 执行 | 主裁判 | 质量 | V1 | score | modelScore | 缺失 must | 错误主张 | 分类 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `float-equality` | PARTIAL | model | passed | PASS | 100 | 9 | - | - | FACT |
| 2 | `array-map` | PARTIAL | model | passed | PASS | 100 | 90 | - | - | FACT |
| 3 | `http-methods` | COMPLETED | model | passed | FAIL | 65 | 80 | c2 | - | CONTEXTUAL |
| 4 | `tcp-udp` | COMPLETED | model | passed | PASS | 100 | 1 | - | - | FACT |
| 5 | `btree-index` | COMPLETED | model | passed | PASS | 100 | 88 | - | - | FACT |
| 6 | `acid` | COMPLETED | rules | inconclusive | FAIL | 69 | 80 | c3 | - | FACT |
| 7 | `jwt-revoke` | PARTIAL | model | passed | PASS | 100 | 1 | - | - | CONTEXTUAL |
| 8 | `csrf-xss` | COMPLETED | model | passed | FAIL | 69 | 80 | c2 | - | FACT |
| 9 | `cache-invalidation` | COMPLETED | model | passed | PASS | 100 | 80 | - | - | CONTEXTUAL |
| 10 | `index-generation` | COMPLETED | model | passed | FAIL | 60 | 0.5 | c2, c3 | - | CONTEXTUAL |
| 11 | `mq-delivery` | COMPLETED | model | passed | PASS | 100 | 100 | - | - | CONTEXTUAL |
| 12 | `distributed-lock` | COMPLETED | model | passed | PASS | 100 | 100 | - | - | CONTEXTUAL |
| 13 | `schema-migration` | PARTIAL | model | passed | FAIL | 60 | 50 | c2, c3 | - | CONTEXTUAL |
| 14 | `feature-flag` | PARTIAL | model | passed | PASS | 100 | 100 | - | - | CONTEXTUAL |
| 15 | `rate-limit` | COMPLETED | model | passed | PASS | 100 | 1 | - | - | FACT |
| 16 | `observability` | COMPLETED | model | passed | PASS | 100 | 0.9 | - | - | FACT |
| 17 | `testing-pyramid` | COMPLETED | model | passed | PASS | 100 | 100 | - | - | CONTEXTUAL |
| 18 | `unicode-utf8` | COMPLETED | model | passed | FAIL | 60 | 65 | c2, c3 | - | FACT |
| 19 | `timezone` | COMPLETED | model | passed | FAIL | 69 | 4 | c2 | - | CONTEXTUAL |
| 20 | `compression` | PARTIAL | model | passed | FAIL | 69 | 85 | c4 | - | CONTEXTUAL |
| 21 | `git-rebase` | COMPLETED | model | passed | FAIL | 69 | 75 | c2 | - | FACT |
| 22 | `process-thread` | COMPLETED | model | passed | FAIL | 60 | 3 | c2, c3 | - | FACT |
| 23 | `memory-leak` | PARTIAL | model | passed | FAIL | 60 | 60 | c2, c3 | - | CONTEXTUAL |
| 24 | `monolith-microservices` | COMPLETED | model | passed | PASS | 100 | 100 | - | - | CONTEXTUAL |

## 3. 执行 PARTIAL

共 7 题。

- `float-equality`：gpt：连不上 https://opencode.ai/inference/go/openai/v1；kimi：连不上 https://opencode.ai/inference/go/openai/v1
- `array-map`：kimi：超过单次调用时限 180 秒
- `jwt-revoke`：kimi：超过单次调用时限 177 秒
- `schema-migration`：kimi：超过单次调用时限 180 秒
- `feature-flag`：kimi：超过单次调用时限 180 秒
- `compression`：kimi：超过单次调用时限 180 秒
- `memory-leak`：kimi：超过单次调用时限 180 秒

## 4. V1 未通过

共 11 题。失败原因全部是**必答主张缺失**或**边界不足**，没有出现 `major` 错误主张。

### `http-methods`

- score：65 / modelScore：80
- 缺失 must：c2
- 错误主张：无
- 边界：未覆盖
- 分类匹配：是（CONTEXTUAL）
- 理由：明确回答了 PUT 幂等、POST 默认不保证幂等，并给出已知 URI 完整替换用 PUT、服务端分配 URI/追加/非幂等动作用 POST，以及 POST 可通过应用层幂等机制安全重试；但未说明幂等不等于每次响应完全相同，也未覆盖 PATCH 幂等性取决于补丁语义和实现的边界。无重大错误。

### `acid`

- score：69 / modelScore：80
- 缺失 must：c3
- 错误主张：无
- 边界：覆盖
- 分类匹配：是（FACT）
- 理由：回答准确说明了 ACID 四义、一致性不由数据库自动保证全部业务规则、隔离性处理的并发异常以及锁、死锁、MVCC、重试等代价；但未明确说明数据库默认隔离级别不一定是可串行化，故 c3 缺失。

### `csrf-xss`

- score：69 / modelScore：80
- 缺失 must：c2
- 错误主张：无
- 边界：覆盖
- 分类匹配：是（FACT）
- 理由：回答准确区分了 XSS（脚本在目标站点上下文执行）与 CSRF（诱导已登录用户浏览器向目标站点发送非预期请求），并完整给出两侧防御重点：CSRF 侧的 SameSite Cookie、CSRF Token、Origin 校验与避免用 GET 做状态变更；XSS 侧的按上下文输出编码、安全 DOM API、富文本净化与 CSP 纵深防御。未命中必答主张 c2——未说明 XSS 成功后可能读取 CSRF token 或以用户身份发起同源请求，从而绕过部分 CSRF 防御，这是两者关联性的关键事实。未出现“CSRF 必须依赖 XSS”“XSS 只窃取 Cookie”“HTTPS 可单独防 CSRF”“两者是同一种攻击”等错误主张。

### `index-generation`

- score：60 / modelScore：0.5
- 缺失 must：c2, c3
- 错误主张：无
- 边界：覆盖
- 分类匹配：是（CONTEXTUAL）
- 理由：给出了有条件的采用建议，并说明读者固定使用同一代、原子切换和回滚方向；但成本没有明确涵盖崩溃恢复及读者生命周期管理，适用条件也未明确说明只读代和构建快照一致性。

### `schema-migration`

- score：60 / modelScore：50
- 缺失 must：c2, c3
- 错误主张：无
- 边界：覆盖
- 分类匹配：是（CONTEXTUAL）
- 理由：给出了有条件的 expand/contract 顺序，并说明不能保证零锁；但未明确短暂元数据锁、旧新版本并存时的双写一致性，也未明确要求按数据库、版本、表结构和并发实测具体 DDL 行为。

### `unicode-utf8`

- score：60 / modelScore：65
- 缺失 must：c2, c3
- 错误主张：无
- 边界：覆盖
- 分类匹配：是（FACT）
- 理由：正确说明 Unicode 是字符/码点标准、UTF-8 是其编码实现，且未出现重大错误；但未明确 UTF-8 为 1–4 字节变长编码，未完整列出乱码原因中的有损替换，也未说明诊断需原始字节和编码声明，因此必答项覆盖不完整。

### `timezone`

- score：69 / modelScore：4
- 缺失 must：c2
- 错误主张：无
- 边界：覆盖
- 分类匹配：是（CONTEXTUAL）
- 理由：清楚区分确定时刻与墙上时钟约定，并给出相应存储建议；也说明了夏令时歧义及纯本地时间不能单独表示确定时刻。唯一时刻的展示只说按业务指定时区转换，未明确指出应按 IANA 时区转换。

### `compression`

- score：69 / modelScore：85
- 缺失 must：c4
- 错误主张：无
- 边界：覆盖
- 分类匹配：是（CONTEXTUAL）
- 理由：回答覆盖了无普遍最优、静态资源 Brotli+gzip 回退、动态按实测、已压缩/小收益不压缩、Accept-Encoding 与 Vary 等条件与边界；但仅泛泛提到压缩侧信道风险，未明确“秘密信息 + 攻击者可控内容”这一触发条件，故 c4 未完整覆盖。无重大错误主张。

### `git-rebase`

- score：69 / modelScore：75
- 缺失 must：c2
- 错误主张：无
- 边界：覆盖
- 分类匹配：是（FACT）
- 理由：回答明确了 merge/rebase 的哈希与线性历史差异，覆盖公共分支默认不 rebase、个人分支可整理及 rebase 已推送公共分支的危害与例外；但未明确说明 fast-forward 时 merge 可不生成合并提交，因此 c2 缺失，边界未完全覆盖。无重大错误主张。

### `process-thread`

- score：60 / modelScore：3
- 缺失 must：c2, c3
- 错误主张：无
- 边界：覆盖
- 分类匹配：是（FACT）
- 理由：核心区别及多进程、多线程的适用场景说明正确。未说明 Linux 中进程和线程均由 task_struct 表示且可调度；对 GIL 未明确限定为默认带 GIL 的 CPython 构建、不能推广到所有 Python 实现；提到异步 I/O，但未说明是否更快应实测。

### `memory-leak`

- score：60 / modelScore：60
- 缺失 must：c2, c3
- 错误主张：无
- 边界：覆盖
- 分类匹配：是（CONTEXTUAL）
- 理由：答案覆盖了堆/堆外分型、观察增长趋势、受控复现与修复后验证，并明确 RSS 增长不能单独证明泄漏；但未明确监控 PSS、native memory 和 GC 日志，也未明确堆快照用 Heap Dump/MAT、堆外用 NMT/native profiler，因此必须主张 c2、c3 缺失。无重大错误主张，边界条件有覆盖。

## 5. 结论

- 24 题都完成了 V1 评分，没有 `unavailable`；
- 分类匹配 24/24，说明裁判对新三分类的理解稳定；
- 13/24 通过 V1 门槛，11/24 失败；
- 失败全部是缺少具体的 must 主张或边界，不是事实性错误主张；
- 7 题执行 `PARTIAL`，主要是 kimi 超过 180 秒或连接失败；
- `acid` 主裁判退回规则版，质量 `inconclusive`；
- 因此不能写“24 题全部通过 V1 门槛”。

## 6. 下一步

1. 对 7 道 `PARTIAL` 和 `acid` 用 300 秒预算重跑，区分网络/超时噪声和内容问题；
2. 复核 11 条缺失 must 是否都应该保持 `must`；其中一些是重要边界（如幂等≠同响应、XSS 可绕过 CSRF、PATCH 语义、Linux task_struct、GIL 适用范围），建议保留；
3. 如果保留 `must`，需要让辩论提示词更明确地要求“覆盖边界和常见误区”，但不能把标准答案直接塞进问题；
4. 修改后重新跑全量 24 题，而不是只补跑失败题。

## 7. 限制

- 单次样本，不是稳定性重复实验；
- V1 评分是 `model-assessed`，不是外部事实核验；
- 评分模型有时给分异常（如 1 分），门槛分已改为代码计算，原始分保留为 `modelScore`；
- 仍然只有一个 Provider，故障域独立性未验证。
