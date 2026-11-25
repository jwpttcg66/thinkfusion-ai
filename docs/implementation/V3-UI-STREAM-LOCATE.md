# V3 UI：流式阅读 + 快速定位轴

日期：2026-11-25  
分支：`feat/v3-ui-stream-conclusion`

## 问题

长任务对话流（提问 → 计划 → 评审 → 执行 → 结论）一长，用户只能靠滚动找「计划在哪 / 结论在哪 / 交付物在哪」。Cursor 时间轴侧栏的启发是：**侧边一条地标轴，点一下跳到对应重点**。

## 规则（与展示策略一致）

1. **默认流式**：旁注里程碑（ECO / 参与 / 循环）不进定位轴。
2. **卡片**：仅多模型辩论里「表态 / 质疑 / 回应」发言方；总览仍流式。
3. **计划**：保留独立计划卡，并作为定位轴节点。
4. **终态**：结论走流式协议阅读；轴上标「结论 · 目标物 N」（AGENTS §8.2）。
5. **步骤**：只标「开始执行」与失败步骤，避免 19 步把轴刷满。

## 地标种类

| kind | 来源 entry | 轴上文案 |
|------|------------|----------|
| prompt | user | 提问 |
| plan | plan | 计划 · 标题 |
| debate | debate | 方案评审 / 多模型 N |
| debate_peer | member（评审标签） | 表态 / 质疑 / 回应 |
| bridge | bridge | 轮间依据 / 执行前依据 |
| step | step（首步或失败） | 开始执行 / 步骤失败 |
| verification | verification | 验证… |
| review | review | 独立评审… |
| conclusion | conclusion | 结论 · 目标物 N |

## 实现

- 投影：`buildStreamLandmarks`（`src/shared/task-conversation.ts`）
- UI：`TaskConversation` 左侧 `StreamLocateRail`，`data-stream-anchor` + `scrollIntoView`
- 测试：`scripts/check-task-conversation.mjs` 增加地标投影用例

## 布局稳定性（开局不闪没）

- 对话流外壳始终 `chat-feed-layout`，左侧定位轴槽位宽度常驻；地标从 0→N 不改正文宽度。
- 空态是 feed 内占位，不是另一套根组件；禁止开局另插 `running` spinner 大卡（成员一到就消失会整页跳）。
- 定位轴绝对定位叠在预留槽；禁止用会改列数的 grid 双栏切换。
- 会话进度条 `progress-strip` 终态收成「已完成」行，不 `return null`；结论卡出现后仍保留同壳。
- 会话→任务 handoff 用同一套 `chat-feed-layout` 占位，不用另一张 spinner 大卡。

## 验收

- [ ] 有计划 + 结论的任务，轴上至少出现「提问 / 计划 / 结论」
- [ ] 点击轴节点，主对话滚到对应块
- [ ] 旁注里程碑（工程上下文 / 循环决策）不出现在轴上
- [ ] 多模型辩论发言方仍出卡；轴上有对应「表态/质疑/回应」
- [x] 任务刚创建到首条流式输出期间，主活动区不整块消失、不左右猛跳（2026-11-25 截图核验：进度条常驻 + feed 同壳）
