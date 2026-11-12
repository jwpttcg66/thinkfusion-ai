# 代码智能 V1.2：多 Agent 交接、补丁安全、验证闭环

日期：2026-11-11。依据：`制定辩论主题方案 (4)-20261111-2005-8.md` 的审查结论。
基线：ThinkFusion `d353f152`；对照 DeepSeek Harness `e8f7b93a`、OpenCode `611cee9d`。

这份文档把审查报告转成可执行的增量任务，并记录哪些已经落地、哪些明确不做。
不重建 Runtime：所有写入仍然走 `fs.edit` / `fs.applyPatch` / `fs.writeFile`，
所有验证仍然读 `StepResult` 与 `ExecutionReport`。

## 1. 裁决

| 报告条目 | 本次处理 | 代码位置 |
| --- | --- | --- |
| P0 多 Agent 从并行提案升级为真实交接 | **已实现**：两阶段，Diff 进 Verify/Review 提示词 | `src/main/coding/team.ts` |
| P0 Diff 路径、版本、冲突校验 | **已实现**：解析 → 路径 → dry-run → expectedHash → 冲突 | `src/main/coding/patch.ts`、`src/shared/unified-diff.ts` |
| P0 验证结果结构化 | **已实现**：compile / tests / diagnostics / changedFiles | `src/agent/verification.ts` |
| P1 LSP Provider 统一管理 | **已实现（TypeScript Provider + 明确的不可用）** | `src/main/lsp/providers.ts` |
| P1 读取—修改—版本校验闭环 | **已实现**：edit / applyPatch 强制 expectedHash | `src/agent/tools/fs-extra.ts`、`src/agent/tools/extended.ts`、`src/shared/contracts.ts` |
| P1 文件修改精确性 | **已实现**：唯一匹配、replaceAll、CRLF、标点回退、文件锁、回读 | `src/agent/tools/fs-extra.ts`、`src/agent/tools/file-lock.ts` |
| P2 Agent Team 任务 DAG / CAS | **已实现**：dependsOn、revision/expectedRevision、完成证据 | `src/main/team-board.ts` |
| P2 Session / 工作区隔离 | **已实现**：read/write + workspace 串行、成员树、会话级任务板 | `src/main/team-board.ts`、`src/main/index.ts` |
| P2 Git Worktree | **已实现**：create 新建分支、脏工作树需 force、不自动清理 | `src/agent/tools/extended.ts` |
| P3 向量代码索引 | **不做**：保持 provider API 边界 | `src/main/embeddings/service.ts` |

## 2. P0：多 Agent 真实交接

### 2.1 原来的问题

旧 `runCodingTeam` 把四个角色一起 `Promise.all`：

```text
Explore ─┐
Code    ─┼─ 同一段任务描述，彼此看不到结果
Verify  ─┤
Review  ─┘
```

Verify / Review 的提示词里没有 Code 的 diff，所谓「交叉评审」只是四份互不相干的意见。

### 2.2 现在的两阶段

```text
阶段一（并行）
  Explore：只读事实（路径:行号）
  Code：输出 unified diff
        │
        ▼
  补丁安全层：解析 / 路径 / dry-run / expectedHash / 冲突
        │
        ▼
阶段二（并行）
  Verify：hunk 是否对得上、跑什么命令、预期退出码
  Review：接口兼容、边界、测试缺口、可回退性
```

Verify / Review 的提示词里有三块真实上游结果：

1. Explore 的原文；
2. Code 的原文；
3. 每个补丁的路径、增删行数、校验结论、`expectedHash`、diff 原文。

成员数不足时按顺序复用成员，但 Review 不会复用 Code（1 个成员除外），
避免「自己审自己」被当成独立评审；默认取 4 个可用 API 成员。两个阶段各自带 `stages[].status`，
失败是 `partial`，不假装完整。

### 2.3 返回值

`CodingTeamResult` 新增：

- `patches: ValidatedPatch[]`：Code 的每个补丁带 `valid` / `reason` / `expectedHash`；
- `applyable: boolean`：全部补丁都通过路径、版本与 dry-run 才为 true；
- `stages: CodingStage[]`：两阶段各自用了谁、是否完整；
- `proposals[].context`：这次回答之前实际交给它的上游结果。

边界不变：**多 Agent 只出方案，不写工作区**。应用仍走
`fs.applyPatch + expectedHash`，写后继续诊断/测试。

## 3. P0：补丁安全链

```text
Diff Parse
  → Path Validation
  → Expected Hash Validation
  → Hunk Dry-run
  → Conflict Detection
  → Plan Approval
  → fs.applyPatch
  → Post-write Diagnostics
```

### 3.1 解析与应用共用一套规则

`src/shared/unified-diff.ts` 提供 `parseUnifiedDiff` / `applyUnifiedHunks`。
`fs.applyPatch` 与方案阶段的 dry-run 使用同一份实现，避免「预检说能过、
落盘说不能过」。

### 3.2 路径

`normalizePatchPath`：

- 去掉 `a/`、`b/` 前缀与时间戳；
- 拒绝绝对路径、`..`、空路径；
- 统一 `\` 为 `/`，再做 `path.posix.normalize`；
- 最终还要 `path.relative(root, absolute)` 再确认没有越界。

新建文件不走 `fs.applyPatch`（它只改已有文件），必须走 `fs.writeFile`。

### 3.3 版本

每个有效补丁带当前文件的 `sha256` 作为 `expectedHash`。真正落盘时
`fs.applyPatch` 再读一次文件并核对；不一致就整份拒绝。

### 3.4 冲突

- 同一方案重复改同一文件：后一个标 `valid:false`；
- 一个 diff 代码块里出现多个文件：整块标 `valid:false`（补丁只按一个目标应用，
  多文件必须拆成多个代码块，避免把 hunk 应用到错误文件）；
- 跨方案同一文件：`detectPatchConflicts` 列出 `{ path, agents }`；
- 当前只有一个 Code 角色，跨方案冲突通常为空；函数保留给多 Code 角色。

## 4. P0：验证结果结构化

`ExecutionReport.verification` 现在带：

```json
{
  "verified": false,
  "reasons": ["测试失败（npm test，退出码 1）"],
  "changedFiles": 2,
  "changedPaths": ["src/a.ts", "src/b.ts"],
  "checks": {
    "compile": { "status": "passed", "exitCode": 0, "command": "npm run typecheck" },
    "tests": { "status": "failed", "exitCode": 1, "command": "npm test" },
    "diagnostics": { "status": "passed", "errors": 0, "warnings": 2, "source": "tsserver" },
    "changedFiles": ["src/a.ts", "src/b.ts"]
  }
}
```

规则：

- 只读 `StepResult`，不允许模型填写；
- `typecheck` / `build` 归 `compile`，其余 `test.run` 归 `tests`；
- `code.diagnostics` 的 `counts.errors` 归 `diagnostics`；
- `verified` 仍按「没有失败写操作，且至少一个检查通过」；
- 老报告没有 `checks` 时按「未记录」处理，不补默认值。

## 5. P1：LSP Provider 层

`src/main/lsp/providers.ts`：

```text
code.definition / references / symbols / hover /
context / impact / diagnostics
        │
        ▼
LspProviderRegistry.providerFor(file)
        │
        ▼
TypeScriptProvider → TsServerClient → tsserver
```

- 按扩展名选 Provider；
- 客户端按工作区 root 缓存，不同 root 各自一个 tsserver；
- 没有对应 Provider 时明确
  `LSP_UNAVAILABLE：.py 还没有语言服务 Provider（当前只有 TypeScript / JavaScript）`；
- 不拿正则或文本搜索冒充语义结果。

当前只注册 TypeScript Provider；Java / Go / Python 等按需再加，不在第一阶段
安装所有语言服务器。

## 6. P1：读取—修改—版本校验

### 6.1 强制观察

`fs.edit`、`fs.applyPatch`、`fs.writeFile(overwrite:true)` 都要求
`expectedHash`（64 位十六进制 sha256）。缺失时：

```text
OBSERVATION_REQUIRED：修改已有文件前先 fs.readFile / fs.stat 拿到 sha256，
并在 expectedHash 里回填
```

`PlanSchema` 同样拒绝没有 `expectedHash` 的 `fs.edit` / `fs.applyPatch`
步骤。模型只能分两轮：先只输出 `fs.readFile`，下一轮拿到 sha256 再改。

### 6.2 精确编辑

- `oldString` 默认必须唯一命中；多处命中直接拒绝；
- 显式 `replaceAll: true` 才允许全量替换；
- CRLF / LF 混用时统一成 LF 匹配，写回恢复原换行风格；
- 精确匹配失败时，才退回弯引号 / 长短破折号 / 不换行空格的逐字符归一化；
  归一化是 1:1 的，只会替换命中的那一段，不改整份文件的标点；
- 同进程内按文件路径排队（`withFileLock`）；
- 写入后重新读盘并比对 sha256，不拿内存里的 `next` 当证据；
- 写后自动诊断仍由 `local-plugins.ts` 的 `withPostWriteDiagnostics` 完成。

## 7. P2：任务 DAG / CAS 与工作区隔离

### 7.1 任务 DAG

`ConversationTeamTask` 新增 `dependsOn`。创建时逐个校验依赖存在、不重复、
不依赖自己；开工（doing）和完成（done）前再检查依赖是否都 done。
`team.task.list` / `team.wait` 直接给 `ready` 与 `blocked`（带缺哪些 id），
不再让模型自己从一列任务里猜顺序。

任务仍然只存在 `Conversation.teamTasks` 里，不新建第二套任务系统；
`ExecutionReport` 仍是执行结果账本，任务证据可以指向报告/测试/提交。

### 7.2 CAS

每个任务带 `revision`（老任务按 1 处理）。`team.task.update` 必须带
`expectedRevision`；不一致直接：

```
CAS_CONFLICT：task-3 已经被更新（当前 revision 4，你拿的是 2）；
先 team.task.get 再改
```

成功后 `revision + 1`。这样两个 Agent 同时认领/更新一条任务时，
后到的不会把前一个的进度覆盖掉。

### 7.3 完成证据

`done` 必须带至少一条 `evidence`：

```json
{ "kind": "test", "ref": "npm test", "detail": "退出码 0，42 条通过" }
```

`kind` 只允许 `execution_report / test / diagnostic / commit / note`；
证据追加保存（最多 50 条），不用一句 note 代替依据。

### 7.4 成员树

`team.spawn` 支持 `parent`，写入 `Conversation.teamParents`。
父级必须已经在这次协作里；自指或成环在写盘前拒绝。
这不创建新 Agent：成员仍然只能来自现有参与者 id。

### 7.5 工作区隔离

- 任务新增 `mode: read | write` 与 `workspace`；
- 只读任务可以共享工作区；
- `write` 任务在同一 `workspace` 同时只能有一个 `doing`，否则：

```
WORKSPACE_BUSY：工作区 /repo 正被 task-2（cloud:xxx）写入；
等它完成或换 worktree
```

- 需要真正并行写同一工程时，把任务指向不同 `git.worktree` 路径即可；
  `git.worktree` 现在支持 `create: true` 用 `-b` 新建分支。
- 移除工作树前先看 `git status --porcelain`；有未提交/未跟踪内容时
  `WORKTREE_DIRTY`，只有显式 `force: true` 才删。应用不会自动清理未完成的
  worktree。
- 新会话从空任务板开始，不继承旧会话的 `teamTasks` / 写入占用；
  后台任务不会跟着“分叉”到新会话。这是 OpenCode Fork 语义在现有产品里的
  落地，不需要再造一个 fork API。

## 8. P3：明确不做

保持与 OpenCode 一致的边界：`src/main/embeddings/service.ts` 只提供
“文本 → 向量”，不接主循环、不建代码索引。只有真实出现跨文件语义检索
瓶颈时才考虑。

## 9. 验证

```bash
cd desktop-agent-macos
npm run typecheck
npm run build:agent
npm run build:test
node --test scripts/check-coding-team.mjs
node --test scripts/check-verify.mjs
node --test scripts/check-local-tools.mjs
node --test scripts/check-extended-tools.mjs
node --test scripts/check-lsp.mjs
node --test scripts/check-execution-timeline.mjs
node --test scripts/check-team-board.mjs
node --test scripts/check-extended-tools.mjs
```

断言点：

- Code 的 diff 原文出现在 Verify / Review 的 `question` 里；
- 补丁 `expectedHash` 等于当前文件 sha256；
- 过期补丁 `valid:false`，`applyable:false`；
- 没有 `expectedHash` 的编辑 / 补丁在工具层与 PlanSchema 层都被拒绝；
- CRLF 文件编辑后仍是 CRLF；
- 结构化验证能区分 compile / tests / diagnostics；
- `.py` 走 `LSP_UNAVAILABLE`，不返回空数组冒充「没有定义」；
- 同一个 `stepId` 的 approval / started / completed 合成一张卡，跨轮不串；
- 任务依赖没完成不能 doing/done；旧 revision 覆盖得到 CAS_CONFLICT；
- write 任务同一工作区只能一个 doing；脏工作树不 force 不删。

## 10. 执行界面：按步骤分卡

原来的工程主界面只有一张 `ExecutionLog` 文本流：`完成 fs.edit` 看不出
改哪个文件、改了哪几行；`完成 code.definition` 看不出跳到哪一行。
V1.2 把同一个 `stepId` 的 `started / approval / completed / failed`
合成一张卡：

```text
● 改文件   src/renderer/src/App.tsx          完成 · 1.2s
  ├ 参数：path / oldString / newString
  ├ diff：- 旧行 / + 新行
  └ 写后诊断：tsserver · 0 error / 2 warn

● 找引用   src/shared/contracts.ts:689        完成 · 180ms
  └ src/main/orchestrator.ts:412  0 处调用   EXACT
    src/main/agent-host.ts:88     引用        POSSIBLE
```

- 事件新增 `step.started.args`、`step.completed.durationMs`、`step.failed.durationMs/args`，
  卡片不用等结果就能显示目标；
- `code.team.run` 展示两阶段、每个补丁的 `valid` / `expectedHash` / 冲突；
- 验证卡展示 compile / tests / diagnostics 三行结构化结果；
- 只渲染事件里真实带的东西：没有结果就不补「成功」。

## 11. 剩余风险

1. **两轮读取增加一次往返**：这是版本保护的代价，不是回归。
2. **模型仍可能给出过期补丁**：dry-run 会拒绝，但需要模型重新读文件；
3. **跨进程锁不存在**：外部编辑器不经过 `withFileLock`，真正兜底是
   `expectedHash`；
4. **Verify / Review 是并行而不是串行**：Review 看不到 Verify 的结论；
   如果以后需要「验证后再评审」，把阶段二拆成两段即可，接口不变。
5. **workspace 是协调规则，不是新的文件授权**：`team.task` 的 `workspace`
   用来阻止两个 write 任务同时开工；真正执行 `fs.edit` / `fs.applyPatch`
   仍然走 `TaskGrant.rootDir`。要让任务真的写进 worktree，就把工作区授到
   那个 worktree 路径；不要用 `workspace` 字段绕过授权。
6. **worktree 不自动清理**：`git.worktree remove` 默认真实检查脏文件，
   未提交内容会报 `WORKTREE_DIRTY`；只有 `force:true` 才删。应用启动时
   不扫描、不删除任何 worktree。
