# Gate 0：Podman 环境核查与 PoC 记录

日期：2026-11-12。分支：`0.2.0`。

## 1. 环境

```
Podman 5.8.2
podman machine: applehv / arm64 / 12 GiB / 16 CPU
Python 镜像: python:3.12-slim (已拉取)
Ollama: 本机 11434，已有 deepseek-r1:14b / gpt-oss:20b
Embedding: all-minilm (45 MB，已拉取)
Neo4j: neo4j:5.26-community（拉取中，网络约 400 KB/s）
CGC: codegraphcontext 0.6.13（容器内 pip 安装中）
```

## 2. 脚本

- `scripts/poc-gate0-podman.sh`：CGC → Neo4j → Graphiti 三段式。
- `scripts/poc-graphiti.py`：Graphiti + Ollama（OpenAI 兼容端点）+ Neo4j 的
  Episode 写入与检索。

运行：

```bash
cd desktop-agent-macos
./scripts/poc-gate0-podman.sh
```

脚本会：

1. 生成一个含 TS / Java 的小工程；
2. 在 Python 3.12 容器里 `pip install codegraphcontext==0.6.13`，
   执行 `cgc index` / `cgc list` / `cgc analyze callers processOrder`；
3. 启动 `neo4j:5.26-community`，等 `cypher-shell` 可连；
4. 在 Python 3.12 容器里安装 `graphiti-core[neo4j]`，用
   `gpt-oss:20b` + `all-minilm` 写 3 条工程记忆并检索。

## 3. 当前结果

- `python:3.12-slim`：已拉取，Python 3.12.16；
- `all-minilm`：已拉取；
- CGC：容器已启动，`pip install` 仍在下载依赖（约 6 分钟，pip cache 19MB，
  网络约 400 KB/s）；
- Neo4j：镜像层仍在拉取；
- Graphiti：等 Neo4j/CGC 后执行。

因此本记录**不宣称 CGC/Graphiti 已通过**。这是网络/镜像拉取阻塞，不是
本地回退核的失败；本地核 `test:code-index` 15 条、`npm test` 全绿。

## 4. 通过标准（脚本应输出）

CGC：

- `cgc index` 成功；
- `cgc list` 能看到 sample；
- `cgc analyze callers processOrder` 返回 `run` 或 `b.ts` 的调用者。

Graphiti：

- 3 条 Episode 写入成功；
- `search("订单重复扣款为什么必须幂等")` 返回至少 1 条 FACT；
- 输出带 `valid_at`（时间事实可见）。

如果 CGC 或 Graphiti 在真实运行中失败，按 V3.0 的回退表：
CGC → LSP/AST/SQLite；Graphiti → SQLite Project Memory + Journal。
