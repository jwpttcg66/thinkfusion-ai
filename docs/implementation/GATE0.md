# Gate 0：架构冻结与技术验证

- 分支：`0.2.1`
- 基线：`4cfd972` + `ad09584` / `3784032` 审核文档
- 状态：**进行中**
- 约束：不改 `src/main/code-index/indexer.ts` 主链路，不改 `SCHEMA_VERSION`，不引入任何 Java 语义服务（JDT 等），不实施全量调用图。
- 说明：JDT 只作为未来可选项出现在审核/历史文档；Gate 0/1 不依赖它。

## 术语

- **夹具（fixture）**：`desktop-agent-macos/scripts/spikes/fixtures/java/*.java`，是 Tree-sitter 的测试输入，不进入产品运行时。V2 计划 D0.7 要求 15 个 Java 语法夹具，当前已补齐。
- **JDT**：Eclipse Java 语义服务，只是未来可选方案；当前没有依赖、没有代码路径、没有运行时进程。Gate 0/1 的边界明确不引入 JDT 或其他 Java 语义服务。

## 0A：决策（文档）

| 任务 | 文件 | 状态 |
| --- | --- | --- |
| Schema v4 / 原子 generation | `adr/0001-generation-atomicity.md` | Proposed |
| 符号身份 / 边模型 | `adr/0002-symbol-and-edge-identity.md` | Proposed |
| Evidence 引用 / 冻结 | `adr/0003-evidence-refs.md` | Proposed |
| Agentic Search 接入 | `adr/0004-agentic-search-runtime.md` | Proposed |
| 构建信任边界 | `adr/0005-build-trust.md` | Proposed |
| Tree-sitter 运行时 | `adr/0006-tree-sitter-runtime.md` | Accepted（spike 范围） |

这些 ADR 是 Gate 0 的决策记录，不代表 Gate 1 已批准。任何与代码不一致的地方以代码审计为准。

## 0B：最小验证

### Tree-sitter Java + Electron

已完成：

- `npm run spike:tree-sitter`
  - 15 个夹具，约 15–18 ms，约 73 MB RSS；
  - class/interface/enum/annotation/record/sealed/nested/constructor/field/method/overload/generic/throws/varargs；
  - method invocation、object creation、anonymous class、lambda、method reference、switch expression。
- `npm run spike:tree-sitter:electron -- --asar`
  - Electron 45.1.0 / Node 24.22.1；
  - grammar ABI 14；disk 与 asar 均加载成功（asar 只验证 grammar；运行时 `web-tree-sitter.wasm` 仍需在安装包内复测）。

文件：

- `scripts/spikes/tree-sitter-java-spike.mjs`
- `scripts/spikes/electron-tree-sitter-spike.cjs`
- `scripts/spikes/fixtures/java/*.java`

未完成：

- 运行时 `web-tree-sitter.wasm` 在安装包内的定位；
- 记录打包后安装包体积、签名/公证影响；
- 大文件/错误恢复/取消；
- 与现有 `collectJava()` 双跑对比（Gate 1 才做）。

### Agentic Search

已完成协议 harness：

- `npm run spike:agentic-search`
- 7 轮、42 条证据，覆盖 Controller → Service → Repository → Database；
- 证据 ID、文件/行号复核、去重、预算/停止条件均通过。

真实模型验证已完成（2026-11-13，见 `GATE0_AGENTIC_SEARCH_RESULTS.md`）：

- 真实工程 `codeStudy/grpc-springboot`，3 个问题；
- 应用不再硬编码默认本地模型；按 Ollama 实际清单选择。第一个 tools 模型 `deepseek-r1:14b` 探测失败；
- 本地改用 `gpt-oss:20b`，3/3 覆盖，但慢 1.4–2 倍、引用不稳定；
- 云端 `deepseek-v4.1-flash` 3/3 覆盖，引用 8–12 条，耗时 1.6–2.3 倍、token 5–20 倍；
- 与一次性预检索基线对比完成；云端 agent 找到 baseline 漏掉的 `50071` 与 `ConditionalOnProperty`。

未完成：

- Web 通道不参与工具循环的 UI 降级文案；
- 多模型并行探索与共享证据快照；
- 结构化 claim/evidence 校验（当前依赖提示词）。

先读 `adr/0004-agentic-search-runtime.md`。

### 构建信任

已完成 Gradle 最小验证：

- `npm run spike:build-trust`
  - 静态扫描识别 Gradle，不执行 `build.gradle`；
  - `--approve` 后执行自定义 task，标记文件出现；
  - 两次均 PASS。

未完成：

- Maven 插件样本；
- 用户拒绝后仍能静态索引的完整链路；
- 审批/超时/取消与现有 TaskGrant 的映射。

先读 `adr/0005-build-trust.md`。

### 基准集

进行中。Gate 0 先建骨架：

- 15 个 Java 语法夹具（已完成）；
- 5 个 Agentic Search 问题及期望组件/文件行号；
- Java 21 单模块、Java 21 多模块（含同名类）、Maven、Gradle Kotlin DSL、最小 Spring Boot；
- Java 8/11/17 后补。

## 通过标准

Gate 0 通过必须同时满足：

1. Tree-sitter 在 Electron（含 asar）可稳定加载，15 个 Java 夹具通过（V2 D0.7），错误样本带位置。
2. Agentic Search 在 3～5 个真实问题上至少 4/5 的关键组件；本次云端 3/3、本地 2.75/3，关键结论可回到源码行。
3. 默认本地模型 + 云端模型都有结果；Web-only 能明确降级。
4. 构建信任：默认不执行未知构建脚本；拒绝后仍可静态索引。
5. ADR 0001～0005 有明确决策；0006 的未决项有后续计划。
6. `typecheck`、`test:code-index`、现有 `npm test` 全绿。

## 不在 Gate 0 范围

- 修改 `indexer.ts` 主链路；
- 修改 `SCHEMA_VERSION`；
- 引入 Java 语义服务（JDT、JavaParser 等）；Gate 0/1 不依赖；
- 全量 Java 调用图；
- Go/Python/TypeScript Tree-sitter 接入；
- 多模型并行探索；
- 完整 Evidence Pack UI。

## 本轮验证记录（2026-11-13）

- `npm run spike:gate0`：Tree-sitter Node、Electron + asar、Agentic Search、Build trust（静态 + 批准）全部 PASS。
- `npm run typecheck`：通过。
- `npm test`：全绿（含 `test:terminal`；修复了等待命令回显导致的竞态）。
- `npm run spike:agentic-search:real`：真实本地/云端模型 3 个问题跑通；结果见 `GATE0_AGENTIC_SEARCH_RESULTS.md`。
- `npm run build`：通过。
- 真机启动 Electron：主界面加载，设置 → 工程智能可打开。

## 下一步

1. 15 个 Java 语法夹具已完成并 PASS；继续补 5 个 Agentic Search 问题和 7 个工程夹具。
2. Agentic Search 真实模型验证已完成；下一步把协议接入现有 `conversation-runner` 的最小实现（仍不接 Gate 1 主链路）。
3. 构建信任已完成 Gradle 最小验证；补 Maven 插件样本。
4. Gate 0 评审后再决定是否进入 Gate 1。
