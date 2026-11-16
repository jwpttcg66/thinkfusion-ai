# Gate 1A：Evidence Pack Spike 结果（0.2.8）

- 分支 / 工作树：`0.2.8` / `/Users/yalla/data/localLab/thinkfusion-ai-0.2.8`
- 脚本：`desktop-agent-macos/scripts/spike-evidence-pack.mjs`
- 命令：`npm run test:evidence-pack-spike`（或 `node scripts/spike-evidence-pack.mjs`）
- 结果：**13/13 通过**
- 结论：契约里的 hash / 冻结 / 回放 / 冲突规则可执行；Gate 2 仍等契约批准

---

## 1. Spike 做了什么

自建一个真实 TypeScript 小仓库（`git init` + 提交），包含：

- `src/math.ts`：`add`、`multiply`
- `src/main.ts`：调用 `multiply`

从快照中取 3 条证据：

| 条目 | 类型 | 定位 |
| --- | --- | --- |
| 1 | `source-file` | `src/math.ts:1-4` |
| 2 | `symbol` | `src/math.ts:6-8`（`multiply`） |
| 3 | `call-edge` | `src/main.ts:4`（`multiply(width, height)`） |

生成 Pack → 读回校验 → 改源码再生成 Pack → 验证旧 Pack 不变 → 篡改/损坏检测 →
并发发布 → 越界行号 → 未知版本。

---

## 2. 验收项与结果

| # | 验收项 | 结果 |
| --- | --- | --- |
| 1 | 生成 1 个 Pack、3 个 Item | PASS（manifest `manifestHash` 为 64 位 hex） |
| 2 | 行号与 fixture 一致 | PASS（`symbol@6`、`call@4`） |
| 3 | Manifest 校验通过 | PASS |
| 4 | 源码改动后旧快照不变 | PASS（旧 Pack 逐条与改动前完全相同） |
| 5 | 新快照 hash 改变 | PASS（`manifestHash` 与 `contentHash` 都变） |
| 6 | 旧 Pack 仍可回放 | PASS（回放到改动前的 `a * b`） |
| 7 | 同一幂等键 + 同一内容 → 复用 | PASS（`reused=true`，不重复发布） |
| 8 | 同一幂等键 + 不同内容 → 冲突 | PASS（`PACK_CONFLICT`，旧 Pack 未被覆盖） |
| 9 | 并发发布同一幂等键 | PASS（只产生一份，无 `.tmp-` 残留） |
| 10 | Manifest 被篡改 | PASS（`MANIFEST_CORRUPT`） |
| 11 | 损坏一条 Item | PASS（`BLOB_CORRUPT`） |
| 12 | 越界行号 | PASS（直接失败，不留半成品） |
| 13 | 未知 `schemaVersion` | PASS（`UNSUPPORTED_VERSION`，不静默降级） |

---

## 3. Spike 改掉的两条契约假设

1. **`packId` 不再是随机 UUID**，改为 `pack_<sha256(idempotencyKey)[:16]>`。
   原因：随机 id 下「同一幂等键 + 不同内容」必须靠额外索引才能发现；派生 id 让
   同一个逻辑快照落在同一个目录，冲突在发布时直接暴露，不需要第二份状态。
2. **去掉 `items/index.json`**。manifest 已经承载全部条目元数据，另写一份索引只会
   增加「索引与 manifest 谁为准」的问题。Pack 目录只有 `manifest.json` 和
   `blobs/<contentHash>`。

两条都已回写进 `DEBATE_V3_2_GATE1_CONTRACT.md`。

---

## 4. 这个 Spike 没有证明什么

- **没有接真实的 code-index**：`symbolId` 用手写值，没有验证索引实际给出的 id 稳定性；
- **没有接 IPC / 渲染层**：映射后的 `DebateEvidence` 只在脚本里比对字段，UI 未验证；
- **没有跨进程并发**：只验证了同进程两个调用，目录 rename 的原子性在跨进程下仍需真机验证；
- **没有模拟断电**：只验证「校验失败时不留半成品」，没有在写 blob 中途杀进程；
- **没有旧 Pack 可读**：仓库里此前不存在 Pack，迁移兼容只能验证「未知版本明确失败」；
- **没有大文件 / Windows 路径 / 非 UTF-8**；
- **没有接裁判/质量引擎**：按契约，Gate 3 前不接；因此「工程证据不参与评分」是可执行
  约束，不是已实现能力。

---

## 5. 对 Gate 2 的输入

Gate 2 可以按契约实现 `EvidencePackStore`，但必须同时满足：

1. 复用 Spike 的 canonical JSON / sha256 / 发布顺序，不另写一套；
2. 映射层只产生 `verified: 'snapshot'` 的 `DebateEvidence`，并带 `origin: 'repo-snapshot'`；
3. 不给 `judges.ts` / `quality.ts` 的证据维度传 Pack 证据（Gate 3 再定工程证据评分）；
4. 老辩论 / 老裁决文件零迁移，新字段全部可选。

在这四条之外新增设计（例如目录级 GC、跨 Pack 去重、远程快照）都要重新评审，
不能借 Gate 2 顺手扩。
