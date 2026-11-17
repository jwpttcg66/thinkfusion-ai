# P2 基准一致性校验

- 分支 / 工作树：`evidence-producer` / `/Users/yalla/data/localLab/thinkfusion-ai-evidence-producer`
- 起点：`78ef16c`（代码引用识别与定位）
- 目标：同一条代码引用，无论辩论后工作区如何变化，都必须从开场基准恢复相同内容
- 本轮不做：每轮增量 Pack、ClaimEvidenceLink(source: 'pack')、真实辩论接线

---

## 1. 快照元数据（阶段 A）

`EvidencePackManifest` 新增可选 `snapshot`：

```ts
interface EvidencePackSnapshot {
  version: 1;
  dirty: boolean;
  dirtyFingerprint?: string;
  files: Array<{
    path: string;
    ranges: Array<{ startLine; endLine; contentHash }>;
    issues: Array<{ code; path?; message }>;
  }>;
  errors: Array<{ code; path?; message }>;
}
```

规则：

- `ranges[].contentHash` 是**片段原始 UTF-8 内容的 sha256**，不是 Pack blob hash；
- `dirtyFingerprint` 对路径、行号、片段 hash、结构化错误排序后计算；
- `snapshot` 参与 `manifestHash`；旧 Pack 没有 `snapshot`，hash 输入与旧版完全一致，
  仍可 replay；
- `EvidencePackStore.get/replay` 校验：
  - manifest hash；
  - 快照指纹；
  - 每个 snapshot range 必须能对应到同路径/行号的条目，且条目内容 raw hash 一致；
- 旧 dirty Pack 没有快照元数据时，基准解析器拒绝恢复 dirty 文件，不猜。

没有用拼接后的 `reason` 文本代替结构化错误；错误逐条存在 `issues/errors`。

---

## 2. BaselineCodeReferenceResolver（阶段 B）

`src/main/evidence-pack/baseline-code-reference-resolver.ts`

输入：

```ts
{
  state: { debateId, repository, evidencePack },
  baselinePackId,
  store,
  candidate: { path, startLine, endLine, confidence }
}
```

校验顺序：

1. `state.repository` 存在；
2. `state.evidencePack.baselinePackId` 与输入一致；
3. Pack 状态不能是 `failed` / `unavailable`；
4. `store.replay(packId)` 验证 manifest + blobs；
5. Pack 的 commit / dirty / branch 与 `DebateState.repository` 一致；
6. 快照指纹与 `state.repository.dirtyFingerprint` 一致；
7. 文件在开场时是否 dirty：
   - 在 `snapshot.files` 中 → 只从 Pack 重组；
   - 不在 → 只从开场 commit 读取；
8. 行号、编码、大小、空片段全部校验。

### 2.1 dirty 文件

- 取该路径全部 ranges，按 `startLine` 排序；
- 要求从第 1 行开始、无重叠、无缺口；
- 每个 range 找到同路径/行号的 Pack 条目；
- 条目内容 raw hash 必须等于 range.contentHash；
- 按行拼接重组完整文件；
- 重组后提取引用范围；
- 任何一步失败返回错误码，不返回半份文件。

### 2.2 clean 文件

```text
git ls-tree -z <commit> -- <path>   # 先看 mode，拒绝 120000/040000/160000
git cat-file -s <commit>:<path>     # 大小上限
git show <commit>:<path>            # 只读开场 commit
```

- 不使用当前 HEAD，不读当前工作区；
- 使用 `execFileSync` 参数数组，不拼 shell；
- CRLF 统一成 LF；末尾换行不产生可引用的空行。

### 2.3 状态

| 情况 | 结果 |
| --- | --- |
| Pack 完整、文件可恢复 | `baseline-verified` |
| Pack 为 `partial`，但该文件完整可恢复 | `partial`（内容可用，但不标 verified） |
| Pack 失败/不可用 | `unavailable` |
| Pack 损坏、指纹不一致、未冻结文件、越界、路径非法 | `rejected` + 稳定错误码 |

错误码包括：`NO_REPOSITORY`、`NO_BASELINE`、`PACK_MISMATCH`、`PACK_UNAVAILABLE`、
`PACK_CORRUPT`、`SNAPSHOT_MISSING`、`SNAPSHOT_CORRUPT`、`PATH_INVALID`、
`FILE_UNFROZEN`、`FILE_NOT_IN_BASELINE`、`RANGE_INVALID`、`FILE_TOO_LARGE`、
`RANGE_TOO_LARGE`、`BINARY`、`SYMLINK`、`GIT_READ_FAILED`、`CHUNK_GAP`、
`CHUNK_OVERLAP`、`CHUNK_MISSING`、`FINGERPRINT_MISMATCH`。

`baseline-verified` 只表示「内容来自经过校验的开场基准」，不表示它支持某条 Claim。

---

## 3. 路径与读取安全（阶段 C）

`code-references.ts` 已加固：

- 逐级检查路径组件，中间目录为符号链接也拒绝；
- 最终文件用 `O_NOFOLLOW` 打开，读取前 `fstat` 再取内容；
- 拒绝绝对路径、`..`、反斜杠、NUL；
- 文件上限 2 MiB、行数上限 20,000、单次片段上限 2,000 字符；
- 行号必须是安全整数；超限明确失败，不截断伪装成功。

**残余竞态**：检查目录组件与打开最终文件之间，父目录仍可能被替换。
`O_NOFOLLOW` 只覆盖最终文件被替换成符号链接这一种；这一边界写在代码与文档里，
不宣称绝对无竞态。

---

## 4. Hash 语义（阶段 D）

| Hash | 输入 | 用途 |
| --- | --- | --- |
| `excerptHash` | 片段原始 UTF-8 内容 | 代码引用内容校验 |
| Pack blob hash | `sha256('blob\0' + content)` | Evidence Pack 存储校验 |
| dirty chunk `contentHash` | 片段原始 UTF-8 内容 | dirty overlay 重组校验 |
| `dirtyFingerprint` | 路径 + 行号 + 片段 hash + 结构化错误 | 快照漂移检测 |
| Git commit | Git 对象 | clean 文件来源 |

三者不能互相替代。测试明确断言 `excerptHash` 不等于 blob hash。

CRLF/LF：统一规范成 LF；文件末尾换行不产生额外可引用行。

---

## 5. 测试

新增：

```bash
npm run test:code-references          # 8/8
npm run test:baseline-code-reference  # 15/15
```

覆盖：

- clean commit 恢复；辩论后改工作区/HEAD，仍返回开场内容；
- dirty modified / untracked 从 Pack 恢复，辩论后修改/删除不影响；
- 跨 chunk 引用重组；
- 仓库 dirty 时开场干净文件仍从 commit 读；
- Pack 损坏、快照篡改、commit/fingerprint 不一致；
- partial 基准：未冻结文件拒绝，其它文件标 partial；
- 旧 dirty Pack 无快照元数据：拒绝；
- chunk 重叠/缺口；
- Hash 语义与 fingerprint 敏感性；
- 开场 commit 中的符号链接、开场不存在的文件；
- 路径穿越、绝对路径、中间目录符号链接、超大文件、超大片段。

回归：

```bash
npm run test:repository-pack   # 15/15
npm run test:evidence-pack     # 9/9
npm run typecheck              # 三套
npm test                       # 本轮最终运行
```

---

## 6. 仍未完成

| 项 | 状态 |
| --- | --- |
| 真实辩论调用 `BaselineCodeReferenceResolver` | NOT INTEGRATED |
| 每轮增量 Pack | NOT STARTED |
| ClaimEvidenceLink(source: 'pack') | NOT STARTED |
| 符号/代码索引解析（path-only 候选） | NOT STARTED |
| 模型引用提取（当前仅文本正则） | NOT STARTED |

本轮没有创建任何 Claim↔Pack 关联，也没有把 resolver 接进辩论编排器。
"基线内容可信"和"证据支持主张"仍是两件事。
