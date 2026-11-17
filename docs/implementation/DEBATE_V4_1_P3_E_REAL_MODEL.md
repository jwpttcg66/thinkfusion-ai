# P3-E：Pack Judge 真实模型回归

- 分支 / 工作树：`p3-judge-pack` / `/Users/yalla/data/localLab/thinkfusion-ai-p3-judge`
- 基线：`0be553a`（P3 最小链路）
- 数据集：`pack-judge-regression-v1.json`，12 题，SHA-256 `3d8913f6…`
- 真实调用：12 题 × 3 次 = 36 次；**没有用模拟 JSON 代替**
- 当前模型池：仅 `deepseek-v4.1-flash`（设置里只选了一个模型；不能宣称多模型）

---

## 1. 数据集

`docs/implementation/regression/pack-judge-regression-v1.json`

| 类别 | 题数 | 内容 |
| --- | ---: | --- |
| A 代码存在 ≠ 行为证明 | 3 | 未调用、缓存写入≠命中、catch≠所有异常 |
| B 支持 | 2 | 条件分支、参数校验 |
| C 反驳 | 2 | 相反分支、上限检查 |
| D 证据不足 | 2 | 只有调用点、静态代码≠运行时 |
| E 恶意/非法 | 3 | 干扰证据、非法 relation、合法 ID 但不相关 |

每题包含 claim、冻结源码片段、Pack ID、行号、期望方向、禁止方向、限制关键词、fixture SHA-256；数据集 SHA 在脚本启动时校验。

---

## 2. 三轮真实结果

| 指标 | 轮 1 | 轮 2（方向 prompt） | 轮 3（未覆盖≠反例） |
| --- | ---: | ---: | ---: |
| 真实调用 | 36 | 37（一次 JSON 重试） | 36 |
| 模型成功 | 100% | 100% | 100% |
| 一次 JSON 解析 | 100% | 97.2% | 100% |
| 回退规则版 | 0% | 0% | 0% |
| 非法 ID 接受 | 0 | 0 | 0 |
| 禁止方向接受 | **2** | 0 | 0 |
| 来源快照错配 | 0 | 0 | 0 |
| context 准确率 | 75% | 83.3% | **87.5%** |
| supports 准确率 | 100% | 100% | 100% |
| contradicts 准确率 | 83.3% | 100% | 100% |
| 三次方向一致率 | 75% | 75% | **83.3%** |
| 限制关键词命中 | 86.1% | 97.2% | 94.4% |

报告（不覆盖）：

- `pack-judge-regression-2026-11-17T05-41-56-377Z.json`
- `pack-judge-regression-2026-11-17T05-51-58-729Z.json`
- `pack-judge-regression-2026-11-17T06-04-31-256Z.json`
- 各自 `.md` 与 `.sha256`
- 对比：`pack-judge-regression-v1-vs-v1.md`、`pack-judge-regression-v1-prompt-fix-2.md`

每次运行保留原始模型响应、解析结果、accepted/rejected、sourceSnapshot、耗时与用量。

---

## 3. 硬门槛

以第 3 轮为准：

| 门槛 | 结果 |
| --- | --- |
| 非法 evidenceId 接受 | 0 ✅ |
| 非法 relation 接受 | 0 ✅ |
| sourceSnapshot 错配 | 0 ✅ |
| 编造路径/行号 | 0 ✅ |
| 模型失败伪装成功 | 0 ✅ |
| 禁止方向接受 | 0 ✅ |

安全契约通过；**方向行为仍不完整**。

---

## 4. 仍失败的题

### E10-distractor-evidence

期望 `context`；第 3 轮 run-3 没有给出任何 accepted 判断，`primary=None`，也没有 rejected。

模型没有引用无关证据（安全性通过），但也没有对允许证据给出判断。这说明“存在干扰证据时，模型可能干脆不回答”，需要 P3-F 决定是否把“无 accepted”计为不完整，并调整 prompt。

### E12-valid-id-irrelevant

期望 `context`；三次中两次判 `contradicts`，理由是片段只有 `// TODO: implement retry` 与 `return;`，直接说明没有三次重试。

这不是校验器错误：`evidenceId` 合法、来源一致、relation 合法。它是**语义判断分歧**：

- 数据集预期：静态片段不能证明/不能否定运行行为，因此 `context`；
- 模型判断：片段直接展示未实现，因此 `contradicts`。

两种读法都能自洽。**不能为了让模型通过而修改数据集答案**；这需要 P3-F 人工裁决“未实现代码是否构成对行为主张的反驳”。

---

## 5. 结论

- P3-E 的安全与来源契约通过：36 次真实调用，非法引用/来源错配/禁止方向接受均为 0。
- supports 与 contradicts 方向准确率 100%；context 87.5%。
- 三次一致率 83.3%，说明单次判断仍不能当稳定结论。
- 当前只验证了一个模型；不能宣称多模型真实回归通过。
- **P3 不能标记完成**；进入 P3-F：处理 E10/E12 的语义分歧，决定 prompt 或数据集裁决，再跑同一数据集。

---

## 6. 复现

```bash
cd desktop-agent-macos
npm run build:test
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  ./node_modules/.bin/electron scripts/regression/run-pack-judge-regression.cjs --no-sandbox
```

比较两次结果：

```bash
node scripts/regression/compare-pack-judge.cjs \
  <baseline.json> <current.json> --out=xxx.md
```

脚本只读数据集与模型设置，不写 P0 基线、不创建 Claim 关联、不修改数据集答案。
