# 安全与隐私报告（Phase K）

日期 2026-11-04。范围：本次 0.1.0 新增的 Provider、执行模式、辩论、裁决、
综合、UI。没有做外部渗透测试，下面只列代码里可核对的事实。

## API Key

| 环节 | 做法 | 验证 |
| --- | --- | --- |
| 存储 | `ApiKeyStore` 走 Electron `safeStorage`，密文 base64 落 `api-keys.json`，权限 `0o600`，原子写 | 测试断言文件里不含明文 |
| 加密不可用 | **直接拒绝写入**，不降级成明文 | 单测覆盖 |
| IPC | `app:set-api-key` 只回 `{id, configured}`；`app:execution-options` 只回 `hasKey: boolean` | 真机 `getExecutionOptions()` 输出里没有任何 Key |
| renderer | 密码输入框，保存后立即清空本地 state，不回显 | UI 真机检查 |
| 日志 | 错误文案只带 provider id，不打 Key | 代码核对 |

`test:cloud:live` 从环境变量读 Key，只在测试进程里出现，不落盘、不打印。

## 隐私边界

`local-only` 只在 `execution/policy.ts` 的选人阶段生效：网页和云端成员被
排除后，后面没有任何路径能把它们加回来。即使显式传
`selectedWebChannels`、或打开 `fallbackEnabled`，也不放行；末尾还有一道
防御性抛错。

真机证据（Phase E）：`local + local-only` 提交 `23 乘 2`，`channels` 与
`answered` 都只有 `ollama:qwen2.5:7b`，回答 `46`，没有向任何网页发送内容。

`web` 与 `local-only` 互斥：web 模式强制归一为 `allow-cloud`（网页本来就
外发），UI 禁用「仅本地」选项并写明原因。不禁用 web 模式，也不假装它能
满足隐私约束。

## IPC 与输入边界

- preload 用 `contextBridge` 暴露逐条 `invoke`，没有 `ipcRenderer` 透传。
- 所有新增 handler 都先 `trustedUiSender(event)`。
- `conversation:submit` 的 `executionConfig` 在 main 侧经
  `normalizeExecutionConfig()` 收敛：非法模式退回 web、非字符串过滤掉、
  隐私模式只认两个合法值。
- `DebateStore` / `VerdictStore` 对 id 做 `^[a-zA-Z0-9-]+$` 校验，挡路径穿越。
- 辩论/裁决文件 `0o600`。

## 提问链路

用户问题**原样**发到网页。Sequential 的前序结果走 `SubAgentTask.context`，
辩论/裁判的指令走 `system`，`WebChannelProvider` 两者都忽略；页面上不会
出现「请质疑以下观点」之类的包装话术。Phase F/G 的测试都钉住了
`question` 文本不变。

## 数据与红线

- 原始回答不覆盖：辩论的修正是另一条 `revision` 消息，带 `targetMessageId`。
- 少数派不删除：裁决 `minorities` 保留原文，综合 `rejected` 也保留原文。
- 多数票不判真伪：`supportCount` 只描述人数，3:1 也照样 `undetermined`。
- 费用与 token：没有单价时 `cost: null` 不是 0；服务端没给 usage 单独计数，
  不当成 0；预算闸门达到上限后不发请求。
- `timeliness` 本地判不了写 `null`，不编造。

## 未做 / 待复核

- 没有 `CLOUD_API_KEY`，**云端真实调用的安全链路（TLS、响应头、Key 是否被
  上游记录）未验证**。
- 没有做 Key 轮换、过期、按会话隔离配额。
- 没有做外部依赖审计或渗透测试。
- `verdictFor` 的映射只在进程内存里，重启后丢失（裁决本身已落盘，不丢）；
  这不影响安全，只影响「裁决 → 下一次综合」的联动范围。
