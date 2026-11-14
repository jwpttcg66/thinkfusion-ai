# 答案完整性复核与修订（P0-3/P0-4）

- 日期：2026-11-14
- 模块：`src/main/debate/completeness.ts`
- 单测：`scripts/check-debate-completeness.mjs`
- 回归开关：`--completeness`

## 1. 为什么要单独做

原来的链路是：

```text
辩论 -> 主裁判 -> 质量报告 -> Final Judge -> V1 评分
```

V1 能发现“缺 must”，但不会把缺口反馈给答案。结果是：知道不合格，却停在
“不合格”。

现在增加两个独立阶段：

```text
辩论 -> 主裁判 -> 完整性复核 -> 有限修订 -> 独立 Judge 再判 -> V1 评分
```

## 2. 两个角色分开

### Completeness Reviewer

只看：

- 题目；
- 候选答案。

检查是否遗漏：

- 关键定义；
- 成立条件；
- 适用边界；
- 例外；
- 失败模式；
- 实施约束。

它**不拿 24 题标准答案**，也不宣布“通过”。输出结构化缺口：

```json
{
  "hasGap": true,
  "missing": [
    {"dimension": "boundary", "text": "缺什么", "why": "为什么重要"}
  ],
  "reason": "总体说明"
}
```

### Reviser

只接收：

- 题目；
- 原答案；
- Reviewer 指出的缺口。

要求保留原结论和证据，只补缺口；无法补充的写进 `stillMissing`。
它不能自己宣布通过。

## 3. 修订后必须重新判

修订完成后：

1. 用修订后的答案重新跑 `standard-rubric`；
2. 再用独立 `JudgeEngine` 对修订答案判一次，记录 `revisionJudge`；
3. 两者都通过，才把修订计入 V1 结果。

`revisionJudge` 不是让修订模型自评，而是主裁判模型对修订后的内容再判一次。

## 4. 防泄漏约束

- Reviewer 和 Reviser 的 prompt 不包含 `debate-standard-answers-v1.json`；
- 只给题目、答案和缺口描述；
- 不把 24 题标准答案塞进辩论或修订提示词；
- 最多一次修订，避免无限循环和成本失控；
- 增量 fingerprint 包含 `completeness` 开关：开/关变化会让旧结果失效，必须重跑。

## 5. 单测

`npm run test:debate-completeness`：7/7 通过。

覆盖：

- 有缺口时返回结构化缺口；
- 无缺口时 `hasGap=false`；
- 复核解析失败重试一次；
- 两次失败标 `unavailable`，不伪造缺口；
- 修订返回修订答案和已补充项；
- 无缺口时不调用修订模型；
- 修订失败时原答案不被覆盖。

## 6. 真实冒烟

用 `--completeness --workers=1 --only=mq-delivery` 跑了一题：

- Reviewer 找到 5 个缺口：
  - 不丢消息的目标边界；
  - 生产端具体丢失点；
  - 存储端具体丢失点；
  - 消费端具体丢失点；
  - 实施约束和成本。
- Reviser 补充了这些内容；
- 独立 Judge 再判：`backend=model`，`undetermined=false`；
- V1 评分：**100 分通过**。

同一轮 `http-methods` 的 Reviewer 认为没有明显缺口，原答案直接 V1 通过。

## 7. 限制

- 只做了单题冒烟，没有重新跑完整 24 题；
- Reviewer/Reviser 仍是 `model-assessed`，不是外部事实核验；
- 最多一次修订；
- `revisionJudge` 使用主裁判模型，但输入是修订后的答案，不是原辩论全文；
- 不能把“修订后 V1 通过”写成“事实正确”。

## 8. 下一步

1. 对严格口径下仍失败的 8 题跑 `--completeness`；
2. 检查修订是否引入新错误；
3. 通过后再跑完整 24 题，确认没有回退。
