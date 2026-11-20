# ThinkFusion V3 正式功能实施计划

版本：V1.1（2026-11-20）
基线：`main@26dfb13`。
性质：正式功能完成，不包含签名、公证、DMG/ZIP 发布与自动更新。

## 0. 实施原则（固定）

- 不重新建立项目基线，不重新评估总体架构；
- 不在每个任务前审计整个工程，只审计当前任务涉及的文件、调用链、测试；
- 已完成功能不重复建设；局部问题局部修复；
- TASK-BOOK / COMPLETION-AUDIT 统计冲突不阻塞实施，任务完成时修正；
- 状态区分：IMPLEMENTED / INTEGRATED / VERIFIED / TESTED。

**没有独立的“基线校正阶段”。直接从阶段 A 开始。**

## 1. 目标

把已具备 Collaboration Engine 的工程状态，推进为三个工作空间完整可用、可操作、可验证的产品：

- General：对话、分析、知识学习；
- Knowledge：研究、阅读、整理、知识分析；
- Engineering：代码理解、计划、执行、评审。

三个空间共享一个 Engine，不建三套 Runtime。

## 2. 阶段

详细设计见 [V3-FORMAL-FEATURES-DESIGN.md](V3-FORMAL-FEATURES-DESIGN.md)。


### A. 协作引擎可靠性

| 任务 | 内容 |
| --- | --- |
| A-01 / P1-00 | CollaborationState 持久化与恢复（复用 AgentStore） |
| A-02 / P1-04 | 并发、取消、超时 |
| A-03 / P1-07 | Independent / Parallel / Progressive / CrossCheck |
| A-04 / P1-14 | Gate 设置入口 |

完成门槛：四项通过验收；不以合并代替验收。

### B. 三个工作空间 UI

UI-01 计划视图、UI-02 参与者、UI-03 证据、UI-04 Engineering、UI-05 Knowledge、UI-06 General、UI-07 统一交付。

完成门槛：三空间端到端可操作；UI 只展示真实状态。

### C. 质量、诊断与安全

P1-15 全量回归、P4-06 CI 门禁、P6-05 诊断 UI、P6-07 安全清单执行。

### D. 旧架构退出

X-01 文档收尾、X-03 删除旧模块；先有调用链证据，再删除；保留回滚开关。

### E. 正式功能总验收

三空间端到端、异常场景、产品一致性、完成评审。

## 3. 实施顺序

A → B → C → D → E。阶段 A 未完成前不开展大规模 UI。

## 4. 明确不包含

Developer ID、签名、公证、DMG/ZIP、GitHub Release、自动更新、外部发行准备。
P6-02 签名/公证与 X-04 实际发布从“正式功能完成”统计中剥离。

## 5. 完成判定

- P1 关键任务验证通过；
- UI-01..07 完成；
- 并发/取消/超时/恢复通过测试；
- 协作行为有真实路径；
- 全量回归与质量门禁有效；
- 诊断与安全能力完成；
- 旧架构退出有证据；
- 三空间与异常场景验收通过；
- TASK-BOOK 与 AUDIT 口径一致。
