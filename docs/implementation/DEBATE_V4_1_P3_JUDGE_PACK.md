# P3：裁判引用 Pack 工程证据

- 分支 / 工作树：`p3-judge-pack` / `/Users/yalla/data/localLab/thinkfusion-ai-p3-judge`
- 基线：`main` = `29b1a3f`（P2-Final 已合并）
- 范围：P3-A 证据输入契约、P3-B 方向判断、P3-C 质量警告、P3-D handler 落盘
- 未做：真实模型 24 题回归、执行证据生产者、P4 外部事实核验

> **P3-E 更新**：已执行 12 题 × 3 次真实模型回归（单一 deepseek 模型）。
> 硬门槛通过，但 context 准确率 87.5%、一致率 83.3%，E10/E12 仍有语义分歧。
> 结果见 `DEBATE_V4_1_P3_E_REAL_MODEL.md`；P3 仍不能标记完成。

---

## 1. 契约：PackEvidenceAssessment

`JudgeVerdict` 新增：

```ts
interface PackEvidenceAssessment {
  claimId: string;
  evidenceId: string;
  relation: 'supports' | 'contradicts' | 'context';
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  limitations: string[];
  sourceSnapshot: { packId: string; commit: string; roundIndex?: number };
}
```

- 只允许引用调用方提供的 `claimId + evidenceId`；
- `relation` 必须由模型显式给出，代码不因「引用了代码」自动升级；
- 编造引用、非法 relation、缺 reason 的项进入 `packEvidenceRejected`，不静默丢弃；
- `sourceSnapshot` 从 Pack id 与辩论的 commit 派生。

## 2. 裁判输入

`JudgeEngine` 从 `state.packEvidenceLinks`（只取 `source: 'pack'`、`relation: 'context'`）
与 `state.packEvidence` 构造可用证据列表：

```text
claim c1 ← pack:<packId>:<itemId> · src/cache.ts · if (!cache.has(key)) ...
```

并明确要求：

- 只能引用列表里的组合；
- 代码存在只能说明实现存在；不能证明行为，relation 必须给 `context`；
- `supports` 需要模型自己的理由，代码不会替它决定。

## 3. 状态与持久化

- `applyJudgePackEvidence(state, verdict)` 写 `state.judgePackEvidenceLinks`；
- `refreshClaimEvidenceLinks(state, 'model-judge')` 把模型判断合并进
  `state.claimEvidenceLinks`；
- 同一对证据方向优先级仍是 `contradicts > supports > context`；
- `handleJudgeAdjudicate` 新增 `saveDebate` 回调；主进程传
  `state => debates.save(state)`，否则模型判断只留在内存；
- 规则裁判路径不会清掉模型已有判断，除非重新收尾时重建且没有新判断。

## 4. 质量警告

`evaluateDebateQuality` 检查：

- 模型把 Pack 证据判成 `supports`，但证据没有成功执行结果；
- 写入 `criticalIssues`：`工程证据被判 supports 但没有成功执行结果`；
- 同时把「工程证据由模型裁判引用；代码存在不等于主张成立」写进事实依据。

这是警告，不是自动否决：模型判断仍然保留，但质量报告不会把它伪装成执行验证。

## 5. 测试

`npm run test:judge-pack-evidence`：**7/7 通过**。

覆盖：

- 合法引用保留 relation 与 sourceSnapshot；
- 编造 evidenceId、非法 relation 被拒绝；
- 没有 Pack 上下文时不注入提示、也不接受编造；
- 规则版不产生 packEvidence；
- `adjudicateDebate` 写状态关联并标 `model-judge`；
- 代码-only supports 进入质量 criticalIssues；
- context 判断不触发该警告；
- IPC handler 通过 `saveDebate` 落盘。

全量：

```text
npm run typecheck  → 三套全绿
npm test           → 本轮最终运行（见交付说明）
```

## 6. 未完成

1. **没有真实模型回归**：本轮的 7 条测试使用模拟裁判 JSON，不能证明真实模型会稳定遵守契约。
2. **没有执行证据生产者**：Pack 只有源码片段，模型若判 supports，质量会警告；真正验证行为仍需测试/命令结果。
3. **没有 P4 外部事实核验**。
4. **没有 UI/IPC 展示 Pack 裁判判断**；状态与 Verdict 已落盘，界面尚未消费。
5. **P3 不能宣称完成**：真实模型行为、执行证据、UI 验证都未做。
