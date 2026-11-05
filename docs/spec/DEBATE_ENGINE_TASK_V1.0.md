# ThinkFusion AI 真理发现与多模型辩论引擎 · Codex 实施任务书 V1.0

> 本文是任务书原文的仓库内副本，供实施与评审引用。
> 原始文件：`ThinkFusion_AI_真理发现与多模型辩论引擎_Codex实施任务书_V1.0.docx`
> （同目录保留，格式与表格以 docx 为准）。由 docx 转 Markdown，正文未改写。
>
> 实施状态见 `docs/architecture/DEBATE_ENGINE_AUDIT.md`（Phase 0 审计）与
> `docs/implementation/PHASE-1-DEBATE-CLAIMS.md`（Phase 1 交付）。
> Phase 2 见 `PHASE-2-DEBATE-REVISION.md`，Phase 3 见
> `PHASE-3-DEBATE-ARGUMENT-JUDGE.md`（论证图与三维裁判）。

---

ThinkFusion AI
真理发现与多模型辩论引擎
Codex 实施任务书 V1.0
面向仓库：jwpttcg66/thinkfusion-ai
版本：V1.0  |  文档性质：技术设计与实施规范
核心目标：证据驱动、可追溯、允许反对与修正的多模型协作

# 文档说明
本任务书定义 ThinkFusion AI 真理发现与多模型辩论引擎的目标架构、核心数据结构、接口边界、辩论算法、证据评价、持久化、并发预算、安全要求、测试与验收标准，供 Codex 分阶段实施。
重要约束：本版是基于已讨论的 ThinkFusion 架构方向形成的实施规范，并非对当前 GitHub 仓库逐文件审计后的代码映射。因此，文中目录和文件名均为建议落点。Codex 必须先读取仓库实际结构、技术栈和现有接口，再将设计映射到真实文件；不得未经核实就创建重复模块或替换现有实现。
# 1. 项目目标与设计原则
## 1.1 项目目标
在现有 ThinkFusion 多模型协作能力上增加独立的 DebateOrchestrator，形成可控的多轮辩论闭环。
将执行模式与协作策略解耦：Web、Local、Cloud、Hybrid 决定模型/工具从哪里执行；truth、adversarial 等策略决定如何协作。
让模型先独立分析，再暴露观点、相互质疑、补充证据、修正结论，避免首轮答案相互污染。
建立 Claim、Evidence、Dispute、ArgumentGraph 等结构化对象，保留论点与证据之间的可追溯关系。
引入独立裁判机制，不以简单多数投票决定真伪；允许结论为部分成立、证据不足或暂不可判定。
将辩论过程、证据来源、模型修正和最终结论沉淀为可查询、可恢复的知识资产。
## 1.2 非目标
不承诺通过增加模型数量自动获得真理；模型共识不等于事实。
不在 V1.0 中训练基础模型或自建大规模模型权重。
不要求所有问题都进入多轮辩论；简单问题应允许走快速路径。
不允许裁判仅凭语言流畅度、模型声誉或票数作出判断。
不将 Web 搜索结果直接视为已验证事实；来源必须经过相关性、可信度和证据强度评估。
## 1.3 核心原则
独立性：首轮各参与模型不得看到其他模型的首轮答案。
可证伪：重要主张必须能被反例、实验、原始资料或逻辑检验挑战。
可追溯：结论必须能追溯到 Claim、Evidence、来源和判断理由。
可修正：参与者可以接受、辩护、修订、撤回或标记无法判断。
不确定性诚实：证据不足时输出不确定，不强行制造共识。
预算可控：轮数、并发、搜索、Token、时间和费用均有上限。
# 2. 仓库审计与实施前置要求
Codex 开始编码前，必须完成以下审计并输出仓库映射报告：
读取 README、项目说明、依赖清单、构建脚本、环境配置和现有测试。
识别当前 MasterAgent、SubAgentPool、AskStage、SynthesisEngine、模型路由、工具调用和持久化实现。
识别当前执行模式（Web/Local/Cloud/Hybrid）及模型注册、配置和调用接口。
确认现有任务生命周期、事件机制、并发控制、超时、取消和错误处理方式。
确认前端对话状态、模式选择、流式输出和历史记录的数据契约。
形成“现有模块 → 目标职责 → 复用/扩展/新增”的映射表，避免重复建设。
审计产物建议：docs/architecture/debate-engine-repository-audit.md。若仓库已有文档目录或规范，应沿用现有约定。
# 3. 总体架构
建议采用分层架构：对话入口负责接收用户请求；策略路由器决定是否进入辩论以及采用何种策略；DebateOrchestrator 管理会话和轮次；Controller 负责拆解、争议识别与挑战生成；EvidenceEvaluator 评价证据；DebateJudge 形成结构化判断；SynthesisEngine 负责最终面向用户的综合表达。
| 组件 | 职责 | 实施要求 |
| --- | --- | --- |
| MasterAgent | 理解用户任务、调用既有 Agent/工具体系 | 优先复用；不将辩论状态机塞入 MasterAgent |
| SubAgentPool | 模型/Agent 参与者管理与并行执行 | 复用现有池化和调度能力 |
| DebateStrategyRouter | 判断问题是否需要辩论并选择策略 | 与执行模式分离 |
| DebateOrchestrator | 会话、轮次、状态、预算、恢复和取消 | 新增独立核心模块 |
| DebateController | Claim 提取、争议检测、挑战和修订流程 | 将流程编排与模型调用解耦 |
| ArgumentGraph | 表达 Claim、Evidence、反驳和支持关系 | 作为可持久化核心资产 |
| EvidenceEvaluator | 来源校验、相关性、独立性、证据强度评估 | 保留评分依据和来源元数据 |
| DebateJudge | 逻辑、证据、反例和最终状态判断 | 不采用简单多数票 |
| SynthesisEngine | 生成最终报告和用户可读答案 | 必须保留分歧与不确定性 |

# 4. 执行模式与协作策略
## 4.1 执行模式
| 模式 | 含义 | 典型用途 |
| --- | --- | --- |
| web | 以网页检索/网页模型为主，使用可访问的外部资料 | 事实核查、最新信息、资料汇总 |
| local | 通过 Ollama 等本地服务调用本地模型 | 隐私任务、低边际成本、离线推理 |
| cloud | 调用云端模型 | 复杂推理、高能力模型、长上下文 |
| hybrid | 按任务阶段混合本地、云端和 Web 工具 | 复杂问题、成本与质量平衡 |

执行模式回答“在哪里执行”；协作策略回答“如何协作”。二者必须独立配置和持久化。
## 4.2 协作策略
| 策略 ID | 策略名称 | 行为重点 |
| --- | --- | --- |
| truth | 真理发现 | 寻找最有证据支持的解释，主动检验主张 |
| adversarial | 对抗辩论 | 优先寻找反例、漏洞和隐藏假设 |
| expert | 专家评审 | 按领域角色分工，要求专业证据 |
| assumption | 假设审查 | 显式列出前提并逐项验证 |
| solution | 方案竞争 | 生成候选方案并按约束、风险和证据比较 |
| discovery | 探索发现 | 并行探索不同假设，逐步缩小搜索空间 |

# 5. 核心数据结构
以下为逻辑数据模型，具体语言类型、序列化方式和 ORM 结构由仓库技术栈决定。
| 对象 | 关键字段 | 说明 |
| --- | --- | --- |
| DebateSession | id, conversationId, question, strategy, executionMode, status, roundLimit, budget, createdAt | 一次辩论会话 |
| DebateParticipant | id, sessionId, modelId, provider, role, capabilities, status | 参与模型及角色 |
| DebateRound | id, sessionId, roundNo, phase, startedAt, finishedAt, status | 一轮辩论及阶段记录 |
| DebateClaim | id, roundId, participantId, text, kind, confidence, status | 可独立评价的主张 |
| DebateEvidence | id, claimId, type, source, locator, excerpt, fingerprint, relevance, strength | 支持或反驳主张的证据 |
| DebateDispute | id, sessionId, claimIds, disputeType, severity, status | 模型间或证据间的争议 |
| ArgumentEdge | fromId, toId, relation, rationale | 论证图中的支持、反驳、依赖等关系 |
| DebateJudgment | id, targetId, judgeType, verdict, rationale, evidenceRefs | 裁判对主张/争议的判断 |
| DebateResult | sessionId, conclusion, confidence, unresolvedIssues, evidenceSummary | 最终结果 |

## 5.1 枚举建议
| 枚举 | 建议取值 |
| --- | --- |
| DebateStatus | created, running, waiting, completed, inconclusive, failed, cancelled |
| ParticipantRole | proposer, challenger, domain_expert, evidence_reviewer, judge |
| ClaimKind | fact, inference, assumption, opinion, prediction, recommendation |
| ClaimStatus | proposed, supported, challenged, revised, withdrawn, unresolved |
| EvidenceType | official_doc, source_code, experiment, standard, paper, dataset, report, web_page, user_input |
| DisputeType | factual, logical, definitional, causal, assumption, scope, evidence_conflict |
| ArgumentRelation | supports, rebuts, qualifies, depends_on, contradicts, derived_from |
| RevisionDecision | accept, defend, revise, withdraw, inconclusive |
| Verdict | supported, partially_supported, unsupported, contradicted, insufficient_evidence |

# 6. 多轮辩论算法
## 6.1 主流程
任务理解：抽取问题范围、时间约束、领域、风险等级和用户指定执行模式。
策略路由：判断是否需要辩论；选择 truth/adversarial/expert 等策略。
参与者选择：按能力、成本、延迟和可用性选择模型，避免只选同一模型家族。
独立分析：并行调用参与者；每个参与者只看到原始问题和共同上下文。
Claim 提取：将回答拆成原子主张，区分事实、推断、假设、观点和建议。
争议检测：识别互相矛盾、定义不同、范围不一致和证据冲突的主张。
挑战生成：针对高影响争议生成具体反例请求、证据请求或逻辑质询。
修订回应：参与者对挑战作出 accept/defend/revise/withdraw/inconclusive 决策并说明理由。
证据评价：核查来源、相关性、独立性、时效性和证据强度。
裁判判断：分别评估逻辑、证据和反例；记录判断理由与引用。
停止判断：根据争议是否收敛、证据质量、预算和轮数决定继续或结束。
综合输出：给出结论、证据链、反方观点、未解决问题和置信度。
## 6.2 轮次建议
默认最多 3 轮；允许按问题复杂度、风险和预算调整。
第一轮必须独立分析，不允许参与者读取其他参与者的答案。
第二轮围绕高优先级争议进行挑战和回应。
第三轮用于关键证据补充、修订确认和裁判收敛。
不得为了达到共识而强迫模型改变观点；保留有证据支持的少数派观点。
## 6.3 争议优先级
争议优先级可综合影响程度、事实性、可验证性、证据缺口、用户任务相关性和错误代价计算。建议先处理会改变最终结论的核心争议，再处理措辞、次要边界和低影响差异。
建议评分：priority = impact × uncertainty × decision_relevance × verifiability；各因子归一化至 0–1。
## 6.4 停止条件
关键争议已得到足够证据支持，且后续轮次预期收益较低。
连续一轮没有新增有效证据、反例或实质性观点修订。
达到最大轮数、Token/费用预算或阶段超时。
核心问题本身不可验证，或现有工具无法获得足够证据，应输出 inconclusive。
用户取消或上游任务失败。
# 7. 裁判与证据评价
## 7.1 裁判维度
| 裁判器 | 关注点 | 输出 |
| --- | --- | --- |
| LogicJudge | 推理是否有效、是否偷换概念、是否存在逻辑跳跃 | 逻辑问题、有效性判断、理由 |
| EvidenceJudge | 证据是否真实、相关、独立、足够且适用 | 证据质量、来源风险、支持强度 |
| CounterexampleJudge | 是否存在足以推翻或限制结论的反例 | 反例、适用边界、反驳强度 |
| FinalJudge | 综合逻辑、证据、反例和不确定性 | 结构化 verdict 与解释 |

裁判输入必须包含原始 Claim、原始参与者消息、证据原文/定位信息、争议上下文和来源元数据。不得只把各模型的摘要交给裁判。裁判应尽可能独立于被裁判的参与者模型。
## 7.2 证据优先级
可重复实验、直接测量和可验证的原始数据。
官方技术文档、标准规范、官方公告和源代码。
同行评审论文、系统性研究和可信研究机构报告。
有明确作者、方法和来源链的专业分析。
一般网页、论坛和社交内容；可用于发现线索，不宜单独支撑高风险结论。
来源优先级必须按领域调整。例如软件行为优先查源代码、官方文档和可复现实验；时事问题则必须检查发布时间。
## 7.3 证据评价维度
真实性：来源是否可访问，引用内容是否确实存在。
相关性：证据是否直接支持或反驳目标 Claim。
独立性：多个来源是否实际引用同一个原始来源。
时效性：证据是否仍适用于问题所讨论的版本/时间。
权威性：来源是否具备该领域的专业能力和责任主体。
充分性：证据强度是否足以支撑结论的确定程度。
必须记录证据 URL/定位、抓取时间、内容指纹、引用片段和评价理由。不得伪造来源或把模型生成内容标记为外部证据。
# 8. 接口设计建议
接口名称为逻辑契约，Codex 应遵循现有项目语言、命名和异步风格调整。
| 模块 | 接口 | 职责 |
| --- | --- | --- |
| DebateOrchestrator | createSession(input) | 创建辩论会话 |
| DebateOrchestrator | start(sessionId) | 启动辩论流程 |
| DebateOrchestrator | getSession(sessionId) | 查询会话及当前状态 |
| DebateOrchestrator | executeNextRound(sessionId) | 执行下一轮 |
| DebateOrchestrator | cancel(sessionId) | 取消会话 |
| DebateOrchestrator | resume(sessionId) | 从持久化状态恢复 |
| DebateController | extractClaims(messages) | 从消息中提取原子主张 |
| DebateController | detectDisputes(claims) | 识别争议 |
| DebateController | rankDisputes(disputes) | 争议排序 |
| DebateController | generateChallenges(disputes) | 生成挑战问题 |
| DebateController | evaluateContinuation(state) | 判断是否继续 |
| EvidenceEvaluator | collectEvidence(claim) | 收集证据 |
| EvidenceEvaluator | verifyEvidence(evidence) | 校验证据 |
| EvidenceEvaluator | evaluateRelevance(evidence, claim) | 评价相关性 |
| EvidenceEvaluator | detectDuplicates(evidence) | 识别重复/同源证据 |
| DebateJudge | judgeLogic(claim, context) | 逻辑判断 |
| DebateJudge | judgeEvidence(claim, evidence) | 证据判断 |
| DebateJudge | judgeCounterexamples(claim, counterexamples) | 反例判断 |
| DebateJudge | aggregateJudgments(judgments) | 形成综合裁判 |
| SynthesisEngine | synthesize(debateResult) | 生成最终用户答案 |

# 9. 持久化与事件模型
建议逻辑表/集合如下，最终以项目当前数据库和迁移规范为准：
debate_sessions：会话元数据、策略、执行模式、状态、预算和版本。
debate_participants：参与者、模型配置快照、角色和执行状态。
debate_rounds：轮次、阶段、时间、耗时和状态。
debate_claims：原子主张、类型、置信度、状态和来源消息。
debate_evidence：证据、来源、定位、指纹、评价和时间信息。
debate_disputes：争议对象、争议类型、优先级和处理状态。
debate_argument_edges：论证图边及 supports/rebuts 等关系。
debate_challenges：挑战内容、目标 Claim 和生成者。
debate_revisions：回应、修订决策、修订前后内容。
debate_judgments：裁判维度、结论、理由和证据引用。
debate_results：最终结论、置信度、分歧和未解决事项。
debate_events：按序号追加的事件流，用于审计和恢复。
持久化要求：事件写入具备幂等键；关键状态变更可恢复；同一会话事件具备稳定顺序；敏感信息遵循项目现有加密和保留策略。
# 10. 并发、预算与可靠性
| 参数 | V1.0 默认建议 | 说明 |
| --- | --- | --- |
| 最大参与模型数 | 3 | 可配置；避免无意义堆叠模型 |
| 最大辩论轮数 | 3 | 按任务复杂度调整 |
| 模型并发数 | 3 | 受 Provider 限流和机器资源约束 |
| 每轮证据搜索数 | 最多 5 组 | 按争议优先级分配 |
| 阶段超时 | 60 秒 | 按模型/工具类型可覆盖 |
| 会话总预算 | 可配置 | Token、费用、时间三类预算同时控制 |

以上是初始默认值，不是硬编码常量。需要支持配置覆盖、预算预估、实际消耗记录和超限降级。
模型超时：标记该参与者失败，按策略重试或使用其他参与者，不阻塞整个会话。
部分失败：保留已完成的独立分析和证据，明确报告缺失参与者。
搜索失败：降低结论确定性，不得把未检索到资料解释为资料不存在。
取消操作：向模型调用、搜索任务和后台工作传播取消信号。
恢复操作：根据最后一个已提交事件恢复，不重复产生不可幂等副作用。
限流处理：Provider 级并发限制、退避重试和熔断。
# 11. 安全与防护
将外部网页、文档、代码仓库和用户上传内容视为不可信数据，不能覆盖系统指令。
对 Prompt Injection 进行隔离：引用内容只作为待分析证据，不作为工具权限或策略指令。
工具调用必须经过权限校验和参数验证；辩论参与者不得自行扩大权限。
按用户/会话隔离数据，防止跨会话读取 Claim、Evidence 或历史消息。
对日志和持久化内容进行敏感信息处理，避免泄露密钥、令牌和个人数据。
对模型输出进行结构化校验；解析失败时使用受控重试，不信任任意生成的 JSON/代码。
# 12. Prompt 文件建议
建议建立独立 Prompt 模板，模板需版本化、可测试，避免把所有流程塞进单个超长 Prompt：
prompts/debate/independent-analysis.md
prompts/debate/claim-extraction.md
prompts/debate/dispute-detection.md
prompts/debate/challenge.md
prompts/debate/revision.md
prompts/debate/judgment.md
prompts/debate/synthesis.md
每个 Prompt 应明确输入 schema、输出 schema、禁止事项、引用要求和失败处理。模板升级需有版本号，历史会话保留所用 Prompt 版本。
# 13. 用户交互与结果呈现
## 13.1 模式选择
对话级选择执行模式：Web / Local / Cloud / Hybrid。
独立选择协作策略：自动 / 真理发现 / 对抗辩论 / 专家评审 / 假设审查 / 方案竞争 / 探索发现。
提供快速回答与深度辩论两种入口；简单问题默认不必启动完整辩论。
## 13.2 最终报告结构
结论摘要：直接回答用户问题。
结论状态：supported / partially_supported / unsupported / contradicted / insufficient_evidence。
关键主张：列出主要 Claim 及状态。
证据链：证据来源、定位、支持/反驳关系和质量评价。
主要分歧：说明参与模型的不同观点及其理由。
反例与边界：指出结论不适用的情况。
修订记录：展示重要观点如何因证据而改变。
不确定性：列出未解决问题、缺失证据和置信度限制。
参考来源：提供可访问的来源链接或原始资料定位。
# 14. 测试计划
## 14.1 单元测试
Claim 提取：复合句拆分、事实/假设区分、重复 Claim 合并。
争议检测：直接矛盾、范围差异、定义差异和证据冲突。
证据评价：重复来源识别、时效性、相关性和来源不可访问。
裁判逻辑：逻辑有效但证据不足、强证据支持少数派、反例限制结论。
状态机：取消、超时、重试、恢复和预算耗尽。
## 14.2 集成与回归测试用例
| 测试 ID | 场景 | 预期结果 |
| --- | --- | --- |
| TF-D-001 | 金属与骨头硬度比较 | 明确硬度指标和材料差异，不输出绝对化结论 |
| TF-D-002 | Java 堆外内存增长排查 | 区分 NMT、Unsafe、malloc、RSS 与碎片化证据 |
| TF-D-003 | Netty 与 glibc arena 行为 | 要求版本和配置证据，区分池化与分配器行为 |
| TF-D-004 | Redis 连接复用方案比较 | 比较真实多路复用能力、Cluster 支持和故障语义 |
| TF-D-005 | Ollama 本地模型选择 | 纳入内存、并发、上下文和质量约束 |
| TF-D-006 | 用户问题包含错误前提 | 识别并纠正错误前提，不顺从错误假设 |
| TF-D-007 | 多个模型共同犯错 | 不因多数一致而直接判为正确 |
| TF-D-008 | 少数派观点有更强证据 | 允许少数派结论胜出并说明理由 |
| TF-D-009 | 证据来源互相转载 | 识别同源来源，避免虚增独立证据数量 |
| TF-D-010 | 证据不足或工具失败 | 输出 insufficient_evidence/inconclusive，不伪造结论 |

## 14.3 质量指标
事实准确率：基于人工标注基准集评估。
证据可追溯率：关键结论能定位到有效来源的比例。
错误前提纠正率：识别并纠正问题错误前提的比例。
无效辩论率：没有新增证据或有效修订的轮次占比。
成本与延迟：每次辩论 Token、费用、总耗时和阶段耗时。
校准度：置信度与实际正确率的一致程度。
分歧保留率：合理少数派观点是否被完整保留。
# 15. 分阶段实施计划
| 阶段 | 范围 | 交付物 | 完成标准 |
| --- | --- | --- | --- |
| Phase 0：仓库审计 | 梳理现有架构、接口、技术栈和测试 | 仓库映射报告、实施差异清单 | 确认复用点和真实文件落点 |
| Phase 1：最小闭环 | 独立分析、Claim 提取、争议检测、基础综合 | 可运行的单轮辩论流程 | 至少 2 个参与者，首轮隔离 |
| Phase 2：多轮辩论 | 挑战、回应、修订、停止条件和预算 | 多轮状态机 | 能执行至少 2 轮并保留修订记录 |
| Phase 3：论证图与裁判 | ArgumentGraph、证据评价、多维裁判 | 结构化判断与证据链 | 非多数投票；支持 inconclusive |
| Phase 4：策略与 UI | 策略选择、执行模式解耦、结果展示 | 用户可操作的辩论体验 | Web/Local/Cloud/Hybrid 可组合策略 |
| Phase 5：质量优化 | 回归集、指标、历史知识和成本优化 | 评测报告与优化建议 | 核心验收指标可持续回归 |

# 16. 验收标准
AC-01：执行模式与协作策略在数据模型和 UI 配置上相互独立。
AC-02：首轮参与者分析相互隔离，不读取其他参与者首轮答案。
AC-03：系统能将回答拆解为结构化 Claim，并区分事实、推断和假设。
AC-04：系统能识别直接矛盾、定义差异、范围差异和证据冲突。
AC-05：系统能生成针对具体 Claim 的挑战，而不是泛泛要求“再想一想”。
AC-06：参与者支持 accept、defend、revise、withdraw、inconclusive。
AC-07：系统支持配置最大轮数、并发、超时、Token 和费用预算。
AC-08：ArgumentGraph 能表达 Claim、Evidence、支持、反驳和依赖关系。
AC-09：关键证据保留来源、定位、时间、指纹和评价理由。
AC-10：能识别同源转载，避免将重复来源当作独立证据。
AC-11：裁判至少包含逻辑、证据和反例三个评价维度。
AC-12：裁判不使用简单多数投票作为真伪判定。
AC-13：证据不足时能输出 insufficient_evidence 或 inconclusive。
AC-14：会话支持取消、失败恢复和幂等事件记录。
AC-15：上述 TF-D-001 至 TF-D-010 回归测试可自动执行并形成报告。
# 17. Codex 执行指令
第一步只做仓库审计，不立即大规模改代码；先提交真实目录、模块和接口映射。
每个阶段单独实施，完成后运行相关测试并汇报文件变更、测试结果和已知风险。
优先复用现有模型路由、Agent 池、工具系统、存储和流式输出机制。
新增抽象必须有明确职责，不为追求架构完整而制造过度复杂的框架。
所有模型输出均需结构化校验；所有外部证据都必须保留来源元数据。
禁止以模型投票数量作为事实判断依据；禁止伪造来源、证据或置信度。
实现结束后更新架构文档、配置示例、迁移说明、测试说明和运行手册。
# 18. 建议的逻辑目录结构（待仓库审计后映射）
debate/
  domain/
    DebateSession
    DebateParticipant
    DebateRound
    DebateClaim
    DebateEvidence
    DebateDispute
    ArgumentGraph
    DebateJudgment
    DebateResult
  orchestration/
    DebateOrchestrator
    DebateController
    DebateStrategyRouter
  evaluation/
    EvidenceEvaluator
    LogicJudge
    EvidenceJudge
    CounterexampleJudge
    FinalJudge
  persistence/
    DebateRepository
    DebateEventStore
  prompts/
    independent-analysis
    claim-extraction
    dispute-detection
    challenge
    revision
    judgment
    synthesis
  tests/
    unit/
    integration/
    regression/
# 19. 最终架构决策摘要
DebateOrchestrator 应独立于 MasterAgent：MasterAgent 负责任务入口和整体调度，Orchestrator 负责辩论状态机。
ArgumentGraph 是长期核心资产：它比单次对话文本更适合沉淀论证结构、证据链和知识关系。
裁判必须看到原始 Claim、原始消息和证据：不能只看各模型的摘要或自我评价。
执行模式与协作策略解耦：同一种辩论策略可运行于 Web、Local、Cloud 或 Hybrid。
结论可以不收敛：证据不足、争议未解决或来源冲突时，系统必须诚实表达不确定性。
# 附录 A：推荐的最终结果 JSON 逻辑示例
{
  "status": "partially_supported",
  "conclusion": "核心结论在给定范围内成立，但存在适用边界。",
  "confidence": 0.78,
  "claims": [
    {
      "id": "claim-001",
      "text": "待验证的原子主张",
      "status": "supported",
      "evidence_ids": ["evidence-001"]
    }
  ],
  "disagreements": [
    {
      "topic": "争议点",
      "positions": ["观点 A", "观点 B"],
      "resolution": "证据更支持观点 A，但仍有边界条件"
    }
  ],
  "unresolved_issues": ["尚缺少的证据或未解决问题"],
  "sources": [
    {
      "id": "evidence-001",
      "type": "official_doc",
      "locator": "来源 URL 或文档定位",
      "assessment": "相关且可核验"
    }
  ]
}

—— 文档结束 ——
