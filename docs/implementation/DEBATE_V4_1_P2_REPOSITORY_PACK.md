# Debate V4.1 P2：工程上下文与开场基准 Pack

- 分支 / 工作树：`0.2.9` / `/Users/yalla/data/localLab/thinkfusion-ai-0.2.9`
- 基线：`abf4b45`（远端已包含 P0/P1）
- 本轮范围：P2-0 审计 + P2-1 解析 + P2-2/3 基准 Pack + P2-6 降级 + P2-7 回放
- 明确未完成：P2-4 每轮增量 Pack、P2-5 Pack↔Claim 接通

---

## 1. P2-0 审计结论（代码事实）

| 检查项 | 结论 |
| --- | --- |
| `EvidencePackStore` | 已存在（Gate 2），但此前没有产品调用方 |
| 辩论状态里的工程上下文 | 本轮之前没有 `repository` / `evidencePack` 字段 |
| `snapshots/store.ts` | 任务文件修改前的备份/还原，不是辩论证据快照，不能复用 |
| `task-worktree.ts` | 有 Git 校验与 Worktree 创建能力，但没有暴露给辩论启动链路 |
| `workspace-store.ts` | 全局默认工作区，不能作为历史辩论的工程来源 |
| 辩论发言/主张 | 只有文本、网页 citation、`evidenceDrafts` 摘要；**没有仓库路径/行号** |
| 每轮 Pack 的 Claim 关联 | 当前没有「主张 → 仓库文件/行」的生产者，无法诚实地建立 |

所以本轮不能直接实现「每轮 Pack 关联 Claim」；那需要先有工程证据生产者
（把代码引用变成 path/line），否则只能伪造关联。

---

## 2. 已实现

### 2.1 RepositoryContextResolver

`src/main/evidence-pack/repository.ts`

- 用 `git -C <root>` 解析：
  - `rev-parse --show-toplevel`
  - `rev-parse HEAD`
  - `rev-parse --abbrev-ref HEAD`
  - `status --porcelain=v1 -z`
- 干净仓库：只返回 commit/branch，不复制整仓。
- dirty 仓库：
  - 用 `--untracked-files=all` 列出未跟踪目录内的每个文件；
  - 修改/未跟踪文件按行切成 ≤1900 字符片段；
  - 每个片段有 `contentHash`，发布时使用解析时已读到的内容，避免重读漂移；
  - 删除、空文件、读不到、符号链接、二进制/非 UTF-8 文件进入 `errors`，Pack 只能标 `partial`；
  - `dirtyFingerprint` 对片段 hash 与错误排序后计算。
- 非 Git / 目录不存在返回明确错误，不抛到辩论主流程。

### 2.2 开场基准 Pack

`src/main/evidence-pack/baseline.ts`

- 一场辩论只发一次，幂等键 `debate:<debateId>:baseline`。
- 干净仓库：Pack 条目为空，manifest 记录 `commit / branch / dirty=false`。
- dirty 仓库：条目为实际改动/未跟踪文件的片段，`snapshotRole: 'dirty-overlay'`。
- 有错误时 Pack 仍发布，但状态 `partial`，原因逐条写入 `evidencePack.reason`。
- Store 失败：状态 `failed`，不阻断辩论。
- Store 未配置：状态 `unavailable`。

### 2.3 辩论状态

`DebateState` 新增：

```ts
repository?: {
  root; requestedRoot; source: 'conversation' | 'workspace' | 'task-worktree';
  commit; branch; dirty; dirtyFiles; dirtyFingerprint?; resolvedAt;
}
evidencePack?: {
  status: 'complete' | 'partial' | 'failed' | 'unavailable';
  baselinePackId?; itemCount; reason?; createdAt;
  commit?; branch?; dirty?;
}
```

旧辩论文件没有这两个字段，读成 `undefined`；不迁移、不回填。

### 2.4 启动链路

`debate:start`：

```text
conversation.workspaceRoot
  → input.workspaceRoot
  → input.workspaceId 对应的 workspace.root
```

只在 `workspaceMode === 'engineering'` 时解析；**不用全局默认目录兜底**。
`DebateOrchestrator.start(..., repository?)` 在创建状态后同步解析并发布基准 Pack；
失败只写 `evidencePack`，辩论继续。

### 2.5 失败矩阵

| 情况 | 状态 | 辩论 |
| --- | --- | --- |
| 干净仓库 + Pack 成功 | `complete` | 继续 |
| dirty 仓库 + 全部文件冻结 | `complete` | 继续 |
| 有删除/二进制/读不到/空文件 | `partial` | 继续 |
| 非 Git / 目录不存在 | `unavailable` | 继续 |
| Store publish 抛错 | `failed` | 继续 |
| Store 未配置 | `unavailable` | 继续 |

---

## 3. 未实现与原因

| 阶段 | 状态 | 原因 |
| --- | --- | --- |
| P2-4 每轮增量 Pack | NOT STARTED | 辩论轮次里没有「本轮涉及哪些仓库文件/行」的数据；只能冻结整份 dirty overlay，重复且无法归到 Claim |
| P2-5 Pack ↔ ClaimEvidenceLink | NOT STARTED | `ClaimEvidenceLink` 需要证据 id；基准 Pack 没有 Claim 关联，不能凭空生成 |
| P2-8 完整端到端 | PARTIAL | 已有「真实辩论 → 基准 Pack → DebateStore → 回放」；没有每轮 Pack 链路 |
| Pack 清理/保留 | NOT STARTED | 需要生命周期策略，未在本轮扩大范围 |

**不把「baseline Pack 已生成」写成「P2 完成」。**

---

## 4. 测试

`npm run test:repository-pack`：**15/15 通过**。

覆盖：

- 干净仓库解析 commit/branch，不产生片段；
- dirty 修改与未跟踪文件冻结，指纹随内容变化；
- 删除文件、符号链接、二进制/非 UTF-8 文件标错误；
- 嵌套未跟踪文件逐个冻结；
- 发布前文件被删除，Pack 仍回放解析时内容；
- Pack 损坏读取抛 `BLOB_CORRUPT`，partial 不冒充 complete；
- 非 Git 目录返回错误；
- 干净仓库基准 Pack 为零条目且可回放；
- dirty 内容回放可读到原文；
- 真实辩论启动写入 `repository/evidencePack` 并落盘；
- 非 Git 目录只标 `unavailable`，辩论照常完成；
- Store 抛错标 `failed`，辩论照常完成。

全量：

```text
npm run typecheck  → 三套全绿
npm test           → 105 个文件全过（27.2s）
```

---

## 5. 下一步

要让 P2-4/P2-5 成立，必须先补一个**工程证据生产者**：

- 从辩论发言/主张中识别 `path:line` 或代码引用；
- 或接入 code-index 查询，把引用解析为文件与行号；
- 再按轮生成 Pack，并用显式 `source: 'pack'` 建立 ClaimEvidenceLink。

在它存在之前，每轮 Pack 只能冻结「仓库变了什么」，不能回答「这条主张引用了哪段代码」。


---

## 6. 合并标记

本切片建议记录为 **P2 Foundation**（tag：`debate-v4.1-p2-foundation`）。
合并前审计见 `DEBATE_V4_1_P2_PRE_MERGE_AUDIT.md`；不创建 `p2-complete` 标签。
