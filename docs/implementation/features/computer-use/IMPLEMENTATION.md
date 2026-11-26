# ThinkFusion V3 真机控制能力实施计划书

版本：V1.0  
代码基线：`main@8601fc2c4b4e3e4be3f7c2c3a717fb65c1f456bc`  
短 SHA：`8601fc2`  
仓库：`jwpttcg66/thinkfusion-ai`  
评估日期：2026-11-25  
实施状态：P0–P6 工程与真机验收已落地。新构建能力清单 109 真机全跑通过：`npm run test:capabilities:live`（`tf-cap-mwvp2fb6`）— ThinkFusion 暴露 109/109 全开全注册，103 Runtime + 6 主进程各执行一次；其中 13 个 `computer.*` 对 TextEdit 真机操作。另有 `test:computer-use:live` 13/13、自动化 18 项。锁屏时控件树不可用。P7 不在本次范围。  
任务分支：`feat/v3-computer-use-macos`

实施原则：复用现有 Runtime、Capability、TaskGrant、审批和 Journal，不重建 Agent Runtime。

本文只约束 **macOS 真机控制（Computer Use）**。它和真机验收不是同一件事：

- **真机控制能力（Computer Use）**：ThinkFusion 能观察真实桌面，并实际操作其他应用，例如点击、输入、切换窗口、滚动和验证操作结果。
- **真机验收能力（Live E2E）**：通过 OpenIDEA、CDP 等方式，在真实运行的 ThinkFusion 窗口中测试功能。

本计划以第一项为核心。第二项只作为实施过程中的验收手段。

---

## 一、项目目标

为 ThinkFusion 增加真正的桌面计算机操作能力，使 AI Agent 不仅能够读写工程文件、执行终端命令、控制应用内网页，还能在用户授权下观察和操作真实桌面中的其他应用。

最终实现：

1. 查看当前桌面和前台应用。
2. 获取目标应用的窗口和可访问性控件树。
3. 识别按钮、输入框、菜单、列表等 UI 元素。
4. 点击控件、输入文本、执行键盘操作。
5. 滚动、拖动、切换窗口。
6. 截取操作前后的屏幕。
7. 检查操作是否真正生效。
8. 失败时能够停止、重试或请求用户接管。
9. 所有操作都经过权限治理，并留下可追溯事件。

核心原则：

**Observe → Understand → Act → Verify**

不能只把鼠标键盘操作发送出去，就认为任务已经完成。必须重新观察桌面，验证操作结果。

## 二、最新代码现状

本计划基于 `main@8601fc2`，不是从零设计。

### 2.1 已经存在的能力

| 现有模块 | 当前能力 | 后续处理 |
| --- | --- | --- |
| `src/agent/tools/screen.ts` | macOS 截屏、区域截屏、PNG 校验、SHA256 | 保留并扩展 |
| `src/agent/tools/system.ts` | 剪贴板、系统信息、进程查看等 | 保留 |
| `src/agent/tools/app-open.ts` | 打开应用和文件，并检查进程 | 保留 |
| `src/platform/accessibility.ts` | macOS Accessibility Provider | 扩展 |
| `native/macos/ax-bridge.swift` | 前台应用识别、控件树读取 | 扩展 |
| `scripts/build-ax-bridge.sh` | Swift Helper 编译 | 保留 |
| `shared/capabilities.ts` | 统一能力清单与权限元数据 | 扩展 |
| `main/capabilities/index.ts` | 主进程能力注册 | 复用 |
| `shared/contracts.ts` | Agent 工具契约 | 扩展 |
| `TaskGrant` | 任务权限 | 复用 |
| `Journal / AgentEvent` | 任务和工具事件 | 复用 |

路径相对于 `desktop-agent-macos/`。

### 2.2 当前最重要的代码事实

macOS AX Helper 现在读命令之外还有一份**写操作白名单**：
`press` / `setValue` / `keypress` / `scroll` / `drag` / `focus`
（`native/macos/ax-bridge.swift:333`）。读命令仍是 `frontmostApplication` / `focusedTree`。

已向 Agent 开放、并在 2026-11-23 真机跑通的 `computer.*` 共 13 个：
`ax.tree` / `ax.find` / `windows` / `capabilities` / `screenshot` / `click` /
`type` / `keypress` / `scroll` / `drag` / `focus` / `verify` / `stop`。

仍然不做：任意坐标盲点、后台应用注入、绕过 TaskGrant 的全局输入。
`capabilities` 会如实报告当前辅助功能授权与可执行动作；没授权时写操作明确报错，
不静默降级成「看起来点了」。

`window.list`、`app.open`、`clipboard.read` / `clipboard.write` 已有实现，
不要重新造一套相同工具。

### 2.3 现有架构边界

必须继续遵守仓库 `AGENTS.md` 的规则：

- 不增加固定任务提示词。
- 不改变用户原始问题。
- 不增加第二套 Agent Runtime。
- 不增加第二套审批和权限系统。
- 不绕开 TaskGrant。
- 不用模型摘要冒充执行事件。
- 每项新能力必须有真实事件、持久化和详情入口。
- 每个任务完成后必须在真实 ThinkFusion 窗口中验证。

## 三、总体架构

采用三层结构。

### 3.1 Agent Tool 层

Agent 通过现有 Capability Registry 调用桌面操作能力。

建议增加的能力：

| Capability ID | 作用 |
| --- | --- |
| `computer.capabilities` | 检查桌面控制能力与权限 |
| `computer.windows` | 获取窗口列表 |
| `computer.screenshot` | 获取桌面或窗口截图 |
| `computer.ax.tree` | 获取控件树 |
| `computer.ax.find` | 查找 UI 元素 |
| `computer.click` | 点击控件或屏幕坐标 |
| `computer.type` | 输入文本 |
| `computer.keypress` | 执行键盘操作 |
| `computer.scroll` | 滚动 |
| `computer.drag` | 拖动 |
| `computer.focus` | 聚焦目标窗口 |
| `computer.verify` | 重新观察并验证操作结果 |
| `computer.stop` | 停止当前桌面操作序列 |

以上为建议能力名。实施时必须先检查现有 ToolName 和能力注册表，避免重复注册。`window.list`、`screen.capture`、`app.open` 已存在，不得再注册一套同义工具。

### 3.2 Platform Provider 层

平台相关实现独立封装。

macOS：

- Swift Native Helper
- Accessibility API
- CoreGraphics CGEvent
- ScreenCaptureKit 或现有系统截屏能力
- NSWorkspace / NSRunningApplication

TypeScript Host：

- Helper 生命周期管理
- JSON Lines IPC
- 请求超时
- 进程异常恢复
- 参数校验
- 操作结果归一化

平台 Provider 接口保持统一，不能让 Agent Tool 直接调用 macOS 专属 API。

### 3.3 Governance 层

复用现有：

- TaskGrant
- PermissionPreset
- Step Approval
- AgentOrchestrator
- AbortSignal
- Journal
- EvidencePackStore

所有副作用操作必须经过授权。

不允许通过直接调用 `osascript`、shell 或其他命令绕开现有权限系统。

## 四、核心执行流程

一次桌面操作应当遵循：

Observe → Identify Target → Check Permission → Act → Wait for Result → Observe Again → Verify → Record Evidence

### 4.1 操作前观察

必须获得：

- 当前前台应用
- 目标窗口标识
- 控件树或截图
- 目标控件身份
- 操作前状态
- 当前操作权限

目标应用发生切换、窗口关闭或控件状态变化时，旧快照必须失效。

### 4.2 目标识别

优先顺序：

1. Accessibility 元素标识。
2. Accessibility role、title、value 和父子关系。
3. 目标窗口内的元素。
4. 截图坐标。

坐标操作必须绑定具体截图和屏幕尺寸。不能在窗口改变后继续使用旧坐标。

### 4.3 操作执行

每次操作都必须携带：

- taskId
- runId
- stepId
- actionId
- targetWindowId
- snapshotId
- 操作类型
- 参数摘要
- 权限决策
- 超时时间

### 4.4 操作后验证

例如：点击保存按钮后，不能仅凭点击成功就返回「已保存」。

必须重新检查：

- 窗口是否仍然存在；
- 保存按钮状态是否变化；
- 是否出现成功提示；
- 文件或数据是否真实写入；
- 是否存在错误提示。

验证失败时，应返回失败原因，而不是将操作标记为成功。

## 五、权限和安全设计

采用现有三个权限等级。

### read-only

允许：

- 获取应用信息；
- 获取窗口列表；
- 获取控件树；
- 查找控件；
- 读取屏幕；
- 截图。

不允许：

- 点击；
- 输入；
- 滚动；
- 拖动；
- 写剪贴板；
- 改变应用状态。

### workspace-write

允许在已授权范围内：

- 操作用户指定的工作应用；
- 点击控件；
- 输入文本；
- 滚动；
- 拖动；
- 使用键盘快捷键。

必须有目标应用范围和操作类型限制。

### danger-full-access

允许更广泛的桌面操作，但仍然不能绕过：

- TaskGrant；
- 用户明确授权；
- 危险操作确认；
- 操作审计；
- 取消机制。

删除、支付、发送消息、提交表单、账号设置、系统权限修改等敏感动作，必须根据风险要求二次确认。

### 安全硬约束

1. 不允许无边界的任意桌面点击。
2. 不允许对未知窗口执行高风险动作。
3. 不允许使用过期截图坐标。
4. 不允许将用户密码、Token 等敏感内容写入普通事件日志。
5. 不允许模型自行扩大授权范围。
6. 发现窗口切换、权限变化或目标不确定时，立即停止。
7. 每个操作必须能被取消。
8. 任何无法确认的结果必须标记为未验证。

## 六、分阶段实施计划

### P0：现状和调用链核对

目标：确认当前 AX、截屏、窗口和权限实现。

检查：

- `src/platform/accessibility.ts`
- `native/macos/ax-bridge.swift`
- `src/agent/tools/screen.ts`
- `src/shared/capabilities.ts`
- `src/shared/contracts.ts`
- Tool Registry
- TaskGrant
- Permission Policy
- IPC
- Journal / AgentEvent

交付：

- 现有能力清单；
- 真实调用链；
- 已有能力与缺失能力映射；
- 权限矩阵；
- Helper 构建与运行检查。

验收：所有新增能力都有明确的现有代码归属，不重复建设。

### P1：统一 Computer Provider 契约

目标：建立平台无关的桌面控制接口。

建议接口：

```ts
interface ComputerProvider {
  getCapabilities(): Promise<ComputerCapabilities>;
  getWindows(): Promise<ComputerWindow[]>;
  screenshot(input: ScreenshotInput): Promise<ScreenshotResult>;
  getAccessibilityTree(input: TreeInput): Promise<AXNode[]>;
  findElement(input: FindElementInput): Promise<ComputerElement | null>;
  click(input: ClickInput): Promise<ActionResult>;
  typeText(input: TypeTextInput): Promise<ActionResult>;
  keypress(input: KeypressInput): Promise<ActionResult>;
  scroll(input: ScrollInput): Promise<ActionResult>;
  drag(input: DragInput): Promise<ActionResult>;
  focus(input: FocusInput): Promise<ActionResult>;
  stop(input: StopInput): Promise<void>;
}
```

接口只定义统一语义，不把平台实现细节暴露给 Agent。

验收：

- macOS Provider 可注册；
- 未支持平台返回明确状态；
- 无 Helper 时能够降级；
- 权限不足时返回 `PERMISSION_REQUIRED`；
- 不支持的动作明确拒绝。

### P2：macOS Native Helper 扩展

目标：让当前只读 AX Helper 具备受控操作能力。

实施：

1. 保留 `frontmostApplication`。
2. 保留 `focusedTree`。
3. 增加窗口枚举。
4. 增加元素查找。
5. 增加 AXPress。
6. 增加受限的 AXValue 写入。
7. 增加鼠标点击。
8. 增加键盘输入。
9. 增加滚动。
10. 增加拖动。
11. 增加焦点控制。
12. 增加动作结果和错误分类。

优先使用 Accessibility 语义操作；只有无法通过 AX 完成的动作才使用 CGEvent 坐标操作。

Helper 必须有：

- 单请求超时；
- 单次操作取消；
- 输入大小限制；
- JSON Lines 协议校验；
- stdout/stderr 分离；
- 异常退出检测；
- 进程回收。

验收：在 macOS 上能够读取真实应用控件树，并对指定测试应用执行一次点击、输入、滚动和验证。

### P3：观察与证据能力

目标：让 Agent 能够真正理解当前桌面状态。

实现：

- 当前应用；
- 窗口列表；
- 窗口焦点；
- 控件树；
- 元素定位；
- 屏幕截图；
- 操作前后截图关联；
- 控件快照失效检测。

截图和 AX 树需要统一关联：

```ts
interface ComputerSnapshot {
  snapshotId: string;
  capturedAt: number;
  appBundleId?: string;
  windowId?: string;
  screen?: {
    width: number;
    height: number;
    scaleFactor: number;
  };
  screenshotRef?: string;
  accessibilityTreeRef?: string;
}
```

这里的引用指向真实保存的快照或证据对象，不允许把截图的伪造路径当作证据。

验收：能够对一个真实应用进行观察，定位指定控件，并输出可回溯的截图和控件信息。

### P4：Agent Tool 接入

目标：让现有 Agent 能够通过工具使用桌面控制。

实施：

- 注册 Computer Provider；
- 增加工具契约；
- 接入现有 Capability Registry；
- 接入权限策略；
- 接入 TaskGrant；
- 接入 AbortSignal；
- 接入 Journal；
- 接入 EvidencePackStore。

必须采用 Observe → Act → Verify。不能增加第二个 Agent Runtime。

验收：Agent 能在用户授权后完成一个真实桌面操作任务，并且每一步都能追溯到工具调用和执行结果。

### P5：工程工作台和交互 UI

目标：让用户清楚知道 Agent 正在操作哪台机器、哪个应用和哪个控件。

建议增加独立的 Computer Use 观察面板：

- 当前前台应用；
- 当前目标窗口；
- 屏幕截图；
- 控件树；
- 当前操作；
- 操作权限；
- 操作结果；
- 验证状态；
- 中断按钮。

执行期间必须展示真实事件：

准备观察 → 已读取窗口 → 找到控件 → 请求授权 → 执行点击 → 重新观察 → 验证结果。

模型 reasoning、工具准备、真实工具调用和执行结果必须区分。

验收：用户可以实时观察桌面操作、了解操作目标、随时停止操作，并检查操作结果。

### P6：macOS 真机测试和安全验收

必须使用真实 ThinkFusion Electron 窗口和真实桌面应用。

测试应用建议从 TextEdit、Finder、系统设置中的非敏感页面开始。

测试用例：

1. 获取前台应用。
2. 获取窗口列表。
3. 读取控件树。
4. 找到输入框。
5. 点击输入框。
6. 输入测试文本。
7. 执行滚动。
8. 验证文本确实出现。
9. 截取操作前后截图。
10. 在操作中取消任务。
11. 验证取消后不再继续发送输入事件。
12. 撤销测试输入，恢复测试应用状态。

每项任务完成后，必须在真实窗口里验证，不能只靠单元测试。

### P7：其他平台适配与正式交付准备

第一阶段不同时实现 Windows 和 Linux。先完成 macOS 原生能力并稳定接口。

后续适配：

Windows：

- UI Automation；
- SendInput；
- Windows Graphics Capture。

Linux：

- AT-SPI；
- X11；
- Wayland Portal。

平台适配不能影响 Agent Tool 契约。

正式分发前再处理：

- Helper 与应用统一签名；
- hardened runtime；
- macOS Accessibility 授权；
- Screen Recording 授权；
- notarization；
- 安装后 Helper 路径和权限检查。

本任务不要求发布、签名、打包或分发。

## 七、事件和可观测性

所有动作必须有事件。

建议事件：

```text
computer.capability.checked
computer.snapshot.created
computer.window.selected
computer.element.found
computer.action.requested
computer.action.approved
computer.action.started
computer.action.completed
computer.action.failed
computer.action.cancelled
computer.verification.completed
computer.verification.failed
```

事件必须关联：

- taskId
- runId
- stepId
- actionId
- snapshotId
- windowId
- sequence
- timestamp
- permissionDecision
- evidenceRefs

原始事件是事实来源。UI 摘要只是派生展示，不允许覆盖原始执行记录。

## 八、测试体系

单元测试：

- Provider 契约；
- AX Helper 协议；
- 元素定位；
- 权限检查；
- 过期快照；
- 超时；
- 取消；
- 失败恢复；
- 事件关联。

集成测试：

- Tool Registry；
- Capability Registry；
- TaskGrant；
- Journal；
- EvidencePackStore；
- UI 事件订阅。

真机测试：

- Finder；
- TextEdit；
- ThinkFusion 自身窗口；
- 用户指定的常见开发工具。

安全测试：

- 未授权点击；
- 未授权输入；
- 目标窗口切换；
- 过期坐标；
- 敏感操作；
- Helper 崩溃；
- 用户中途取消；
- 权限被撤销。

## 九、最终验收标准

以下条件全部满足才能宣布完成：

1. 真实读取桌面和前台应用。
2. 真实获取目标窗口控件树。
3. 真实定位 UI 元素。
4. 真实点击和输入。
5. 真实滚动和键盘操作。
6. 每个操作都有权限检查。
7. 每个动作都有操作前快照。
8. 每个动作都有执行后验证。
9. 用户可以中断。
10. 事件和证据能够恢复。
11. 不支持的平台明确降级。
12. 不存在绕过 TaskGrant 的操作路径。
13. 真实 Electron 任务通过验收。
14. 自动化测试通过。
15. 所有状态与实际代码一致。

## 十、范围和禁止事项

本次实施：

- macOS Computer Use；
- AX Helper；
- 鼠标键盘控制；
- 屏幕观察；
- 操作验证；
- 权限治理；
- 事件与证据；
- 工程工作台展示。

本次不实施：

- 重建 Agent Runtime；
- 重建 Capability Registry；
- 重建 TaskGrant；
- 重建 Journal；
- 重建 Verifier；
- 重建 Browser Use；
- 同时实现 Windows / Linux；
- 无限制控制整台电脑；
- 自动支付、自动发送敏感消息；
- 自动修改系统安全设置；
- 发布、签名、分发。

## 十一、最终产品体验

用户可以直接对 ThinkFusion 说：

「打开 Finder，进入下载目录，找到刚下载的文件，并告诉我文件内容。」

或者：

「打开 TextEdit，新建一个文档，输入这段文字，保存后检查文件是否存在。」

ThinkFusion 应当：

1. 识别用户意图；
2. 检查桌面控制能力；
3. 展示当前应用和操作权限；
4. 观察真实桌面；
5. 定位控件；
6. 在授权范围内执行；
7. 再次观察；
8. 验证实际结果；
9. 将结果和证据交付给用户。

最终定位：ThinkFusion 不只是能调用本地工具的 Agent，而是能够在用户授权下理解、操作和验证真实桌面环境的桌面 Agent。

## 十二、实施时必须守住的三点

1. **先做 macOS，不要同时做三个平台。** 最新代码已经有 Swift AX Helper、Accessibility Provider 和 macOS 截屏实现。先把现有只读能力扩展成可控、可验证的操作能力。等 Provider 契约稳定后再做 Windows 和 Linux。
2. **不要让模型直接操作鼠标坐标。** 优先通过 Accessibility 控件树识别元素，只有无法获得语义控件时才退回截图坐标。窗口移动、分辨率变化和弹窗出现都会导致误操作。
3. **Computer Use 必须进入现有治理体系。** 它不是另一个独立 Agent。它应该是 ThinkFusion 现有 Agent 能调用的一组受控工具，复用现有审批、权限、事件和证据系统。

另外两条已经存在的约束也必须尊重：

- `AGENTS.md` 要求每项任务完成后进行真机验证。这里的真机验证是验收手段，不是本计划要建设的 Computer Use 本身。
- 当前 AX Helper 的设计明确禁止任意点击和键盘注入。扩展时只能增加受控动作，不能改成无边界的鼠标键盘注入。
