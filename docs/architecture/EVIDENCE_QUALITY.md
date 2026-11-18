# P4 证据与质量设计

状态：**设计完成（2026-11-18）**。
设计分支：`product-v3`。代码基线：`cd30be3`。
上游：[P1-002 领域与运行时契约](../implementation/P1-002-DOMAIN-RUNTIME-CONTRACT.md)。

原则：**不新建 EvidenceStore**。`EvidenceRef` 是现有 `EvidencePack` 条目的引用视图；
P4 只补映射、验证、质量与回放。

---

## 1. 映射：Pack → EvidenceRef

| `EvidencePackItemKind` | `EvidenceRef.kind` | 说明 |
| --- | --- | --- |
| `source-file` | `code` | 文件片段 |
| `symbol` | `code` | 符号 |
| `call-edge` | `code` | 调用关系 |
| `dependency` | `code` | 依赖 |
| `git-commit` | `code` | 提交 |
| `test-result` | `execution` | 真实测试 |
| `command-result` | `execution` | 命令 |
| `doc-excerpt` | `web` | 网页/文档正文 |

规则：

- 同一证据在跨空间复用时复用 `packId/itemId`，不复制内容；
- `hash` 统一用 `evidence-pack/hash.ts`；
- 旧 Pack 的 `context.kind='baseline'` 只读兼容；新代码写 `snapshot`；
- 没有 `source` 或 `hash` 的引用不得标 `verified`。

---

## 1.1 归属与兼容

```ts
export interface EvidencePackContext {
  kind: 'snapshot' | 'baseline' | 'round';
  /** 归属类型：目标 / 任务 / 辩论。 */
  ownerType: 'goal' | 'task' | 'debate';
  ownerId: string;
  roundIndex?: number;
  baselinePackId?: string;
}
```

- 新数据必须写 `ownerType/ownerId`；
- 旧数据没有 `ownerType` 时按 `ownerType='debate'`、`ownerId=debateId` 读取；
- 仓库快照写 `{ kind:'snapshot', ownerType:'task', ownerId }`，不再把任务 id 填进 `debateId`；
- `EvidenceRef` 单一定义在 P1-002，其他文档只引用。


---

## 2. 验证

```ts
export type VerificationMethod = 'code' | 'execution' | 'source' | 'cross';

export interface VerificationPlan {
  claimId: string;
  method: VerificationMethod;
  /** 需要哪些证据；没拿到就标 unverified。 */
  requiredEvidence: string[];
  steps: string[];
}

export interface VerificationResult {
  claimId: string;
  relation: 'supports' | 'contradicts' | 'context' | 'unverified';
  confidence: 'low' | 'medium' | 'high';
  limitations: string[];
  evidenceRefs: string[];
  method: VerificationMethod;
}
```

流程：

```text
Claim
 ├─ 有代码位置？ → code：路径:行号 + 内容哈希
 ├─ 有执行结果？ → execution：attestation 校验
 ├─ 有网页来源？ → source：URL/时间/版本 + 可打开
 └─ 都没有？     → unverified（不默认成立）
```

规则：

- 验证者独立于提出者；
- `insufficient_evidence` 与 `unsupported` 分开；
- 验证失败不删除 Claim，标 `unverified` 并保留；
- Debate 的 judge 只能作为 `cross` 方法之一，不能替代执行/代码验证。

---

## 3. 质量指标

| 指标 | 公式 | 目标 |
| --- | --- | --- |
| Goal Completion | 满足的 acceptance 项 / 总项 | 发布场景 100%；shadow ≥90% |
| Evidence Coverage | 有关键 Claim 带证据的比例 | 通用/知识 ≥80%；工程「已修复」100% |
| Verification Coverage | 关键 Claim 已判定（非 unverified）比例 | ≥70%；工程关键结论 100% |
| Uncertainty Honesty | 未核验项被显式标记比例 | 100% |
| Collaboration Efficiency | 无新增信息的调用 / 总调用 | ≤20%；简单问题 ≤2 次 |
| Replanning Quality | 产生有效新信息的重规划 / 总重规划 | ≥50%，总次数 ≤2 |
| Engineering Success | 闭环场景通过 / 受控场景总数 | 100% |

```ts
export interface QualityReport {
  goalId: string;
  completion: number;
  evidenceCoverage: number;
  verificationCoverage: number;
  honesty: number;
  efficiency: number;
  replanQuality: number;
  engineeringSuccess?: number;
  failures: Array<{ metric: string; actual: number; target: number }>;
}
```

采集点：P0 事件；不在 UI 层另算。未达标时门禁失败，不靠人工解释。

---

## 4. 回放与篡改

- 同一 `goalId`、同一 commit、同一证据哈希：重复校验得到同一结论；
- `EvidenceRef` 指向的 Pack 条目被改 → 校验失败，并能报出字段；
- `ExecutionAttestation` 被改 → Item Hash/Manifest Hash 失败；
- 回放不调用模型，只重跑校验与交付。

---

## 5. 测试体系

| 层 | 内容 | 运行 |
| --- | --- | --- |
| Unit | 映射、验证、指标、哈希 | 每次提交 |
| Integration | 编排 + mock agents | 每次提交 |
| Live | Web/Local/Cloud/CLI | 发布前（`TF_LIVE=1`） |
| Scenario | 40 个真实任务 | 发布前 |

Fixture：

- 5 个仓库：Java/TS/Node/Maven/Gradle；clean/dirty 两态；
- 网页文本 fixture；假 CLI 覆盖成功/失败/超时；
- live 无登录态时明确跳过，不假装通过。

场景：10 General + 10 Knowledge + 20 Engineering（见 [TASK-BOOK](../implementation/TASK-BOOK.md)）。

---

## 6. 验收

- 8 类 Pack → 5 类 EvidenceRef 映射通过；
- 四类验证路径可走通；unverified 保留；
- 指标有公式/采集/阈值；门禁能拦「无证据 → 通过」；
- 40 场景受控集通过；live 跳过有原因；
- 篡改证据被发现；回放一致。

---

## 7. 风险

| 风险 | 对策 |
| --- | --- |
| 证据两套 | 只加映射，不建存储 |
| 把 judge 当验证 | execution/code 优先；cross 只作补充 |
| 指标只算不拦 | CI 门禁 |
| live 测试污染 | fixture + 明确跳过 |
| 回放依赖网络 | 只重跑校验，不发新调用 |
