# P3-F.2：Claim 级执行证据契约

- 分支 / 工作树：`p3f2-runtime` / `/Users/yalla/data/localLab/thinkfusion-ai-p3f2`
- 基线：`main` = `4fee0d4`
- 目标：Runtime Claim 只接受与 Claim 直接关联的执行断言；普通命令成功不算

---

## 1. 执行证据结构

`DebateEvidence.execution`：

```ts
{
  kind: 'test-result' | 'command-result';
  exitCode?: number;
  /** 与 Claim 直接关联的行为断言结果 */
  assertion?: 'passed' | 'failed';
  /** 这条执行结果验证了哪些 Claim */
  verifiesClaimIds?: string[];
  /** 测试/断言名称或位置，供追溯 */
  reference?: string;
}
```

规则：

- `exitCode=0` 只是命令成功，不证明 Claim；
- `assertion=passed` + `verifiesClaimIds` 包含当前 claimId → 可支持 `supports`；
- `assertion=failed` + 包含当前 claimId → 可支持 `contradicts`；
- 没有 assertion、没有 verifiesClaimIds、或验证的是别的 Claim → Runtime 判断只能是 `context`；
- Pack 条目的 `meta.assertion / meta.verifiesClaimIds / meta.reference` 映射到 `DebateEvidence.execution`。

---

## 2. Judge 规则

```
scope=missing → 只允许 context
scope=code    → 完整方法/分支结构可 supports/contradicts
scope=runtime → 必须 execution.verifiesClaim 且方向匹配：
                  supports    ← assertion=passed
                  contradicts ← assertion=failed
                  否则 context / 拒绝
```

`scope` 仍由 Claim 创建方提供，裁判不得推断。

---

## 3. 数据集修订

v1.3：保留 v1.2；E11 拆成 CODE/RUNTIME；F03/F04 Claim 改为同一结构问题；新增 Runtime 执行证据：

| 案例 | 执行证据 | 预期 |
| --- | --- | --- |
| R01-runtime-unrelated-test | passed，但 verifiesClaimIds 指向别的 Claim | context |
| R02-runtime-linked-pass | passed，verifiesClaimIds 包含当前 Claim | supports |
| R03-runtime-linked-fail | failed，verifiesClaimIds 包含当前 Claim | contradicts |

v1.4：修正 F03/F04 的 question 仍带“重试”造成的误导，Claim 不变。

原始 v1.2 / v1.3 数据集与报告不覆盖。

---

## 4. 验收

硬门槛：

- 非法 ID / 来源错配 / 禁止方向 / 无效 Runtime 执行证据接受：0；
- 缺失 scope 的非 context 接受：0；
- E11 / F03 / F04 / R01–R03 方向准确率单独统计；
- 无判断单独统计，不算正确；
- 只有 `deepseek-v4.1-flash`，不能宣称多模型通过。

本轮仍不启动 P3-G。
