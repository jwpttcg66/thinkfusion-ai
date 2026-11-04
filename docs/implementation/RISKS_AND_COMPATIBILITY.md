# 风险与兼容性清单（Phase A 交付物）

日期 2026-11-04。对应项目书 Phase A 交付清单，以及第十九章「风险清单 /
潜在兼容性问题 / 推荐实施顺序」三项汇报要求。

和 `MULTI_MODEL_UPGRADE_PLAN.md` 第六节是同一份清单的两面：计划里是简表，
这里给出证据位置与当前状态。「已缓解」只标有代码或实测的。

## P0：不处理会造成不可逆后果

| # | 风险 | 触发 | 证据 | 缓解 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | `local-only` 被自动 fallback 突破，用户内容外发 | E / F | 项目书 6.3 禁止向云端和网页发；19 章第 13 条禁止自动突破 | 选 Provider 前先按 `privacyMode` 过滤，非法组合直接报错；重试也走同一过滤 | 待实现 |
| 2 | API Key 明文落到 renderer、配置或日志 | D | preload 只暴露 `agentAPI`，renderer 拿不到 `fs`；但 IPC 返回值若不收敛，key 会顺着它回来 | `safeStorage` 存密文，IPC 只回 `hasKey: boolean`；日志只打 provider id | 待实现 |
| 3 | 以模型数量判定正确性 | H / I | `ARCHITECTURE.md` 11.8 红线；19 章第 14 条 | Judge 不读 `support` 计数；少数派强制进 `disagreements`；输出允许「无法确定」 | 待实现 |
| 4 | 为达成共识删掉少数派观点 | G / I | 项目书决策 7、19 章第 15 条 | 辩论记录只追加，不覆盖；综合保留独立结构 | 待实现 |
| 5 | 破坏现有 Web Channel | 全程 | 决策 3、19 章第 5 条 | Phase E 之前新模块一律不接线；每阶段结束真机问一句 | **Phase B/C 物理上未接线**；B 的真机回归仍未补 |

## P1：会造成错误结论或频繁返工

| # | 风险 | 触发 | 缓解 | 状态 |
| --- | --- | --- | --- | --- |
| 6 | `web` 与 `local-only` 语义互斥，写出矛盾配置 | E | web 下 `privacyMode` 恒 `allow-cloud`，UI 不给 `local-only`；**保留 web 模式** | 已裁决，待实现 |
| 7 | 老会话缺 `executionConfig`，打开即违规或崩溃 | E | 默认 `{web, fallbackEnabled:false, allow-cloud}`；字段可选 | 已裁决，待实现 |
| 8 | 辩论把 JSON journal 写盘拖垮 | G | 先按天分文件，实测不够再 append-only；不上 SQLite | 待实现；`DATA_MODEL_AUDIT.md` 已列检查清单 |
| 9 | 网页通道取消被上层当成 `abort` | E | 能力如实写 `give-up`；`CancellationMode` 三态 | **Phase B 已做** |
| 10 | 上下文长度写死或读不到就编一个 | C / D | `contextTokens: null` 表示不知道；`num_ctx` 取 min(配置, 模型真实值) | **Phase C 已做并真机验证**（32768 / 2048） |
| 11 | 本地模型无上限并发，24GB 内存换页 | C | `LocalAdmission` 并发 1 + 30s 排队上限 + 切模型前卸载 | **Phase C 已做并真机验证** |
| 12 | 冷加载被误判成超时 | C | 三层超时（连接 3s / 首字 120s / 块间隔 60s） | **Phase C 已做**；9B 冷加载未实测（本机没有 9B） |
| 13 | 汇总算法提前接线，H 没定型就改综合 | I | 四个文件冻结，补齐 evidence/ranker/engine 和测试再一并提交 | 冻结中 |
| 14 | 两套名单并存导致「关掉的模型还在回答」 | E | Phase E 必须定谁是唯一名单 | 未决；见 `MODEL_PROVIDER_AUDIT.md` 末尾 |
| 15 | Token 预算 / 费用估算基于硬编码价格或假 token 数 | D | usage 取服务端；价格做可编辑配置；流式开 `include_usage` | 待实现 |

## P2：长期维护成本

| # | 风险 | 说明 |
| --- | --- | --- |
| 16 | 网页选择器漂移 | 已有 `page:learn-selectors`（「更新样式」）入口；不额外做自动修复 |
| 17 | `page-driver.ts` 2579 行承担过多职责 | 是 Web Channel 唯一实现，Phase E 之前不动；将来拆要先有端到端测试 |
| 18 | 无端到端测试进 CI | 现有 210 条测试都是逻辑级；真机靠 `scripts/` 下 CDP 脚本手动跑 |
| 19 | `deepseek:*` IPC 名与「按 sourceId 查任意通道」的实际行为不符 | 历史命名，改名会牵动 preload / contracts / 面板，暂不动，文档注明 |

## 文档之间的冲突（已裁决）

| 冲突 | 裁决 | 依据 |
| --- | --- | --- |
| 目录 `src/providers/` vs `src/main/providers/` | 用后者 | `ARCHITECTURE.md` 11.9；20 个检查脚本按现有路径 import |
| SQLite 是不是前置 | 不是；先沿用 JSON journal | `store.ts:30-32` 注释；项目书决策 9 |
| `FinalSynthesis.consensus: string[]` | 保留 `Claim[]` 扩字段 | 项目书决策 6 + 9.3 要求可溯源 |
| 第十章「已有网页内容提取」 | 降级为「暂无输入源」 | 仓库无 Fetcher/Extractor，见 `WEB_CHANNEL_AUDIT.md` 末节 |
| `type: 'local' \| 'cloud'` | 扩为三值含 `'web'` | 网页通道两者都不是；误算成 cloud 会放宽外发档位 |
| `capabilities.available` | 挪到 `health()` | 能力静态、可用性动态 |
| `supportsCancellation: boolean` | 三态 | 网页只能 `give-up` |

## 明确未验证 / 未完成

这些不能写成通过（`项目书 19 章` 明确禁止）：

- Phase B 的「现有 Web Channel 正常运行」**没做真机回归**，只做了逻辑测试。
- Phase C 用 `qwen2.5:7b` 验证，**没有下载项目书默认的 `qwen3.5:9b-q4_K_M`**，
  9B 的冷加载、内存占用、首字延迟均未测。
- `OllamaProvider` **没注册进 `main/index.ts`**，没有 UI 入口，不影响现有链路。
- Phase K 的 17 项场景（Ollama 中途退出、网络中断、应用重启恢复等）
  要等接线后才有意义，全部未跑。
- `src/main/synthesis/` 四个文件未接线、无测试。

## 推荐实施顺序

见 `MULTI_MODEL_UPGRADE_PLAN.md` 第二节。一句话版本：C/D 并行 →
E 落配置与唯一名单 → F 编排 → G 辩论（**先改存储**）→ H 裁判 →
I 综合 → J 界面 → K 测试；A 的五份架构文档在 E 之前补齐即可。
每阶段结束停下等确认，不自动进下一阶段。
