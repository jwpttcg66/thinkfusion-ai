# P3-F.2 结果：Runtime 执行证据与语义修订

- 分支 / 工作树：`p3f2-runtime` / `/Users/yalla/data/localLab/thinkfusion-ai-p3f2`
- 基线：`main` = `4fee0d4`
- 数据集：`pack-judge-regression-v1.4.json`（25 题，SHA-256 `5d7b3778…`）
- 模型：`deepseek-v4.1-flash`（当前唯一配置；不能宣称多模型）
- 结论：**P3-F.2 在当前模型/配置下通过硬门槛与方向准确率；P3 仍未完成（UI、真实执行证据生产者、P4）**

---

## 1. 本轮修正

### 1.1 E11 拆分

| 案例 | scope | Claim | 预期 |
| --- | --- | --- | --- |
| E11-CODE | code | 代码调用 `logger.info()` 记录日志 | supports |
| E11-RUNTIME | runtime | 运行时日志会写入目标日志系统 | context（只有静态代码） |

原 E11 保留在 v1.2，不修改历史报告。

### 1.2 F03/F04 结构级 Claim

两例使用同一问题：

> `run()` 的完整代码是否包含一个最多迭代三次并调用 `attempt()` 的循环？

| 案例 | Evidence | 预期 |
| --- | --- | --- |
| F03 | 完整循环三次调用 | supports |
| F04 | 完整方法只调用一次 | contradicts |

v1.3 的 question 仍带“重试”，模型被词义带偏；v1.4 只修 question/关键词，不改 Claim 与证据。

### 1.3 Runtime 执行证据

`DebateEvidence.execution` 扩展：

```ts
{
  kind: 'test-result' | 'command-result';
  exitCode?: number;
  assertion?: 'passed' | 'failed';
  verifiesClaimIds?: string[];
  reference?: string;
}
```

判定规则：

- `exitCode=0` 本身不算 Runtime 证据；
- `assertion=passed` 且 `verifiesClaimIds` 包含当前 claimId → supports；
- `assertion=failed` 且包含当前 claimId → contradicts；
- 未关联当前 Claim、无 assertion、或验证别的 Claim → context / 拒绝；
- Pack 条目 `meta.assertion / verifiesClaimIds / reference` 映射到证据。

新增数据集案例：

| 案例 | 执行证据 | 预期 |
| --- | --- | --- |
| R01-runtime-unrelated-test | passed，但验证别的 Claim | context |
| R02-runtime-linked-pass | passed，验证当前 Claim | supports |
| R03-runtime-linked-fail | failed，验证当前 Claim | contradicts |

---

## 2. 真实回归

### 2.1 第一轮（v1.3）

75 次调用，硬门槛未过：

- 禁止方向接受：1（F03 被“重试”词义带偏）
- context 100%、supports 88.9%、contradicts 93.3%、一致率 92%

### 2.2 第二轮（v1.4）

| 指标 | 结果 |
| --- | ---: |
| 真实调用 | 75 |
| 模型成功 | 100% |
| 无判断 | 0 |
| ID 规范化 | 0 |
| 缺失 scope | 0 |
| 非法 ID 接受 | 0 |
| 禁止方向接受 | 0 |
| 来源错配 | 0 |
| 回退规则版 | 0% |
| context 准确率 | 100% |
| supports 准确率 | 100% |
| contradicts 准确率 | 100% |
| scope 准确率 | code 100% / runtime 100% |
| 三次一致率 | 100% |
| 限制关键词命中 | 90.7% |
| 平均耗时 | 16.4s |

分组：原 base 51 次、F 组 24 次，全部 100%。

报告：

- `pack-judge-regression-p3f2-2026-11-17T09-20-41-843Z.*`（v1.3，未过）
- `pack-judge-regression-p3f2-2026-11-17T09-41-10-430Z.*`（v1.4，通过）
- `pack-judge-regression-p3f2-v14-summary.md`
- `pack-judge-regression-p3f2-v13-vs-v14.md`

---

## 3. 验收对照

| 门槛 | 结果 |
| --- | --- |
| 非法 ID 接受 | 0 ✅ |
| 来源错配 | 0 ✅ |
| 禁止方向接受 | 0 ✅ |
| 无效 Runtime 执行证据被接受 | 0 ✅（R01 为 context） |
| 缺失 scope 的非 context | 0 ✅ |
| E11 方向准确率 | 100% ✅ |
| F03/F04 方向准确率 | 100% ✅ |
| 无判断 | 0（单独统计） ✅ |
| 模型回退 | 0 ✅ |

---

## 4. 边界与未完成

1. **只验证了 `deepseek-v4.1-flash`**；配置里仍只有这一个模型。
2. **R01–R03 是 fixture 级执行证据**；真实辩论链还没有“执行结果 → verifiesClaimIds”的生产者。P3 的 Runtime 契约已验证，但工程执行证据生产仍未接。
3. **P3-G UI 未开始**；裁判依据尚未展示。
4. 不能标记 P3 完成；下一步是 P3-G（UI）或执行证据生产者，二者都应基于这份已冻结的契约。

---

## 5. 全量测试说明

P3 相关套件通过：

```text
test:judge-pack-evidence      15/15
test:evidence-pack            9/9
test:repository-pack          15/15
test:round-evidence-pack      5/5
test:claim-evidence-links     12/12
```

`npm test` 当前在 `check-cli-agent` 的“注册表：两个默认 CLI”失败（`headless` 期望 verified，实际 unverified）。该失败在 `main` 工作树复现，与本轮 P3-F.2 改动无关，是 CLI 能力版本/指纹漂移；没有为此修改测试或掩盖。

## 6. 复现

```bash
cd desktop-agent-macos
npm run build:test
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  ./node_modules/.bin/electron scripts/regression/run-pack-judge-regression.cjs \
  --no-sandbox --dataset=../docs/implementation/regression/pack-judge-regression-v1.4.json
```
