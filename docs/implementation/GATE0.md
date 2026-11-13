# Gate 0：架构冻结与技术验证

- 分支：`0.2.1`
- 基线：`4cfd972` + `ad09584` / `3784032` 审核文档
- 状态：**进行中**
- 约束：不改 `src/main/code-index/indexer.ts` 主链路，不改 `SCHEMA_VERSION`，不引入 JDT，不实施全量调用图。

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
  - 3 个夹具，约 12–18 ms，约 65–68 MB RSS；
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

- 扩展到 20 个夹具；
- 运行时 `web-tree-sitter.wasm` 在安装包内的定位；
- 记录打包后安装包体积、签名/公证影响；
- 大文件/错误恢复/取消；
- 与现有 `collectJava()` 双跑对比（Gate 1 才做）。

### Agentic Search

已完成协议 harness：

- `npm run spike:agentic-search`
- 7 轮、42 条证据，覆盖 Controller → Service → Repository → Database；
- 证据 ID、文件/行号复核、去重、预算/停止条件均通过。

未完成（Gate 0B 的真实模型验证）：

- 一个真实工程；
- 默认本地模型 + 一个云端 API 模型；
- 3～5 个问题；
- 与“一次性预检索 + 单次回答”基线对比；
- 记录轮数、工具调用成功率、证据行号准确率、耗时。

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

未开始。Gate 0 先建骨架：

- 15 个 Java 语法夹具（当前 3 个）；
- 5 个 Agentic Search 问题及期望组件/文件行号；
- Java 21 单模块、Java 21 多模块（含同名类）、Maven、Gradle Kotlin DSL、最小 Spring Boot；
- Java 8/11/17 后补。

## 通过标准

Gate 0 通过必须同时满足：

1. Tree-sitter 在 Electron（含 asar）可稳定加载，20 个 Java 夹具通过，错误样本带位置。
2. Agentic Search 在 5 个真实问题上 ≥4 个找到期望跨文件组件，关键结论行号 ≥95%，0 条无证据“确定调用”。
3. 默认本地模型 + 云端模型都有结果；Web-only 能明确降级。
4. 构建信任：默认不执行未知构建脚本；拒绝后仍可静态索引。
5. ADR 0001～0005 有明确决策；0006 的未决项有后续计划。
6. `typecheck`、`test:code-index`、现有 `npm test` 全绿。

## 不在 Gate 0 范围

- 修改 `indexer.ts` 主链路；
- 修改 `SCHEMA_VERSION`；
- 引入 JDT；
- 全量 Java 调用图；
- Go/Python/TypeScript Tree-sitter 接入；
- 多模型并行探索；
- 完整 Evidence Pack UI。

## 下一步

1. 扩充 Java 夹具到 20 个，并把 spike 结果写入 `adr/0006`。
2. 做 Agentic Search 最小循环（只读、预算、取消、证据），先在 mock/单模型上验证协议，再接真实模型。
3. 做构建信任 spike（Gradle/Maven 默认不执行）。
4. Gate 0 评审后再决定是否进入 Gate 1。
