# ADR-0006：Tree-sitter 运行时与打包

- 状态：Accepted（仅限 Gate 0 spike；生产接入待 Gate 1）
- 日期：2026-11-12
- 适用：Gate 0 / Gate 1

## 背景

V2 把 Tree-sitter 作为轻量语法提取候选，要求先做 Electron spike，不能未经验证进入主索引链路。

候选：

- native `tree-sitter` / `tree-sitter-java`（N-API addon）；
- `web-tree-sitter` + 预编译 `.wasm` grammar。

## Spike 结果

环境：Electron 45.1.0 / Node 24.22.1 / Chrome 156。

依赖：

- `web-tree-sitter@0.27.2`（MIT）
- `@vscode/tree-sitter-wasm@0.3.1`（MIT，含 Java grammar）

结果：

```
npm run spike:tree-sitter
  15 files, ~15–18 ms, ~73 MB RSS, PASS

npm run spike:tree-sitter:electron -- --asar
  disk: grammarAbi=14, root=program, hasError=false, ok=true
  asar: grammarAbi=14, root=program, hasError=false, ok=true
```

夹具覆盖（15 个文件）：

- package、普通/静态 import；
- class / interface / enum / annotation / record / sealed；
- 字段、构造器、方法、重载、泛型、throws、多行签名、varargs；
- extends / implements；
- 方法调用、对象创建、匿名类、lambda、method reference、switch expression；
- 嵌套类。

## 决策

- Gate 0 采用 **WASM**：`web-tree-sitter` + `@vscode/tree-sitter-wasm` 的 Java grammar。
- 不使用 native `tree-sitter-java` 作为 Gate 0 方案：npm 包是 N-API addon，需要 Electron rebuild / asarUnpack，风险高于 WASM。
- 加载方式：`fs.readFileSync()` 读 `.wasm` 成 `Uint8Array` → `Language.load(buffer)`。
  - 不用 `fetch()` 从 asar 里取文件。
  - 打包时把 grammar 放 `asarUnpack` 或 `extraResources`，路径由运行时解析。
  - **注意**：`Parser.init()` 自己还要加载 `web-tree-sitter.wasm`。当前 spike 只验证了 grammar 从 asar 读取，运行时 wasm 仍来自 node_modules 磁盘；正式打包必须同时处理运行时 wasm（`locateFile` 指向 asarUnpack/extraResources），并在安装包内复测。
- grammar 版本固定，不跟随 `@vscode/tree-sitter-wasm` 自动升级；升级前跑同一套夹具。
- 解析失败必须返回 `parseStatus`、line/column、失败节点；不得静默成功。

## 未决

- 运行时 `web-tree-sitter.wasm` 在安装包内的定位方式与体积；
- 生产安装包体积与签名/公证影响；
- native 方案在超大工程上的性能是否明显优于 WASM；
- grammar 对 Java 新版本语法的滞后策略；
- 是否将 TS/JS 也切到 Tree-sitter（当前决定：**不切**；TS/JS 继续用现有 TypeScript AST）。
- Go/Python grammar 暂不接入；Gate 1 只做 Java + 现有 TS/JS。

## 验收

- 15 个 Java 夹具全部通过（V2 D0.7）；错误样本带位置。
- 打包后（asar/asarUnpack）可加载。
- 冷启动、RSS、解析耗时有记录。
- 不修改 `src/main/code-index/indexer.ts` 主链路，直到 Gate 1 批准。
