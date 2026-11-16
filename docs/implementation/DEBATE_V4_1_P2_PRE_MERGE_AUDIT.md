# P2 基准切片合并前审计

- 审计对象：`0.2.9` 的 P2 基准切片（提交 `3fde988` + 本轮修复）
- 基线：`main` = `abf4b45`
- 结论：**可以合并为 P2 Foundation；不能标 P2 完成，也不能接 Claim↔Pack**

---

## 1. 审计发现与处理

| # | 发现 | 风险 | 处理 |
| --- | --- | --- | --- |
| 1 | `git status` 默认只列未跟踪目录，不列目录内文件 | dirty overlay 会漏掉未跟踪文件 | 改为 `--untracked-files=all`，并加嵌套未跟踪文件测试 |
| 2 | 未检查符号链接 | 可能冻结仓库外文件，造成泄露 | `lstat` 拒绝符号链接，标 `partial`，加测试 |
| 3 | 解析时读内容、发布时重读文件 | 两次读之间文件变化会让 Pack 内容与指纹不一致 | `EvidencePackItemDraft` 支持显式 `content`；baseline 使用解析时内容，加「发布前删文件仍回放原内容」测试 |
| 4 | 二进制/非 UTF-8 文件按 utf8 读会产生替换字符 | 冻结内容失真 | 检测 NUL 与 UTF-8 往返不一致，标 `partial` |
| 5 | 删除文件无法冻结正文 | 可能被误读成完整快照 | 保留 `partial` 状态与原因，加测试 |
| 6 | Pack 损坏后状态仍是 `complete` | 消费方可能误用损坏 Pack | 存储层读取时抛 `BLOB_CORRUPT`；消费方必须走 `get/replay`，不能只信状态字段 |
| 7 | Pack 创建在 `start()` 同步执行 | 大 dirty 树可能阻塞启动 | 保留为已知限制；P2 后续再改异步，不在本切片扩大 |
| 8 | 任务 Worktree 优先级没有接入 | 生命周期最优先的工程来源缺失 | 当前 `debate:start` 没有 taskId，不能凭空关联；文档标 P2-1 未完全覆盖 |
| 9 | 每轮 Pack / Claim 关联缺失 | 无法回答「这条主张引用了哪段代码」 | 明确不在本切片；需要工程证据生产者 |

## 2. 审计后仍存在的边界

1. **任务 Worktree**：优先级规则已定，但入口没有 taskId。等 P2 生产者或任务链路
   把 worktree root 显式传进 `debate:start` 再接，不能靠猜。
2. **同步冻结**：`start()` 里同步解析/发布，dirty 文件很多时会拖慢启动；当前
   限制写在这里，不伪装成异步。
3. **Pack 状态不是校验结果**：`evidencePack.status` 表示「创建时」的状态；
   之后文件损坏只能通过 `EvidencePackStore.get/replay` 发现，消费方不得跳过校验。
4. **每轮 Pack 与 Claim 关联**：未实现，原因见 P2 文档。

## 3. 合并前验收

| 项 | 结果 |
| --- | --- |
| P2 基准切片测试 | `test:repository-pack` 15/15 |
| 开场 Pack 绑定工程目录与 Git 基准 | 通过 |
| dirty overlay 包含未跟踪文件（含嵌套） | 通过 |
| Pack hash/内容损坏不能当有效证据 | `BLOB_CORRUPT` 测试 |
| Pack 失败不伪装成功、不阻断辩论 | `failed` / `unavailable` 测试 |
| Replay 可恢复并验证冻结内容 | 通过 |
| 文档写明 P2-4/P2-5/生产者未完成 | 已写入 P2 文档 |
| 不存在伪造的 Claim↔Pack 关联 | 本切片没有生成任何 pack 关联 |
| P0 冻结基线与历史回归未修改 | 无改动 |
| 全量测试 / typecheck | 待本轮最终运行 |

## 4. 合并标记

建议 tag / 记录名：

```text
debate-v4.1-p2-foundation
```

不创建 `p2-complete` 标签，也不在文档里写「P2 完成」。
