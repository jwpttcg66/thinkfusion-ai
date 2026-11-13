# Gate 0 spikes

这些脚本不是产品代码，不进入 `src/main/code-index/` 主链路。它们只用于回答 Gate 0 的问题；Gate 1 批准前不要把它们当作实现。

| 命令 | 验证 |
| --- | --- |
| `npm run spike:tree-sitter` | Node 下加载 Java grammar，解析 3 个夹具 |
| `npm run spike:tree-sitter:electron -- --asar` | Electron 主进程 + asar 内加载 grammar |
| `npm run spike:agentic-search` | 确定性脚本模型验证工具循环、去重、预算、证据行号 |
| `npm run spike:build-trust` | 静态扫描 Gradle 不执行构建脚本 |
| `npm run spike:build-trust -- --approve` | 显式批准后才执行自定义 task |
| `npm run spike:gate0` | 顺序跑完以上全部 |

依赖：`web-tree-sitter@0.27.2`、`@vscode/tree-sitter-wasm@0.3.1`（均 MIT）。生产接入前必须重新评估打包、签名/公证和 grammar 升级策略，见 `docs/implementation/adr/0006-tree-sitter-runtime.md`。

Agentic Search spike 只证明协议；真实模型验证仍需默认本地模型 + 云端模型各跑 3～5 个真实问题，见 `docs/implementation/adr/0004-agentic-search-runtime.md`。
