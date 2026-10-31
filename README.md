# ThinkFusion

**把多个 AI 的观点收上来、让它们互相质疑、再综合成一个更好的答案。**

而不是问一个模型、拿到一段话、默认它是对的。

> 当前版本只走通了这条路的**第一段**：把一个网页版 AI 当模型通道，从它的回答里取出
> 结构化方案，多个方案冲突时如实报出来，而不是替你挑一个。多模型、多来源、交叉质疑与
> 综合，写在 [Roadmap](#roadmap) 里，还没做。这个 README 不替它们吹牛。

---

## 它解决什么

把大模型接进本地工具，通常卡在三件事上：

1. **要 API Key。** 有额度才能跑；本地小工具、内网环境、只想试一下的时候都很别扭。
2. **要模型遵守 JSON Schema。** 网页版 AI 不保证输出格式，也没有 function calling。
3. **要信任它的输出。** 让一个不可控的文本通道直接驱动文件操作，谁都不敢。

ThinkFusion 的做法：

- 用 Electron 内嵌一个真实浏览器视图打开 AI 网页，把提示词**真的发出去**，再把回答取回来。
- 从**渲染后的 markdown** 里抽结构化消息——不是从 API 响应，是从网页上肉眼看到的那段字。
- 抽出来的计划先过严格 schema 校验，再交给用户确认，最后由**独立的 UtilityProcess** 在授权目录内执行。
- 执行结果结构化回传给网页，进入下一轮，直到任务完成。

```
你的目标
   │
   ├─► 内嵌网页（真实浏览器视图）──► 提示词发出 ──► 模型回答
   │                                                │
   │                                    ┌───────────┘
   │                                    ▼
   │                          从渲染文本抽协议块
   │                                    │
   │                            schema 校验 + 冲突检测
   │                                    │
   │                          你确认（整份计划）
   │                                    │
   │                          独立 Runtime 串行执行
   │                          （路径校验 / 只读或写入 / sha256 复验）
   │                                    │
   └──────────────────────────── 执行报告回传，下一轮 ◄──┘
```

## 现在做到哪一步

| 环节 | 状态 |
| --- | --- |
| 收集一个来源的观点 | ✅ 网页版 AI，真实浏览器视图，不依赖 API |
| 结构化成可校验的方案 | ✅ 严格 schema，不合格的整份拒绝，不做"尽力修复" |
| 收集多个来源 | ⏳ 通道层已与 Electron 解耦，接口留好了，只接了一个 |
| 让观点互相质疑 | ⏳ 未做。当前只会报冲突，不会追问 |
| 综合成一个答案 | ⏳ 未做。冲突计划不合并、不投票、不给取舍建议 |

## 多个方案怎么处理

一轮回答里可能同时出现多个候选计划。当前版本：

- **完全相同的重复块**：容忍，只取一份。
- **互相冲突的多个计划**：拒绝执行并报出冲突数量——不替你猜哪个才是你要的。
- **跨轮次**：每一份计划都会落库、计算内容哈希、10 分钟内可审批，历史任务里能回看当时批了什么。

真正的**融合**（同类步骤去重、写入路径冲突检测、按证据给取舍建议）是下一个里程碑。

## 安全模型

这不是一个"信任模型输出"的工具，边界写得很直白：

| 边界 | 做法 |
| --- | --- |
| 网页文本 | 当作不可信输入；只当 JSON 解析，绝不当代码或命令执行 |
| 渲染进程 | 无 Node 集成、contextIsolation、sandbox；IPC 只接受主 frame |
| 内嵌页面 | 独立 `WebContentsView`、独立分区、拒绝一切权限请求、只允许目标站点 |
| 执行进程 | 独立 UtilityProcess；每步执行前重新校验授权凭据 |
| 工具面 | 白名单：列目录、读文件、建目录、独占创建文件。没有 shell、没有删除、没有覆盖 |
| 审批 | 每一份计划都要人点确认；授权 30 分钟过期，计划 10 分钟过期 |

细节见 [`SECURITY.md`](desktop-agent-macos/SECURITY.md)。

## 快速开始

要求：macOS（Apple Silicon）、Node.js ≥ 22.12、Electron 45。

```bash
cd desktop-agent-macos
npm install --no-audit --no-fund
npm run typecheck
npm test          # 协议 24 + 适配器 27 + 状态机 8
npm run dev
```

启动后在右侧内嵌页面登录 AI 网页，在底部输入框写目标，选择工作区，等计划出现后确认。

实机验证（应用已在跑、页面已登录）：

```bash
npm run start:debug                     # 带 CDP 端口启动
npm run check:layout                    # 分栏对齐 + 应用列几何
npm run check:drag                      # 拖动全流程
npm run e2e:live -- <工作区目录>          # 真实任务走完整条链路
```

## 当前状态

诚实版：

- 闭环**已在真实网页 + 真实登录态下跑通**：提交 → 计划 → 审批 → 执行 → 报告回传 → 完成。
- 离线 59 项（协议 24 / 网页通道时序 27 / 状态机 8），实机 40 项（分栏 15 + 应用列 9 + 拖动 16）。
- 未做：多来源、交叉质疑、方案融合、崩溃恢复、逐步骤审批、打包签名与公证；
  真实鼠标拖动没有自动化覆盖。

细节与"证不了什么"的清单在 [`TEST_PLAN.md`](desktop-agent-macos/docs/TEST_PLAN.md)，
交付状态在 [`DELIVERY_STATUS.md`](desktop-agent-macos/DELIVERY_STATUS.md)。

## 仓库结构

```
desktop-agent-macos/   Electron 应用：主进程 / 预加载 / 渲染进程 / 独立 Runtime
  src/main/            任务、存储、网页适配、编排、窗口分栏
  src/agent/           独立 Runtime：计划校验、工具执行、结果验证
  src/renderer/        React 三栏界面
  src/shared/          协议、IPC 契约、分栏计算（主进程与渲染进程共用）
  scripts/             离线测试 + 实机检查（scripts/lib/cdp.mjs 是共用底座）
packages/              可复用的模型通道包（零依赖，与 Electron 解耦）
docs/                  仓库工作流文档（提交规范、分支模型、发版）
scripts/               版本管理基础设施（钩子、发版脚本）
```

工程内部文档：

| 文档 | 内容 |
| --- | --- |
| [`PROTOCOL.md`](desktop-agent-macos/docs/PROTOCOL.md) | 协议词汇、三级解析、回声剥离、回答归属 |
| [`IPC.md`](desktop-agent-macos/docs/IPC.md) | 通道清单、信任检查、为什么某些参数是字面量 |
| [`TEST_PLAN.md`](desktop-agent-macos/docs/TEST_PLAN.md) | 离线测什么、实机断言什么、证不了什么 |
| [`HARNESS_BASELINE.md`](desktop-agent-macos/docs/HARNESS_BASELINE.md) | 借鉴了谁的设计、明确没有依赖谁 |

## 参与开发

首次克隆后执行一次 `./scripts/git-setup.sh`，激活提交规范钩子与常用别名；
约定见 [`docs/git-workflow.md`](docs/git-workflow.md)。

## Roadmap

- [ ] **接第二个来源**：通道层已与 Electron 解耦，加一个网页 AI 或 RSS / 搜索源
- [ ] **交叉质疑**：把 A 的方案喂给 B，让 B 指出漏洞，而不是各自独立作答
- [ ] **方案融合**：同类步骤去重、写入路径冲突检测、按证据给取舍建议
- [ ] 崩溃恢复：执行中断的任务进入待核对状态，而不是停在 `executing`
- [ ] 逐步骤审批：整份计划批准后，仍可在危险步骤前停下
- [ ] 打包、签名、公证

## License

MIT
