# P3-F：裁判语义边界

- 分支 / 工作树：`p3f-semantics` / `/Users/yalla/data/localLab/thinkfusion-ai-p3f`
- 基线：`main` = `234923c`
- 目标：先定规则，再让 Prompt 实现规则，最后用真实模型验证
- 不改：P3-E 数据集与三轮报告；P0 基线

---

## 1. 方向判断规则

| 证据情况 | 允许方向 | 理由 |
| --- | --- | --- |
| 代码明确实现 Claim 描述的行为，且 Claim 范围不超过证据范围 | `supports` | 有直接实现依据 |
| 代码明确实现与 Claim 相反的行为，且 Claim 范围不超过证据范围 | `contradicts` | 有直接反向实现依据 |
| 片段没有展示相关实现 | `context` | 覆盖不足 |
| 只有 TODO / 注释 / 设计意图 | `context` | 不是实际运行行为 |
| 代码片段不完整，无法确认调用路径 | `context` | 无法证明系统级结论 |
| 完整权威作用域内存在明确反向逻辑 | `contradicts` | 否定性证据覆盖足够 |
| 证据与 Claim 无关 | 拒绝关联或 `context` | 不得强行建立方向 |

核心约束：

> **absence of evidence ≠ evidence of absence**
>
> 片段没有展示某行为，不等于它证明该行为不存在。

`contradicts` 的必要条件：

1. 证据直接展示相反实现，而不是「没看到实现」；
2. Claim 的范围不超过证据覆盖范围；
3. 理由中说明反向证据与覆盖范围。

---

## 2. E12 裁决

- Claim：系统会重试三次
- Evidence：`// TODO: implement retry` + `return;`
- 数据集预期：`context`
- 裁决：**保留 `context`，不修改数据集**

理由：

- TODO 是未完成标记，不是运行行为证据；
- 单个片段不能证明系统其他路径不存在重试；
- 只有当证据是完整、权威的方法/入口，且 Claim 限定在该方法内时，`contradicts` 才成立。

---

## 3. 实现约束

1. Prompt 必须写明 absence ≠ negative、TODO 只能 context、contradicts 需要覆盖范围。
2. 校验器对含 `TODO/FIXME/XXX` 的片段：
   - 关系不是 `context` → 拒绝该判断并写入 `packEvidenceRejected`；
   - 不把模型输出改写成 context，避免伪造判断。
3. Prompt 要求对每条提供的证据给出判断；证据不足用 context，不得省略。
4. 模型自报 confidence 不作为方向正确性的证明。
5. 新数据集保留原 12 题，新增 F01–F08 配对案例；原数据集与报告不覆盖。

---

## 4. P3-F 专项案例

| 案例 | 输入 | 预期 |
| --- | --- | --- |
| F01 | 片段没有重试代码 | context |
| F02 | TODO retry | context |
| F03 | 完整方法实现三次重试 | supports |
| F04 | 完整方法只执行一次，无重试 | 方法级 Claim：contradicts |
| F05 | 只展示调用方，无被调方法 | context |
| F06 | 重试次数设为 5，Claim 说 3 | contradicts |
| F07 | 注释说支持重试，无实现 | context |
| F08 | 其他模块可能实现，当前证据未覆盖 | context |

这些案例验证「证据覆盖范围」而不是记忆答案。

---

## 5. 验收

- 非法 evidenceId / relation / 来源错配 / 禁止方向：0；
- 片段未覆盖被接受为反例：0；
- 无判断单独统计，不伪装为正确；
- 真实调用与模型成功率单独统计；
- 当前只有 `deepseek-v4.1-flash`，不能宣称多模型通过。

P3-F 通过后仍不等于 P3 完成：UI 展示、执行证据、P4 外部核验未做。


---

## 6. P3-F.1 结果

claimScope 与 evidenceId 规范化已实现；v1.2 把 E10 拆成 code/runtime 两例。
真实回归仍未通过：E11 的 code scope 与数据集 context 预期冲突，F03/F04 的“重试”措辞仍含糊。
详见 `DEBATE_V4_1_P3_F1_SCOPE.md`。
