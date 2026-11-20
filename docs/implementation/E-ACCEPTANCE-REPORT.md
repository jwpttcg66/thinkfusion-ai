# V3 正式功能验收报告

日期：2026-11-20。
范围：A-03、A-04、B、C、D、E；不包含签名、公证、DMG/ZIP、发布。
结论：**有条件通过；未达到“全部完成”**。

## 1. 功能清单

| 项 | 状态 | 证据 |
| --- | --- | --- |
| A-03 四种协作行为 | ✅ | `check-collaboration-plan` |
| A-04 Gate 服务/IPC | 🟡 | `check-collaboration-settings`；设置页未接 |
| B-01 计划 | ✅ | `CollaborationPlanPanel` |
| B-02 参与者 | ✅ | `ParticipantPanel` |
| B-03 证据 | ✅ | `EvidencePanel` |
| B-04 工程 | 🟡 | `WorkspacePanel`；diff 正文/进度未做 |
| B-05 知识 | 🟡 | 三块地图；来源/阅读状态未做 |
| B-06 General | ✅ | 对话 + 交付 |
| B-07 交付 | ✅ | `WorkspacePanel` 交付段 |
| C 质量/诊断/安全 | ✅ | `verify`、诊断面板、安全基线 |
| D 旧架构退出 | 🟡 | 删除 lead-prompt；legacy 保留 |
| E-01 三空间 E2E | ✅ | `check-v3-e2e` 4/4 |
| E-02 异常矩阵 | ✅ | `check-v3-exceptions` 11/11 |
| E-03 一致性 | ✅ | `check-v3-e2e` |
| E-04 报告 | ✅ | 本文 |

## 2. 测试结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:core` | 通过 |
| `npm run test:features` | 97/97 |
| `npm run test:e2e` | 4/4 |
| `npm run test:exceptions` | 11/11 |
| `npm run test:prompt-policy` | 4/4 |
| `npm run test:security-baseline` | 通过 |

## 3. 三空间 E2E

- General：计划 → 执行 → 交付；
- Knowledge：卡片存储 → 召回；
- Engineering：状态齐全可完成、计划含回退。

## 4. 异常场景

11/11 通过；覆盖本地/远端/Web 失败、参与者失败、部分失败、超时、取消、重启、权限、证据缺失、Reviewer 不通过。

## 5. 一致性

- 同一 Engine；
- local 不越界；
- 工程网页不能提问；
- 无争议不辩论；
- Evidence 可追溯；
- UI 与 State 同源。

## 6. 未解决问题 / 已知限制

| 项 | 说明 |
| --- | --- |
| P1-14 设置页 | 服务/IPC 完成；设置面板未接 |
| UI-04/05 工程/知识 | 基础面板；diff 正文、执行进度、来源/阅读状态未做 |
| UI-06 旧辩论入口 | 未移除 |
| P6-02 签名/公证 | 按计划排除，发布阶段做 |
| X-03 legacy 删除 | 待 active 稳定；当前保留回滚 |
| X-04 实际发布 | 按计划排除 |

## 7. 架构退出

- 已删：`synthesis/lead-prompt.ts`；
- 保留：legacy `strategy/runner`、Debate 主流程、`buildInitialPrompt`、`debateId` 兼容；
- 依据：`D-LEGACY-EXIT-AUDIT.md`。

## 8. 结论

**有条件通过。** 核心引擎、三空间主链路、质量/诊断/安全、E2E 与异常矩阵已通过；
设置页、工程/知识深度、旧辩论入口、legacy 删除仍未完成，不能标记“全部完成”。
