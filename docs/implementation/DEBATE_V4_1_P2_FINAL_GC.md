# P2-Final：Evidence Pack 生命周期与引用可达性 GC

- 分支 / 工作树：`p2-pack-gc` / `/Users/yalla/data/localLab/thinkfusion-ai-pack-gc`
- 基线：`main` = `3403d29`
- 本轮范围：Pack 生命周期接口、引用可达性 GC、清理审计、文档一致性
- 明确不做：P3 裁判方向判断，GC 不按时间删除已引用 Pack

---

## 1. 引用根

GC 从仍然存在的 `DebateState` 收集引用：

| 字段 | 解析方式 |
| --- | --- |
| `evidencePack.baselinePackId` | 直接 packId |
| `roundEvidencePacks[].packId` | 直接 packId |
| `packEvidence[].evidenceId` | `pack:<packId>:<itemId>` |
| `packEvidenceLinks[].evidenceId` | `pack:<packId>:<itemId>` |
| `evidence[]`（`origin: repo-snapshot`） | `pack:<packId>:<itemId>` |

规则：

- packId 必须是 `pack_<16 hex>`；
- 任何看起来像引用但解析不了的字段 → **整个 GC 中止**，不冒险删除；
- 读不了的辩论文件由 `DebateStore.scanAll()` 返回 error，GC 同样中止；
- 一个 Pack 被多场辩论引用时，删掉其中一场仍受保护。

---

## 2. Store 生命周期接口

`EvidencePackStore` 新增：

| 接口 | 作用 |
| --- | --- |
| `list()` | 轻量扫描 manifest，返回 ready/corrupt、大小、context |
| `inspect(packId)` | 完整校验，返回 ready/corrupt/unavailable |
| `delete(packId)` | 先 rename 到 quarantine，再递归删除 |
| `listTemporary()` | 发布中断留下的 `.tmp-*` 目录 |
| `listQuarantine()` | 崩溃留下的 quarantine 目录 |

删除安全：

- packId 正则校验，路径不能穿越；
- 同一进程正在读取的 Pack 拒绝删除；
- rename 到 `.quarantine/` 是原子步骤，读者要么看到完整 Pack，要么看到不存在；
- 删除失败返回原因，不静默。

跨进程没有分布式锁；当前应用是本地单主进程模型。跨进程并发属于已知边界，靠原子 rename 与宽限期降低风险，不宣称绝对无竞态。

---

## 3. GC 规则

`collectPackGarbage({ store, debates, scanErrors, dryRun, now, graceMs })`

- **默认 dry-run**；只有 `dryRun: false` 才实际删除。
- 被引用 Pack：永久保护。
- 损坏 Pack：默认保护（无法判断内容完整性，不删）。
- 未引用 Pack：超过 `graceMs`（默认 24h）才进入候选。
- 新发布但尚未写入 DebateState 的 Pack：靠宽限期保护。
- `scanErrors` 非空：整个 GC 中止，连临时目录都不清理。
- 临时目录 / quarantine：超过宽限期且非活动对象才清理。
- 删除后再次 replay 明确返回 `PACK_NOT_FOUND`。

GC 计划包含：

```text
scannedPacks / referencedPacks / unreferencedPacks / corruptPacks
protectedPacks / candidatePacks / deletedPacks / deletedBytes
reclaimableBytes / temp / quarantine / skipped / audit / aborted
```

每个删除/保护/跳过都有 `audit` 记录，包含 kind、id、reason、bytes。

---

## 4. 辩论删除联动

- `DebateStore.remove()` 只删除辩论记录，不递归删 Pack；
- 下一次 GC 重新扫描引用；
- 仍被其他辩论引用 → 保留；
- 最后一场引用删除后，Pack 才进入孤儿候选，并受宽限期约束。

---

## 5. 测试

`npm run test:pack-gc`：**12/12 通过**。

覆盖：

- baseline / round Pack 被引用时保护；
- 同一 Pack 被多场辩论引用；
- 删除一场辩论不释放共享 Pack；
- 删除最后一场后进入候选；
- 宽限期内保护、超期后可清理；
- dry-run 不产生删除；
- 损坏 Pack 保护；
- 辩论记录读不了时整个 GC 中止；
- 无法解析的 `pack:` 引用导致中止；
- 临时目录 / quarantine 清理与审计；
- 重复 GC 幂等；
- 删除后 `PACK_NOT_FOUND`；
- `DebateStore.scanAll` 报告坏文件而不是静默跳过。

全量回归：

```text
npm run test:pack-gc          12/12
npm run test:repository-pack  15/15
npm run test:code-references   8/8
npm run test:baseline-code-reference 15/15
npm run test:round-evidence-pack 5/5
npm run test:claim-evidence-links 12/12
npm run typecheck             三套全绿
npm test                      109 个文件全过（27.2s）
```

---

## 6. 未接线与限制

- GC 没有自动在应用启动/退出时运行；需要显式调用，默认 dry-run。
- 没有 UI/IPC 清理入口。
- 跨进程并发没有锁；依赖单主进程 + 原子 rename + 宽限期。
- 损坏 Pack 默认永久保护；需要人工处理，不自动删。
- 没有按辩论删除级联删 Pack；这是有意设计，避免破坏其他回放。

---

## 7. 文档状态修正

历史实施记录保留；当前状态以本节和各文档顶部“状态更新”为准：

| 能力 | 当前状态 |
| --- | --- |
| 基准一致性 resolver | IMPLEMENTED + 接入 round producer |
| 每轮 Pack | IMPLEMENTED + 接入 orchestrator |
| Pack → DebateEvidence | IMPLEMENTED + TESTED |
| ClaimEvidenceLink(source: pack) | IMPLEMENTED，仅 context |
| supports / contradicts | NOT STARTED（P3） |
| Pack GC | IMPLEMENTED + TESTED，未接 UI/自动调度 |
| P2 完成 | 否；仍缺 P3 裁判方向与 GC 调度 |
