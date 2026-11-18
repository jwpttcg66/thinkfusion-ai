# ThinkFusion AI

**Many Minds. One Better Answer.**
**众智汇流，答案更优。**

ThinkFusion AI 是一个开源的多智协同平台，把来自多个 AI 模型与网页来源的想法、知识和视角汇集到一起，
产出更深入的洞察与更好的答案。

它不依赖单一的模型或单一的信息源，而是先收集不同观点，再分析其中的一致与分歧、找出缺失的信息，
最后综合成一个统一的、经过推敲的结果。

**English: [README.md](README.md)**

---

## 核心能力

- **多模型汇总** — 从多个 AI 模型收集回答与见解。
- **网页情报** — 从网页与在线来源中提取、归纳信息。
- **视角分析** — 比较不同观点，找出共识，识别矛盾。
- **知识综合** — 把互补的想法合并成更完整的答案。
- **批判性推理** — 质疑前提，找出缺口，提升结论质量。
- **知识索引** — 对积累下来的知识做组织、索引与检索。
- **迭代精炼** — 通过持续的补充调研与分析不断打磨结论。

## 愿景

把碎片化的信息与多样的视角，变成集体智慧。
让多个 AI 系统与知识源叠加后的智能，比任何单一回答都更有用。

**众智汇流，答案更优。**

---

## 它到底是什么

用户提出一个问题，ThinkFusion 让多个 AI **各自独立作答**，把真正有分歧的主张挑出来
定向互驳，再用证据校验，最后给出**带分歧与不确定性的结论**。只有确实需要动本地文件时，
才生成一份可审批的执行计划。

> 可验证的多模型审辩 + **Optional** Local Agent Runtime

`Optional` 仍然是最重要的词：本地运行时是子系统，不是产品本体。没有它，问答、辩论与结论
照样成立。

目标形态与取舍见 [docs/PRODUCT.md](docs/PRODUCT.md)，技术架构见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，版本路线与完成判据见
[docs/ROADMAP.md](docs/ROADMAP.md)，全部文档见 [docs/README.md](docs/README.md)。

## 现在真的能做到什么

上面讲的是产品**为了什么**，下面讲代码**当前做了什么**——README 许的愿超过仓库能兑现的
东西，那就只是宣传：

| 能力 | 状态 |
| --- | --- |
| 多通道独立作答 | ✅ 网页版 AI，无需 API Key；原话直发，通道间互不可见 |
| 多页面管理 | ✅ 窗口右缘切换；每页独立 Cookie 与主机白名单 |
| 主张抽取 / 争议检测 | ✅ 辩论引擎，分歧指到具体两句 |
| 定向辩论与修订 | ✅ 质疑、反例、修订；六种协作策略 |
| 裁判与方向判断 | ✅ supports / contradicts / context，含置信度与局限 |
| 证据包与内容哈希 | ✅ 证据与执行断言进入 Item Hash，篡改可发现 |
| 真实执行证据生产者 | ✅ 代码就绪；尚未接入辩论编排器 |
| 代码智能 | ✅ V3.2：符号、引用、影响面、构建信任 |
| 本地执行 Runtime | ✅ 27 个白名单工具；审批、路径校验、sha256 复验 |
| 外部 CLI Agent | ✅ Qoder / Claude 作为通道接入 |
| 知识索引 / 跨会话证据检索 | ⏳ 0.4 |
| 外部事实核验 | ⏳ 0.3.3 |

一句话概括：**审辩与证据链已经能跑，缺的是把裁判与证据接到用户面前（0.3.x）与跨会话索引（0.4）。**

## 工程介绍

### 整体链路

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

四个设计决定：

1. **模型通道是网页，不是 API。** Electron 内嵌一个真实 `WebContentsView`，把提示词敲进去，
   再把回答读回来。不需要 Key，不需要额度，也不要求模型支持 function calling。
2. **解析发生在渲染后的 markdown 上。** 不是 API 响应，是人在聊天框里肉眼看到的那段字——
   那是网页版 AI 唯一能保证的接口。
3. **那段文本是不可信输入。** 只当 JSON 解析，绝不当代码执行，绝不变成 shell 命令，
   也绝不直接碰文件系统。
4. **执行是另一个进程。** `UtilityProcess` 拿到已批准的计划，每一步执行前重新校验授权，
   并且只能在工具白名单里动作。

### 多个网页，一个规划者

窗口右缘是一排按钮，一个按钮对应一个内嵌网页。点一下把那一页换到前台；其余的**只是被停到
窗口外，不会被销毁**——聊天页一旦被销毁，模型正在写的那段就没了。

一次只显示一页是故意的：两个聊天界面并排，各自只能分到半个窗口，而半个窗口宽的聊天界面
还不如点一下切过去。

右缘那排按钮是 DOM，网页是画在 DOM 之上的原生视图。所以视图的 bounds 必须比窗口右边缘少
一个 `RAIL_WIDTH`——忘了这一点，按钮就是看不见也点不动，而且哪里都不会报错。`app:view-bounds`
的存在，就是让这种失效能被看见，而不是静默。

### 多个方案怎么处理

一轮回答里可能同时出现多个候选计划。当前版本：

- **完全相同的重复块**：容忍，只取一份。
- **互相冲突的多个计划**：拒绝执行并报出冲突数量——不替你猜哪个才是你要的。
- **跨轮次**：每一份计划都落库、计算内容哈希、10 分钟内可审批，历史任务里能回看当时批了什么。

真正的**融合**（同类步骤去重、写入路径冲突检测、按证据排序取舍）是下一个里程碑，不是已完成的功能。

### 安全边界

这不是一个"信任模型输出"的工具，边界写得很直白：

| 边界 | 做法 |
| --- | --- |
| 网页文本 | 当作不可信输入；只当 JSON 解析，绝不当代码或命令执行 |
| 渲染进程 | 无 Node 集成、`contextIsolation`、sandbox；IPC 只接受主 frame |
| 内嵌页面 | 每个来源一个独立 `WebContentsView`、独立持久分区；拒绝一切权限请求；主机白名单在跳转、重定向、`window.open` 三处都拦 |
| 执行进程 | 独立 `UtilityProcess`；每步执行前重新校验授权凭据 |
| 工具面 | 27 个白名单工具：文件读/写/属性/树/搜内容/找文件/读图/字面量编辑/移动/复制/移除（默认进废纸篓）、固定测试命令、分层 `shell.run` 与后台作业、截屏、打开应用、剪贴板、系统通知、系统信息、进程查看/结束、`web.fetch`。没有上传。`workspace-write` 下 shell 只放行只读与构建类命令；`danger-full-access` 给真 shell，但仍拦不可回收的操作 |
| 审批 | 每一份计划都要人点确认；授权 30 分钟过期，计划 10 分钟过期 |

细节见 [`SECURITY.md`](desktop-agent-macos/SECURITY.md)。

### 测试

- **离线测试**：`npm test` 跑 `package.json` 里的全部子脚本（协议、适配器、状态机、辩论、
  证据包、代码智能等）。CI 每次 push 都跑，见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。
- **实机检查**：需要真实运行的应用和已登录的页面，所以是手动跑的；脚本通过 CDP 读真实状态，
  不读像素。清单见 [`desktop-agent-macos/docs/TEST_PLAN.md`](desktop-agent-macos/docs/TEST_PLAN.md)。
- 这些测试**证不了什么**，逐条写在 `TEST_PLAN.md` 里——那份清单本身就是交付物的一部分。

## 快速开始

要求：macOS（Apple Silicon）、Node.js ≥ 22.12、Electron 45。

```bash
cd desktop-agent-macos
npm install --no-audit --no-fund
npm run typecheck
npm test          # 全部离线测试
npm run dev
```

启动后在右侧内嵌页面登录 AI 网页，在底部输入框写目标，选择工作区，等计划出现后确认。

实机验证（应用已在跑、页面已登录）：

```bash
npm run start:debug                     # 带 CDP 端口启动
npm run check:layout                    # 分栏对齐 + 应用列几何
npm run check:drag                      # 拖动全流程
npm run check:new-task                  # 「新任务」点下去要看得见反馈
npm run e2e:live -- <工作区目录>          # 真实任务走完整条链路
```

## 仓库结构

```
desktop-agent-macos/   Electron 应用：主进程 / 预加载 / 渲染进程 / 独立 Runtime
  src/main/            任务、存储、网页适配、编排、窗口分栏
  src/agent/           独立 Runtime：计划校验、工具执行、结果验证
  src/renderer/        React 三栏界面
  src/shared/          协议、IPC 契约、分栏计算（主进程与渲染进程共用）
  scripts/             离线测试 + 实机检查（scripts/lib/cdp.mjs 是共用底座）
packages/              可复用的模型通道包（零依赖，与 Electron 解耦）
docs/                  产品定位、架构、规格、ADR 与文档索引
scripts/               版本管理基础设施（钩子、发版脚本）
```

## 工程文档

| 文档 | 内容 |
| --- | --- |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | 产品定位、原则与成功判据 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 五层架构、三套协议、两条主链路 |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | 现在在哪、下一阶段是什么、怎么算完成 |
| [`docs/README.md`](docs/README.md) | 全部文档索引（规格、ADR、测试、应用层） |
| [`PROTOCOL.md`](desktop-agent-macos/docs/PROTOCOL.md) | 协议词汇、三级解析、回声剥离、回答归属 |
| [`IPC.md`](desktop-agent-macos/docs/IPC.md) | 通道清单、信任检查、为什么某些参数是字面量 |
| [`TEST_PLAN.md`](desktop-agent-macos/docs/TEST_PLAN.md) | 离线测什么、实机断言什么、证不了什么 |

## 参与开发

首次克隆后执行一次 `./scripts/git-setup.sh`，激活提交规范钩子与常用别名；
约定见 [`docs/git-workflow.md`](docs/git-workflow.md)。

## Roadmap

0.3.x 的主题是**可验证**：把裁判、证据与执行断言接到用户面前，让每条结论都能追到证据。
之后是知识索引（0.4）与通道/模型扩展（0.5），判据见
[`docs/ROADMAP.md`](docs/ROADMAP.md)。

## License

MIT
