# 测试报告（Phase K）

日期 2026-11-04。所有数字来自本次实际执行，没有估算。

## 总览

```
npm test                319 条，全绿，0 失败
npm run typecheck        干净
npm run build            通过
npm run test:ollama      17 条（真实录制 payload 回放）
npm run test:ollama:live  7 条（真机 Ollama）
npm run test:cloud        17 条（文档结构回放）
npm run test:cloud:live   3 条 skip（没有 CLOUD_API_KEY）
npm run test:execution    13 条
npm run test:collaboration 11 条
npm run test:debate       13 条
npm run test:debate-lead  13 条（三种主导方式）
npm run test:judge        14 条
npm run test:fusion       11 条
npm run test:scenarios    15 条（Phase K 的 17 项场景）
```

## 17 项场景结果

| # | 场景 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | Web 模式回归 | ✅ 真机 | Phase B 两轮（三通道 `51`）、Phase E/K 各一轮；删除 `failed: []`，三站侧栏无残留 |
| 2 | Local 模式 | ✅ 真机 | Phase E 两轮，`channels/answered` 只有 `ollama:qwen2.5:7b`，回答 `46` |
| 3 | Cloud 模式 | ⚠️ 真机未验 | 无 API Key。`getProviderHealth()` 显示「还没有配置 API Key」；`test:cloud:live` 3 条整组 skip；逻辑侧 health/429/usage/budget/重试全测 |
| 4 | Hybrid 模式 | ✅ 真机 | `19 乘 2`：`channels = [ollama:qwen2.5:7b, chatgpt, gemini, kimi]`，四个都答 `38` |
| 5 | 多模型并行 | ✅ 真机 + 逻辑 | 同上四来源一轮完成；分批与顺序有单测 |
| 6 | 多轮辩论 | ✅ 真机 | 三种主导方式各跑一场：`local` 只走 Ollama、`web` 3 网页 + 1 本地、`hybrid` 4 成员首轮全发言且无主辩；主导者与选人理由落盘可查；逻辑侧 standard/deep/adversarial 各轮数、后轮 context 0/1/2 全测 |
| 7 | 模型中途失败 | ✅ 逻辑 | 失败成员重试一次，其余照常完成；彻底失败记 unanswered |
| 8 | 网络中断 | ✅ 逻辑 | `OllamaProvider` fetch 抛错 → `unavailable`，不抛裸错 |
| 9 | Ollama 退出 | ✅ 逻辑 | `health().available=false`，detail 指向 `ollama serve` |
| 10 | API 限流 | ✅ 逻辑 | 429 两次后成功共 3 次请求；耗尽报 `busy` 且不再重试 |
| 11 | 用户取消 | ✅ 逻辑 | 辩论 `stop→stopped`、`resume→completed`，已完成轮次不重跑；流式 abort 报 `cancelled` |
| 12 | 应用重启 | ✅ 真机 | 重启后 `getConversations()` 读到 1 条，状态 `answered`，`executionConfig` 完整保留 |
| 13 | 历史记录恢复 | ✅ 真机 + 逻辑 | 重启后消息与提问内容一致；辩论/裁决/Key 独立文件重启可读 |
| 14 | 隐私模式 | ✅ 真机 + 逻辑 | Phase E `local + local-only` 只走 Ollama；hybrid + local-only 显式选网页/云端也被策略排除 |
| 15 | 超长网页内容 | ✅ 逻辑 | 400 段切句不崩，span 有效；顺手修掉「以上就是…」漏过滤 |
| 16 | Token 预算耗尽 | ✅ 逻辑 | 达到 `maxTokens` 后抛 `budget-exceeded`，请求计数不增加 |
| 17 | 多个 Conversation 同时执行 | ✅ 逻辑 | 两场辩论并行，问题、轮次、消息 id 都不串台 |

## 真机数据清理（硬性要求）

每轮测试都是：删前打开会话读提问内容确认是自己的测试题 →
`agentAPI.deleteConversation` → 回读应用侧会话列表 → 遍历网页 target 读
`document.body.innerText` 确认无测试标记。

- Phase B 两轮：`cleaned/reset` 覆盖三站、`failed: []`，应用侧 0 条。
- Phase E 两轮：`failed: []`，应用侧 0 条。
- Phase K Hybrid：重启恢复后删除，`cleaned = [chatgpt, kimi, gemini]`、
  `failed: []`，应用侧 0 条，三站侧栏都无 `TF-K-HYBRID` 标记。
- 三种主导模式辩论：每场结束用 `debate:cleanup-web` 按 `threadUrl` 删站点侧
  会话，`web` / `hybrid` 两场都是 `cleaned/reset = [chatgpt, kimi, gemini]`、
  `failed: []`、`noAddress: []`；再用 `debate:remove` 删本地记录。复核应用侧
  会话 0 条、辩论记录 0 条、三站 `innerText` 无 `TF-LEAD-*` 标记。
- 临时脚本已清。用户自己的会话全程 0 条，一条没动。

## 真机观察到的两点（如实记录）

1. **短答案融合会降级**。Hybrid 四个通道都答 `38`，但每句不足 12 字，
   观点抽取把它们全过滤了，综合报告写「没有跨通道共识」。这是保守行为，
   符合「不把平行回答包装成一致」的红线；但它对纯数字问答确实偏保守，
   界面上应该配合 `degraded` 提示一起读。
2. **Gemini 回答会带站点 UI 文案**（「导出此代码…知道了」）。`stripChrome`
   没完全剥干净，但没影响本轮结论。属于已知的网页壳清洗边界，未在本轮修。
