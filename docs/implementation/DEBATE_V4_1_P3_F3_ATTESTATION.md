# P3-F.3：执行断言元数据完整性

- 分支 / 工作树：`p3f3-attestation` / `/Users/yalla/data/localLab/thinkfusion-ai-p3f3`
- 基线：`main` = `7f48ecf`
- 目标：让 `assertion / verifiesClaimIds / reference` 进入 Item Hash，篡改可被发现
- 范围：只做完整性；真实执行证据生产者未实现

---

## 1. 原问题

Runtime Claim 是否被接受，取决于执行条目的：

- `assertion: passed | failed`
- `verifiesClaimIds`
- `reference`

但这些字段此前只在 `meta`，而 `itemHashOf` 只覆盖 kind、commit、path、行号、symbolId、contentHash。
Manifest Hash 基于 Item Hash，因此修改这些字段不会破坏现有校验。

---

## 2. 修复

新增可选 `ExecutionAttestation`，放在 Pack 条目上：

```ts
interface ExecutionAttestation {
  executionId: string;
  testId?: string;
  assertionId: string;
  claimId: string;
  assertion: 'passed' | 'failed';
  exitCode?: number;
  repoCommit: string;
  snapshotFingerprint?: string;
  resultHash: string;
  producer: { name: string; version: string };
}
```

- `itemHashOf` 在存在 attestation 时把它加入 canonical JSON；
- manifest Hash 继续通过 Item Hash 覆盖它；
- 旧 Pack 没有 attestation，hash 输入完全不变，仍可 replay；
- `repoCommit` 必须与 Pack commit 一致；
- `passed` 的 exitCode 若存在必须为 0；
- `resultHash` 必须是 64 位 hex；
- producer 名称/版本必填；
- attestation 只允许用于 `test-result` / `command-result`。

映射规则：

- 有 attestation：`execution.assertion / verifiesClaimIds / reference / exitCode` 从 attestation 派生；
- 没有 attestation：保留旧 `meta` 映射（兼容旧 Pack），但旧 meta 不进入 hash，文档标为 legacy。

---

## 3. 测试

`npm run test:evidence-pack`：**12/12 通过**。

新增：

- 篡改 manifest 里的 `attestation.assertion` → `MANIFEST_CORRUPT`；
- attestation 的 `repoCommit` 与 Pack 不一致 → `INVALID_CONTENT`；
- 映射优先使用 attestation，而不是未受 hash 保护的 meta；
- 旧无 attestation Pack 仍可 replay（既有测试）。

P3 相关：

```text
test:evidence-pack          12/12
test:judge-pack-evidence    15/15
typecheck                   三套全绿
```

`npm test` 仍只失败在既有的 `check-cli-agent` 注册表测试（main 同样失败，CLI 版本/指纹漂移）；本轮没有修改该测试。

---

## 4. 仍未完成

| 项 | 状态 |
| --- | --- |
| 真实执行证据生产者 | NOT IMPLEMENTED |
| 从 ExecutionReport 生成 attestation | NOT IMPLEMENTED |
| 真实执行 → Pack → Judge E2E | NOT IMPLEMENTED |
| P3-G UI | NOT STARTED |

P3-F.3 只解决「已有执行断言不能被静默篡改」，不解决「这些断言从哪里来」。
下一步必须复用 `AgentOrchestrator` / `ExecutionReport` 生产 attestation，不能由模型或上游随手填写 `verifiesClaimIds`。
