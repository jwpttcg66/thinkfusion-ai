# Gate 3：工程证据评分规则（0.2.8）

- 分支 / 工作树：`0.2.8` / `/Users/yalla/data/localLab/thinkfusion-ai-0.2.8`
- 输入：用户对 Gate 3 两个口径的决策
  - `snapshot` 证据：**快照 + 执行结果才算证据**
  - 独立性：**按 commit 收敛**
- 结论：**评分规则与映射已改并有测试；Pack 的创建/关联/展示仍未接入编排器**

---

## 1. 这一轮改了什么

| 位置 | 改动 |
| --- | --- |
| `src/main/evidence-pack/mapping.ts` | `originKey` 从 `repo:<commit>:<path>` 改为 `repo:<commit>`；`test-result` / `command-result` 映射出 `execution: { kind, exitCode }` |
| `src/main/debate/types.ts` | `DebateEvidence.execution?`：只有工程执行条目才有 |
| `src/main/debate/judges.ts` | 证据维度新增工程规则：只有快照 → `partial`；快照 + `exitCode === 0` 的执行 → `sufficient`；执行失败 → `partial` |
| `src/main/debate/quality.ts` | `evidence.no_support_without_link` 的可核验来源扩展为「页面链接，或快照 + 成功执行」；只有快照仍然拦下 |
| `scripts/check-debate-judge.mjs` | 3 条工程证据维度测试 |
| `scripts/check-debate-quality.mjs` | 2 条质量门测试 |
| `scripts/check-evidence-pack.mjs` | 独立性断言改为按 commit；新增执行结果映射测试 |

---

## 2. 规则写死成什么样

```text
主张关联的证据里：
  - 有页面链接 → 走原来的网页证据规则，不变
  - 只有 snapshot（无执行结果）→ evidence = partial
      理由：代码里确实有这段，但没有测试/命令证明它成立
  - snapshot + test-result/command-result(exitCode === 0) → evidence = sufficient
  - snapshot + 执行失败（exitCode != 0）→ partial
  - 既没有页面链接也没有快照 → unverifiable（原行为）
```

质量门同步：

```text
supported 主张必须有：
  - 至少一条 page-link 证据，或
  - 至少一条 snapshot 且该条 execution.exitCode === 0
```

注意两个边界：

1. **执行条目是否真的对应这条主张，由建立 `ClaimEvidenceLink` 的调用方负责**。
   评分层只看「这条证据被关联到了这条主张，且执行成功」，不会替调用方判断
   「跑的是不是这个测试」。
2. **按 commit 收敛意味着同一份快照只算一个来源**。从同一 commit 取 10 个
   文件，仍然只有一个独立来源；这不是「证据越多越强」的计数器。

---

## 3. 测试

```bash
cd desktop-agent-macos
npm run test:debate-judge     # 30/30
npm run test:debate-quality   # 7/7
npm run test:evidence-pack    # 9/9
npm run typecheck             # 三套 tsconfig 全绿
npm test                      # 101 个文件全过
```

新增用例钉住的事：

- 只有快照 → `partial`，且不会判 `supported`；
- 快照 + 成功执行 → `sufficient`；
- 执行失败 → 仍然 `partial`；
- 质量门对「只有快照的 supported 主张」报越界 1 条；
- 质量门对「快照 + 成功执行」放行；
- 映射只在 `test-result` / `command-result` 上写 `execution`，源码条目不能伪装；
- 同 commit 的 3 条证据只有 1 条 `independent`，另 2 条带 `duplicateOf`。

---

## 4. 仍然没做的事

| 缺口 | 为什么没做 | 影响 |
| --- | --- | --- |
| 编排器创建 Pack | 需要先定「收尾时建还是每轮建」「失败是否阻断辩论」 | 真实辩论还不会生成 Pack |
| 写 `ClaimEvidenceLink` | 需要主张与条目的关联来源（作者/评审/裁判） | 映射层拿不到链接时 `claimIds=[]`，评分不会误用 |
| IPC / UI | 没有查看 Pack 的入口 | 用户看不到冻结快照 |
| code-index `symbolId` 对接 | 需要确认 generation 不一致时的拒绝策略 | `symbolId` 仍由调用方提供 |
| 24 题最终回归 | 本轮只改工程证据分支，网页证据路径未变 | 上线前仍需跑一次全量回归 |

因此，现在可以说「工程证据评分规则已实现并测试」，不能说「工程辩论闭环已完成」。

---

## 5. 状态表

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| 工程证据评分 | IMPLEMENTED + TESTED | `judges.ts`；3 条测试 |
| 工程质量门 | IMPLEMENTED + TESTED | `quality.ts`；2 条测试 |
| 快照独立性（按 commit） | IMPLEMENTED + TESTED | `mapping.ts`；映射测试 |
| Pack 创建入口 | NOT STARTED | 需要定创建时机 |
| Claim 关联写入 | NOT STARTED | 只有类型与映射消费端 |
| 工程辩论闭环 | NOT STARTED | 未接编排器 |
| 外部事实核验 | NOT STARTED | Gate 4 |

---

## 6. 下一步的入口条件

接入编排器前必须先回答：

1. Pack 在什么时机创建：辩论收尾、每轮结束，还是用户显式发起？
2. 创建失败是否阻断辩论，还是记 `degradation` 继续？
3. 谁负责把「哪条主张引用了哪条工程证据」写成 `ClaimEvidenceLink`？
4. `repoRoot` / `commit` 从哪里取，工作区脏时是否允许冻结？

这四个问题不回答就接线，只会把「有 Pack」变成「不知道 Pack 对应哪次代码」。
