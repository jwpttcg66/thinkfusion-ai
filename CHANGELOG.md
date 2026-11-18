# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versions follow
[Semantic Versioning](https://semver.org/). Entries are generated from
Conventional Commits by `scripts/release.sh`.

## Unreleased

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
