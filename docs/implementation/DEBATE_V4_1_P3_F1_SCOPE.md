# P3-F.1：claimScope 与 evidenceId 规范化结果

- 分支 / 工作树：`p3f1-scope` / `/Users/yalla/data/localLab/thinkfusion-ai-p3f1`
- 基线：`main` = `c2c1318`（实际最新；不是 234923c）
- 数据集：`pack-judge-regression-v1.2.json`（21 题，SHA-256 `b3fd40b0…`）
- 模型：`deepseek-v4.1-flash`（当前唯一配置）
- 结论：**硬门槛仍未通过；不合并 main，不启动 P3-G。**

---

## 1. 三项裁决的实现

### 1.1 claimScope

`DebateClaim` 新增可选：

```ts
claimScope?: 'code' | 'runtime';
```

- Claim 创建方提供；裁判不得自行推断；
- 缺失 scope：只允许 `context`，非 context 判断直接 rejected；
- scope=code：完整方法/分支结构可以 supports/contradicts；
- scope=runtime：只有静态代码时只能 context，`supports/contradicts` 必须有成功执行结果；
- 旧记录没有 scope，按保守策略处理，不迁移、不回填。

### 1.2 E10 拆分

原始 E10 保留在 v1.1 和原报告中，**没有修改**。v1.2 将 E10 拆成：

| 案例 | scope | Claim | 期望 |
| --- | --- | --- | --- |
| E10-CODE | code | 该方法实现了三次重试循环 | supports |
| E10-RUNTIME | runtime | 系统运行时会执行三次重试 | context |

两例使用同一 fixture，但 Claim 范围不同。

### 1.3 evidenceId 规范化

只允许一种规则：

```text
模型输出缺少固定前缀 pack:
  → 补成 pack:<raw>
  → 必须在本次 allowed 集合中唯一精确命中
```

- 精确匹配优先；
- 不允许截断、模糊、编辑距离、猜测 packId；
- 规范化后仍走全部来源/唯一性校验；
- 每条 accepted 记录 `rawEvidenceId / canonicalEvidenceId / normalized / normalizationRule`；
- 无法唯一匹配直接 rejected。

### 1.4 Prompt

新增：

- `scope` 由 Claim 创建方提供，不是模型猜；
- runtime + 静态片段只能是 context；
- 代码结构 Claim 可直接由完整结构支持；
- evidenceId 必须逐字复制，含 `pack:` 前缀；
- 对每条提供的证据必须给出判断，不足用 context。

---

## 2. 两轮真实结果（21 题 × 3 次）

| 指标 | 第一轮 | 第二轮（精确 ID/结构规则） |
| --- | ---: | ---: |
| 真实调用 | 63 | 63 |
| 模型成功 | 100% | 100% |
| 无判断 | 6 | **0** |
| ID 规范化次数 | 1 | 0 |
| 非法 ID 接受 | 0 | 0 |
| 来源错配 | 0 | 0 |
| 禁止方向接受 | 0 | **1** |
| context 准确率 | 87.2% | 97.4% |
| supports | 91.7% | 83.3% |
| contradicts | 91.7% | 91.7% |
| scope 准确率 | code/runtime 88.9% | code 88.9% / runtime 100% |
| 一致率 | 66.7% | 85.7% |

第二轮原 12 题（含 E10 拆分后 base 组）：context 95.8%、supports 100%、contradicts 100%、一致率 92.3%。
F 组：context 100%、supports 33.3%、contradicts 83.3%、一致率 75%。

报告：

- `pack-judge-regression-p3f1-2026-11-17T07-42-15-864Z.*`
- `pack-judge-regression-p3f1-2026-11-17T08-03-49-580Z.*`
- `pack-judge-regression-p3f1-summary.md`
- `pack-judge-regression-p3f1-fix.md`

---

## 3. 为什么仍未通过

### 3.1 E11 的数据集预期与 code scope 冲突

E11 Claim：`这段代码会记录日志`，scope=code；证据直接包含 `logger.info(...)`。
数据集预期 `context`，但模型判 `supports`。在 code scope 下，这是**直接结构实现**，`supports` 并不违背 P3-F 的规则。

第二轮唯一的禁止方向接受来自这里。不能靠 Prompt 把合理判断压回 context；需要把 E11 也按 code/runtime 或“日志调用 vs 实际输出”拆分。

### 3.2 F03/F04 的“重试”语义仍有歧义

- F03 Claim：`该方法实现了三次重试循环`；证据是无条件 `for` 三次 `attempt()`。
- F04 Claim：`该方法会重试三次`；证据是只调用一次。

模型仍把“重试”理解为必须包含失败判断/异常分支，而不是“固定三次循环”。这是 Claim 措辞问题，不是 scope 问题。
需要把 Claim 改成“代码包含三次 attempt 调用循环”或“失败后重试三次”，不能靠模型猜“重试”的含义。

### 3.3 规范化机制本身通过

第二轮 0 次无判断、0 次规范化，说明 Prompt 已要求逐字 ID；第一轮的 1 次规范化也正确记录了 raw/canonical。规范化没有绕过来源校验。

---

## 4. 当前状态

| 能力 | 状态 |
| --- | --- |
| claimScope 输入与保守拒绝 | IMPLEMENTED + TESTED（11 条裁判测试） |
| E10 code/runtime 拆分 | DONE（v1.2，原数据不改） |
| evidenceId 精确/前缀规范化 | IMPLEMENTED + TESTED |
| 真实模型回归 | 硬门槛仍有 1 次，未通过 |
| P3-G UI | NOT STARTED |

P3-F.1 的结论是：结构性契约已经补上，但**数据集里还有至少两个含糊 Claim（E11、F03/F04 的“重试”）**。继续调 Prompt 不会让相互冲突的预期同时成立。

下一步应先做数据集语义修订（E11 拆分、F03/F04 措辞明确），再重跑；不能直接改 Prompt 迁就模型。
