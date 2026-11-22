# M2 · 全局记忆真机 CDP 验收任务书

> **目标**：把 `GLOBAL_MEMORY_STATUS.md` 里两项 ⚠️「未真机」变成 ✅：
> 设置页 `MemoryPanel` 与对话页 `MemoryTraceCard`。
>
> **基线**：`main @ 111fba5`。
> **门禁**：本任务书全部 checklist 勾选 + 证据齐全 + `M2-REPORT.md` 签字。
> **不做**：不改生产代码（除验收中发现的真实缺陷，另开 issue）、不扩架构、不接 Debate。

---

## 0. 为什么单独一份任务书

`npm run verify` 的 471 项跑的是**模块与假 Provider**，它证明不了两件事：

1. 组件在真实 DOM/CSS 变量下是否可用（按钮有没有被遮住、`--danger` 变量在当前主题是否存在）；
2. IPC 在 `trustedUiSender` 的真实窗口上下文里是否放行（渲染层 origin 判定）。

这两件事只能在真机点。**但「页面能打开」不算验收**：每一项必须同时有
「点击动作」与「点击后从主进程读回的状态」两条证据，缺一不算通过。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 构建 | `npm run build`（或 `npm run dev` 的等价产物）可启动 |
| 数据备份 | **先备份** `~/Library/Application Support/ThinkFusion/memory.sqlite`（含 `-wal`/`-shm`）与 `settings.json`，记下备份路径 |
| 干净起点 | 验收使用**测试数据**；结束必须删除（见 §6） |
| CDP | 启动参数 `--remote-debugging-port=9333`，只监听 127.0.0.1 |
| 截图 | 存 `docs/spec/evidence/M2/`，命名见 §5 |

启动命令（在 `desktop-agent-macos/` 下）：

```bash
npm run build
npx electron . --remote-debugging-port=9333
```

> 若 `npm run build` 产物是 `out/main/index.js`，也可 `npx electron out/main/index.js --remote-debugging-port=9333`；
> 以仓库 `package.json` 的 `main` 为准。

CDP 连接检查：

```bash
curl -s http://127.0.0.1:9333/json/list | python3 -c "import json,sys; [print(t['id'], t['title'], t['webSocketDebuggerUrl']) for t in json.load(sys.stdin) if t['type']=='page']"
```

必须能看到主窗口 page 的 `webSocketDebuggerUrl`。

---

## 2. 验收数据准备（用渲染层 API，不伪造数据库）

在 CDP 的 `Runtime.evaluate` 里执行（`awaitPromise: true`）。**这是准备数据，不是验收动作**；
验收动作必须是 §3/§4 的点击。

```js
// 造 3 条 active 记忆 + 2 条候选 + 1 组冲突
const m = window.agentAPI.memory;
await m.remember({ kind:'constraint', scope:'PROJECT', scopeId:'p_m2', title:'M2 迁移前先跑 staging', content:'所有数据库迁移前必须先在 staging 环境验证', status:'active' });
await m.remember({ kind:'decision',   scope:'PROJECT', scopeId:'p_m2', title:'M2 记忆用独立 sqlite', content:'记忆放在独立 memory.sqlite，不挂 code-index', status:'active' });
await m.remember({ kind:'fact',       scope:'GLOBAL',  title:'M2 全局偏好：提交信息用中文', content:'提交信息一律中文', status:'active' });
// 冲突：同 scope 同 key 第二条 active
await m.remember({ kind:'decision', scope:'PROJECT', scopeId:'p_m2', title:'M2 记忆用独立 sqlite', content:'另一份说要用 JSON 文件', status:'active' });
// 候选：走真实抽取
await m.extract({ conversationId:'conv-m2', messageId:'msg-m2-1', role:'user', projectId:'p_m2', text:'记住：M2 这条候选要在界面里确认' });
await m.extract({ conversationId:'conv-m2', messageId:'msg-m2-2', role:'user', projectId:'p_m2', text:'记住：M2 这条候选要在界面里拒绝' });
'prepared'
```

预期读回：`status().records >= 4`、`listCandidates('pending').length === 2`、`conflicts().length === 1`。

---

## 3. 设置页验收（逐项点击，缺一不算）

打开：左下角设置 → 「全局记忆」。截图 `01-settings-overview.png`。

| # | 动作（必须点） | 断言（点后读回 / 观察） | 证据 |
|---|---|---|---|
| S1 | 观察状态卡 | 显示「记忆已开启」、记录数≥4、待审候选=2、迁移状态可见 | `01` |
| S2 | 取消勾选「启用全局记忆」，再勾回 | 取消后卡片变「记忆已关闭」；`status().enabled===false`；勾回后恢复 | `02-toggle-off.png` / `03-toggle-on.png` |
| S3 | 关闭「允许注入模型请求」，再打开 | `getSettings().inject` 跟随；**不影响记录管理** | `04-inject-toggle.png` |
| S4 | 改「单次注入上限（条）」为 3，读回 | `getSettings().maxRecords===3`；重启应用后仍是 3（持久化） | `05-budget.png` |
| S5 | 切到「待审候选」，点**确认写入**（第一条） | 候选数 2→1；`listRecords` 多一条 status=active；审计算 `candidate.approved` | `06-confirm.png` |
| S6 | 点**拒绝**（第二条） | 候选数 1→0；`listCandidates('pending')` 为空；再调 `extract` 同一句**不再新增**（去重） | `07-reject.png` |
| S7 | 切「记录」，搜索框输入 `staging` | 只剩匹配记录；清空后恢复全量 | `08-search.png` |
| S8 | 对一条记录点**否定** | 该条 status 变 `refuted`；`recall` 不再命中它；审计有 `governance.refute` | `09-refute.png` |
| S9 | 再点**过期**、**归档**各一条 | status 分别变 `expired` / `archived`；均不再召回 | `10-expire-archive.png` |
| S10 | 点**删除**（会 `window.confirm`）→ 确认 | 记录消失；审计留一条（删除不静默） | `11-delete.png` |
| S11 | 切「冲突」 | 显示 1 组、2 条 memoryId；点「否定这条」后组消失 | `12-conflicts.png` |
| S12 | 切「审计」 | 能看到 S5–S11 的动作，含时间、action、memoryId | `13-audit.png` |
| S13 | 点**导出** | 浏览器下载 `thinkfusion-memory-export.json`；文件里 `records`/`candidates` 与读回一致 | `14-export.png` + 导出文件 |
| S14 | 重复 S13 的导出，`importAll` 回灌同一份 | `imported=0`、`archivedForConflict` 不覆盖现有 active（幂等 + 不静默覆盖） | `15-reimport.png` |

**S2/S3 的额外断言**：关闭记忆后，`window.agentAPI.memory.status().enabled === false`，
且对话页不再出现新的注入卡（见 §4 的 D6）。

---

## 4. 对话页验收

前置：设置页把记忆重新打开、注入打开。开一条新会话（或复用 `conv-m2`），发一个问题，
让它命中 `p_m2` 的记忆。

> 真机没有本地模型时，用「网页通道」发问也能验收**边界**（`skipped/web-verbatim`）；
> 要验收 `provider-confirmed` 必须配一个本地 Ollama 或云端 Key。两种都要覆盖。

| # | 动作 | 断言 | 证据 |
|---|---|---|---|
| D1 | 发一个与 `M2 迁移前先跑 staging` 相关的问题 | 回答后出现「记忆：注入 N · 跳过 M」条；展开后该请求 `命中≥1` | `20-trace-injected.png` |
| D2 | 展开明细 | 三哈希都显示（L1/L2/L3 前 10 位）；`provider-confirmed` 时 L1=L2=L3，文案是「已注入（Provider 层已确认拼装）」 | `21-trace-hashes.png` |
| D3 | 用**网页通道**再发一问 | 该请求显示「未注入：网页通道保持原话直发」；页面里收到的仍是逐字原话（对比发送文本） | `22-web-skipped.png` |
| D4 | 用 **CLI 通道**发一问（若已配置） | 显示「未注入：CLI 没有 system 轮次」 | `23-cli-skipped.png` |
| D5 | 发一个与库里**无关**的问题 | 显示「未注入：no-recall」或注入 0 条，不得硬塞低相关记忆 | `24-no-recall.png` |
| D6 | 设置页关闭记忆后再发一问 | 该请求 `skipped/memory-disabled`；对话页无记忆块 | `25-disabled.png` |

**禁止**：文案出现「模型已使用记忆」。出现即不通过（`describeInjection` 应已挡住，这里复核 UI）。

---

## 5. 故障场景（降级）

**先备份真实文件**，验收后恢复。

1. 退出应用。
2. `mv memory.sqlite memory.sqlite.bak`，然后 `printf 'not a sqlite db' > memory.sqlite`。
3. 启动应用，打开设置 → 全局记忆：
   - 状态卡标题为「记忆库不可用（降级）」；
   - 有红字 detail；记录数 0；
   - **回答照常**：回对话页发一问，能正常收到回答（不因记忆坏了而失败）。
   - 截图 `30-degraded.png`；读回 `status().state === 'degraded'`。
4. 如可行，再测 `chmod 000 memory.sqlite` 的另一种降级（权限错误），确认 detail 不同但行为一致。
5. 退出，恢复 `memory.sqlite.bak`，删掉伪造文件，重启确认回到 `ready`。

---

## 6. 清理（必须做，不能把测试数据留给用户）

```js
// 在 CDP 里删除本次造的测试记录（按标题前缀 M2 精确定位，不做模糊批量删）
const m = window.agentAPI.memory;
for (const r of await m.listRecords({ limit: 500 })) {
  if (r.title.startsWith('M2 ')) await m.deleteRecord(r.memoryId);
}
for (const c of await m.listCandidates('all')) {
  if (c.proposedTitle.startsWith('M2 ')) await m.rejectCandidate(c.candidateId);
}
```

再回读 `listRecords({limit:500})` 确认无 `M2 ` 前缀记录；截图 `99-cleanup.png`。
对话页测试会话按「删前确认是自己的测试题」规则删除。

---

## 7. 证据与报告

目录：

```
docs/spec/evidence/M2/
  01-settings-overview.png … 25-disabled.png
  30-degraded.png
  99-cleanup.png
  thinkfusion-memory-export.json
  M2-REPORT.md
```

`M2-REPORT.md` 必填：

```md
# M2 真机验收报告
- 基线：111fba5
- 时间：YYYY-MM-DD HH:mm（时区）
- 机器/系统：macOS xx / 是否打包版
- 是否配了本地模型 / 云端 Key / CLI
- 设置页：S1–S14 逐项 ✅/❌（❌ 写现象与截图）
- 对话页：D1–D6 逐项 ✅/❌（D1/D2 若只测了网页通道，写明「provider-confirmed 未覆盖，原因」）
- 降级：✅/❌
- 清理：✅/❌（列出删除条数）
- 未覆盖项与原因
- 结论：M2 通过 / 不通过
```

**签字规则**：只有「动作 + 读回状态 + 截图」三样齐全才可填 ✅；
只截了图没点击的，填 ❌ 并注明「仅观察」。

---

## 8. 失败处理

| 现象 | 处理 |
|---|---|
| `trustedUiSender` 拒绝（IPC sender rejected） | 记录窗口 origin 与 `file://`/dev 判定，作为**真实缺陷**开 issue；不要绕过校验去点 |
| 按钮点了没反应 | 打开 DevTools Console 抓错误；记录组件名与栈 |
| 样式错位/红字不可见 | 记录主题（light/dark）与 CSS 变量，补 `style.css` 的证据截图 |
| 降级后回答失败 | **不通过**。记忆必须旁路，回答不能受牵连 |
| 导出文件与读回不一致 | 不通过，记 `export` 差异 |

---

## 9. 退出条件

- [ ] S1–S14 全部 ✅（每条三样证据齐全）
- [ ] D1–D6 全部 ✅（D1/D2 至少覆盖一种 `provider-confirmed` 路径，或写明未覆盖原因）
- [ ] 降级场景 ✅
- [ ] 清理完成且回读无 `M2 ` 记录
- [ ] `M2-REPORT.md` 签字
- [ ] `GLOBAL_MEMORY_STATUS.md` §1.5 的 M2 行改为 ✅，并链接本报告

任何一条没达成，M2 保持 ❌，不得因为「核心功能已测」而放行。
