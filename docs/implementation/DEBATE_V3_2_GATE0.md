# Gate 0 实施记录（0.2.8）

- 分支：`0.2.8`（从 `main` `dbeca16` 切出）
- 工作树：`/Users/yalla/data/localLab/thinkfusion-ai-0.2.8`（与仓库既有「一版本一 worktree」惯例一致）
- 本轮范围：Gate 0A / 0B / 0D 已落地，**0C 因云端额度 429 暂缓（DEFERRED）**
- 结论口径：只写跑过的东西。没跑、没实现、没真机验证的，一律标 SPECIFIED / NOT STARTED / DEFERRED

---

## 1. 为什么先做这四项

上一轮审核已经把话说清：

- 0A 不是「补测试」，是「**实现 + 测试**」——候选失败后的重选在代码里根本不存在；
- 0B 不是「把质量引擎接进来」，质量引擎早就接好了；真实问题是**三个入口、两套规则**；
- 0C 的 18/24 是 11-15 00:37 那次的历史成绩，P3 修复（`6ba5fa0`）之后没在当前 main 上跑过全量；
- 0D 要把「测试通过」和「生产可用」分开记。

所以这一轮先补「可执行的前提」，再谈 Evidence Pack。

---

## 2. Gate 0A：裁判失败后的重选（实现）

新增 `src/main/judge/adjudicate.ts`。语义按顺序写死：

| 情形 | 行为 |
| --- | --- |
| 没有任何可用候选 | 规则版；**不写** `judgeReselection`——「没得换」不是「换过没换成」 |
| 首选裁判调用失败 / 两次输出都不是 JSON | 记一次 attempt → 把它排除出候选池 → 重新选人（重算全部身份字段） |
| 重选到参辩成员 | `judgeMode: participant-review`、`judgeIndependent: false`、带 `sharedWith` |
| 重选到独立成员 | `judgeMode: independent-judge`、`judgeIndependent: true`，模型/Provider 一并换成新人的 |
| 候选全部试过仍失败 | 规则版 + `judgeReselection.exhausted: true`，`fallbackReason` 逐条列出谁为什么失败 |

关键实现约束：

1. **失败的候选出池**。`excluded` 集合在每轮重选前过滤候选，否则会「失败 → 又选中它 → 再失败」。
2. **七个字段一起重算**：`judgeAgentId / judgeModelId / judgeProviderId / judgeMode / judgeIndependent / modelIndependence / sharedWith`。做法是每次重选都按新的 `resolution` 新建一次引擎，而不是复用上一次的选项。
3. **两种终态分开记**：`participant-review` 与 `rules-fallback` 是不同的 `judgeMode`，`exhausted` 只在候选真的用完时为 true。
4. 默认最多换 2 个人（`maxReselections`），再多就是在赌小概率，不如如实退回规则版。

新增记录字段（`src/main/judge/types.ts`）：

```ts
judgeReselection?: {
  attempts: { agentId; judgeModelId?; judgeMode; reason }[];
  excludedAgentIds: string[];
  exhausted: boolean;
  finalJudgeAgentId: string | null;
};
```

老裁决文件没有这个字段，读出来是 `undefined`，不补空对象。

---

## 3. Gate 0B：公共裁决核（`adjudicateDebate`）

`src/main/judge/adjudicate.ts` 只做**机制**：

```
候选 → resolveJudge → JudgeEngine → 失败？→ 出池重选
                         ↓ 成功
              evaluateDebateQuality → finalizeDebate → 返回
```

它**不定义**评价标准：`judgeDebate` 仍持有三维判定，`evaluateDebateQuality` 仍持有质量维度，一行都没搬。

### 3.1 三个入口收成一个

| 入口 | 之前 | 现在 |
| --- | --- | --- |
| IPC `judge:adjudicate` | `index.ts` 内联 37 行：自己选人、自己 new 引擎、自己存 | `handleJudgeAdjudicate` → `adjudicateDebate` |
| 24 题回归 | 脚本自己 `new JudgeEngine`（两处），裁判由脚本按轮换直接指定，**不走 `resolveJudge`** | 同一函数，裁判用 `preferredJudgeId` 表达 |
| 每场辩论结束 | `orchestrator.conclude()` 跑 `judgeDebate` 三维规则 | 不变（见 3.3） |

`handleJudgeAdjudicate` 单独成文件（`src/main/judge/handler.ts`）是为了能在 Node 里测
「IPC 层」的整条链：入参仍按 IPC 的样子给 `unknown`，校验 → 选人 → 裁决 → 落盘 →
会话广播一步不跳。`index.ts` 只留 handle 与可信发送方检查。

### 3.2 权威 rules 结论（0B 的契约交付物）

结论：**`debate/judges.ts` 的三维逐条判定是唯一权威**。理由不是「更准」，而是：

- 它一条条指着原文和证据，可以复核；文本线索打分（`engine.ts` 的 `ruleVerdict`）只能给整场一句判断；
- 质量门槛 `verdict.recomputable`（`debate/quality.ts:79`）就是按它建的；权威换人会让这条门槛失去意义。

所以：规则版裁决现在会带

```ts
rulesConclusion: {
  authority: 'debate.claim-judgments',
  debateVerdict: 'supported' | ... ,
  agrees: boolean | null   // null = 权威侧没给结论，不可比
}
```

**没有改结论措辞的来源**。这一点是刻意的：退回规则版时用哪句话当结论属于语义变更，
会直接改变 24 题的答案，不该混在「抽公共核」这一步里做——否则 0C 的基线会被这次
改动污染，分不清是退化还是改口径。这条留到 Gate 3 单独决策。

### 3.3 刻意不动 `judgeDebate`

抽核时只要动一次三维判定，`verdict.recomputable` 会让**全部历史辩论**这条门槛由
pass 翻 fail，24 题里已过的题会变成 `needs_revision`。本轮规则实现零改动，只抽编排。

---

## 4. Gate 0C：当前 main 的 24 题全量回归

### 4.1 规程（写死，不靠人记）

1. **禁 `--incremental`**。`incremental.cjs` 的指纹只含手写常量 `RUNNER_VERSION` 与
   `PROMPT_VERSION`，**不含代码 SHA**；不改版本就带增量，会把旧结果原样复用成「本次结果」，
   报告看起来还是新生成的。
2. `RUNNER_VERSION` 从 `2.0.0` 提到 **`2.1.0`**（裁决入口变了）。即使有人误带增量，
   指纹也已全失效——第二道锁。
3. 报告新增 `runner: { version, promptVersion, commit, adjudication, rulesAuthority }`，
   让报告能自证「这是哪份代码跑出来的」。历史报告没有这个字段，本轮起才有。
4. 口径必须与 18/24 一致才能逐题比：`--completeness --workers=3`、同一数据集、同一模型池。
5. 连接失败的题单独记，**不并入主结果**，不用单题重跑去改写通过率。

### 4.2 对比工具

新增 `scripts/regression/compare-results.cjs`：机械产出「新增通过 / 退化 / 不变」，
并在数据集 sha256、completeness 开关、模型池任一不同时**拒绝给出差异结论**
（打印「口径不同，不作逐题差异」），不硬比。

### 4.3 结果：**DEFERRED（未执行，不得当作已完成）**

2026-11-15 首跑在 `0.2.8` 上启动过，24 题**全部失败于 429**：

```
云端限流（429）：{"type":"GoUsageLimitError","message":"OpenCode Go usage limit
reached (weekly, resets in 20h 5m)..."}
```

三个云端模型（`deepseek-v4.1-flash` / `gpt-6-luna` / `claude-haiku-5-5`）同属一个
OpenCode Go 周额度池，池子空了就一个都问不出来。这不是代码问题，也不构成任何回归结论。

**那份报告已删除，没有留在仓库里。** 它结构完整、时间戳新鲜，24 条 `FAILED` 会被
后来的人读成「0.2.8 把 24 题全跑挂了」——比没有报告更危险。

用户裁决：**等 CLI 输入源做好再继续跑。**

恢复执行时按这套命令，别改口径：

```bash
cd /Users/yalla/data/localLab/thinkfusion-ai-0.2.8/desktop-agent-macos
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  ./node_modules/.bin/electron scripts/regression/run-debate-regression.cjs \
  --no-sandbox --disable-gpu --workers=3 --completeness --suffix=gate0
```

跑之前先确认两件事：`RUNNER_VERSION` 已是 `2.1.0`（增量指纹已失效）、命令里**没有**
`--incremental`。跑完用 `compare-results.cjs` 对历史 18/24 出逐题差异，再把结果填回本节。

---

## 5. Gate 0D：全量测试与类型检查

`npm run typecheck`（主进程 / 渲染层 / 测试三套）全绿；`npm test` 全量 **1217 / 1217**，
`not ok` 0 条（日志 `/tmp/tf-028-test.log`）。

新增 `test:judge-adjudicate` 已并入 `test:judge` 与 `test:p0-gaps`，12 条：

- 没有候选 → 规则版，且不写 `judgeReselection`（「没得换」≠「换过没换成」）
- 首选调用失败 → 换下一个独立候选，七个身份字段按新人重算
- 候选全部失败 → 每人只试一次，退回规则版并逐条写明原因
- 换到的人本身参辩 → `participant-review` + `sharedWith`，**不复用旧的 `judgeIndependent`**
- 两次输出都不是 JSON → 也换人，不是直接退回规则版
- 全部候选都不可解析 → 换完退回规则版，保留每次失败原因
- 规则版记权威口径；权威侧没给结论时是「不可比」，不是「一致」
- IPC 四条：非字符串入参拒绝且不落盘 / 找不到辩论不落空裁决 / 落盘并广播同一份对象 / 降级也落盘

**这不等于生产可用**：handler 层测的是函数，不是真机上点「裁决」按钮那条路。界面侧仍待
一次带 UI 的验证。

---

## 6. 状态表（六个状态分开标，不用一个 completed 盖住）

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| Judge 失败重选 | IMPLEMENTED + TESTED | `adjudicate.ts`；`check-judge-adjudicate.mjs` 12 条 |
| Judge 降级 IPC 链 | IMPLEMENTED + TESTED（handler 层） | `handler.ts`；未真机点按钮验证 |
| 公共裁决核 | IMPLEMENTED + INTEGRATED | IPC 与 24 题回归共用 |
| 权威 rules 结论 | SPECIFIED + IMPLEMENTED（只记录，不改结论来源） | `rulesConclusion.authority` |
| 24 题当前 main 回归 | **DEFERRED**（未执行） | 云端周额度 429，见 §4.3；报告已删，等 CLI 输入源就绪后重跑 |
| Evidence Pack | SPECIFIED | 本轮未动 |
| 工程辩论闭环 | NOT STARTED | 本轮未动 |
| 外部事实核验 | NOT STARTED | 本轮未动 |

「TESTED」只说明对应的测试跑过并通过，不等于生产可用；「handler 层」也明确写了不是
真机点按钮——那需要另开一次带界面的验证。

---

## 7. 本轮没做的事（避免被读成已完成）

- **Gate 0C 没跑成**：24 题因为云端周额度 429 全失败，一份结果都没有。这是本轮唯一
  未交付的 Gate 0 项，也是「Gate 0 未通过、不得进入 Evidence Pack」的直接原因；
- 没有新增 Evidence Pack / EvidencePackItem / ClaimEvidenceLink / FactVerification 的任何类型；
- 没有给 `DebateState` 加 `schemaVersion`，也没有改两个 store 的解析失败返回 null 的行为；
- 没有改 `judgeDebate` 的判定，也没有改退回规则版时的结论措辞；
- 没有把 18/24 改写、没有把 `model-assessed` 写成 `fact-verified`。
