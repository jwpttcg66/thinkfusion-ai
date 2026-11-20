# 排查记录：工程“制作示例工程”被当成问答

日期：2026-11-20。
现象：工程空间输入“制作一个spring boot的示例工程，”，
显示“问答 / 工程实施 / 云端主导”，最终只有“ChatGPT 未登录：页面尚未加载”，
没有生成执行计划。

## 1. 已确认

| 观察 | 结论 |
| --- | --- |
| 截图 UI 没有 V3 计划/参与者/证据面板 | 运行的是旧 legacy 路径，不是本次构建的 V3 UI |
| 默认模式为 `legacy` | 未切 shadow/active 时，不进入新引擎 |
| 规则词表无“制作/生成/搭建” | `classifyEngineeringIntent` 落成 analysis |
| 云端主导的 `selectParticipants` 会阻止网页回答 | 当前代码不会把 ChatGPT 放进云端 answerIds |

## 2. 直接原因

旧规则把“制作一个示例工程”判成只读问答：

```text
classifyEngineeringIntent("制作一个spring boot的示例工程，")
→ analysis / “没有改动意图，按只读问答处理”
```

因此没有进入 `submitWorkspace`，转而走问答链路；截图中的模型判定理由虽写
“要新建示例工程，属落地动作”，但最终 taskKind 仍是 analysis（或运行的是未包含
本次修复的旧构建）。

## 3. 本次修复

1. **云端/本地驱动不再预判**：`executionMode !== 'web'` 时，工程请求跳过
   `routeTask` 词表和 `ROUTING_SYSTEM` 分类提示词，直接交给 Planner；
   只有纯网页模式保留规则兜底。
2. `EXECUTION_VERBS` 增加：`制作|生成|搭建|初始化|脚手架`（仅网页兜底）。
3. 设计辩论：计划新增 `kind=design` 与 `design.document/viewpoints`；
   `design` 强制辩、辩论对象是设计文档/观点，不受开关影响；
   写文件等工具不再触发强制辩。单模型可自辩。
4. 技能：expertiseFor 结果注入 Planner，并在转交消息提示加载数量。
5. 新增回归：
   - `check-runner`：云端工程“分析目录结构”也直接交 Planner，不问网页；
   - `check-v3-routing`：制作/生成/搭建判实施；云端主导不问网页。

## 4. 仍需确认

1. 运行的是否为旧安装包：本次改动在本地 `main`，需要重新构建/启动；
2. 若重新构建后仍去问 ChatGPT：检查
   - `conversation.executionConfig.executionMode` 是否真的为 `cloud`；
   - 云端模型是否已配置且可用；
   - `routing` trace 的 `taskKind`；
3. “ChatGPT 未登录”本身是页面健康检查结果；云端主导不应走到它。

## 5. 建议

- 重新构建并切到 `shadow` 观察计划，再切 `active`；
- 若仍复现，保留该会话的 `collaboration-shadow.jsonl` / trace 与设置，继续按链路排查。
