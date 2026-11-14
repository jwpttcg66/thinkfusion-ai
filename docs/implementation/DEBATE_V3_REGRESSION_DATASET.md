# Debate V3 24 题自动回归集

- 数据集版本：`1.0.0`
- SHA-256：`ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 文件：`desktop-agent-macos/scripts/regression/debate-dataset.json`
- 运行器：`desktop-agent-macos/scripts/regression/run-debate-regression.cjs`

## 1. 这份数据集测什么

它不是事实基准集，也不使用模型生成的参考答案。它只做回归：

- 24 道题能否真实进入 `DebateOrchestrator`；
- 六种策略各 4 题，角色和轮次是否仍然不同；
- 两个模型辩论、第三个模型独立裁判时，裁判是否 `backend: 'model'`；
- 质量报告能否生成，事实维度是否仍然停在 `model-assessed`；
- Final Judge 是否只复用五档 `Verdict`，不新增结论状态；
- 是否有超时、PARTIAL、失败和 sharedWith。

`anchor` 是人工列出的规则可查词，只做一次粗烟测。它不计算准确率，
也不能证明回答正确。

## 2. 题目

| # | ID | 类别 | 策略 | 问题 | anchor 规则词 |
| --- | --- | --- | --- | --- | --- |
| 1 | `float-equality` | JavaScript | `truth` | JavaScript 中 0.1 + 0.2 === 0.3 的结果是什么？为什么？ | false, 0.30000000000000004, 不相等, 不等于 |
| 2 | `array-map` | JavaScript | `adversarial` | JavaScript 的 Array.prototype.map 会修改原数组吗？它和 forEach 的区别是什么？ | 不会, 不修改, 新数组, new array |
| 3 | `http-methods` | HTTP | `expert` | HTTP 的 PUT 和 POST 哪个是幂等的？在设计 REST API 时应该怎么选？ | PUT, 幂等, idempotent |
| 4 | `tcp-udp` | Networking | `assumption` | TCP 和 UDP 的核心区别是什么？各自适合什么场景？ | - |
| 5 | `btree-index` | Database | `solution` | 数据库为什么常用 B+ 树而不是二叉树做索引？B+ 树在磁盘和范围查询上有什么优势？ | B+, 磁盘, 页, 范围查询 |
| 6 | `acid` | Database | `discovery` | ACID 四个字母分别是什么意思？隔离性解决什么问题，又带来什么代价？ | 原子, 一致性, 隔离, 持久 |
| 7 | `jwt-revoke` | Security | `truth` | JWT 无状态鉴权如何实现主动失效？黑名单、短过期、刷新令牌各有什么取舍？ | 黑名单, 撤销, 短过期, revoke |
| 8 | `csrf-xss` | Security | `adversarial` | CSRF 和 XSS 的区别是什么？防御手段分别是什么？ | - |
| 9 | `cache-invalidation` | Caching | `expert` | 缓存一致性为什么难？常见的失效策略有哪些，各自适合什么场景？ | - |
| 10 | `index-generation` | Architecture | `assumption` | 团队准备把本地代码索引从“每次覆盖旧索引”改成“Generation 原子快照”。请分析收益、风险和适用条件。 | - |
| 11 | `mq-delivery` | Messaging | `solution` | 消息队列如何保证不丢消息？生产、存储、消费三个环节分别可能在哪里丢？ | - |
| 12 | `distributed-lock` | Distributed Systems | `discovery` | 分布式锁需要满足哪些条件？Redis 锁有什么风险，如何避免锁过期后误删别人的锁？ | - |
| 13 | `schema-migration` | Database | `truth` | 在线数据库 schema 迁移如何避免锁表和长时间不可用？常见的 expand/contract 流程是什么？ | - |
| 14 | `feature-flag` | Architecture | `adversarial` | Feature flag 的收益和长期维护风险是什么？什么时候应该清理 flag？ | - |
| 15 | `rate-limit` | Networking | `expert` | 令牌桶和漏桶的区别是什么？分别适合什么流量整形场景？ | - |
| 16 | `observability` | Operations | `assumption` | 日志、指标、追踪各自解决什么问题？为什么不能互相替代？ | - |
| 17 | `testing-pyramid` | Testing | `solution` | 单元测试、集成测试、端到端测试的边界怎么划？测试金字塔还适用吗？ | - |
| 18 | `unicode-utf8` | Text | `discovery` | UTF-8 和 Unicode 是什么关系？为什么会出现乱码？ | Unicode, UTF-8, 编码, 字符集 |
| 19 | `timezone` | Time | `truth` | 跨时区系统应该如何存储和展示时间？为什么不应该用本地时间存数据库？ | UTC, 时区, timezone |
| 20 | `compression` | Networking | `adversarial` | gzip 和 brotli 的取舍是什么？什么情况下不应该压缩？ | - |
| 21 | `git-rebase` | Version Control | `expert` | git rebase 和 merge 的区别是什么？团队协作中应该如何选择，为什么不能 rebase 已推送的公共分支？ | - |
| 22 | `process-thread` | OS | `assumption` | 进程和线程的区别是什么？什么场景适合多进程，什么场景适合多线程？ | - |
| 23 | `memory-leak` | Operations | `solution` | 如何定位一个长时间运行服务的内存泄漏？从监控、快照到复现应该怎么排查？ | - |
| 24 | `monolith-microservices` | Architecture | `discovery` | 什么时候应该从单体拆微服务？什么时候不该拆？判断依据是什么？ | - |

## 3. 运行方式

```bash
cd desktop-agent-macos
npm run build:test
./node_modules/.bin/electron scripts/regression/run-debate-regression.cjs --no-sandbox
```

先跑少量题目：

```bash
./node_modules/.bin/electron scripts/regression/run-debate-regression.cjs --no-sandbox --limit=2
```

只重跑一题并单独输出（不覆盖整轮 latest）：

```bash
./node_modules/.bin/electron scripts/regression/run-debate-regression.cjs --no-sandbox \
  --only=cache-invalidation --suffix=rerun
```

把重跑结果合并回整轮记录：

```bash
./node_modules/.bin/electron scripts/regression/run-debate-regression.cjs --no-sandbox \
  --only=cache-invalidation --suffix=rerun \
  --merge-into=../docs/implementation/regression/debate-regression-latest.json
```

脚本会把结果写到：

- `docs/implementation/regression/debate-regression-latest.json`
- `docs/implementation/regression/debate-regression-latest.md`
- 带时间戳的同内容 JSON 快照

每跑完一题就写一次，长跑中断不丢已完成记录。

## 4. 真实运行条件

- 辩论模型：用户设置里的 `deepseek-v4.1-flash`、`gpt-6-luna`、`kimi-k2.7-code`；
- 每题只让其中两位辩论，第三位当裁判；
- 24 题按顺序轮换裁判，每位模型各判 8 题；
- 每题 2 轮；
- 单次调用 180 秒，整场 300 秒；
- 每题最多等 380 秒，超时就停止并如实记 `CANCELLED` / `timedOut`。

## 5. 验收口径

可以自动判：

- 执行是否 `COMPLETED`；
- 裁判是否模型版、是否独立；
- 质量报告和 Final Judge 是否生成；
- 事实维度是否被错误标成 `supported`；
- `rule.ok`、失败数、耗时、锚点命中。

不能自动判：

- 回答是否符合世界事实；
- 模型是否真正理解了题目；
- 锚点命中是否等于正确。

所以最终只能写 `TESTED` / `STRUCTURAL PASS`，不能写事实准确率或
`PRODUCTION_READY`。

## 6. 配套改动

### 协作组织方式

`LeadPlan` 增加 `collaboration?: DebateCollaborationPlan`，记录：

- 形态：单模型 / 双模型 / 专家角色 / 多模型；
- 轮内并行、轮间递进；
- 是否允许交叉质疑；
- 裁判是否要求独立。

老辩论文件没有这个字段，按 `undefined` 读回，不补造。

### 裁判 JSON 重试

模型偶尔会先写分析、忘了输出 JSON。`JudgeEngine` 现在只对“解析失败”
重试一次，并在 `judgeAttempts` 里记录实际问了几次。两次都不合法才退回
规则版；不会把 prose 硬解析成裁决，也不会把规则版标成模型评审。

### 退回规则版时的质量口径

规则版 `argumentQuality` 是规则文本线索，不是模型评审。质量报告现在：

- `logicalValidity = unknown`，不再写“模型裁判论证质量均值”；
- `criticalIssues` 明确写出“裁判退回规则版”；
- `factualAccuracy` 仍是 `unknown` / `insufficient`。

## 7. 人工复核基线 V1

24 题技术主张已经由用户逐条复核：

- 11 题保留；
- 10 题保留并补充；
- 3 题（`cache-invalidation`、`mq-delivery`、`distributed-lock`）重新形成结论；
- 分类：FACT 11、CONTEXTUAL 13、INSUFFICIENT 0。

标准答案、必答主张、允许表达、错误主张和评分规则见：

- `docs/implementation/DEBATE_TECH_FACT_BASELINE_V1.md`
- `desktop-agent-macos/scripts/regression/debate-standard-answers-v1.json`

关键修正：`CONTEXTUAL` 不等于 `INSUFFICIENT`。题目需要具体场景，不代表裁判
可以拒绝给任何结论；应给出条件、边界和推荐方案。

裁判提示词也已同步要求输出 `questionType`，避免把有条件的技术决策
误判成信息不足。

### 默认回归门槛

`scripts/regression/run-debate-regression.cjs` 现在默认加载 V1 标准，并对每题
额外调用一次标准答案评分器：

- 检查 `questionType` 与标准分类是否一致；
- 检查所有 `must` 必答主张；
- 检查 `major` 错误主张；
- `CONTEXTUAL` 必须给边界；
- 代码按规则封顶：缺 must ≤ 69，major 错误 ≤ 39，CONTEXTUAL 缺边界 ≤ 65，
  分类不一致 ≤ 60；
- 通过要求标准分 ≥ 70。

评分器在 `src/main/debate/standard-rubric.ts`。它是 `backend: model`，只表示
模型应用了人工标准，不是事实核验。结果里的 `standard` 字段会记录
`matchedClaims`、`missingClaims`、`wrongClaims`、`boundaryCovered`、`score`、
`rubricAgentId` 和 `participatedInDebate`。

### 3 路并行

```bash
cd desktop-agent-macos
npm run regression:debate:parallel
```

它把 24 题拆成 3 组，每组一个独立 Electron 进程；组内仍串行，组间并行。
每题仍是 2 辩手 + 1 独立裁判 + V1 评分。

并行结果会合并到：

- `docs/implementation/regression/debate-regression-current-pool-final-latest.json`
- `docs/implementation/regression/debate-regression-current-pool-final-latest.md`

注意：并行只缩短墙钟时间，不会自动提高 V1 分数；答案仍有随机波动。
