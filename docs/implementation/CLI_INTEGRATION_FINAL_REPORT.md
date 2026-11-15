# CLI 接入整体验收报告（0.2.7）

日期 2026-11-15 · 分支 `0.2.7` · worktree `/Users/yalla/data/localLab/thinkfusion-ai-0.2.7`
基线 `b6b2fa7`（最新 main）· 只本地提交，不 push，不合并 main。

状态标签：`SPECIFIED / IMPLEMENTED / INTEGRATED / VERIFIED / TESTED / PRODUCTION_READY`；
`NOT_IMPLEMENTED / PARTIAL` 见基线审计；`BLOCKED` = 环境前置条件不具备，本轮没验证到。

## 1. 最终判断

**CLI 接入的功能与治理能力已全部落地，Qoder 链路达到 `PRODUCTION_READY`。
整体验收判定为「有条件就绪」，不写全量 `PRODUCTION_READY`。**

唯一未闭合的是外部条件：Claude Code 使用的 OpenCode Go **周额度耗尽**（429，
约 19h31m 后重置），导致 4 个真实 CLI E2E 用例本轮 `BLOCKED`（3 个 Claude 用例 +
1 个多 CLI 并发）。代码、测试、应用侧链路都已 `IMPLEMENTED / TESTED`，
但 `VERIFIED` 这一档不能靠推测补上。额度恢复后重跑一条命令即可闭合。

本轮没有按 V1.0 计划书重写 `CliAdapter` / `TerminalHost` / `TerminalRouter` /
终端 UI；这些类在代码里从未存在，架构决策见
`ADR_CONFIG_DRIVEN_CLI_ADAPTER.md`。所有工作只补治理、审计、状态、验证能力。

## 2. 按修订路线逐阶段核对

| 阶段 | 交付 | 状态 |
| --- | --- | --- |
| Phase 0 重建真实基线 | `CLI_INTEGRATION_BASELINE_AUDIT.md`、`ADR_CONFIG_DRIVEN_CLI_ADAPTER.md`；纠正「实施前已有 / 本次新增 / 代码里不存在」 | `PRODUCTION_READY` |
| Phase 1 安全与版本治理 | 脱敏前置、审批卡最终有效参数、版本+参数指纹能力验证、六类错误分类、关闭确认 | `IMPLEMENTED / INTEGRATED / VERIFIED / TESTED` |
| Phase 2 终端审计 | JSONL 每会话一份、`sequence`、全事件类型、`dropped` 落盘、写失败补记、8MB/14 天策略、应用退出记录、脱敏先于落盘 | `IMPLEMENTED / INTEGRATED / VERIFIED / TESTED` |
| Phase 3 状态机与回放 | 进程状态/连接状态分离、运行时长、`replay-terminal.mjs --verify/--markers` | `IMPLEMENTED / INTEGRATED / VERIFIED / TESTED` |
| Phase 4 真实 E2E 与回归 | opt-in 真 CLI 脚本、Fake CLI 高频测试、多终端并发、取消清理、全量 `npm test` | 见 §3、§6；Claude 部分 `BLOCKED` |
| Phase 5 最终验收 | 四份文档、状态标签核对、遗留问题、就绪判断 | 本文，`PRODUCTION_READY`（文档本身） |

### 优先级复核（按审核意见）

| 任务 | 优先级 | 本轮结果 |
| --- | --- | --- |
| 权限参数展示 | P0 | 审批卡展示展开后的 argv / 真实 cwd / 有效权限 / 是否可改文件 / 是否高危 |
| 版本变化能力失效 | P0 | 硬编码 `verified` 已去掉，绑定 `(cliId, 版本, os, 指纹)`；只降级相关能力 |
| 终端审计持久化 | P0 | 已落地，且**脱敏排在落盘之前**（审核意见没单列，本轮提为硬前置） |
| 终端事件回放 | P1 | 顺序 + resize 可重现，完整性校验能抓乱序/缺尾/坏行 |
| 完整状态机 | P1 | 六态 + 连接状态分离，`CANCELLED` 只在终止成功后置位 |
| 关闭确认与退出记录 | P1 | 二次确认 5 秒窗口；`before-quit` 写 `app-exit.jsonl` |
| 配额限流分类 | P1 | 六类 + 三层信任；真机 429 样本促使补了结构化正文层 |
| 真实 CLI E2E 脚本 | P1 | opt-in，默认 dry-run，PASS/FAIL/BLOCK 三态 |
| 全量回归 | 发布前 P0 Gate | 见 §3 |
| 文档整理 | P1 | 四份交付文档齐备 |

## 3. 验收结果

| 验收项 | 结果 |
| --- | --- |
| `npm run typecheck`（main / agent / renderer 三套） | 全绿 |
| `npm run build`（renderer / main / agent） | 成功 |
| `npm run test:cli-production` | **35/35 通过**（本轮新增 7 条回归：警告行解析、多行取最后一个 JSON、E2E 口径对齐、真机 429 分类、应用退出补尾 3 条） |
| `npm test`（全量，约 95 个套件链） | **全绿**：整条链跑到最后一个 `test:cli-production` 35/35，`not ok` 0 条、`error TS` 0 条、每个套件 `# fail 0`；日志 `/tmp/tf-027-full-test-final2.log` |
| 相关既有单项 | `test:terminal` 5/5、`test:worktree` 6/6、`test:capabilities` 18/18、`test:harness` 12/12、`test:attachments` 17/17、`test:verify` 9/9、`test:cli` 15/15 |
| 真实 CLI E2E `--run --all` | **5 PASS / 0 FAIL / 4 BLOCK**（Qoder 全通过；Claude + 并发因周额度 `BLOCKED`） |
| 生产「重新验证」真机 | `verifyCliHeadless('qoder')` → `ok:true, version:1.1.89, headless:verified`，能力记录落盘 |
| 应用侧真机 | 设置页 CLI 两行与「重新验证」、两个 PTY 会话、状态栏、结束二次确认、审计 JSONL 与回放完整性校验全部通过 |

**全量回归**：`npm test` 的最终输出在 `/tmp/tf-027-full-test-final2.log`（9159 行）。
整条链从 `test:protocol` 一直跑到末尾 `test:cli-production`，没有中途退出：
`not ok` 0 条、每个套件的 `# fail` 汇总均为 0、`error TS` 0 条，末套件
35/35。全量链不含 `test:cli-real`（opt-in、会联网）。收尾另复跑了
`npm run typecheck`（三套全绿）与 `npm run test:cli-production`（35/35），
结果与全量链一致。

> 说明：`test:cli` 曾用 Fake CLI 真进程测试出现一次偶发失败，随后三次单跑 15/15；
> `test:local-tools` 曾因执行沙箱拦截测试自身清理 `jobs/*.log` 出现 1 条环境性假失败，
> 单跑 53/53。两者都记录了原因，没有靠重跑掩盖。

## 4. 交付物

| 文件 | 作用 |
| --- | --- |
| `docs/implementation/ADR_CONFIG_DRIVEN_CLI_ADAPTER.md` | 架构决策：不引入空壳 Adapter |
| `docs/implementation/CLI_INTEGRATION_BASELINE_AUDIT.md` | 按 Git 事实重建的三类基线 |
| `docs/implementation/QODER_CLI_SPIKE_REPORT.md` | 真实版本、逐项实测结果、环境阻断 |
| `docs/implementation/CLI_INTEGRATION_FINAL_REPORT.md` | 本文 |
| `desktop-agent-macos/docs/CLI_AGENTS.md` §9–§14 | 使用说明、状态、测试命令、交付文档索引 |
| `src/shared/redact.ts` | 脱敏（落盘/展示前） |
| `src/shared/cli-result.ts` | 结构化结果统一解析口径 |
| `src/shared/cli-errors.ts` | 六类错误分类 |
| `src/shared/terminal-state.ts` | 进程状态推导 |
| `src/agent/effective-args.ts` | 审批卡最终有效参数 |
| `src/agent/tools/terminal-audit.ts` | 终端审计 JSONL |
| `src/main/cli-capabilities.ts` | 版本/参数绑定能力记录 |
| `src/main/terminal-audit-reconcile.ts` | 应用退出时给未收尾的会话同步补尾（标不完整） |
| `scripts/replay-terminal.mjs` | 回放与完整性校验 |
| `scripts/spikes/cli-real-e2e.mjs` | 真实 CLI opt-in E2E |
| `scripts/check-cli-production.mjs` | 生产化自动化测试 |

## 5. 本轮真机发现的四个真实缺陷（均已修 + 回归测试）

1. **结构化结果被警告行毁掉**：Qoder 1.1.89 在 JSON 前打一行自定义命令重命名
   警告，主进程「重新验证」和 E2E 脚本的整段 `JSON.parse` 把成功任务判成失败。
   统一到 `src/shared/cli-result.ts` 的按行容错解析，三处共用，成功标准不放宽。
2. **取消验证是空集假阳性**：`ps -eo pid,pgid` 在受限环境返回 EPERM → 空列表，
   「进程组已清空」其实没观测到。改为 `process.kill(-pgid, 0)` 真实信号探测，
   前置条件不满足一律 `BLOCKED`。
3. **真机 429 被分成 UNKNOWN_ERROR**：Claude 把额度原因写在结构化 `result` 正文，
   `subtype` 只有 `error`；旧逻辑短路成 `UNKNOWN_ERROR(high)`。补一层
   `structured / medium` 正文证据，真机样本正确落到 `RATE_LIMITED`。
4. **应用正常退出后，活着的 PTY 会话永远缺 session-end**：`app-exit.jsonl` 写出
   了，Claude 会话的 JSONL 却停在最后一条 stdout —— Electron 直接杀掉
   UtilityProcess，Runtime 的 `process.on('exit')` 不会执行。新增
   `src/main/terminal-audit-reconcile.ts`，`before-quit` 同步按文件事实补
   `exit` + `session-end`，标 `auditIncomplete: true` / `recoveredBy`，不伪造退出码；
   回放校验会如实指出这份记录不完整。用真机遗留文件复验：11 → 13 事件、
   sequence 连续、二次执行幂等；再用最终构建重启调试实例并优雅退出，
   `app-exit.jsonl` 实际写出
   `"reconciledSessions":["term-mwhbn0xy-2","term-mwhd86ei-1","term-mwhd86ep-2"]`，
   三份文件末条都是 `recoveredBy: 'main-process'`，原有完整会话未被改动。

四处都不是「为了验收好看」的修饰，是真实 CLI / 真实应用退出跑出来才暴露的行为差异。

## 6. 遗留问题与风险

| 问题 | 性质 | 处理 |
| --- | --- | --- |
| Claude + 并发 4 个 E2E `BLOCKED` | 外部 OpenCode Go 周额度耗尽（429） | 额度重置后 `npm run test:cli-real -- --run --all`；不伪造通过 |
| CLI 自动升级后参数漂移 | 外部 | 版本/参数指纹自动降级 `unverified`，点「重新验证」 |
| PTY 无独立 stderr | 平台事实 | 审计记 `stdout` 并标 `stream: pty-merged`，不假装分得开 |
| 能力记录在启动时载入内存 | 实现取舍 | 运行期手改 `cli-capabilities.json` 不会即时生效；重启或点「重新验证」 |
| 审计 stdin 可能含敏感输入 | 设计边界 | 落盘前统一脱敏；用户仍应避免往终端粘贴密钥明文 |
| 被应用退出带走的会话退出码未知 | 平台事实 | 主进程补尾并标 `auditIncomplete: true`；`--verify` 明确报「不完整」，不冒充完整审计 |

## 7. 复跑清单

```bash
cd /Users/yalla/data/localLab/thinkfusion-ai-0.2.7/desktop-agent-macos
npm run typecheck
npm run build
npm run test:cli-production
npm test
npm run test:cli-real -- --run --all          # 需两家 CLI 都有登录态与额度
npm run replay:terminal -- <sessionId> --verify
npm run replay:terminal -- <sessionId> --markers
```

## 8. Git 约定

- 从最新 `main`（`b6b2fa7`）建独立 worktree `0.2.7`，所有改动留在该 worktree。
- 只做本地 `git commit`，**不 push**，**不合并 main**；合并由用户决定。
- 遵守 `AGENTS.md` 第 5 节与 `docs/git-workflow.md` 第 3 节。

## 9. 追加：软件源设置与「问题源」边界（同分支，后一次提交）

用户追加提问「支持问题源了吗，软件源设置也要支持」。先按事实核对，再只改确定的一项。

**「问题源」：当前刻意不支持，本轮不改。** 依据不是猜测，是代码原文：
`src/main/cli-agents.ts` 文件头与 `src/shared/contracts.ts` 都写明
「CLI 是执行者，不是回答通道」，理由是硬规则「所有已开启且页面可用的通道都要问」
不能作用到会改代码的进程；`SubAgentRegistry` 是网页通道池，`ExecutionPool` 按
`web / local / cloud` 归属收敛，把 CLI 塞进去会同时破坏知识空间与工程空间的
选人规则。重读《CLI 接入实施计划书 V1.0》全文（附件 (15)，814 行）也确认：
里面没有「问题源 / 软件源」这两项，§2.3 架构预留只提到 OpenCode CLI /
CodeBuddy CLI 的 Adapter 类型标识，§16 更明确「本项目只负责 CLI 的接入、
承载、交互和应用层治理，辩论系统升级是另一个独立项目」。因此这项保持
`NOT_IMPLEMENTED`，要支持必须先由用户裁决提问链路的归属规则。

**「软件源设置」：`IMPLEMENTED / INTEGRATED / VERIFIED / TESTED`。**

| 能力 | 落点 |
| --- | --- |
| 可执行文件、安装/更新来源、服务端点、备注 | 设置 → 智能体 → 每行「软件源设置」 |
| 校验（basename / 绝对路径 / shell 元字符 / https / 包名） | `src/shared/cli-software-source.ts` |
| 落盘与重启读回 | `userData/cli-agents.json` 的 `softwareSource` |
| 绝对路径必须亲手挑过 | `cli:pick-executable` + 主进程 `pickedCliExecutables` |
| 换命令名自动降级能力 | 既有参数指纹机制，无需新逻辑 |
| 自动化测试 | `npm run test:cli-source`，8/8 |

明确不做的：不替用户安装/更新、不联网、不把端点混进 argv、不放凭据、
不因为一个开关就把 CLI 变成回答通道。

验收追加：`npm run typecheck` 三套绿、`npm run build` 成功、
`test:cli-source` 8/8、`test:cli-production` 35/35。全量 `npm test`
（`/tmp/tf-027-full-test-source.log`，9225 行）跑到最后一个
`test:cli-source` 8/8，`not ok` 0 条、`error TS` 0 条、每个套件 `# fail 0`。

真机（Electron 调试实例，CDP 复核）：

- `getCliAgents()` → `setCliSoftwareSource()` → `getCliAgents()`：Qoder 从
  `softwareSource: null` 变成 `npm 包 / @qoder/cli / 端点 / 备注`，重读一致；
  `command` 仍是 `qoder`、headless 仍是 `verified`（没改命令就不该降级）。
- 未经「选择…」的绝对路径 `/bin/ls` 被主进程明确拒绝，报错原文是
  「绝对路径必须先用「选择…」在文件对话框里挑过」。
- 设置 →「Agent 预设」两行都出现「软件源设置」按钮与「软件源：…」描述；
  点开表单后四个输入框回填 `qoder / @qoder/cli / 端点 / 备注`，下拉为 `npm`，
  「选择…」按钮在位。
- 验证完用备份把 `userData/cli-agents.json` 还原成测试前的样子，
  `softwareSource` 已清空；调试实例优雅退出，没有留下测试配置。
