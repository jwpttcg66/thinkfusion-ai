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

## 3. 实际结果

### 3.1 CGC：通过

容器内 `codegraphcontext 0.6.13`，后端切到 Neo4j：

```bash
cgc config db neo4j
NEO4J_URI=bolt://<neo4j-ip>:7687 \
NEO4J_USERNAME=neo4j NEO4J_PASSWORD=testpass \
cgc index /work
```

输出：

```
Total scanned files 3
Files by extension .java:1, .ts:2
Function nodes 5
Class nodes 2
CALLS edges 5
Successfully finished indexing: /work in 31.20 seconds
```

`cgc analyze callers processOrder`：

```
Caller Function  run
Location         /work/src/b.ts:2
Call Type        Project
Total: 1 caller(s)
```

说明：CGC 默认 FalkorDB Lite 在这个容器里启动后长时间停在 indexing；
切到 Neo4j 后端后通过。CGC 的 Java/TS 都是 Tree-sitter 级结果，不是
tsserver 级精确调用；这条结果只证明“能索引/能查 callers”，不证明
“与编译器结果完全一致”。

### 3.2 Graphiti：通过

同一 Neo4j 实例，Ollama `gpt-oss:20b` 做抽取，`all-minilm` 做 embedding：

```bash
STRUCTURED_MODE=json_schema \
OLLAMA_BASE=http://host.containers.internal:11434/v1 \
python /work/poc.py
```

输出：

```
added episode 0
added episode 1
added episode 2
FACT 订单服务需要 processOrder 的幂等性以避免重复扣款
valid_at 2026-11-12 09:14:11.306313+00:00
```

说明：

- `structured_output_mode="json_object"` 失败：模型返回了 JSON Schema 本身，
  不是 `ExtractedEntities` 数据，Pydantic 报 `extracted_entities Field required`；
- 改成 `json_schema` 后通过；
- 3 条 Episode 写入、实体/关系抽取、检索、时间字段都跑通；
- 目前是同一 Neo4j 实例的两个数据域，不是双实例；
- Graphiti 使用 `all-minilm` 384 维，脚本里的 embedding_dim 与它一致。

### 3.3 环境问题

- Podman machine 中途重启过一次，Neo4j 容器 IP 从 `10.88.0.10` 变为
  `10.88.0.5`；脚本已改为 `podman inspect` 取动态 IP。
- `graphiti-core` 0.31.2 的 `[neo4j]` extra 不存在，实际需要显式安装
  `httpx openai neo4j`。
- CGC 的默认 FalkorDB Lite 在容器里启动后卡住；Neo4j 后端通过。

### 3.4 资源

本次 PoC 未做完整的内存/CPU 压测；只验证链路。两套图库/记忆是否上正式
版本，仍需 Gate 3 的资源测试。

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
