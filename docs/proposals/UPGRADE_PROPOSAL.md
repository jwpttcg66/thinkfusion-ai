> **归档说明**
>
> 来源：`~/Downloads/ThinkFusion_AI_多模型协作平台升级项目书.md`，2026-11-04 归档。
> 正文未改动。审计结论见 [docs/audits/2026-11-04-upgrade-proposal.md](../audits/2026-11-04-upgrade-proposal.md)。
> 注意：这份项目书**不含**观点融合算法细节，也不含 LLM-Blender 一节；那些内容出自另一份
> 《观点融合引擎：完整技术建议》v1.0（见 [ARCHITECTURE.md](../ARCHITECTURE.md) 第 11 章），尚未入库。

# ThinkFusion AI 多模型协作平台升级项目书

**项目名称：** ThinkFusion AI --- Multi-Model Orchestration & Debate
System\
**项目目标：** 将 ThinkFusion AI 升级为支持 Web、Local、Cloud、Hybrid
四种执行模式，并具备多模型协作、多轮辩论、观点修正、独立裁决和证据综合能力的多模型智能决策平台。

**目标硬件环境：** Apple Silicon Mac M5 系列，24GB 统一内存\
**本地模型运行时：** Ollama\
**项目实施方式：**
分阶段开发、分阶段验收，先审计现有代码，再实施架构升级。

------------------------------------------------------------------------

# 一、项目总体目标

## 1.1 最终产品定位

ThinkFusion AI 不再只是将同一个问题发送给多个 AI 网站，然后收集回答。

升级后，它应该具备以下能力：

1.  用户可以选择网页 AI、本地模型、云端 API 或混合模式。
2.  多个不同来源的模型可以共同完成一个问题。
3.  MasterAgent 可以根据任务特点自动分配模型和子任务。
4.  支持多模型独立回答、并行评审、递进分析。
5.  支持多轮辩论：独立观点、交叉质疑、反驳、观点修正。
6.  支持独立裁判，对各模型的观点和证据进行评估。
7.  Synthesis 将全部回答、证据、争议和裁决整合为最终报告。
8.  完整保存模型原始回答、辩论过程、执行记录和最终结论。
9.  支持成本、Token、并发、时间和本地内存控制。
10. 支持隐私保护，明确控制数据是否可以发送给云端。

## 1.2 最终支持的四种执行模式

  ------------------------------------------------------------------------------
  模式                    说明                           典型场景
  ----------------------- ------------------------------ -----------------------
  Web                     使用现有                       直接使用网页 AI
                          ChatGPT、Claude、Gemini 等网页 
                          Channel                        

  Local                   使用本地 Ollama 模型           隐私任务、本地分析

  Cloud                   使用云端模型 API               高质量推理、代码分析

  Hybrid                  网页、本地、云端模型协同工作   复杂问题、多模型决策
  ------------------------------------------------------------------------------

注意：

Web、Local、Cloud、Hybrid 是执行模式。

辩论、并行协作、智能分工、递进分析是协作策略。

两者必须解耦，不能混为一套枚举。

## 1.3 最终产品能力矩阵

  能力                         Web    Local   Cloud   Hybrid
  -------------- ----------------- -------- ------- --------
  单模型回答                     ✓        ✓       ✓        ✓
  多模型并行       视 Channel 能力   可配置       ✓        ✓
  智能任务分配                 ---      ---     ---        ✓
  多轮辩论                       ✓        ✓       ✓        ✓
  独立裁判                       ✓        ✓       ✓        ✓
  最终综合报告                   ✓        ✓       ✓        ✓

实际能否并行执行，必须遵循各 Provider 和现有 Web Channel 的能力限制。

------------------------------------------------------------------------

# 二、整体系统架构

## 2.1 总体架构

``` mermaid
flowchart TB
    UI[Electron UI / Conversation Settings]

    UI --> CONFIG[Conversation Execution Config]
    CONFIG --> MASTER[MasterAgent]

    MASTER --> ROUTER[Execution Router]
    ROUTER --> ORCH[Collaboration Orchestrator]

    ORCH --> DEBATE[Debate Orchestrator]
    ORCH --> PARALLEL[Parallel Collaboration]
    ORCH --> SMART[Smart Task Planner]
    ORCH --> SEQ[Sequential Collaboration]

    ROUTER --> WEB[Existing Web Channels]
    ROUTER --> LOCAL[Ollama Provider]
    ROUTER --> CLOUD[Cloud API Providers]

    WEB --> RESULT[Unified Result Pipeline]
    LOCAL --> RESULT
    CLOUD --> RESULT

    DEBATE --> RESULT
    PARALLEL --> RESULT
    SMART --> RESULT
    SEQ --> RESULT

    RESULT --> JUDGE[Independent Judge]
    JUDGE --> SYNTH[Synthesis]
    SYNTH --> RUNNER[ConversationRunner]
    RUNNER --> DB[(Conversation Storage)]
    RUNNER --> UI
```

## 2.2 核心架构原则

必须遵守：

1.  保留现有 Web Channel，不允许用 Ollama 或 API Provider
    替换现有网页能力。
2.  MasterAgent 只负责决策和调度，不直接承担底层模型通信。
3.  Ollama 独立实现为 Model Provider。
4.  云端 API 独立实现为 Model Provider。
5.  Web Channel 与 API Provider
    可以统一接入调度层，但必须保留不同的执行适配器。
6.  DebateOrchestrator 独立管理辩论流程。
7.  Judge 独立负责裁决，不和普通模型回答混为一谈。
8.  Synthesis 负责综合，不负责启动模型调用和管理辩论轮次。
9.  ConversationRunner 负责对话持久化和事件流。
10. 原始回答必须完整保存，不允许仅保存摘要。
11. 所有 Provider 必须具备超时、取消、错误处理和状态管理。
12. 新架构必须兼容现有项目，优先渐进式改造，不允许无依据的大规模重写。

------------------------------------------------------------------------

# 三、统一模型 Provider 系统

## 3.1 目标

建立统一的模型调用抽象，使系统能够调用不同来源的模型。

建议目录：

``` text
src/
  providers/
    interfaces/
      ModelProvider.ts
      ProviderCapabilities.ts
      ModelMetadata.ts

    ollama/
      OllamaProvider.ts
      OllamaClient.ts
      OllamaModelDiscovery.ts

    cloud/
      CloudProvider.ts
      OpenAICompatibleProvider.ts
      ProviderRegistry.ts

    web/
      WebChannelAdapter.ts

    registry/
      ModelRegistry.ts
      ProviderRegistry.ts
```

以上是建议目录，实际落地时先根据仓库现有结构调整。

## 3.2 统一接口

``` ts
interface ModelProvider {
  id: string;
  type: "local" | "cloud";

  listModels(): Promise<ModelMetadata[]>;

  getCapabilities(
    modelId: string
  ): Promise<ProviderCapabilities>;

  generate(
    request: ModelRequest,
    signal?: AbortSignal
  ): Promise<ModelResponse>;

  stream(
    request: ModelRequest,
    signal?: AbortSignal
  ): AsyncIterable<ModelStreamChunk>;

  healthCheck(): Promise<ProviderHealth>;
}
```

Web Channel 不应为了满足这个接口而强制伪装成普通 API Provider。

应该通过 `WebChannelAdapter` 适配现有 Channel 的能力，并保留：

-   Channel 登录状态。
-   页面状态。
-   输入发送机制。
-   回答接收机制。
-   Channel 并发限制。
-   Channel 错误和超时状态。

## 3.3 Provider 能力描述

``` ts
interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  maxContextTokens?: number;
  supportsCancellation: boolean;
  maxConcurrency: number;
  available: boolean;
}
```

能力必须实际探测或由可信配置提供，不能假设所有模型支持所有功能。

------------------------------------------------------------------------

# 四、Ollama 本地模型集成

## 4.1 目标

让 ThinkFusion AI 可以直接调用 Mac 本地 Ollama 服务。

默认服务地址：

``` text
http://127.0.0.1:11434
```

主要接口：

``` text
GET  /api/tags
GET  /api/ps
POST /api/show
POST /api/chat
```

需要实现：

1.  自动检测 Ollama 是否运行。
2.  获取已安装模型。
3.  获取当前加载模型。
4.  获取模型详细信息。
5.  发送普通请求。
6.  支持 Streaming。
7.  支持取消请求。
8.  支持模型切换。
9.  支持超时和错误处理。
10. 支持模型运行状态展示。
11. 支持上下文长度和生成长度控制。
12. 支持 keep_alive 配置。

## 4.2 本地模型初始配置

目标机器为 M5、24GB 统一内存。

建议初始配置：

  项目             默认值
  ---------------- -------------------
  主力模型         Qwen3.5 9B Q4_K_M
  备用模型         Qwen3.5 4B Q4_K_M
  本地最大并发     1
  最大驻留模型数   1
  默认上下文       8192
  默认生成长度     2048～4096
  Ollama 地址      127.0.0.1:11434

模型标签和实际可用性应以安装时 Ollama Model Library 为准。

24GB 统一内存还需要给 macOS、Electron、浏览器、KV Cache
和其他应用留出空间。

不能只依据模型权重大小判断实际运行内存。

## 4.3 本地资源管理

新增：

``` text
LocalModelAdmissionController.ts
```

职责：

-   控制本地模型最大并发。
-   防止多个大模型同时加载。
-   管理模型排队。
-   识别 Ollama 是否繁忙。
-   控制模型驻留时间。
-   提供模型加载和卸载状态。
-   提供超时和取消能力。

严禁在 MasterAgent 中直接实现 Python 或 Ollama 进程管理。

Ollama 是独立服务，ThinkFusion 通过 HTTP API 与其通信。

------------------------------------------------------------------------

# 五、云端 API Provider

## 5.1 目标

支持通过 API Key 调用不同云端模型。

第一阶段优先实现 OpenAI 兼容接口抽象。

建议配置：

``` ts
interface CloudProviderConfig {
  providerId: string;
  name: string;
  baseUrl: string;
  apiKeyRef: string;
  enabled: boolean;
  maxConcurrency: number;
  timeoutMs: number;
}
```

注意：

-   API Key 不能明文写入普通配置文件。
-   使用 Electron 安全存储机制。
-   Renderer 不得直接读取 API Key。
-   所有 API 请求由受控的 Main Process 执行。
-   不要在日志中输出密钥。
-   用户必须明确配置并启用 Provider。

## 5.2 第一阶段支持

-   OpenAI 兼容 API。
-   模型列表配置。
-   Streaming。
-   请求取消。
-   超时处理。
-   Token 使用量统计。
-   费用估算。
-   并发控制。
-   错误重试。

后续再根据需求扩展其他厂商的专用接口。

------------------------------------------------------------------------

# 六、统一执行模式与对话配置

## 6.1 Conversation 级别配置

执行模式必须保存在每个 Conversation 中。

不能只做成全局设置。

``` ts
type ExecutionMode =
  | "web"
  | "local"
  | "cloud"
  | "hybrid";

interface ConversationExecutionConfig {
  executionMode: ExecutionMode;

  primaryProviderId?: string;
  primaryModelId?: string;

  selectedWebChannels?: string[];
  selectedLocalModels?: string[];
  selectedCloudModels?: string[];

  fallbackEnabled: boolean;

  privacyMode:
    | "local-only"
    | "allow-cloud";
}
```

## 6.2 配置行为

Web：

-   使用现有网页 Channel。
-   用户可以选择参与的网页 AI。

Local：

-   使用 Ollama。
-   用户选择本地模型。

Cloud：

-   使用已配置的云端 API Provider。
-   用户选择云端模型。

Hybrid：

-   可以选择网页、本地和云端模型。
-   由协作调度器分配任务。
-   支持智能混合和全模型协作。

## 6.3 隐私策略

必须实现硬性规则：

``` text
privacyMode = local-only
```

意味着：

-   禁止向云端 API 发送用户内容。
-   禁止向网页 AI Channel 发送用户内容。
-   禁止通过 fallback 降级到云端或网页。
-   本地模型不可用时必须明确报错。
-   不允许自动突破隐私策略。

`allow-cloud` 才允许根据用户配置向云端发送数据。

网页 Channel 也属于外部数据传输，不能因为它是网页模式就绕过隐私控制。

------------------------------------------------------------------------

# 七、Hybrid 混合协作系统

## 7.1 核心目标

Hybrid 不应该简单地把同一个问题发送给所有模型。

MasterAgent 应先分析任务，再决定如何分工。

## 7.2 Hybrid 策略

``` ts
type HybridStrategy =
  | "smart"
  | "parallel"
  | "all-selected"
  | "sequential";
```

### Smart：智能混合模式

默认推荐。

MasterAgent 根据以下因素选择模型：

-   任务类型。
-   模型能力。
-   上下文长度。
-   成本。
-   延迟。
-   隐私要求。
-   本地资源情况。
-   Provider 可用性。

例如：

``` text
用户问题
  ↓
MasterAgent 任务分析
  ↓
本地 Qwen：任务分类、信息提取
  ↓
ChatGPT 网页：核心方案设计
  ↓
Claude 网页：独立评审
  ↓
云端 API：补充验证
  ↓
Synthesis：综合
```

这是任务分工，不是每个模型都回答全部内容。

### Parallel：并行协作

多个模型同时回答同一个问题。

适合：

-   观点对比。
-   多模型评审。
-   独立方案生成。

### All-selected：全模型协作

用户选中的模型都必须参与。

适合：

-   重要架构设计。
-   技术选型。
-   重大方案评估。

### Sequential：递进协作

前一个模型的输出交给后一个模型继续分析。

适合：

-   分步骤研究。
-   方案完善。
-   多阶段代码审查。

------------------------------------------------------------------------

# 八、多轮辩论系统（重点功能）

## 8.1 项目目标

新增独立的 `DebateOrchestrator`。

多轮辩论不是简单地让模型重复回答。

必须具备：

1.  独立观点。
2.  交叉质疑。
3.  反驳回应。
4.  观点修正。
5.  证据核验。
6.  停止判断。
7.  最终裁决。
8.  完整辩论记录。

## 8.2 辩论策略

``` ts
type DebateStrategy =
  | "standard"
  | "deep"
  | "adversarial";
```

### Standard：标准辩论

默认流程：

``` text
第一轮：独立观点
第二轮：交叉质疑
第三轮：反驳回应
第四轮：观点修订
第五轮：最终裁决
```

默认两轮交锋。

### Deep：深度辩论

-   最多 5 轮交锋。
-   每轮可以重新评估证据。
-   允许模型修正自己的观点。
-   允许追加独立评审。
-   根据停止条件提前结束。

### Adversarial：对抗辩论

-   明确正方。
-   明确反方。
-   独立评审方。
-   裁判方。

正反双方必须主动寻找对方论证中的问题。

不能只重复各自立场。

## 8.3 辩论角色

``` ts
type DebateRole =
  | "proposer"
  | "challenger"
  | "reviewer"
  | "judge";
```

  角色         责任
  ------------ ----------------------------
  Proposer     提出方案和论证
  Challenger   寻找漏洞、反例和风险
  Reviewer     审查技术事实、证据和逻辑
  Judge        独立评估全部论证并形成裁决

角色可以在不同轮次调整，但每次发言必须记录当前角色。

## 8.4 辩论执行流程

``` mermaid
flowchart TD
    A[用户提出问题] --> B[选择参与模型]
    B --> C[独立观点生成]
    C --> D[收集全部原始回答]
    D --> E[交叉质疑]
    E --> F[反驳和回应]
    F --> G[观点修正]
    G --> H{停止条件满足?}
    H -->|否| E
    H -->|是| I[独立裁判]
    I --> J[证据和争议综合]
    J --> K[最终报告]
```

必须保证第一轮模型独立回答，不能在生成第一轮答案前看到其他模型的观点。

后续轮次只接收完成当前任务所需要的辩论上下文，避免无意义地传递所有历史。

## 8.5 辩论数据结构

``` ts
interface DebateConfig {
  enabled: boolean;

  strategy: DebateStrategy;

  maxRounds: number;

  participants: string[];

  judgeModelId?: string;

  autoStop: boolean;

  maxBudgetTokens?: number;

  maxDurationMs?: number;
}

interface DebateRound {
  id: string;

  round: number;

  phase:
    | "opening"
    | "cross-examination"
    | "rebuttal"
    | "revision"
    | "judgment";

  participantId: string;

  role: DebateRole;

  content: string;

  claims: string[];

  evidence: string[];

  objections: string[];

  responses: string[];

  providerId: string;

  modelId: string;

  status:
    | "pending"
    | "running"
    | "completed"
    | "failed";

  createdAt: number;
}

interface DebateResult {
  debateId: string;

  rounds: DebateRound[];

  consensus: string[];

  disputed: string[];

  rejectedClaims: string[];

  unresolvedQuestions: string[];

  finalConclusion: string;

  confidenceExplanation: string;
}
```

需要结合现有 Conversation、Message 和 Agent
结构调整，不能机械地新增重复的数据模型。

## 8.6 自动停止机制

支持：

-   达到最大轮数。
-   达到 Token 预算。
-   达到时间预算。
-   连续一轮没有产生新的有效论据。
-   关键质疑均得到回应。
-   观点已经稳定。
-   用户手动终止。

注意：

停止辩论不代表已经达成共识。

如果证据不足，必须允许输出"无法确定"。

## 8.7 独立裁判机制

裁判不能简单统计哪个观点获得更多模型支持。

必须评估：

1.  论证逻辑。
2.  证据可靠性。
3.  事实正确性。
4.  反例处理能力。
5.  质疑回应完整性。
6.  方案可行性。
7.  风险和限制。
8.  未解决问题。

裁判必须保留有充分证据支持的少数派观点。

不能为了生成一个统一答案而强行消除分歧。

------------------------------------------------------------------------

# 九、Synthesis 综合系统升级

## 9.1 现有能力保护

如果现有 Synthesis 已经支持：

-   consensus
-   disputed
-   unique
-   gaps
-   recommendation

必须保留这些能力。

升级应以增强为主，而不是推倒重写。

## 9.2 新的综合报告结构

``` ts
interface FinalSynthesis {
  executiveSummary: string;

  consensus: string[];

  disputed: string[];

  uniqueInsights: string[];

  evidence: EvidenceItem[];

  rejectedClaims: string[];

  unresolvedQuestions: string[];

  risks: string[];

  recommendations: string[];

  finalDecision: string;

  confidenceExplanation: string;
}
```

报告必须能够回答：

-   哪些结论已经有充分证据支持？
-   哪些结论只是模型推测？
-   哪些观点发生了改变？
-   哪些质疑没有得到解决？
-   哪些少数派观点值得保留？
-   最终建议的依据是什么？

## 9.3 证据管理

每个重要结论尽量关联：

-   来源模型。
-   辩论轮次。
-   原始发言 ID。
-   原文段落或外部资料引用。
-   证据类型。
-   证据可靠性说明。

模型之间互相认可不能直接当作事实证据。

------------------------------------------------------------------------

# 十、已有网页内容提取能力的接入

当前项目已经实现网页内容提取和整理。

本次项目不重新开发 Fetcher 或 Extractor。

重点是将现有提取结果作为统一的上下文输入，接入 Web、Local、Cloud、Hybrid
和 Debate 流程。

需要增加：

1.  内容长度估算。
2.  Token 估算。
3.  超长内容分块。
4.  输入完整性检查。
5.  内容截断检测。
6.  原始内容快照保留。
7.  段落 ID 或来源定位。
8.  摘要与原文的关联。
9.  关键结论的证据引用。
10. 防止网页内容中的 Prompt Injection。

网页提取内容一律视为不可信数据。

不得执行网页内容中包含的系统指令、工具指令或未经用户授权的操作。

长内容不能仅依靠一段摘要代替全部原文。

必要时应通过分块、按需补充原文和来源引用完成分析。

------------------------------------------------------------------------

# 十一、Admission Controller 和资源管理

新增统一调度控制机制。

建议目录：

``` text
src/
  orchestration/
    admission/
      AdmissionController.ts
      LocalModelAdmissionController.ts
      CloudAdmissionController.ts
      WebChannelAdmissionController.ts
```

## 11.1 初始资源配置

  资源                               初始限制
  --------------------- ---------------------
  Ollama 本地并发                           1
  本地加载模型数量                          1
  Cloud API 并发                         2～4
  Web Channel 并发        按现有 Channel 能力
  默认辩论轮数                              2
  最大辩论轮数                              5
  Hybrid 交叉评审模型                2 个起步

这些是初始默认值，不是硬编码的永久限制。

## 11.2 资源控制能力

-   全局并发限制。
-   Provider 独立并发限制。
-   本地模型排队。
-   请求优先级。
-   Token 预算。
-   费用预算。
-   时间预算。
-   超时处理。
-   用户取消。
-   失败重试。
-   模型健康检查。
-   任务状态监控。

辩论任务必须受预算控制，不能无限调用模型。

------------------------------------------------------------------------

# 十二、前端 UI 和交互设计

## 12.1 新建对话设置

新建对话时允许选择：

**执行模式：**

-   Web
-   Local
-   Cloud
-   Hybrid

**协作方式：**

-   单模型执行
-   并行协作
-   智能混合
-   全模型协作
-   递进分析
-   多轮辩论

协作方式应根据执行模式和可用模型能力动态显示。

## 12.2 辩论设置

启用辩论后允许设置：

-   标准辩论。
-   深度辩论。
-   对抗辩论。
-   最大轮数。
-   参与模型。
-   正方和反方。
-   评审模型。
-   裁判模型。
-   自动停止。
-   Token 预算。
-   时间预算。

## 12.3 对话执行过程展示

建议增加可展开的执行时间线：

``` text
用户问题
  │
  ├── MasterAgent 任务分析
  │
  ├── 模型独立回答
  │    ├── ChatGPT
  │    ├── Claude
  │    └── Qwen Local
  │
  ├── 第一轮质疑
  │
  ├── 第一轮反驳
  │
  ├── 第二轮质疑
  │
  ├── 观点修订
  │
  ├── Judge 裁决
  │
  └── 最终综合报告
```

每个阶段显示：

-   当前模型。
-   Provider。
-   执行状态。
-   耗时。
-   Token 使用量。
-   错误状态。
-   原始回答。
-   观点变化。

## 12.4 历史记录

历史对话需要能够查看：

-   当时的执行模式。
-   使用的模型。
-   每轮辩论内容。
-   模型原始回答。
-   观点修正记录。
-   最终裁决。
-   Token 和费用统计。

------------------------------------------------------------------------

# 十三、数据存储和兼容性

必须先审计现有数据库、消息格式和持久化方式。

新增数据应尽可能复用现有 Conversation、Message、Agent 和 Event 机制。

建议新增或扩展：

``` text
Conversation
  ├── executionConfig
  ├── collaborationConfig
  ├── debateConfig
  └── messages

ExecutionTask
  ├── taskId
  ├── conversationId
  ├── providerId
  ├── modelId
  ├── status
  ├── latency
  ├── tokenUsage
  └── routingReason

DebateSession
  ├── debateId
  ├── conversationId
  ├── strategy
  ├── participants
  ├── rounds
  └── result
```

必须考虑：

-   老版本数据兼容。
-   数据迁移。
-   失败任务恢复。
-   应用重启后的状态恢复。
-   用户取消后的状态一致性。
-   历史数据不丢失。
-   原始消息不可被摘要覆盖。

------------------------------------------------------------------------

# 十四、Electron 安全和隐私要求

这是不可妥协的要求。

1.  Renderer 不得直接访问敏感 API Key。
2.  模型 API 请求由 Main Process 或现有安全服务执行。
3.  IPC 必须有输入校验。
4.  Provider 配置必须校验 URL。
5.  防止任意本地地址访问和 SSRF。
6.  不允许未经授权访问本地文件。
7.  不允许未经用户授权执行 Shell 命令。
8.  不允许网页提取内容中的指令直接触发工具。
9.  Local-only 必须禁止所有外部模型传输。
10. API Key 不得写入日志。
11. 所有异步任务支持取消。
12. 所有模型调用有超时和错误边界。

------------------------------------------------------------------------

# 十五、项目实施阶段和开发顺序

必须严格分阶段实施。

每个阶段都有明确交付物和验收标准。

## Phase A：现有项目全面审计

**目标：先弄清楚现有项目，禁止直接改代码。**

审计内容：

1.  仓库目录结构。
2.  MasterAgent。
3.  SubAgent。
4.  SubAgentPool。
5.  ConversationRunner。
6.  Synthesis。
7.  Web Channel。
8.  网页内容提取流程。
9.  Electron Main/Renderer。
10. IPC。
11. 数据库和持久化。
12. 现有任务调度机制。
13. 测试体系。
14. 现有错误处理和取消机制。

交付文档：

``` text
docs/
  architecture/
    CURRENT_ARCHITECTURE.md
    MODEL_PROVIDER_AUDIT.md
    WEB_CHANNEL_AUDIT.md
    SYNTHESIS_AUDIT.md
    DATA_MODEL_AUDIT.md

  implementation/
    MULTI_MODEL_UPGRADE_PLAN.md
    RISKS_AND_COMPATIBILITY.md
```

必须明确：

-   哪些模块可以复用。
-   哪些模块需要改造。
-   哪些模块需要新增。
-   哪些设计会影响旧功能。
-   现有架构中存在的技术债。
-   推荐的最小改动路径。

**Phase A 完成后必须停止，等待人工审核。**

不允许自动开始 Phase B。

## Phase B：统一 Provider 抽象

目标：

-   实现 Provider 接口。
-   实现 Provider Registry。
-   实现 Model Registry。
-   实现能力描述。
-   实现统一错误模型。
-   实现超时和取消。
-   保留现有 Web Channel。

验收：

-   现有 Web Channel 可以正常运行。
-   新接口不会破坏原有调用流程。
-   Provider 可以独立注册和检测状态。
-   测试通过。

## Phase C：Ollama 集成

目标：

-   实现 OllamaProvider。
-   获取本地模型。
-   模型状态检测。
-   普通调用。
-   Streaming。
-   取消。
-   超时。
-   本地并发限制。
-   模型驻留控制。

验收：

-   能识别 Ollama 服务状态。
-   能获取模型列表。
-   能使用本地模型回答问题。
-   能正常接收流式回答。
-   不会因为并发请求造成无限加载。
-   Ollama 不可用时能明确提示。

## Phase D：Cloud API 集成

目标：

-   实现 Cloud Provider。
-   API Key 安全存储。
-   Provider 配置。
-   模型选择。
-   Streaming。
-   超时。
-   重试。
-   Token 统计。
-   费用估算。

验收：

-   可以配置并调用云端模型。
-   API Key 不暴露给 Renderer。
-   错误和限流能够正确处理。
-   用户可以禁用 Provider。

## Phase E：统一执行模式

目标：

-   Web。
-   Local。
-   Cloud。
-   Hybrid。

实现：

-   ConversationExecutionConfig。
-   执行模式切换。
-   Provider 选择。
-   Model 选择。
-   Fallback Policy。
-   Privacy Mode。

验收：

-   新建对话可以选择四种执行模式。
-   每个对话独立保存配置。
-   切换模式不丢失历史。
-   Local-only 不会发生云端降级。
-   老对话仍能正常打开。

## Phase F：Hybrid Orchestrator

目标：

实现：

-   Smart。
-   Parallel。
-   All-selected。
-   Sequential。

实现智能任务分配、并发控制、任务状态管理和失败恢复。

验收：

-   可以将任务分配给不同 Provider。
-   可以并行执行多个模型任务。
-   可以串行传递前序结果。
-   可以控制资源和预算。
-   每个子任务都有独立执行记录。

## Phase G：多轮辩论系统

这是核心功能阶段。

实现：

-   DebateOrchestrator。
-   DebateConfig。
-   DebateRound。
-   DebateRole。
-   Standard Debate。
-   Deep Debate。
-   Adversarial Debate。
-   交叉质疑。
-   反驳。
-   观点修正。
-   自动停止。
-   用户中止。
-   辩论状态恢复。

验收：

-   至少两个不同模型能够参与辩论。
-   第一轮独立生成观点。
-   第二轮能够看到并质疑其他模型观点。
-   后续轮次能够逐条回应质疑。
-   模型可以修改原始观点。
-   少数派观点完整保留。
-   辩论达到上限后能够停止。
-   用户可以中止。
-   完整过程可恢复和查看。

## Phase H：Judge 独立裁决

目标：

-   独立裁判。
-   证据评估。
-   论证质量评估。
-   少数派观点保护。
-   未解决问题提取。
-   最终结论。

验收：

-   Judge 能读取完整辩论记录。
-   不以模型数量作为正确性判断依据。
-   可以输出无法确定。
-   可以明确说明分歧原因。
-   结果能关联原始回答和证据。

## Phase I：Synthesis 升级

目标：

保留现有 Synthesis 能力，增加：

-   Debate Result。
-   Evidence。
-   Rejected Claims。
-   Unresolved Questions。
-   Final Decision。
-   Confidence Explanation。

验收：

-   能生成结构化报告。
-   能保留不同观点。
-   能引用原始模型回答。
-   不会丢失少数派观点。
-   不会把模型共识误认为事实。

## Phase J：前端 UI

目标：

-   新建对话执行模式选择。
-   模型选择。
-   Hybrid 配置。
-   辩论设置。
-   辩论过程时间线。
-   实时状态。
-   最终报告。
-   历史查看。
-   预算统计。

验收：

-   UI 能完整操作四种模式。
-   能启用和关闭辩论。
-   能设置参与模型和轮数。
-   能看到各轮发言。
-   能查看最终裁决。
-   失败和取消状态正确展示。

## Phase K：稳定性和性能测试

重点测试：

1.  Web 模式回归。
2.  Local 模式。
3.  Cloud 模式。
4.  Hybrid 模式。
5.  多模型并行。
6.  多轮辩论。
7.  模型中途失败。
8.  网络中断。
9.  Ollama 退出。
10. API 限流。
11. 用户取消。
12. 应用重启。
13. 历史记录恢复。
14. 隐私模式。
15. 超长网页内容。
16. Token 预算耗尽。
17. 多个 Conversation 同时执行。

交付：

``` text
docs/
  testing/
    TEST_PLAN.md
    TEST_REPORT.md
    PERFORMANCE_REPORT.md
    SECURITY_REPORT.md
```

------------------------------------------------------------------------

# 十六、项目验收标准

最终必须满足以下条件才能视为项目完成。

## 基础能力

-   [ ] 现有 Web Channel 不受破坏。
-   [ ] Ollama 本地模型可以调用。
-   [ ] 云端 API 模型可以调用。
-   [ ] 四种执行模式正常工作。
-   [ ] 每个 Conversation 独立保存执行配置。

## 混合协作

-   [ ] 智能分工。
-   [ ] 多模型并行。
-   [ ] 全模型协作。
-   [ ] 递进分析。
-   [ ] 任务状态追踪。
-   [ ] 失败恢复。

## 多轮辩论

-   [ ] 独立观点。
-   [ ] 交叉质疑。
-   [ ] 反驳回应。
-   [ ] 观点修正。
-   [ ] 自动停止。
-   [ ] 手动停止。
-   [ ] 独立裁判。
-   [ ] 少数派观点保留。
-   [ ] 完整辩论历史。

## 综合分析

-   [ ] 共识。
-   [ ] 争议。
-   [ ] 独特观点。
-   [ ] 证据来源。
-   [ ] 被否定观点。
-   [ ] 未解决问题。
-   [ ] 最终建议。

## 安全和性能

-   [ ] API Key 安全存储。
-   [ ] Local-only 隐私约束。
-   [ ] 本地模型最大并发受控。
-   [ ] Token 预算控制。
-   [ ] 费用预算控制。
-   [ ] 超时和取消机制。
-   [ ] 无明显资源泄漏。
-   [ ] 旧版本数据兼容。

------------------------------------------------------------------------

# 十七、关键设计决策

以下决策在开发中必须保持一致。

**决策 1：执行模式与协作策略分离。**

Web、Local、Cloud、Hybrid 是执行模式。

Smart、Parallel、Sequential、Debate 是协作策略。

**决策 2：辩论是独立子系统。**

不能把多轮辩论逻辑直接堆在 MasterAgent 或 Synthesis 中。

**决策 3：Web Channel 必须保留。**

不能为了统一 Provider 而重写现有网页 AI 执行机制。

**决策 4：本地模型必须受到资源约束。**

M5 24GB 默认只允许一个本地模型并发执行。

**决策 5：裁判独立于参辩模型。**

如果资源或模型数量不足，可以允许指定某个参与模型兼任裁判，但必须明确标记这一事实，并尽可能使用独立裁判。

**决策 6：原始答案不可丢失。**

摘要、观点提取和最终报告不能覆盖模型原始回答。

**决策 7：不强求共识。**

有充分证据的少数派观点必须保留。

**决策 8：隐私策略优先于自动调度。**

Local-only 模式下，任何自动降级都不得突破隐私边界。

**决策 9：渐进式迁移。**

先兼容现有架构，再逐步引入新能力，不进行没有充分理由的大规模重构。

------------------------------------------------------------------------

# 十八、交付物清单

最终需要交付：

``` text
docs/
  architecture/
    CURRENT_ARCHITECTURE.md
    TARGET_ARCHITECTURE.md
    PROVIDER_ARCHITECTURE.md
    DEBATE_ARCHITECTURE.md
    SYNTHESIS_ARCHITECTURE.md

  implementation/
    MULTI_MODEL_UPGRADE_PLAN.md
    IMPLEMENTATION_PROGRESS.md
    DATA_MIGRATION.md
    RISKS_AND_COMPATIBILITY.md

  testing/
    TEST_PLAN.md
    TEST_REPORT.md
    PERFORMANCE_REPORT.md
    SECURITY_REPORT.md

src/
  providers/
  orchestration/
  debate/
  synthesis/
  admission/
```

目录仅作为建议，最终以实际仓库架构为准。

------------------------------------------------------------------------

# 十九、给 Codex 的执行指令

你现在是这个项目的高级架构师和高级工程师。

请按照本项目书实施 ThinkFusion AI 多模型协作平台升级。

必须遵守以下开发纪律：

1.  第一件事是全面阅读仓库和现有代码。
2.  不允许根据项目名称或文档猜测代码实现。
3.  不允许在没有完成架构审计前直接修改业务代码。
4.  不允许一开始就大规模重构。
5.  不允许破坏现有 Web Channel。
6.  不允许删除现有功能。
7.  不允许跳过测试。
8.  不允许把所有逻辑写入 MasterAgent。
9.  不允许把辩论调度写进 Synthesis。
10. 不允许让本地模型无上限并发。
11. 不允许绕过 Electron IPC 安全边界。
12. 不允许把 API Key 明文写入配置和日志。
13. 不允许自动突破 Local-only 隐私限制。
14. 不允许因为模型多数赞同就认定某个观点正确。
15. 不允许为了达成共识而删除少数派观点。

## 第一阶段执行要求

**当前只允许执行 Phase A：现有项目全面审计。**

具体任务：

-   读取仓库目录。
-   阅读核心源代码。
-   梳理实际架构。
-   确认现有 Web Channel 工作流程。
-   确认 MasterAgent 和 SubAgent 的职责。
-   确认 ConversationRunner 的消息与事件机制。
-   确认 Synthesis 的真实实现。
-   确认网页内容提取流程。
-   确认数据持久化方式。
-   确认 Electron IPC 安全边界。
-   确认测试体系。
-   形成架构审计报告。
-   形成目标架构与现有架构的差异报告。
-   形成分阶段实施计划。

## 第一阶段禁止事项

-   不修改业务代码。
-   不修改数据库结构。
-   不安装新的依赖。
-   不新增 Provider 实现。
-   不修改 UI。
-   不自动启动 Phase B。
-   不删除或重构现有模块。

## 第一阶段完成后

向我汇报：

1.  现有架构分析。
2.  关键模块及其真实代码位置。
3.  可以直接复用的模块。
4.  需要修改的模块。
5.  需要新增的模块。
6.  潜在兼容性问题。
7.  风险清单。
8.  推荐实施顺序。
9.  Phase B 的详细开发方案。

然后停止执行，等待人工确认。

**只有在我明确确认后，才能开始 Phase B。**

后续每个阶段也必须遵循：

-   先给出本阶段实施计划。
-   明确修改文件。
-   实施代码。
-   执行测试。
-   汇报实际结果。
-   列出未完成事项。
-   等待下一阶段确认。

不得将未执行的测试标记为通过，不得将计划实现的功能描述成已经完成。

------------------------------------------------------------------------

**最终目标：**

将 ThinkFusion AI 建设为一个真正的多模型协作系统。

它不仅能调用不同模型，还能让不同模型独立思考、分工合作、相互质疑、反驳修正、检查证据，最后由独立裁判给出有依据、有争议说明、可追溯的综合结论。

项目的核心价值不是模型数量，而是模型之间的协作质量、辩论质量和最终决策质量。
