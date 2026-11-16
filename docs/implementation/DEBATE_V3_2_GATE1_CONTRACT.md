# Gate 1：Evidence Pack 契约评审（0.2.8）

- 分支 / 工作树：`0.2.8` / `/Users/yalla/data/localLab/thinkfusion-ai-0.2.8`
- 依据代码：HEAD `a122a08`（Gate 0 收尾提交）
- 状态：**APPROVED（2026-11-16）**；Gate 2 已按此实现，接入边界见 `DEBATE_V3_2_GATE2.md`
- 范围：只定契约与 Spike 验收；本轮不实现正式存储、不改辩论链路

---

## 0. 为什么先有这份文档

用户审核已批准「先契约评审、再 Spike、最后实现」。本文只回答契约问题，不把设计写成
已完成能力。文末的 Spike 结果单独标注实际跑过的部分。

---

## 1. 现有代码事实（写契约前逐条核对过）

| 事实 | 位置 | 对契约的约束 |
| --- | --- | --- |
| `DebateEvidence` 必填 `messageId`、`span`，`span` 里也带 `messageId` | `src/main/debate/types.ts:272`、`src/shared/fusion.ts:24` | 工程证据没有「辩论消息」；映射必须给一个**合成 id**，并让消费方能分辨 |
| `EvidenceVerification = 'page-link' \| 'reported' \| 'unverified'` | `src/main/debate/types.ts:263` | 把冻结快照标成 `unverified` 是错的；需要新增 `snapshot`（加一个成员，编译期会强制补 UI 标签） |
| `judges.ts` 的证据维度只把 `page-link` 当可核验来源 | `src/main/debate/judges.ts:290-302` | 若映射后的工程证据立刻进裁判评分，会被判成「没有可核验的来源」；**Gate 3 前不得接入** |
| `quality.ts` 的「无链接不得 supported」「同源不重复计数」都只统计 `page-link` | `src/main/debate/quality.ts:169-205` | 同上：`snapshot` 天然不参与这两条规则，不会虚增独立来源，也不会被误判 |
| `independent` 的语义是「同一份材料的第一条」 | `src/main/debate/evidence.ts:206` | 仓库同一 commit 不是「多份独立来源」；映射必须按文件收敛，不能把三个片段算三个独立来源 |
| `DebateStore` / `VerdictStore` 都是「一个对象一个文件 + 原子写」 | `src/main/debate/store.ts`、`src/main/judge/store.ts` | Pack 不适合塞进单个辩论 JSON（要跨辩论复用），需要独立 store；写入沿用原子写 |
| 辩论与裁决记录**没有** `schemaVersion` | 同上 | 不追溯改动旧文件；新 Pack 文件自带版本号，未知版本明确失败 |
| `ClaimSpan` 是 `{ messageId, start, end }` | `src/shared/fusion.ts:24` | Pack 条目的内容偏移可以落在合成 messageId 上，不影响旧记录 |

---

## 2. 六个必答问题

### 2.1 Pack 如何创建

- 创建入口只有一个：`EvidencePackStore.publish(draft)`。
- 调用方（Gate 2 的工程辩论编排）先构造 `EvidencePackDraft`（repo 快照 +
  条目列表 + 幂等键），`publish` 负责校验、计算 hash、原子发布。
- 不提供「修改已有 Pack」的入口，也不提供「手动编一条证据」的 IPC。
- `packId` 由幂等键派生：`pack_<sha256(idempotencyKey) 前 16 位>`。同一个逻辑快照
  只能有一个 packId；不同内容硬用同一个键是冲突，不是「再发一个包」。
- 同一键 + 同一 `manifestHash` → 返回已有 Pack（幂等）；同一键 + 不同 hash →
  抛 `EvidencePackConflictError`，不覆盖、不静默选一个。

### 2.2 Item 如何定义

```ts
export type EvidencePackItemKind =
  | 'source-file'      // 文件片段
  | 'symbol'           // 具名符号（函数/类/类型）
  | 'call-edge'        // 调用点
  | 'test-result'      // 测试执行结果
  | 'command-result'   // 命令输出
  | 'dependency'       // 依赖清单条目
  | 'git-commit'       // 提交元数据
  | 'doc-excerpt';     // 外部文档片段（仅明确标注来源类型时使用）

export interface EvidencePackItem {
  itemId: string;              // 包内稳定标识（不是校验和）
  kind: EvidencePackItemKind;
  source: {
    repoRoot?: string;         // 仅创建时用于定位，不写入 manifest 的 hash 输入
    commit: string;            // 快照对应的 commit
    path?: string;             // 仓库相对路径，POSIX 分隔符
    language?: string;
  };
  locator: {
    path: string;              // 与 source.path 一致；doc-excerpt 用来源路径/URL 的本地化名
    startLine: number;         // 从 1 开始
    endLine: number;           // >= startLine
    symbolId?: string;         // 复用 code-index 的稳定 id；没有就不写
    symbolName?: string;
  };
  content: string;             // 冻结原文片段，不改写、不省略
  contentHash: string;         // sha256(utf8(content))，见 §2.3
  meta: {
    tool: string;              // 采集工具/入口，例如 'code-index'、'test-runner'
    capturedAt: number;        // 不参与 hash
    generation?: number;       // code-index 的快照代次
    command?: string;          // command-result 用
    exitCode?: number;
  };
}

export interface EvidencePack {
  schemaVersion: 1;
  packId: string;              // pack_<hash(idempotencyKey)>，与内容无关
  status: 'building' | 'ready' | 'failed';
  idempotencyKey: string;
  repo: { commit: string; dirty?: boolean };
  items: EvidencePackItem[];
  manifestHash: string;
  createdAt: number;
}
```

条目规则（全部为硬失败，不截断、不猜测）：

1. `path` 必须是仓库相对路径；绝对路径、`..`、反斜杠一律拒绝。
2. `startLine >= 1`、`endLine >= startLine`、`endLine` 不得超过快照文件行数。
3. `content` 必须与快照中该行范围逐字一致（允许统一换行符），不允许加省略号。
4. 单条 `content` 上限 2000 字符；超限由创建方拆成多条，**不在映射层截断**。
5. `itemId = 'item_' + sha256(kind + '\0' + path + '\0' + startLine + '\0' + endLine + '\0' + (symbolId ?? '')).slice(0, 16)`；
   同包内 `itemId` 重复且 `contentHash` 不同 → 冲突错误。
6. 不新增第二套「证据数据库」：Pack 只存快照；主张与证据的关系仍由
   `ClaimEvidenceLink` 表达。

### 2.3 Hash 如何计算

- 规范化：键排序、无空白、UTF-8、数字原样；数组保序（条目列表在算 manifest 之前先排序）。
- `contentHash = sha256('blob\0' + content)`
- `itemHash = sha256(canonicalJson({ kind, commit, path, startLine, endLine, symbolId, contentHash }))`
- `manifestHash = sha256(canonicalJson({ schemaVersion, commit, items: items.map(i => i.itemHash).sort() }))`
- 排除项：`capturedAt`、`createdAt`、`repoRoot`、主机名、临时目录、写入顺序。
- 全部为 64 位小写 hex。`packId` / `itemId` 是标识，不是校验和，读的时候**必须重算 hash 校验**。

### 2.4 如何冻结

状态机：

```
publish(draft)
  ├─ 校验失败 → failed（不产生目录）
  └─ 建 <packId>.tmp-<pid>/
       ├─ blobs/<contentHash>          ← 内容寻址，按内容去重
       └─ manifest.json.tmp → rename manifest.json   ← 提交点（元数据全在 manifest）
     然后 rename 临时目录 → packs/<packId>
```

- `manifest.json` 存在且能通过 `manifestHash` 校验 = `ready`；这是唯一判定标准。
- 写入顺序：先 blobs，再 item 索引，最后 manifest；中途失败删除临时目录，**不发布半成品**。
- 目标目录已存在 → 冲突错误，绝不覆盖（历史快照不可被改写）。
- 读取时按 manifest 重算每个 blob 的 `contentHash` 和整体 `manifestHash`；任一不符即
  抛 `EvidencePackCorruptError`，不返回「尽量读出来」的部分结果。

### 2.5 如何映射（`EvidencePackItem` → `DebateEvidence`）

映射是纯函数，放在 `mapping.ts`，不读写存储：

| `DebateEvidence` 字段 | 取值 | 说明 |
| --- | --- | --- |
| `evidenceId` | `'pack:' + packId + ':' + itemId` | 全局唯一、可反查 |
| `claimIds` | 由 `ClaimEvidenceLink` 提供；映射函数不猜 | 没有链接就是 `[]` |
| `kind` | `source-code`（`doc-excerpt` 按显式 `meta.sourceType` 映射） | 不扩展 `EvidenceKind` |
| `excerpt` | `item.content` | 不截断；超限在创建时已被拒绝 |
| `span` | `{ messageId: evidenceId, start: 0, end: content.length }` | 合成 id，不是真实发言 |
| `sourceId` | `'evidence-pack:' + packId` | 同包同源 |
| `messageId` | 同 `span.messageId` | 消费方不得把它当真实消息去取 |
| `roundIndex` | `-1` | 明确表示不来自任何辩论轮次；Gate 3 前不得据此排序 |
| `url` / `finalUrl` | `repo://<commit>/<path>#L<start>-L<end>` | 可显示、不可网络打开 |
| `fingerprint` | 复用现有 FNV-1a（去空白与标点） | 与页面证据同一算法 |
| `originKey` | `'repo:' + commit` | 同一 commit 收敛（用户 Gate 3 决策）；第一条 `independent: true`，其余 `false` + `duplicateOf` |
| `verified` | `'snapshot'` | 新增枚举成员，见 §3.1 |
| `assessment` | `'来自冻结快照 <commit> <path>:<start>-<end>'` | 人可读，不写「已核验事实」 |
| `origin`（新增可选） | `'repo-snapshot'` | 让 UI / 评审能分辨合成 messageId |

**接入限制（必须写进 Gate 2 验收）**：映射结果在 Gate 3 完成工程证据评分前，
只允许持久化和展示，**不得传给** `judges.ts` 的证据维度或 `quality.ts` 的
`no_support_without_link` / 同源计数，否则工程证据会被判成「没有可核验来源」。

### 2.6 如何回放

- `readPack(packId)`：读 `manifest.json` → 校验 `manifestHash` → 逐条校验 blob →
  返回 `{ pack, items }`；任何一步失败抛类型化错误。
- `replay(packId)`：重新执行映射并计算 `itemHash`，与 manifest 比对；不重新跑模型。
- 回放不依赖当前仓库工作区：所有内容都在 Pack 里；仓库被改动不影响旧 Pack。
- 回放不写盘（只读），因此不会因回放产生「新版本」。

---

## 3. 三个待批准的类型决策

### 3.1 `EvidenceVerification` 增加 `'snapshot'`

```ts
export type EvidenceVerification = 'page-link' | 'reported' | 'unverified' | 'snapshot';
```

理由：快照内容确实被读取并通过 hash 校验，标 `unverified` 是假的，标 `page-link`
会把它算进网页来源统计。`snapshot` 只回答「内容来自冻结快照」，不回答「主张正确」。

代价：渲染层 `EVIDENCE_LABEL` 必须补中文标签（`'冻结快照'`），TypeScript 会强制发现。

### 3.2 `FactVerificationStatus` 挂载位置

不放进 `QualityStatus`，也不放进 `QualityDimension.status`：

```ts
export type FactVerificationStatus =
  | 'verified' | 'contradicted' | 'partially_verified'
  | 'insufficient' | 'conflicting' | 'not_verifiable';

export interface FactVerification {
  status: FactVerificationStatus;
  basis: string[];
  sourceRefs: Array<{ url: string; version?: string; readAt: number }>;
  verifier: { modelId?: string; method: string; independent: boolean };
  checkedClaimIds: string[];
}
```

挂载点：`DebateQualityReport.factVerification?: FactVerification`（Gate 4 才写入）。
质量引擎的八个维度**不读**这个对象；它只描述外部来源核验结果。老裁决没有该字段，
读成「未做外部核验」，不读成 `not_verifiable`。

### 3.3 `ClaimEvidenceLink`

```ts
export interface ClaimEvidenceLink {
  debateId: string;
  claimId: string;
  evidenceId: string;
  relation: 'supports' | 'contradicts' | 'context';
  source: 'author' | 'reviewer' | 'judge' | 'pack';
  reason: string;
}
```

存放：`DebateState.claimEvidenceLinks?: ClaimEvidenceLink[]`（可选，老文件读成空数组）。
不替代 `DebateEvidence.claimIds`，也不替代 `ClaimJudgment.evidenceIds`；Gate 2 只写入
新产生的链接，**不回填、不改写**旧记录。

---

## 4. 存储与迁移兼容

- 新增 `EvidencePackStore`，目录：`<appData>/evidence-packs/packs/<packId>/`；
  Pack 内布局只有 `manifest.json` 与 `blobs/<contentHash>`，不另建索引文件；
  与 `DebateStore` / `VerdictStore` 平级但独立，不改它们的文件格式。
- 旧辩论 JSON、旧裁决 JSON 不需要迁移；新增字段全部可选。
- 创建失败：临时目录删除；目标目录不出现；不写任何「索引文件」。
- 并发创建：同一 `idempotencyKey` 并发调用，只允许一个成功 rename；
  其余返回同一 Pack（hash 相同）或抛冲突（hash 不同）。不做跨进程锁，靠目录 rename 的原子性。
- 历史快照不可覆盖：发布路径只 rename 到不存在的目标；`publish` 永不 `writeFile` 到已有 pack。
- 版本：`schemaVersion: 1`；读到未知版本抛 `UnsupportedEvidencePackVersion`，
  不静默降级、不猜字段。
- 删除/GC 不在本期；接口先不提供删除，避免「删了但裁决还在引用」。

---

## 5. Spike 验收（Gate 1A）

Spike 用真实 TypeScript 仓库（自建 fixture，不改产品仓库）验证：

| 验收项 | 通过标准 |
| --- | --- |
| 读取源码、定位符号、定位调用点 | 行号与 fixture 一致 |
| 生成 1 个 Pack、3 个 Item | manifest 可解析，3 条 itemHash |
| 修改源码后再建 Pack | 新 Pack 的 `manifestHash` 与旧的不同 |
| 旧快照不变 | 旧 Pack 的全部 blob hash 重算一致 |
| Manifest 校验 | 篡改 manifest 任一字段能被发现 |
| 损坏一条 Item | 重算 blob hash 失败并报错 |
| 旧 Pack 可回放 | 重新映射后 itemHash 与 manifest 一致 |
| 并发创建同一幂等键 | 不产生脏目录；结果只有「同一 Pack」或「明确冲突」 |
| 发布失败 | 不残留 `packs/<id>` 半成品 |

Spike 已于 2026-11-16 跑完，**13/13 通过**，结果见
`docs/implementation/DEBATE_V3_2_GATE1_SPIKE.md`。命令：`npm run test:evidence-pack-spike`。

---

## 6. Gate 1 出口条件

1. 用户批准 §3 的三个类型决策与 §2 的 hash / 冻结 / 映射规则；
2. Spike 全部验收项通过（已通过：13/13，见 Gate 1A 结果）；
3. 明确 Gate 2 的接入边界：Pack 只做证据快照，不接裁判评分。

三条都满足才进入 Gate 2。任一不满足，不开始正式实现。
