# V3.1 实施计划重新审核（当前实现版）

- 审核对象：`/Users/yalla/Downloads/制定辩论主题方案 (9)-20261113-1131-2.md`
- 当前代码：`0.2.0-v3` / `74a6a1c`
- 审核日期：2026-11-13
- 说明：这份附件是 **V3.1**，不是最新的 V3.2。V3.2 的专项审核见
  `CODE_INTELLIGENCE_V3_2_PLAN_REVIEW.md`。

---

## 1. 结论

**V3.1 的方向仍然成立，但不能再按原状态表执行。**

V3.1 写下时，Gate 1B 的 Generation 原子化还没有实现；现在代码已经推进到：

- Schema v5；
- 新旧 Generation 并存；
- 失败/构建中的新代不可见；
- 旧代保留与清理；
- 4 轮工程读文件循环；
- 5 个真实工程问题基准。

但 V3.1 本身仍有三个问题：

1. 把 Gate 0/1A/1B 标成 `APPROVED`，容易被理解为已经验收通过；
2. Gate 1A 的 TS/JS 稳定 Symbol ID 还没有完成；
3. Gate 2 的范围已经被 V3.2 取代，不能同时按 V3.1 和 V3.2 各做一遍。

**建议**：以 V3.1 作为 Gate 1 的历史基线；当前执行以 V3.2 的 Gate 2A–2D 为准。Gate 1A 单独做。

---

## 2. V3.1 计划要求 vs 当前实现

| V3.1 要求 | 当前实现 | 状态 |
| --- | --- | --- |
| Gate 0 收尾 | ADR 状态、Maven、模型探测、Web UI、成本复核仍未全部完成 | **进行中** |
| Gate 1A Schema v4 | Schema 已到 v5，v4 加法迁移已落地 | **已超过 v4** |
| Gate 1A TS/JS Symbol ID | `symbolId` 仍回填 `nodeId`，路径仍在身份里 | **未完成** |
| Gate 1A Java provisional | 已标 `provisional` | **已完成** |
| Gate 1B Generation 原子化 | v5 generation 主键、copy-on-write、旧代保留、读过滤、GC | **已实现** |
| Gate 1B 扫描完整性 | 截断不删除；但超过 500 文件仍只索引前 500 | **部分完成** |
| Gate 1B FTS/vector/link 一致性 | FTS 按 current docs 过滤、vectors 绑 generation；link 仍未校验 | **部分完成** |
| Gate 1B 崩溃/并发 | 有失败/构建中不可见测试；没有进程级崩溃/并发读取压测 | **部分完成** |
| Gate 2 正式 Agentic Search | 4 轮 fs 工具循环；无正式状态机/预算/Tool Contract | **起步** |
| Gate 2 30 问题/3 工程 | 5 个问题、1 个工程；本地 business-flow 仍空壳 | **未完成** |
| Gate 3 Tree-sitter | 未进入产品主链路 | **未开始** |
| Gate 4 Evidence Pack | 未实现 | **未开始** |
| Gate 5 辩论融合 | 未实现 | **未开始** |

---

## 3. 这轮真正解决了什么

### 3.1 Generation v5 已经落地

当前 `SCHEMA_VERSION=5`，以下表进入 generation 作用域：

- `code_nodes`
- `code_edges`
- `code_search_docs`
- `code_vectors`
- `code_file_state`

关键行为：

- 新 generation 构建期间，读路径仍读旧 ready generation；
- 失败/取消不会覆盖旧代；
- 未变文件从旧代复制，变更文件写新代；
- 不完整扫描把未扫描旧文件复制到新代；
- FTS 通过 `doc_id + current docs` 过滤，避免混代；
- 旧代默认保留 current + 上一代；
- 实际 51MB v4 索引迁移到 v5，4 个工程数据保留。

这部分已经可以按 V3.1 的 Gate 1B 验收记录，但仍要补进程级崩溃和并发读取压测。

### 3.2 Agentic Search 从 1 轮到 4 轮

`askWithReadTool` 已从 1 轮扩到 4 轮，工具结果跨轮累积。  
但这仍是**文本 JSON 协议 + 4 个 fs 工具**，不是 V3.2 要的正式 Runtime。

### 3.3 5 问题基准

已扩到 5 个问题，云端 5/5 覆盖；本地 `business-flow` 预算耗尽后仍空壳。  
这正好验证了 V3.2 的 P0：**预算耗尽必须强制收束**。

---

## 4. 仍然阻断的问题

### P0-1：Gate 1A 的 TS/JS Symbol ID 仍未完成

当前：

- `symbolId` 在插入时默认 `nodeId`；
- `nodeId` 仍由文件路径参与计算；
- 没有“移动文件后 symbolId 不变”的实现或测试。

因此不能把 Gate 1A 标成 `PASSED`。

### P0-2：扫描完整性只做到“不误删”，没做到“索引完”

当前 `DEFAULT_MAX_FILES=500`：

- 超过 500 个文件只索引前 500；
- 没有分页、游标、source root 继续扫描；
- UI 只显示“扫描不完整”，不会继续索引剩余文件。

V3.1 的 Gate 1B 验收需要补“覆盖率/分页”，否则大工程仍然只能搜前 500 个文件。

### P0-3：V3.1 Gate 2 已被 V3.2 取代

V3.1 的 Gate 2 是“正式 Agentic Search + 14 工具 + 8 轮 + 30 问题”；  
V3.2 把范围收敛为：

- Budget Manager；
- 强制收束；
- Provider Tool Contract；
- 状态机；
- Web-only 降级。

不能同时按两份计划各写一套循环。建议：

- V3.1 Gate 2 标记为 **superseded by V3.2**；
- 当前只执行 V3.2 的 Gate 2A–2D；
- V3.3 再做 Symbol/Git 工具扩展。

### P0-4：V3.1 的“APPROVED”语义仍会误判

V3.1 第 4 章把 Gate 0/1A/1B 标成 `APPROVED`；但：

- Gate 0 还有 Maven、模型探测、Web UI、ADR 状态；
- Gate 1A 还有 Symbol ID；
- Gate 1B 还有扫描覆盖、并发/崩溃；
- Gate 2 只有 4 轮 fs 循环。

建议统一改成：

```text
AUTHORIZED / IN_PROGRESS / PASSED
```

只有验收报告和测试都齐了，才能 `PASSED`。

### P0-5：Evidence 仍然是临时状态

V3.1 的 Gate 4 仍 DEFERRED；V3.2 也明确不新建持久 Evidence Store。  
当前搜索只有工具结果文本和 Trace，没有：

- 稳定 `evidenceId`；
- Pack；
- Claim 关联；
- Generation 引用保护；
- stale 检测。

这不能在 V3.1 的 Gate 2 里顺手做成第二套事实模型。

---

## 5. 重新审核后的执行建议

### 当前应做

1. **Gate 1B 收尾**
   - 分页/游标/source root 覆盖；
   - 进程崩溃恢复测试；
   - 并发读取压测；
   - Code-Memory Link 的 generation 校验。
2. **Gate 1A 独立**
   - TS/JS Symbol Identity；
   - 文件移动测试；
   - Java provisional 保持到 Gate 3。
3. **V3.2 Gate 2A–2D**
   - 预算耗尽确定性报告；
   - Provider Tool Contract；
   - 状态机；
   - Web-only 降级；
   - business-flow 空壳回归。
4. **V3.3**
   - Symbol/Git 工具；
   - Generation 固定快照；
   - 30 问题/3 工程基准。

### 当前不应做

- 按 V3.1 Gate 2 再写一套 14 工具循环；
- 提前做 Tree-sitter 产品化；
- 提前做 Evidence Pack；
- 提前做 Jury/Jev；
- 把 5 问题结果当跨工程能力证明。

---

## 6. 最终意见

V3.1 作为 Gate 1 的历史基线仍然有效，且其 Gate 1B 已经被当前代码大幅落实。

但这份计划已经不是当前执行主线：

- **Gate 1B**：继续收尾，重点是扫描覆盖、崩溃/并发、Link；
- **Gate 1A**：独立完成 Symbol Identity；
- **Gate 2**：以 V3.2 的预算/收束/Tool Contract/状态机为准；
- **Gate 3～5**：继续 DEFERRED。

**一句话**：V3.1 的“先把 Generation 做可靠”已经做到大半；现在不要回头按 V3.1 重写 Agentic Search，应该按 V3.2 先修预算收束和 Tool Contract。
