# 辩论引擎 · 配置 / 迁移 / 测试 / 运行手册

对应任务书 §17「实现结束后更新架构文档、配置示例、迁移说明、测试说明和运行手册」的
后四项。架构与分阶段交付见 `docs/architecture/DEBATE_ENGINE_AUDIT.md` 和
`docs/implementation/PHASE-0..5`；验收逐条对照见
`docs/architecture/DEBATE_ACCEPTANCE.md`。

本文只写**仓库里真实存在**的字段和命令。没有的功能（Token / 费用预算、置信度、
裁判抓取网页正文）在最后一节列出，不给配置示例——写不生效的示例比不写更糟。

---

## 1. 配置示例

所有配置从渲染层经 `debate:start` 传入，入口是 `window.agentAPI.startDebate`。
字段在 `src/shared/contracts.ts` 的 `DebateConfigInput`、`src/main/debate/types.ts`
的 `normalizeDebateConfig` 里定义；非法值退回默认，**不会抛错**，会被静默归一。

### 1.1 最小：用界面默认值跑一场

```ts
await window.agentAPI.startDebate({
  question: 'SQLite 适合作为高并发写入的主数据库吗？',
  config: {}   // config 必填，可以为空对象
});
```

等价的完整形态（下面这些就是实际的默认值）：

```ts
await window.agentAPI.startDebate({
  question: 'SQLite 适合作为高并发写入的主数据库吗？',
  config: {
    strategy: 'truth',        // 六种之一，见 1.2
    maxRounds: 3,             // 1~10，超出退回策略默认轮数
    leadMode: 'hybrid',       // local | web | hybrid
    convergenceStop: true,    // 观点不再变化时提前收尾
    participants: []          // 空 = 由 planLead 按当前可用成员挑
  }
});
```

### 1.2 六种协作策略

| `strategy` | 默认轮数 | 改了什么 |
| --- | --- | --- |
| `truth` | 3 | 先给结论再检验证据链；争议优先看证据冲突 |
| `adversarial` | 3 | 同时给「最可能错在哪」；proposer / critic 分工；优先找反例 |
| `expert` | 3 | 先声明本领域的证据标准；全员 `domain_expert` |
| `assumption` | 3 | 前提逐条列出并标注类型；优先看范围差异 |
| `solution` | 3 | 给 2~3 个候选按约束对比；优先看事实冲突 |
| `discovery` | 3 | 竞争假设 + 能区分它们的证据 |

`standard` / `deep` 是 0.1.0 的旧名，仍能从老记录读回（分别是 2 轮 / 3 轮的
真理发现），界面不再提供。**策略不改裁判口径**：`judges.ts` 没有 strategy 参数。

### 1.3 执行模式与主导方式

`src/shared/conversation.ts` 里三个字段各管一件事，互不覆盖：

| 字段 | 取值 | 管什么 |
| --- | --- | --- |
| `executionMode` | `web / local / cloud / hybrid` | 这一轮回答从哪里来 |
| `strategy` | `smart / parallel / all-selected / sequential` | 这一轮子任务怎么调度 |
| `debateStrategy` | 六种（同 1.2） | 会话内自动辩论用哪种辩法 |
| `leadMode` | `local / web / hybrid` | 谁给基准观点（辩论配置里） |

四种执行模式 × 六种辩论策略都能组合，`check-debate-strategies.mjs` 有 4×6
归一用例守着。

### 1.4 预算与提前收尾

```ts
await window.agentAPI.startDebate({
  question: '……',
  config: {
    strategy: 'assumption',
    maxRounds: 3,
    budget: {
      stageTimeoutMs: 60_000,   // 单次模型调用，默认 60s
      totalMs: 240_000,         // 整场，不传则不设总时限
      maxConcurrency: 3         // 同时问几位，默认 3
    },
    earlyStopOnStall: true      // 默认 false；连续两轮没新证据/修订/争议才收尾
  }
});
```

`earlyStopOnStall` 默认关闭，界面也不默认勾：它会改变「打满 N 轮」的预期，
得有人明确选。`convergenceStop` 与 `earlyStopOnStall` 是两个开关：前者看单轮
有没有实质进展，后者要求**连续两轮**都没有。

`budget` 与 `earlyStopOnStall` 里，界面目前只暴露后者（一个复选框）。三项预算
是给程序化调用方用的：独立辩论面板和会话内自动辩论都用默认值，不逐场覆盖。
`DebateConfigInput.budget` 原先漏了这个字段，UI 之外即使传了也会被类型挡掉，
本次补齐并加了归一 / 落盘用例。

**没有的配置**：Token 与费用预算。三条通道（网页、本地 Ollama、云端 Provider）
都不返回用量，写一个估算值会让「预算」变成假的，所以类型里不留这两个字段。

### 1.5 发起前的可用性检查

```ts
const options = await window.agentAPI.getExecutionOptions();
// options.debateCandidates: 每个成员的 id / label / type / available / detail
// options.localModels: Ollama 实际安装的模型名（启动时刷新）
```

`planLead` 只认 `available: true` 的成员。没配 Key 的云端模型不会变成「能选但
每轮失败」的幽灵成员。本地成员清单启动时问一次 Ollama；服务没起时保留兜底值，
`health()` 会逐条说明不可用。

### 1.6 存储位置

```
~/Library/Application Support/thinkfusion-ai/
├── agent-store.json          # 主 journal（会话、消息）——辩论记录不进这里
└── debates/<debateId>.json   # 每场辩论一个完整快照，权限 0600
```

独立成文件是为了不放大主 journal 的写放大：一轮就有 N 条发言，塞进 journal
会让每次 mutation 全量重写整个 state。

---

## 2. 迁移说明

### 2.1 从 0.1.0 升级：不需要迁移脚本

辩论文件是**读时兼容**，不是写时迁移。老文件缺的字段读出来是 `undefined`，
代码一律按「没记录过」处理，绝不补一个看起来合理的值：

| 缺的字段 | 读时行为 | 为什么 |
| --- | --- | --- |
| `lead` / `plan` | 填 `LEGACY_LEAD` / `LEGACY_PLAN`，`reason` 明说「主导模式上线之前」 | 只读不该产生写入，也不该把「未记录」伪装成某个真实模式 |
| `config.leadMode` | 填 `'hybrid'` | 同上，且老记录确实没有这个概念 |
| `rounds[].phase` | `undefined` | 不按轮次下标猜它是质疑还是回应 |
| `rounds[].claims` / `disputes` / `evidence` / `graph` / `judgments` / `verdict` / `metrics` / `events` | `undefined` | 补空数组等于伪造「分析过但没抽到」 |
| `minorities` | 兜空数组 | 裁判取这个字段时不能让整场判不了 |
| `promptVersion` | `undefined` | 不补成当前版本；历史得看得出当时用的哪一版 |

`DebateStore.get()` 是唯一补默认值的地方，且**不写回盘**。`save()` 只在辩论
真的推进时调用。

### 2.2 旧策略名

老记录里的 `standard` / `deep` 仍能读回、界面能列出，`strategyProfile()` 把它们
映射到真理发现的两轮 / 三轮版。新建的辩论一律用六个新名字。

### 2.3 模板版本历史

| 版本 | 变更 | 影响范围 |
| --- | --- | --- |
| `1.0.0` | 从 `orchestrator.ts` 抽出独立模板模块，登记七个模板的契约；**文案逐字未改** | 只是把版本写进 `DebateState.promptVersion`。之前的所有辩论该文件字段为 `undefined` |

模板在 `src/main/debate/prompts.ts`。改任何一条 `system` 文案、或改任一规则模板的
输入 / 输出约束，都要：① 推高 `PROMPT_VERSION`；② 在上表加一行；③ 更新
`check-debate-prompts.mjs` 的快照用例。快照用例锁着渲染结果逐字不变，改文案
会红——这是有意的。

### 2.4 删除辩论记录

```ts
await window.agentAPI.removeDebate(debateId);          // 只删本地 JSON
const out = await window.agentAPI.cleanupDebateWeb(debateId); // 连带删网页侧会话
```

`cleanupDebateWeb` 按发言里落盘的 `threadUrl` 精确定位，**不按标题模糊匹配**，
也不动用户自己的会话。测试产生的辩论记录必须当场删干净，并回读列表确认无残留。

---

## 3. 测试说明

统一入口：`cd desktop-agent-macos && npm test`。先跑 `npm run build:test`
把 TS 编到 `out-test/`，各脚本从那里 import。

| 命令 | 覆盖 | 条数 |
| --- | --- | --- |
| `test:debate` / `check-debate.mjs` | 配置归一、首轮隔离、3 轮结束 | 14 |
| `test:debate-lead` | 三种主导模式、网页只收原话 | 15 |
| `test:debate-claims` | Claim 结构、五类争议、definitional | 13 |
| `test:debate-revision` | 五个决策、修订状态回写 | 12 |
| `test:debate-graph` | 4 节点 6 边、边带轮次与来源 | 6 |
| `test:debate-judge` | 三维独立、五档、TF-D-011/012/013、判据收紧 | 19 |
| `test:debate-events` | 事件链、seq 单调、key 幂等、恢复 | 7 |
| `test:debate-regression` | TF-D-001~010 固定回放 | 10 |
| `test:page-citations` | 三家 HTML fixture、URL 归一、指纹 | 10 |
| `test:debate-strategies` | 六种策略、角色、争议排序、4×6 归一 | 8 |
| `test:debate-metrics` | 指标、成本、历史复用 | 9 |
| `test:debate-eval` / `quality:debate` | 十一项硬门槛 + 13 条基准场景，输出达标/不达标报告 | 1 |
| `test:debate-prompts` | 模板契约、文案快照、版本落盘、网页原话 | 11 |

另有适配器 / 融合 / 文本 / 状态等基础用例，见 `package.json` 的 `test` 链。

生成报告（会写进 `docs/reports/`，不写 `TF_REPORT=1` 时只落 `out-test/`）：

```bash
npm run report:debate-regression   # → docs/reports/DEBATE_REGRESSION.md
npm run quality:debate              # → docs/reports/DEBATE_QUALITY.md（达标门槛 + 报告）
```

**两类测试要说清区别**：

- **固定回放**（TF-D-001~010、模板快照）断言结构，不断言模型措辞。真模型同样
  输入不保证同样输出，断言「模型说了 X」的用例第二天就会红。
- **标注集**（`fixtures/debate-labels.mjs`）13 条，`rule` 11 条（由任务书条款
  推出）/ `seed` 2 条 / `human` 0 条。报告只给「与规则基准一致」，明说这不是
  事实准确率；概率校准度不适用（结论不带置信度）。
- **达标线**见 `docs/architecture/DEBATE_QUALITY.md`：`npm run quality:debate`
  跑十一项硬门槛 + 13 条基准场景，任一不过就 `exit 1`。门槛做过变异测试，
  故意把「无证据 → 判 supported」会立刻变红。

页面脚本是模板字符串拼接，`\/` 会被吃成 `/` 开注释且编译期不报错——
`check-adapter.mjs` 里有用 `new Function` 编译每个页面脚本的用例兜底。

---

## 4. 运行手册

### 4.1 启动

```bash
cd desktop-agent-macos
npm install
npm run typecheck        # 三个 tsconfig 都过
npm run build            # 生产构建
npm run dev              # 开发模式
npm run start:debug      # 带 CDP 9222 调试端口，验证界面时用这个
```

本地模型需要先起 Ollama 并拉模型（`ollama serve`、`ollama pull qwen2.5:7b`）。
默认模型固定 `qwen2.5:7b`，不因 Ollama 返回顺序漂移；其他已安装模型会作为
额外成员出现在清单里。没起 Ollama 也能用网页模式，本地成员会如实标不可用。

### 4.2 发起一场辩论

1. 「研究设置 → 辩论」选策略（六张卡片各带一句「改了什么」）、轮数、参与成员。
2. 网页成员会自动开新会话，避免追进用户正在看的对话里。
3. 点开始，列表轮询 `debate:get`；跑完打开结论报告。
4. **测完删记录**：`removeDebate` 删本地，必要时 `cleanupDebateWeb` 删网页侧，
   回读列表确认无残留。用户自己的会话一律不动。

界面两处展示：对话页综合卡下方一条五档结论横幅（结论 + 三维 + 可追溯率 +
轮次耗时，读不到辩论就整块不显示）；「研究设置 → 辩论」里是完整报告九块
（关键主张、可点击证据链、主要分歧、反例与边界、修订前后、不确定性、参考
来源、质量指标）。

### 4.3 常见状态与处置

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 页面卡在「提问中」 | 站点改版 / 登录态失效 | 用页面栏的「刷新」（`page:reload`），不要重开应用 |
| 辩论列表里成员每轮失败 | 云端没配 Key 或 Ollama 没起 | 看 `getExecutionOptions().debateCandidates` 的 `available` / `detail` |
| 结论是「证据不足（不等于错）」 | 没有可核验的页面来源，或证据互相冲突 | 正常结果，不是故障；`insufficient_evidence` 与 `unsupported` 是两回事 |
| 可追溯率 0% | 本地模型不会给链接 | 只有网页通道的回答才可能带 `a[href]`；这项指标衡量来源可核验，不衡量答案对错 |
| 小模型没写「决策：」行 | 输出太短 | 记成 `decision: null` 且标 `inferred`，系统不替它圆 |
| 论点变更想复查 | 模板版本 | 看 `DebateState.promptVersion`，对照本文 2.3 表 |

### 4.4 取消、恢复、失败

```ts
await window.agentAPI.stopDebate(id);      // 写 session.stopped，幂等
await window.agentAPI.resumeDebate(id);    // 从最后一条已提交事件继续
```

恢复会重跑没跑完的那一轮，靠事件 `key` 挡掉重复的 `round.started`；连按两次
停止也只有一条 `session.stopped`。单次调用超时标该成员失败、不阻塞整轮；
整场预算见底立刻放弃，不拖着等一个不会来的回答。事件流与状态快照都在同一个
JSON 文件里，`seq` 单调。

### 4.5 权限与安全边界

- 辩论文件 `0600`，`debateId` 经过 `/^[a-zA-Z0-9-]+$/` 校验挡路径穿越。
- 网页 / 文档 / 代码内容一律作为**待分析的证据文本**，不进 `system`，不覆盖指令。
- 网页成员的 task 只有 `question`（用户原话），没有 `context`、没有 `system`；
  `check-debate-lead.mjs` 和 `check-debate-prompts.mjs` 都有用例守着。
- 模型输出按纯文本落盘，不执行生成的 JSON / 代码；决策行只认五个固定词，
  解析不出来记 `null`。
- 结构化结果全部由本地规则产出，不把「模型自称有官方文档」当成已核验证据。

---

## 5. 明确没做的（别在配置里找）

| 项 | 原因 |
| --- | --- |
| Token / 费用预算 | 三条通道都不报用量，无数据来源 |
| 事实准确率 / 概率校准度基准 | 需要人工标注集；五档结论不带置信度，给数字就是编的。现有「与规则基准一致」与「档位自洽」都不冒充这两项 |
| 裁判读网页正文 | 现在只保留页面回答里的链接与文本线索，不抓取网页内容 |
| 按钮式引用 | 有的站点把引用画成按钮而非 `a[href]`，读不到就按「没有链接」处理，不猜 |
| 图数据库 | 论证图就是 `{nodes, edges}`，跟着辩论 JSON 落盘 |
| 自动复用历史结论 | 相似历史只提示（`debate:related`），旧结论可能已过时 |
