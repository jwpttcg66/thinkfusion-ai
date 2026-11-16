# Debate V4.0 计划审计

- 审计对象：用户提交的《ThinkFusion AI 多模型辩论系统升级实施计划书 V4.0》
- 审计基线：`main` = `c8419c00d277bee5067b519ead002df8b8b66c8f`（已用 `git ls-remote origin refs/heads/main` 核对）
- 审计方式：只读代码与报告，不修改业务代码
- 结论：**方向批准，P0 优先正确；但 P0 出口条件必须补三项，计划中有 7 处事实/口径需要修正，否则后续阶段会拿一个不稳定的数字当基准。**

---

## 1. 计划中已核实为真的部分

| 计划表述 | 核实结果 | 依据 |
| --- | --- | --- |
| 远端 main 是 `c8419c0` | 真 | `git ls-remote origin refs/heads/main` |
| 24 题报告 runner.commit 是 `4403514` | 真 | `docs/implementation/regression/debate-regression-gate0-cloud-latest.json` |
| 与当前 main 相差 9 个提交 | 真 | `git rev-list --count 4403514..main` = 9（6 个内容提交 + 3 个合并） |
| 24 题 COMPLETED 22 / PARTIAL 2 | 真 | 报告 `summary.execution` |
| V1 通过 19/24、失败 5/24 | 真 | 报告 `summary.standard` |
| `structuralOk=false` | 真 | 报告与 `summary.cjs` 判定 |
| `ClaimEvidenceLink` 已有类型 | 真 | `src/main/debate/types.ts`，Gate 2 引入 |
| Evidence Pack 支持存储、哈希、冻结、回放 | 真 | `src/main/evidence-pack/store.ts` + 9 条测试 |
| Pack 映射支持 commit 级独立性 | 真 | `mapping.ts`，`originKey = repo:<commit>` |
| 工程证据评分规则存在 | 真，但状态需改写 | `judges.ts` / `quality.ts`，5 条测试 |
| 外部事实核验未完成 | 真 | 只有 `FactVerificationStatus` 类型，无核验器 |
| Pack 自动创建 / Claim 关联写入未完成 | 真 | 没有编排器调用方、没有 link 写入方 |
| UI 真机验证未完成 | 真 | 只测到 handler 层 |
| `AgentOrchestrator` 已存在 | 真 | `src/main/orchestrator.ts`；辩论侧没有引用它 |

---

## 2. 必须修正的 7 处

### 2.1 单次 24 题结果不能当基准（最高优先级）

计划说「19/24 不能直接作为当前 main 的实测成绩」，这正确，但还不够：**同一个提交附近连续两次运行就出现过 18/24 与 19/24**。

- 2026-11-16 03:06 UTC 首跑：V1 18/24；
- 03:32 UTC 修完报告 `runner` 字段后重跑：V1 19/24；
- 两次之间产品行为只多了「报告元数据」改动，模型池、数据集、completeness 开关相同。

原因是回归链路没有固定 `temperature` / `seed`：`OpenAICompatibleProvider` 的请求体里没有这两个字段（全仓 grep 无结果），模型默认随机性不可控。

**后果：** 如果 P0 只跑一次，得到一个 18 或 19，后面每个阶段都会把 ±1 的模型波动当成「回归/进步」。这与计划「可信质量基准」的目标直接冲突。

**修订要求：**

1. P0 的基线定义为 **N 次运行的逐题通过次数与总通过率分布**（建议 N=3；额度不足时 N=2 并明确标注样本不足）。
2. 报告必须记录每题在 N 次中通过几次，而不是只留最后一次。
3. 回归判定不比较单次通过数，比较「逐题通过次数是否显著下降」和「必须通过的题是否掉出」。
4. 如果 Provider 支持 `temperature` / `seed`，先做一次固定参数可行性验证；不支持就按分布口径，不要假装可复现。

### 2.2 `19/24` 的构成要说清

`19/24` 里包含一道执行状态为 PARTIAL 的题（`mq-delivery` 的 V1 通过）。所以不能读成「19 道完整跑完并通过」。

建议统一写法：

```text
执行：COMPLETED 22 / PARTIAL 2
V1：19/24（其中 1 道为 PARTIAL 题的评分结果）
结构：structuralOk=false（要求 24/24 COMPLETED 且 V1 全过）
```

### 2.3 「工程证据评分：部分已有」状态写低了

实际是：

- 规则已实现：只有快照 → `partial`；快照 + `exitCode === 0` → `sufficient`；
- 质量门已实现；
- 有 5 条测试；
- **没有接入任何真实调用链**。

建议状态改成：`IMPLEMENTED + TESTED（单元/规则层），NOT INTEGRATED`。
「部分已有」会被读成「还没写完」，而真实缺口是「写完了但没接线」。

### 2.4 P3 的「反例执行 → 冲突证据处理」目前不存在

计划 P3 要求：

```text
有反例执行 → 必须进入冲突证据处理
```

但当前代码：

- `judgeEvidence` 只把 `execution.exitCode === 0` 当成功；
- `exitCode !== 0` 只会让证据维度变成 `partial`；
- `conflicting` 只来自 `conflictingClaims(disputes)`，即辩论争议类型为 `evidence_conflict` 的主张；
- 执行失败与 `conflicting` 之间没有连接。

**修订要求：** 在 P3 契约里明确「哪些执行失败算反例、由谁把失败执行升级为冲突证据、是否需要新的 dispute 类型」，并补反例测试。否则 P3 的验收句无法成立。

### 2.5 P4 的核验状态与现有类型不一致

计划写的状态：

```text
verified / contradicted / insufficient / unavailable / stale
```

现有 `FactVerificationStatus`：

```text
verified / contradicted / partially_verified / insufficient / conflicting / not_verifiable
```

差异：计划新增 `unavailable`、`stale`，删掉 `partially_verified`、`conflicting`、`not_verifiable`。

**修订要求：** 先决定是合并语义还是加成员，再动手实现。建议：

- `unavailable`（取不到来源）与 `insufficient`（来源不足）分开；
- `stale` 作为来源元数据（`readAt` + 版本/时效判定），不要塞进主状态；
- 保留 `conflicting`，因为「来源互相矛盾」与「核验不了」是不同结论；
- `partially_verified` 保留，避免把「部分支持」压成 `insufficient`。

### 2.6 P2 的「Pack 与 Claim 的关联」边界要写死

`ClaimEvidenceLink` 现在放在 `DebateState`，Pack 只存快照，不存关联。计划的这句话容易被实现成「Pack 里再加一张关联表」，变成第二套关联来源。

**修订要求：** 明确写：

```text
Pack = 证据快照（内容 + 定位 + hash）
ClaimEvidenceLink = 主张与证据的关系（状态层）
Pack 内不存支持/反驳关系
```

回放校验的是「Pack 内容与 hash 一致」，不是「关联关系还指向同一条证据」；后者由 P1 的引用完整性校验负责。

### 2.7 「六种策略」与代码枚举不一致，P5 性质要改写

`DebateStrategy` 实际有 8 个值：`truth / adversarial / expert / assumption / solution / discovery / standard / deep`。24 题数据集覆盖的是前 6 个。

另外六种策略已有执行路径和回归脚本（`check-debate-strategies.mjs`），P5 的主要工作不是「新建策略」，而是：

- 补齐证据链与裁决链的策略回归；
- 定义动态选择与提前终止的判据；
- 证明策略不只是配置名。

**修订要求：** 把「六种辩论策略」改成「数据集覆盖的六种策略」，并把 P5 描述为「策略验证与动态化」，避免被读成从零建设。

---

## 3. P0 现在就能预填的答案

计划 P0 的 4、5 两项不必重新摸索，审计已经给出结论：

### 3.1 `structuralOk=false` 的判定

`scripts/regression/summary.cjs`：

```text
structuralOk = 所有题都满足：
  debate.outcome === 'COMPLETED'
  且 judge.backend === 'model'
  且 judge.sharedWith 为空
  且 quality 存在
  且 decision 存在
  且 quality.factualAccuracy.status !== 'supported'
  且 standard.passed === true
```

当前 2 道 PARTIAL + 5 道 V1 未过，两者任一项就足以让 `structuralOk=false`。

### 3.2 5 道 V1 未过的原因

全部是标准答案条目缺失，不是结构异常：

| 题 | 缺的条目 |
| --- | --- |
| `acid` | c3 |
| `jwt-revoke` | c3 |
| `schema-migration` | c2 |
| `process-thread` | c3 |
| `memory-leak` | c3 |

这与「不降低 must 来提高通过率」的原则一致：该补的是答案内容，不是门槛。

### 3.3 2 道 PARTIAL 的原因

两题都是 `claude-haiku-5-5` 返回：

```text
API Key 被拒绝（403）：Upstream request failed: Endpoint is unavailable.
```

不是 429、不是超时、不是代码异常。回归 runner 没有对 403/5xx 做重试。

### 3.4 `4403514..c8419c0` 里真正影响运行时的提交

| 提交 | 是否影响辩论行为 |
| --- | --- |
| `a122a08` | 只改回归报告 `runner` 元数据 |
| `70e0f7e` | 文档 + Spike 脚本 |
| `99664a2` | 测试 + 文档 |
| `0c98c8d` | 新增 Evidence Pack；`snapshot` 枚举；UI 标签。网页证据路径无变化 |
| `8659216` | 工程证据评分分支；只有存在 `snapshot` 证据时才生效，而当前辩论不会产生 Pack |
| `6c453b2` | 文档 |
| 3 个合并提交 | 无独立行为 |

结论：**从代码路径看，`19/24` 在当前 main 上大概率可复现；但「大概率」不是验收标准，仍需 P0 重跑。** 同时，重跑的差异主要来自模型随机性，不是这 9 个提交。

---

## 4. 阶段顺序与验收缺口

### 4.1 顺序

计划的顺序（P0 → P1 → P2 → P3 → P4/P5 → P6 → P7）总体成立，但建议：

1. **P0 增加「基线冻结」**：给 `c8419c0` 打一个带注释的 tag，后续报告引用 tag，而不是手写 commit。
2. **P0 增加「重试策略决策」**：403 是否重试、重试几次、是否改 runner 版本。这个决定会改变 `COMPLETED` 数和 `structuralOk`，必须在建立基线前定，否则要重建两次基线。
3. **P4 与 P5 并行**可以接受；但 P5 的证据链回归必须在 P3 之后，不能提前宣称策略闭环。
4. **P6 不应等到最后才设计指标**：质量门的字段与阈值应在 P1/P2 的契约里先占位，否则 P6 会回头改数据契约。

### 4.2 验收定义缺口

| 缺口 | 影响 |
| --- | --- |
| 没有 N 次运行的方差口径 | 单次结果无法判定回归 |
| P6 的 `Reasoning Quality` 没有测量方法 | 只能生成字段，不能证明质量 |
| 没有每阶段额度/成本预算 | 24 题 × 3 模型 × N 次可能触发周额度上限 |
| P2 没有 Pack 保留/清理策略 | 快照会无界增长 |
| P4 没有来源白名单、版本策略、抓取安全边界 | 事实核验可能引入不可信来源或 SSRF 风险 |
| P7 没有 UI 自动化工具决定 | 「不允许 handler 代替 UI」无法执行 |
| P1 没有引用完整性契约 | Claim/Evidence 删除、去重、回放后可能出现悬空关联 |

---

## 5. 建议的 P0 执行清单（修订版）

```text
1. git fetch && git rev-parse origin/main
   期望：c8419c0...；不一致则停止并说明。

2. 给基线打 tag（注释 tag），例如 debate-baseline-2026-11-16。
   后续报告引用 tag；不引用手写 commit。

3. 记录 4403514..c8419c0 的运行时改动清单（本审计 §3.4 已给出）。

4. 决定 403/5xx 重试策略：
   - 不改 runner：基线保留 2 道 PARTIAL，structuralOk 必然 false；
   - 改 runner：bump RUNNER_VERSION，记录重试次数，重跑全部 24 题。
   两者只能选一个作为基线口径，不能混。

5. 确认云端周额度足够 N 次运行；不足则降到 N=2 并在报告里标明。

6. 用当前 main 跑 N 次 24 题（不带 --incremental）：
   - 记录每题 N 次中通过次数；
   - 报告执行状态、V1、structuralOk、逐题波动；
   - 不把旧 commit 的数字写进新报告。

7. 复核 5 道 V1 失败是否仍为缺 c2/c3：
   - 是内容缺口就记录，不改标准答案门槛；
   - 若变成结构问题，单独列出。

8. 输出 P1 的源码清单与测试设计（ClaimEvidenceLink 写入方、引用完整性校验）。
```

**P0 出口条件（建议新增）：**

- 新基线报告带 tag / commit，能自证运行代码；
- N 次运行结果与逐题波动已记录；
- `structuralOk` 的判定过程可复核；
- 2 道 PARTIAL 的原因与重试策略已定；
- 5 道 V1 失败逐条有原因；
- 不在新基线里混入旧 commit 或单题重跑结果。

满足以上六条才进 P1。

---

## 6. 当前状态表（按代码事实，不按计划措辞）

| 能力 | 状态 |
| --- | --- |
| 多模型辩论 | IMPLEMENTED + INTEGRATED + TESTED |
| Judge 失败重选 | IMPLEMENTED + INTEGRATED + TESTED（handler 层；未 UI 真机） |
| 质量报告落盘/读取 | IMPLEMENTED + INTEGRATED + TESTED |
| Claim 提取 | IMPLEMENTED + INTEGRATED + TESTED |
| ClaimEvidenceLink | SPECIFIED + IMPLEMENTED（类型与映射消费）；无写入方，NOT INTEGRATED |
| Evidence Pack 存储/哈希/冻结/回放 | IMPLEMENTED + TESTED；NOT INTEGRATED |
| Pack 映射 | IMPLEMENTED + TESTED；NOT INTEGRATED |
| 工程证据评分 | IMPLEMENTED + TESTED（规则层）；NOT INTEGRATED |
| 外部事实核验 | SPECIFIED（只有类型）；NOT STARTED |
| 六种数据集策略 | IMPLEMENTED + TESTED；动态策略 NOT STARTED |
| UI 真机链路 | NOT VERIFIED |
| 24 题当前 main 基线 | NOT RUN（19/24 属于旧 commit 与单次运行） |

---

## 7. 审计结论

1. **批准 V4.0 的方向和 P0 优先级。**
2. **P0 的验收标准需要按本文 §5 收紧**，否则「新基线」仍然只是一个单次随机结果。
3. **P0 不需要重新发现 5 道失败题和 2 道 PARTIAL 的原因**，本文已给出；把时间花在 N 次运行、重试策略和基线冻结上。
4. **P1 之前必须补三件契约**：引用完整性、关联写入方、context 不计入支持。
5. **P2 之前必须补 Pack 生命周期**：创建时机、失败降级、保留/清理。
6. **P3 之前必须补反例执行规则**：失败执行是否升级为冲突证据。
7. **P4 的状态枚举必须先对齐**，不要一边实现一边改。
8. **P7 的 UI 验证必须先选工具**，否则「真机验证」无法执行。

在这些修订完成前，不建议启动 P1～P7 中任何大规模编码。
