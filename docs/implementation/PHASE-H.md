# Phase H 实施记录：Judge 独立裁决

对应项目书 8.7、第十五章 Phase H。日期 2026-11-04。

## 新增

| 文件 | 内容 |
| --- | --- |
| `src/main/judge/types.ts` | `JudgeVerdict` / 证据评估 / 论证质量 / 少数派 / 未解决问题 / 置信度 |
| `src/main/judge/engine.ts` | `JudgeEngine`：规则版 + 可选独立模型版，失败退回规则版 |
| `src/main/judge/store.ts` | 每场裁决一个独立文件 |
| `src/main/index.ts` | `judge:adjudicate` / `judge:get` |
| `scripts/check-judge.mjs` | 14 条测试 |

## 红线做成结构，不写成注释

- `supportCount` 只**描述**「多少人这么说」，永远不自动变成 `conclusion`。
  测试专门钉了「3 票对 1 票也照样无法确定」。
- `undetermined` 是正当结果：分歧未消解或证据不足时 `conclusion: null`，
  并写清为什么，不挑一个顺眼的说法当结论。
- 少数派原样进 `minorities`，连带说明为什么留着，不为达成共识删掉。
- `sourceMessageIds` 覆盖辩论里的每一条原始发言，裁决可逐条回溯。
- 规则版 `confidence.level` 永远是 `low`，理由写明「只评估文本线索，不验证
  外部事实」。本地规则没有资格给高置信度。

## 规则版怎么判

证据分只看**文本里有没有可核查的线索**：具体数字/单位（+0.3）、出处或数据
（+0.3）、成立条件（+0.2）、推理连接词（+0.2）、绝对化措辞（−0.1）。
论证质量看是否回应过质疑、有没有推理、有没有写条件。

只有「单一立场 + 平均证据分 ≥0.5 + 没有未解决问题」才给结论。注意判据里
没有 `supportCount`。

## 独立模型与兼任

`JudgeEngine` 传 `ask` + `judgeAgentId` 就走 model 后端：把完整辩论记录放进
`context`，裁决规则放进 `system`（要求输出 JSON）。解析失败或调用失败时
**退回规则版并写 `fallbackReason`**，不把失败伪装成模型裁决。模型版只覆盖
结论/理由/分歧/未解决问题，证据与少数派仍按原文计算。

决策 5 允许资源不足时兼任，但必须标 `sharedWith`——测试钉住了。**当前接线
用的是规则版**：本机只有一个本地模型、云端无 Key，没有独立于参辩者的模型
可用；让同一个模型既当运动员又当裁判，不如如实标 `backend: 'rules'`。

## 验收对照（项目书 Phase H）

| 要求 | 状态 |
| --- | --- |
| Judge 能读取完整辩论记录 | ✅ `messagesOfVerdict` + context 传全部发言 |
| 不以模型数量作为正确性判断依据 | ✅ 3:1 测试 |
| 可以输出无法确定 | ✅ `undetermined` + null conclusion |
| 可以明确说明分歧原因 | ✅ `disagreement` + `reason` |
| 结果能关联原始回答和证据 | ✅ `sourceMessageIds` / `evidence[].messageId` |
| 独立裁判 | ⚠️ 引擎支持，本机无独立模型 → 规则版并如实标记 |

## 测试

```
npm run test:judge   14 条，全绿
npm test             280 条全绿
npm run typecheck    干净
```

## 没做的

- **真机独立模型裁决**（无独立模型可用）。四个 model 后端的分支都有测试。
- **报告 UI**（Phase J）。
- **Synthesis 接入裁决结果**（Phase I）。
