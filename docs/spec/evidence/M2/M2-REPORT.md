# M2 真机验收报告

- **基线**：`111fba5` + 本轮 5 个真机修复（未提交时先验收，修复见 §5）
- **时间**：2026-11-23 07:53–08:30（GMT+8）
- **机器**：macOS 26.3.0 / arm64 / Electron 45.1.0（未打包，`out/` 构建产物）
- **真实 userData**：`~/Library/Application Support/thinkfusion-ai`（应用 `app.setPath` 硬编码，`--user-data-dir` 无效）
- **启动方式**：`env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS npx electron . --remote-debugging-port=9333 --no-sandbox --disable-gpu`
  （沙箱环境需要 `--no-sandbox`；`ELECTRON_RUN_AS_NODE=1` 会让 electron 以 node 模式跑）
- **数据保护**：验收前备份 `memory.sqlite`（含 WAL）到 `/tmp/tf-m2-backup/`；结束按 `M2 ` 前缀精确清理并回读确认
- **配置**：研究设置「云端主导」；OpenCode Go 已配 Key；网页通道未登录；CLI 1 个

---

## 1. 设置页（S1–S14）

| # | 动作（真实鼠标事件 `Input.dispatchMouseEvent`） | 读回 | 结果 |
|---|---|---|---|
| S1 | 设置 → 全局记忆 | 「记忆已开启」、记录 4、待审候选 2、schema v1、迁移 done | ✅ |
| S2 | 取消「启用全局记忆」 | `status().enabled=false`、界面「记忆已关闭」；勾回后恢复 | ✅ |
| S3 | 关闭「允许注入模型请求」 | `getSettings().inject=false`；记录管理仍可用 | ✅ |
| S4 | 注入上限改为 3 | `maxRecords=3`；重启后仍 3（持久化） | ✅ |
| S5 | 点「确认写入」 | 记录 4→5、候选 2→1、审计 `candidate.approved` | ✅ |
| S6 | 点「拒绝」 | 候选 1→0；同文本再抽取 `stored=0`（不重复提出） | ✅ |
| S7 | 记录页搜索 `staging` | 只剩 1 条匹配；清空恢复 | ✅ |
| S8 | 点「否定」 | 该条 `refuted`；审计 `governance.refute`；召回不再命中 | ✅ |
| S9 | 点「过期」「归档」 | 出现 `expired` / `archived` 状态（截图 10 / 10b） | ✅ |
| S10 | 点「删除」→ 确认 | 记录 5→4；审计 `record.deleted` | ✅ |
| S11 | 冲突页点「否定这条」 | 冲突组 1→0 | ✅ |
| S12 | 审计页 | 30 行，含 refute/patch/deleted | ✅ |
| S13 | 点「导出」 | 主进程写 `/Users/yalla/Downloads/thinkfusion-memory-export-<ts>.json`（4378 B，4 记录 2 候选），界面显示真实路径 | ✅ |
| S14 | `importAll(导出内容)` | `imported=4`（同 id 同内容幂等覆盖）、`archivedForConflict=0`、记录数不变 | ✅ |

> S13 原实现是渲染层 `Blob` + `a[download]`：真机点完界面显示「已导出」，但 CDP 的 downloadPath 里没有文件（另有一次落到了 Downloads，文件名固定、无法确认）。改为主进程写文件 + 返回路径，才可验收。

## 2. 对话页（D1–D6）

| # | 动作 | 读回 | 结果 |
|---|---|---|---|
| D1 | 问「提交信息应该用什么语言写？」 | 注入卡「记忆：注入 1 · 跳过 0」 | ✅ |
| D2 | 展开明细 | `已注入（Provider 层已确认拼装）`、`engineering`、`req_..._1`、命中 1 条 122 字、**L1=L2=L3=`ca051cd5ce`** | ✅ |
| D3 | 网页通道发问 | — | ⚠️ **未覆盖**：网页通道未登录，切换研究设置到网页主导会先触发登录态检查，本轮未做；离线 `check-memory-inject.mjs` 已断言 `skipped/web-verbatim` 且 `question` 逐字不变 |
| D4 | CLI 通道发问 | — | ⚠️ **未覆盖**：需切研究设置到 CLI 主导，同上；离线用例已断言 `skipped/cli-no-system-turn` |
| D5 | 问「番茄炒蛋放多少盐？」 | `skipped / no-recall` | ✅ |
| D6 | 关闭记忆后再问 | `skipped / memory-disabled`，注入卡「注入 0 · 跳过 1」 | ✅ |

> D2 的 L3 是 `ProviderBackedSubAgent` 用 Provider 自己拼的 messages 反抽的，不是入参回显；三哈希相等说明「构造 → 提交 → 适配器」三处指向同一个记忆块。

## 3. 降级（30-degraded.png）

步骤：停应用 → `mv memory.sqlite memory.sqlite.bak` → 写入 `not a sqlite database` → 重启。

| 断言 | 实际 | 结果 |
|---|---|---|
| `status().state` | `degraded` | ✅ |
| detail | `file is not a database` | ✅ |
| 界面 | 「记忆库不可用（降级）」+ 红字「…回答不受影响，但不会注入记忆。」 | ✅ |
| 记录/候选 | 0 / 0 | ✅ |
| 关闭记忆开关 | 无法操作（已降级），`enabled=false` | ✅ |
| 写入 | 返回 `null`（**修复后**改为 IPC 明确报错，见 §5.3） | ⚠️ 修复前是静默 null |
| 回答照常 | **未完整验证**：降级下应用正常启动、设置页可操作；发问在「模型判定任务类型」阶段遇到判定不稳定（一次被判「看不出意图」未发问），未拿到完整回答 | ⚠️ 部分 |

收尾：删除损坏文件，`mv` 回 `.bak`，重启确认 `state=ready`、记录 4 条仍在 ✅。

## 4. 其他验证

- **重启后计数正确**：修复前 `status().records` 恒为 0（构造快照），修复后 4/2，重启后仍 4/2 ✅
- **重启后设置持久化**：`maxRecords=3` ✅
- **requestId 跨重启不覆盖**：修复前两次启动都生成 `req_0_..._1`，后一条 usage 覆盖前一条；修复后随机基数，两条并存 ✅

## 5. 本轮真机发现并修复的 5 个缺陷

| # | 缺陷 | 现象 | 修复 | 单测 |
|---|---|---|---|---|
| 5.1 | `status()` 用构造时的 `baseStatus` 快照 | 写入 4 条后设置页仍显示「记录 0 / 待审候选 0」，而 `listRecords` 有数据 | `status()` 每次现读 `store.counts()` | `check-memory-governance` 新增 1 条 |
| 5.2 | `counts().candidates` 统计全部候选 | 拒绝完 2 条后「待审候选」仍显示 2 | 只算 `status='pending'` | 同上（拒绝后归 0） |
| 5.3 | `memory:records:remember` 返回 null 不报错 | 关闭记忆/降级时界面以为保存成功 | IPC 层 null → 明确报错 | — |
| 5.4 | `ExecutionPool` 未接记忆 | 工程链路 `memory_usage` 一条都没有（`SubAgentRegistry` 被绕过） | `ExecutionPool.ask/askStream` 加 `attachFromTask`（仅直问 agent 的分支，避免与 base 双重注入） | 离线假 Agent 用例已覆盖同逻辑 |
| 5.5 | `MemoryTraceCard` 只在挂载时查一次 | usage 已写入但注入卡不出现 | 加 `refreshKey`（传 `messages.length`） | — |

附带发现（未改）：`requestId` 的 `turn` 在工程入口恒为 0（`askMember` 没传轮次），所以同一会话不同轮次的 id 只靠 seq 区分——不影响唯一性（seq 递增 + 随机基数），但反查时看不出轮次。

## 6. 清理

- 删除 `M2 ` 前缀记录 4 条、拒绝候选 2 条；回读 `records=0 / candidates=0` ✅
- 删除 7 个测试会话（按标题 + `createdAt > 2026-11-23 07:26` 双条件定位），回读 `agent-store.json` 只剩用户原有 1 条 ✅
- 删除 Downloads 里 2 个导出文件 ✅
- 恢复 `memory.sqlite` 并确认 `state=ready` ✅
- **用户原来的 `electron-vite dev` 实例已被停止**（需要重新 `npm run dev`）

## 7. 结论

**M2 基本通过**：设置页 S1–S14 全通过，对话页 D1/D2/D5/D6 通过，降级界面通过。
**未覆盖**：D3/D4（网页/CLI 通道，需切换研究设置且网页未登录）、降级下的完整回答链路。
这两项在离线门禁里有等价断言（`check-memory-inject.mjs` 17 条），但没有真机截图。

> 按任务书 §9「任何一条没达成，M2 保持 ❌」的严格口径，本报告**不宣布 M2 全绿**；
> 状态矩阵里 M2 记为「部分通过」，D3/D4 + 降级回答补齐后才改 ✅。
