# 辩论回归报告（TF-D-001 ~ TF-D-010）

由 `npm run report:debate-regression` 生成，生成时间 2026-11-05T11:06:59.008Z。
断言只看结构（主张、争议、证据、结论），不比措辞；用例数据见
`desktop-agent-macos/scripts/fixtures/debate-regression.mjs`。

**10/10 通过。**

| 用例 | 场景 | 结论 | 轮次 | 主张 | 证据 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| TF-D-001 | 金属与骨头硬度比较 | insufficient_evidence | 1 | 2 | 0 | 通过 |
| TF-D-002 | Java 堆外内存增长排查 | insufficient_evidence | 1 | 2 | 0 | 通过 |
| TF-D-003 | Netty 与 glibc arena 行为 | insufficient_evidence | 1 | 2 | 0 | 通过 |
| TF-D-004 | Redis 连接复用方案比较 | insufficient_evidence | 1 | 3 | 0 | 通过 |
| TF-D-005 | Ollama 本地模型选择 | insufficient_evidence | 1 | 3 | 2 | 通过 |
| TF-D-006 | 用户问题包含错误前提 | insufficient_evidence | 1 | 2 | 0 | 通过 |
| TF-D-007 | 多个模型共同犯错 | insufficient_evidence | 1 | 3 | 0 | 通过 |
| TF-D-008 | 少数派观点有更强证据 | supported | 1 | 3 | 1 | 通过 |
| TF-D-009 | 证据来源互相转载 | supported | 1 | 2 | 6 | 通过 |
| TF-D-010 | 证据不足或工具失败 | insufficient_evidence | 1 | 2 | 0 | 通过 |

## 各用例检查明细

### TF-D-001 金属与骨头硬度比较

- ✅ `claimsMentionAll`：关键词齐全：莫氏、硬度
- ✅ `claimsMentionAll`：关键词齐全：指标
- ✅ `noAbsoluteConclusion`：没有给出结论
- ✅ `verdictNot`：结论：insufficient_evidence（不应是 supported）

### TF-D-002 Java 堆外内存增长排查

- ✅ `claimsMentionAll`：关键词齐全：NMT、Unsafe、malloc
- ✅ `claimsMentionAll`：关键词齐全：RSS

### TF-D-003 Netty 与 glibc arena 行为

- ✅ `claimsMentionAll`：关键词齐全：版本
- ✅ `claimsMentionAll`：关键词齐全：配置
- ✅ `verdictNot`：结论：insufficient_evidence（不应是 supported）

### TF-D-004 Redis 连接复用方案比较

- ✅ `claimsMentionAll`：关键词齐全：Cluster
- ✅ `claimsMentionAll`：关键词齐全：连接池

### TF-D-005 Ollama 本地模型选择

- ✅ `claimsMentionAll`：关键词齐全：内存
- ✅ `claimsMentionAll`：关键词齐全：并发
- ✅ `claimsMentionAll`：关键词齐全：上下文

### TF-D-006 用户问题包含错误前提

- ✅ `correctsPremise`：发言指出了前提问题
- ✅ `claimsMentionAll`：关键词齐全：并发

### TF-D-007 多个模型共同犯错

- ✅ `noSupportedClaims`：0 条主张被判成立（不该有）
- ✅ `verdictNot`：结论：insufficient_evidence（不应是 supported）
- ✅ `conclusionNull`：没有给结论

### TF-D-008 少数派观点有更强证据

- ✅ `minorityWins`：少数派胜出
- ✅ `verdictIs`：结论：supported
- ✅ `claimsMentionAll`：关键词齐全：6.0

### TF-D-009 证据来源互相转载

- ✅ `independentSourcesAtMost`：单条主张最多 1 个独立来源（上限 1）
- ✅ `duplicateEvidenceAtLeast`：1 条证据被标成同源重复

### TF-D-010 证据不足或工具失败

- ✅ `verdictIs`：结论：insufficient_evidence
- ✅ `conclusionNull`：没有给结论
