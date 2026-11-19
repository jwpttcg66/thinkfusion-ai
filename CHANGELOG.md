# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versions follow
[Semantic Versioning](https://semver.org/). Entries are generated from
Conventional Commits by `scripts/release.sh`.

## Unreleased

- feat(collaboration): active 管线接入 Replanner 判定、Debate 触发、可选模型审核
- build(mac): electron-builder 增加 zip target；P6-02 配置检查测试
- test(engineering): P3-09 六场景验收
- test(release): P6-06 应用/数据回滚钻取；文档 P6-06-ROLLBACK-DRILL
- feat(engineering): P3-02 搜索动作计划、P3-06 CLI 回答/执行分流、P3-08 Java 文本降级
- test(engineering): 相关 10/10
- feat(collaboration): P1.1 active 管线（Planner→审核→Scheduler→Runner→Deliver），未接 ConversationRunner
- feat(engineering): P3-07 git S1/S2 快照（commit/dirty/diff 指纹）
- feat(collaboration): P5-03 通道声明校验、P5-05 5 组发布矩阵
- test: 相关 7/7
- feat(evidence): P4-04/05/07 六个场景夹具与确定性回放；执行失败映射 contradicts
- feat(release): P6-02 打包配置检查、P6-05 诊断脱敏、P6-06 回滚计划、P6-07 安全检查
- test: P4/P6 相关 10/10
- feat(release): P6-01 版本清单、P6-03 迁移备份、P6-04 备份恢复、P6-08 发布门禁
- test(release): 4 项；P4/P5/P6 相关 12/12
- feat(collaboration): P5-01 能力注册表、P5-02 路由/降级、P5-04 通道观测
- test(collaboration): P5 4 项；P4/P5 相关 12/12
- feat(evidence): P4-01 Pack→EvidenceRef 映射、P4-02 统一 Verifier、
  P4-03 质量指标、P4-06 质量门禁函数
- test(evidence): P4 4 项；P3/P4/knowledge 22/22
- feat(engineering): P3-01 EngineeringTaskState（S1/S2/测试/构建/评审）、
  P3-03 计划/审批、P3-04 执行断言、P3-05 评审独立性
- test(engineering): 新增 task-state/plan 6 项测试
- feat(knowledge): P2-04 缺口检测/任务化/接 Replanner；P2-05 知识地图三块+出处
- test(knowledge): 新增 gap/map 测试，knowledge 共 12/12
- feat(knowledge): P2-01 KnowledgeStore（原子写/旧数据兼容/证据必填）、
  P2-02 规则召回、P2-03 时效三态；P2-06 六场景测试
- test(knowledge): 4 组测试，共 8 项
- feat(collaboration): P1-11 Replanner 纯逻辑、P1-12 Debate 触发/映射、
  P1-13 规则+模型审核、P1-14 Active 门禁函数
- test(collaboration): 新增 10 项 P1.1 测试，collaboration 共 35/35
- feat(collaboration): P1-08 Shadow plan-only；P1-09 ConversationRunner shadow 分支
  （legacy 默认零行为变化，shadow 计划写 collaboration-shadow.jsonl）
- test(collaboration): shadow 零 ask 测试；runner shadow 分支测试
- feat(collaboration): P1-01 ParticipantManager、P1-02 规则 Planner、P1-03 Scheduler、
  P1-04 顺序 Runner、P1-05 Deliver；网页只收问题的边界测试
- test(collaboration): 新增 participants/plan/runner 3 组测试，collaboration 共 23 项
- feat(collaboration): P0-04 CollaborationMode 存储（legacy/shadow/active，默认 legacy，损坏回退）
- test(collaboration): 模式/回滚/域状态 3 个测试脚本，共 13 项
- docs(implementation): P0-06 回滚钻取、P1-00A 代码映射；P1-001 签收、P0-J 关闭
- feat(collaboration): P1-00 Domain 类型与 CollaborationState 纯转移（未接入 AgentStore）
- docs(review): 完成 P0-J 独立评审（文档/代码双评审），3 阻断关闭、2 复评项修复；记录残余门禁 P0-04/P0-06
- docs(design): P0 最终一致性收敛——网页角色/Policy 字段统一、快照更新 2d05b12、ROADMAP 状态、01 与 P1-002 对照
- rule(roles): 知识/通用允许网页担任提问者（单条追问 + 数据），工程模式网页只能回答；执行规划仍只允许 local/cloud（ADR 0009）
- docs(design): P0-F..J 修订——CollaborationState 聚合根、TaskGraph 不持久化、ModelInput/16 个 Prompt 处置、EvidencePack 归属、P1-00A 映射任务、P0-J 门禁
- docs(design): 新增 P6 发布与运维（版本/打包签名/迁移/备份/诊断/回滚）与 8 个任务；阶段上限改为 P6
- docs(design): 补齐 P2–P5 领域设计（知识空间、工程契约、证据与质量、能力与通道路由）
- docs(design): 记录设计冻结（用户确认 2026-11-18）；P0 退出，进入 P1 实施准备
- docs(implementation): 新增 TASK-BOOK（P0–P5、UI、发布与跨阶段的全部任务设计）
- docs(design): P0-B.1/B.2/C 完成——TaskSpec/TaskRuntimeState/Attempt 三层拆分、Plan/Assignment 所有权、Dispute 独立、重试/取消状态机、文档契约统一到 P1-002
- docs(design): P0-B 契约收敛——Plan 不可变化 + planHistory、删除 TaskGraphState、Planner 模型/规则边界、三空间契约；设计只留在 product-v3
- docs(implementation): 新增 P0-A 设计一致性审查（11 处矛盾、D1–D8 决策清单），修正参与者规则残留与基线/状态口径
- docs(implementation): 新增 P1-002 领域与运行时契约（对象、所有权、生命周期、状态机、错误/重试/取消/并发/预算、持久化与事件）
- docs(implementation): 新增 P1-001 迁移审计（18 项：架构、重复职责、状态、Runtime、Planner、Debate、Evidence、工程、Java、增删改清单、风险与边界）
- rule(scope): 明确「网页渠道」与「模型驱动」是两类；模型范围分 local / remote / hybrid，越界不得降级改道
- rule(agent): 第 2 条改为「参与者数量由任务决定」——简单问题可 1 个，高风险至少 2 个，选择理由与跳过原因可见（ADR 0008）
- docs(implementation): 不做 shadow 双跑；关键阶段允许模型审核（计划后 / 重规划前 / 辩论触发前），输入仅数据与 schema
- docs(implementation): 新增 P0–P5 逐任务实施计划（契约、协作引擎、知识、工程、证据、通道），含门禁、flag、回滚、删除条件与 40 场景
- rule(agent): 新增 AGENTS 第 6 节——不使用任务提示词、不冻结流程基线（含允许的机器可读契约与工程快照）
- refactor(debate): 删除 `prompts.ts`；辩论不再向模型发送 role / stage / format / challenge 指令，网页后续轮只附带数据
- refactor(evidence-pack): `baseline.ts` 改为 `repository-snapshot.ts`，`publishRepositorySnapshot()` 由任务按需调用；辩论开场不再创建基线，`round-evidence` 接线移除
- test: 删除 prompt 模板与开场基线用例，辩论用例改为断言「不发送提示词、争议只落盘」
- docs(product): 产品定位 V3——从「可验证的多模型审辩平台」改为「多模型协作智能工作平台」；一个协作引擎、三个工作空间（知识学习 / 工程 / 通用）
- docs(architecture): 新增协作架构 V1、工程工作空间 V1、迁移计划；辩论降级为按需协作行为，明确不新建第二套 Runtime / 审批 / 证据格式
- docs(roadmap): 路线重排为 P0–P5，辩论不再单独占据主线
- docs: README 中英双版、文档索引与 ARCHITECTURE / 辩论任务书同步新方向

## v0.3.0 - 2026-11-18

- docs(product): 重新定位为「可验证的多模型审辩」——独立作答、定向辩论、证据校验、条件化结论；PRODUCT 只保留目标形态、取舍原则与成功判据
- docs(product): 补齐知识学习（0.4）与工程能力（0.5）两条后续主线的定位与判据，说明两个空间共用同一套证据链
- docs(roadmap): 重写为 0.3.x–1.0 的完成判据，现状与缺口分开写
- docs: 文档树收敛——删除阶段实现日志、回归产物、过期审计与 docx，保留规格 / ADR / 测试 / 索引；新增 `docs/README.md` 作为唯一入口
- docs: 修复文档、脚本与源码注释中指向已删除文件的链接
- feat(evidence-pack): 执行证据生产者与显式验证意图并入 main（ExecutionReport → ExecutionAttestation → Pack）
- chore: 版本号统一为 0.3.0（`VERSION`、`desktop-agent-macos/package.json`）

## v0.1.0 - 2026-10-31

- fix(scripts): keep the changelog title above the first release entry (aa83d53)
- feat(scripts): add one-step setup and semantic release (cecdbd4)
- feat(hooks): enforce commit conventions and block unsafe commits (d823d2b)
