# Gate 2：Evidence Pack 最小实现（0.2.8）

- 分支 / 工作树：`0.2.8` / `/Users/yalla/data/localLab/thinkfusion-ai-0.2.8`
- 输入：`DEBATE_V3_2_GATE1_CONTRACT.md`（用户已批准 §3 三个类型决策）、Gate 1A Spike 13/13
- 结论：**Store / hash / 映射 / 契约已实现并有测试；没有接入辩论链路，也没有接裁判评分**

---

## 1. 本轮做了什么

| 文件 | 内容 |
| --- | --- |
| `src/main/evidence-pack/types.ts` | `EvidencePackItemKind`、Item / Manifest / Draft / Read、类型化错误码 |
| `src/main/evidence-pack/hash.ts` | canonical JSON、sha256、`packIdOf`、`itemHashOf`、`manifestHashOf` |
| `src/main/evidence-pack/store.ts` | `EvidencePackStore.publish/get/replay`：校验、原子发布、幂等/冲突、篡改检测 |
| `src/main/evidence-pack/mapping.ts` | `EvidencePackItem → DebateEvidence`，合成 messageId、`verified: 'snapshot'` |
| `src/main/debate/types.ts` | `EvidenceVerification` 增加 `snapshot`；`ClaimEvidenceLink`；`DebateState.claimEvidenceLinks?`；`DebateEvidence.origin?` |
| `src/main/debate/quality-engine.ts` | `FactVerificationStatus` / `FactVerification`；`DebateQualityReport.factVerification?` |
| `src/renderer/src/components/ResearchPanel.tsx` | `snapshot` 标签「冻结快照」；`repo://` 只按文字显示，不渲染成外链 |
| `scripts/check-evidence-pack.mjs` | 8 条测试，见 §3 |

实现严格按契约：

- `packId = pack_<sha256(idempotencyKey)[:16]>`；
- Pack 目录只有 `manifest.json` 与 `blobs/<contentHash>`；
- 发布顺序：blobs → manifest.tmp → rename manifest → rename 目录；
- hash 只收稳定字段（`capturedAt` / `createdAt` / `repoRoot` 不参与）；
- 行号越界、绝对路径、`..` 越界、空证据、超 2000 字符一律硬失败；
- 读到损坏 manifest / blob 抛类型化错误，不返回部分结果；
- 未知 `schemaVersion` 明确失败，不静默降级。

---

## 2. 刻意没做的事

1. **没有接 `DebateOrchestrator`**：Pack 目前只能被显式调用创建，辩论流程不会自动生成快照。
2. **没有接 IPC / UI**：没有「创建 Pack / 查看 Pack」的入口；映射结果也没有进会话页面。
3. **没有接裁判与质量引擎**：`judges.ts` 与 `quality.ts` 的证据维度仍只看 `page-link`，
   `snapshot` 证据传进去会被判成「没有可核验来源」。Gate 3 必须先定工程证据评分。
4. **没有接 code-index**：`symbolId` 仍由调用方提供，没有验证索引 id 的稳定性。
5. **没有 GC / 删除 / 跨 Pack 去重**：接口不提供删除，避免「删了但裁决还在引用」。

所以本轮不能宣称「工程辩论闭环」或「Evidence Pack 已投入辩论」。

---

## 3. 测试

命令：

```bash
cd desktop-agent-macos
npm run test:evidence-pack
```

结果：**8/8 通过**。

| 用例 | 钉住的事 |
| --- | --- |
| 发布后读回 | 条目内容、行号、manifest hash、packId 派生都对 |
| 同键同内容 | 复用已有 Pack，`createdAt` 不参与 hash |
| 同键不同内容 | `PACK_CONFLICT`，旧 Pack 内容不变 |
| 越界 / 绝对路径 / `..` | 对应错误码；`packs/` 下不留任何目录 |
| 篡改 / 损坏 / 未知版本 | `MANIFEST_CORRUPT` / `BLOB_CORRUPT` / `UNSUPPORTED_VERSION` |
| 映射 | `snapshot`、`repo-snapshot`、合成 messageId、`roundIndex=-1`、`claimIds` 不含 context、同文件只算一个独立来源 |
| doc-excerpt | 显式 `sourceType` 才映射，否则 `UNMAPPED_ITEM` |
| 旧辩论文件 | `claimEvidenceLinks` / `evidence` 读成 `undefined`，不补假数据 |

全量回归：

```bash
npm run typecheck   # 三套 tsconfig 全绿
npm test            # 101 个文件全过（27.2s）
```

---

## 4. 迁移与兼容检查

| 检查 | 结果 |
| --- | --- |
| 旧辩论记录能否读取 | 能；新字段可选，有测试 |
| 旧裁决记录能否读取 | 能；`quality` / `factVerification` 缺失时读成未记录 |
| 新旧 Schema 是否兼容 | 新字段全部可选；没有改动旧字段语义 |
| 创建失败是否留脏数据 | 临时目录删除，`packs/` 不出现目标目录，有测试 |
| 并发创建 | 目录 rename + 同键冲突；Spike 已验证同进程并发 |
| 历史快照是否可能被覆盖 | 发布路径只 rename 到不存在的目标，冲突即拒绝 |

---

## 5. 状态表

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| Evidence Pack 契约 | APPROVED + IMPLEMENTED（类型层） | `DEBATE_V3_2_GATE1_CONTRACT.md`、`types.ts` |
| EvidencePackStore | IMPLEMENTED + TESTED | 8 条测试；未接产品调用方 |
| EvidencePackItem → DebateEvidence 映射 | IMPLEMENTED + TESTED | `mapping.ts`；未接 UI |
| `ClaimEvidenceLink` | SPECIFIED + IMPLEMENTED（类型） | 尚无写入方 |
| `FactVerificationStatus` | SPECIFIED + IMPLEMENTED（类型） | 尚无核验器；质量引擎不读 |
| 工程辩论闭环 | NOT STARTED | 本轮未接编排 |
| 外部事实核验 | NOT STARTED | Gate 4 |

---

## 6. Gate 3 前必须定的问题

1. **工程证据怎么评分**：`snapshot` 能否算「有证据支持」？还是必须同时有测试结果？
2. **独立性口径**：同一 commit 的不同文件算几个来源？当前映射按文件收敛，不等于按仓库收敛。
3. **调用边界**：编排器在哪个时机创建 Pack（收尾时？每轮？），失败是否阻断辩论。
4. **UI 展示**：`repo://` 地址是否需要在应用内打开到对应文件/行。
5. **与 code-index 的对接**：`symbolId` 由谁生成、generation 不一致时是否拒绝建 Pack。

这些问题定完再进 Gate 3，不能借「已经能存」直接接进裁判。
