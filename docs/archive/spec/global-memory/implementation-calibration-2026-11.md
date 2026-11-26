# 全局记忆实现期校准记录（历史）

> 文档状态：HISTORICAL。此文记录 2026-11 实施期改动原因，不是当前规范。最终规则以 [GLOBAL_MEMORY.md](../../../spec/GLOBAL_MEMORY.md) 为准。

## 8. 实施期校准记录（相对 V3.0 定稿）

> 定稿正文 §1–§7 保留原样作为审计基线。以下 6 处是**按评审 R2 授权的
> 「用固定语料校准评分公式」**、以及实现期发现的自身矛盾所做的必要修正。
> 每处都给了触发它的失败证据，不是重新讨论架构。

### 8.1 三哈希必须算同一个对象（修定稿 §1.1 的自相矛盾）

定稿写 `contextHash = sha256(renderedText)`，又写 `submittedSystemHash =
sha256(canonicalSystem(task.system))`，而 §1.2 要求「三哈希相等」才
`provider-confirmed`。`task.system` 里还有原有 system 指令，L2 永远不等于 L1，
`judgeInjection` 会一律判 `failed/hash-mismatch`，`provider-confirmed` 不可达。

实现改为：三处都算**同一个记忆块**（`MEMORY_BLOCK_PREFIX` 起始、固定为 system
最后一段）：
- L1：`contextHashOf(renderedText)`；
- L2：`submittedSystemHash()` 用 `memoryBlockFromSystem(task.system)` 重新抽出该块再算；
- L3：Provider 用 `systemHashFromMessages(assembledSystemMessages)` 从自己拼好的
  messages 的 system 段抽出该块再算。

三处代码互不引用、L3 不是入参回显。守门测试（「声明支持却丢 system 的假
Provider」→ `failed/provider-capability`）仍然有效，且实测通过。

### 8.2 召回评分改为乘性质量权重（修定稿 §2.2 的基线分缺陷）

定稿是 `score = 0.45*lex + 0.20*kind + 0.15*scope + 0.10*recency + …`。
其中 0.55 与查询**完全无关**：一条毫不相关的 active 记忆也约 0.49 分，高于
任何可行阈值 → §2.4 的「空召回零误命中」「P@5 ≥ .80」不可能达成。

改为 `score = lex * quality - penalty`，`quality` 仍是那六项加权和（和 = 1.00、
满分仍可达 1.0），但 `lex=0` 必得 0 分。静态项退化为质量放大系数，只决定同类
命中之间的排序，不再凭空造分。

### 8.3 长度归一化与多字段合并（修定稿 §2.2）

`0.6*jaccard + 0.4*coverage` 在语料上暴露系统偏差：用户问题常是 12 个 bigram、
记忆标题只有 5 个，jaccard 分母被长问题撑大，命中 2–6 个词也只有 0.13–0.2，
召回率仅 0.25。且逐字段加权平均会稀释命中（「数据库迁移」在 content、「迁移前」
在 title，任何单字段都覆盖不全）。

改为 `0.6*coverage + 0.4*jaccard`（coverage 天然按问题长度归一），并在
`lexScore` 里对「全字段合并后的整段」再算一次，与逐字段加权平均取 max。
这正是评审 R2 要求明确的「长度归一化 / 多个匹配字段如何合并」。

### 8.4 阈值冻结为 0.12

`corpus-v1`（40 记录 / 24 查询 / 8 空召回）扫描 0.10→0.35：
0.10 的 P@5=.783 不达标；**0.12 是满足全部指标的最小值**（P=.810 / R=.850 /
误注入 0 / 空召回 0）；0.13/0.14 也达标但非最小；≥0.15 起 R 掉到 .80 以下。
`.18` 作废。`check-memory-recall.mjs` 会重新扫描并断言最小值等于常量。

### 8.5 拆掉 `(scope, scope_id, normalized_key)` 唯一索引

唯一索引会在数据库层直接拒绝第二条同 key 的 active，于是「迁移残留 / 并发写入
产生冲突」永远不会有实体，`detectConflicts()` 形同虚设。改为普通索引，冲突交给
§2.3 的召回去重与 P6 的人工裁决。`importAll` 同步改为「已有 active 且内容不同则
保留旧记录 + 记冲突审计」，不再 `INSERT OR REPLACE` 抹掉当前决策。

### 8.6 注入收口点改为 `attachTaskMemory()`

定稿 §6 写「收口点 `SubAgentRegistry.ask/askStream`，四类链路都经过」。
复核源码后不成立：Master / Collaboration / Engineering / Debate 各自的
`askStreaming` 并不都经过同一个 pool 方法。实现改为
`src/main/memory/runtime.ts` 的 `attachTaskMemory(task, extra, scope)`：四个入口
各 3 行（attach → 用 `hook.task` 发问 → `hook.finalize(answer)`），内部共用
`attachMemory()` 一个函数，`question` 逐字不变。Web/CLI 的 skipped 判定、
requestId 冻结、送达落库都在这个 hook 里，入口不重复实现。

### 8.7 诚实边界不变

L3 仍只证明「适配器拼装并提交给传输层的载荷含该块」，不能证明对端收到，
也不能证明模型在推理中采用了它。UI 文案禁止写「模型已使用记忆」。
