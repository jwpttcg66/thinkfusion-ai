# V3.2-R3 实施计划审核

- 审核对象：`/Users/yalla/Downloads/制定辩论主题方案 (11)-20261113-1758-2.md`
- 当前代码：`0.2.0-v3` / `2ec1b3f`（审核提交 `74a6a1c` 是审核文档提交，不是代码基线）
- 审核日期：2026-11-13
- 上一轮：`CODE_INTELLIGENCE_V3_2_PLAN_REVIEW.md`

---

## 1. 结论

**V3.2-R3 是目前质量最高的一版；六项 P0 已经转成接口、状态和验收项。建议批准，但不是“全部任务直接开工”。**

建议：

- **立即批准 TF-V32-00（基线检查）和 TF-V32-01（接口冻结）**；
- TF-V32-02～08 在接口冻结后按依赖顺序实施；
- Gate 1A 独立，不与 V3.2 混做；
- Gate 3～5 继续后置。

编码前还有 **5 个接口/顺序问题** 必须修正，否则会出现“计划很完整、实现却和现有代码对不上”。

---

## 2. R3 已经解决的事

| 上一轮 P0 | R3 处理 | 判断 |
| --- | --- | --- |
| 预算耗尽确定性报告 | 第 6 章定义 `deterministicFinalReport()`、Finding 规则、summary 模板 | **已解决方向** |
| Token 预算/Provider 能力 | 5.7/5.8 定义 usage source、estimated/unavailable、ModelRequest 扩展 | **方向正确** |
| Evidence Store 越权 | 4.6 明确只做临时 EvidenceRef，Gate 4 再做 Pack | **已解决** |
| Web-only 矛盾 | 7.5 明确 Web 永不直接调用本地工具 | **已解决** |
| Runtime 接入点 | 3.2 明确由 `conversation-runner` 内部执行器持有 | **已解决方向** |
| 状态/终止映射 | 8.3 有完整映射表 | **已解决** |

这些修正都正确，尤其是：

- `BUDGET_EXHAUSTED` → State `COMPLETED` + Report `PARTIAL`；
- 取消不请求模型、直接确定性报告；
- 工具错误保留其他证据；
- 不允许把估算 Token 当真实值。

---

## 3. 编码前必须修正的 5 个 P0

### P0-1：现有 `ProviderCapabilities` 已存在，不能同名新建

当前 `src/main/providers/types.ts` 已有：

```ts
interface ProviderCapabilities {
  streaming: boolean;
  cancellation: CancellationMode;
  modelDiscovery: DiscoveryMode;
  maxConcurrency: number;
  structuredOutput: boolean;
  toolCalling: boolean;
}
```

R3 第 7.2 又定义了同名 `ProviderCapabilities`，但字段结构完全不同：

```ts
interface ProviderCapabilities {
  toolCalling: { mode; status };
  usage;
  outputTokenLimit;
  streaming;
}
```

这会造成：

- 两套同名类型；
- Provider 实现无法同时满足；
- 后续代码不知道 import 哪一个。

**建议**：

- 扩展现有 `ProviderCapabilities`，增加 `usage`、`outputTokenLimit`、`toolCallingMode/status`；
- 或把 R3 的类型改名为 `ProviderToolCapabilities`；
- 在 TF-V32-01 中明确保留旧字段，避免破坏现有 Provider/UI。

### P0-2：`generation` 类型与 Schema v5 不一致

R3 多处写：

```ts
generation?: string;
```

当前 Generation v5 是 **number**：

- `code_generation.generation INTEGER`；
- `CodeNode.generation: number`；
- `currentGeneration(): number | null`。

**建议**：

- 统一用 `generation: number`；
- 如果确实需要字符串 ID，定义 `generationId = String(generation)`，不要混用；
- `EvidenceRef.generation`、`AgenticSearchContext.generation`、`SearchReport` 全部统一。

### P0-3：固定 Generation 没有实现入口

R3 第 9 章要求一次搜索固定 Generation，但当前 `CodeIndexStore` 的读方法都是：

```ts
const generation = this.currentGeneration(projectId);
...
```

没有接收“固定 generation”的参数。搜索过程中如果后台提交新 generation，`symbol_lookup` / 文件查询可能切到新代。

**建议**：

- 增加只读快照入口，例如：
  - `CodeIndexStore.withGeneration(projectId, generation, fn)`；或
  - 所有查询方法增加可选 `generation` 参数；
- `AgenticSearchContext` 创建时固定 generation；
- 所有工具调用使用同一 generation；
- Generation 已被清理时返回明确错误，不静默切换。

**这是 V3.2 的 P0，但 R3 的任务列表里没有单独的“固定 Generation”任务。** 建议加入 TF-V32-03 或 TF-V32-06。

### P0-4：预算范围与现有“多成员”执行方式冲突

R3 说“同一问题所有探索轮次共享预算”，但当前 `conversation-runner` 是：

- 多个 local/cloud 成员分别调用 `askWithReadTool`；
- 每个成员都可能各自发起 4 轮工具调用。

如果每个成员的 `askWithReadTool` 各自创建 Context/Budget：

- 5 个成员 × 8 轮 = 40 轮，不是 8 轮；
- 预算隔离会变成“每个成员一份”，不是“每个问题一份”。

**建议**：

- 明确预算作用域：
  - **A：每个用户问题共享一份预算**（更符合 R3 文字）；
  - **B：每个成员一份预算，但总预算再加一层聚合上限**。
- 如果选 A，需要把 Context 提到成员循环之外，由 `conversation-runner` 创建并传给每个成员；
- 如果选 B，需要定义“总预算”和“成员预算”两个层级；
- 无论哪种，都要在 TF-V32-03 写清。

### P0-5：任务顺序自相矛盾

第 18 章顺序：

```
TF-V32-03 Budget Manager
TF-V32-04 FINALIZING 接入
TF-V32-05 Provider Tool Contract
```

但第 18 章依赖又写：

```
TF-V32-05 为 TF-V32-04 提供正式工具契约
```

即 04 依赖 05，却排在 05 前面。

**建议**：

- 先 TF-V32-05，再 TF-V32-04；或
- 04 先用现有 `parseToolRequest` 接入预算，05 再替换为正式契约，并明确这是两步。

否则实施者会在 04 里临时造一套工具契约，05 再改一遍。

---

## 4. 其他需要补的接口

### 4.1 `ToolResult` 缺 project/generation

R3 的 `ToolResult` 有 `callId/toolName/argsSummary/status/data/error/evidenceRefs/warnings/truncated/durationMs`，但缺：

- `projectId`；
- `generation`；
- `providerMode`（可选）；
- `readOnly`（可选）。

建议补上。Evidence 校验需要 project/generation。

### 4.2 `EvidenceRef` 缺冻结内容

`EvidenceRef` 只有 path/line/contentHash/toolCallId，没有 `excerpt`/`content`。

但：

- 确定性报告要生成“某行包含某符号”的 Finding；
- Web-only 要把证据内容发给 Web 模型；
- Generation 清理后，只有引用无法还原内容。

**建议**：

- V3.2 的 EvidenceRef 增加 `excerpt: string`（限长）或 `snapshotRef`；
- 明确“临时快照只在本次任务生命周期内有效”；
- 正式持久化仍留到 Gate 4。

### 4.3 `SearchBudgetUsage` 的 unavailable 不能是 0

R3 说 `unavailable` 不能当真实消耗，但接口字段是 `number`。

建议：

```ts
inputTokens: number | null;
outputTokens: number | null;
usageSource: 'provider' | 'estimated' | 'unavailable';
```

否则 `0 + unavailable` 在 UI 上会被读成“没有消耗”。

### 4.4 Token 估算策略要写死

当前工程没有通用 tokenizer。R3 说“使用现有 Tokenizer，没有则估算”，但没定义估算规则。

建议：

- 有 provider usage → 用真实值；
- 无 usage → `Math.ceil(chars / 4)`，明确标 `estimated`；
- 连字符都无法可靠统计 → `unavailable`；
- 估算方法写入 `warnings`。

### 4.5 工具安全还缺“敏感文件过滤”

R3 7.8 有路径、读取、搜索、权限安全，但没有：

- `.env` / `*.pem` / `*.key` / `id_rsa` / `.aws/credentials` 等默认拒绝；
- 云端外发提示；
- 源码内容 prompt injection 的处理。

建议在 TF-V32-05 明确。

---

## 5. 测试矩阵评估

R3 的测试矩阵很完整，B01–B14 / R01–R10 / T01–T12 / S01–S10 / G01–G05 覆盖了主要路径。

建议再补：

- **M01**：多成员同时搜索时预算是否共享；
- **M02**：一个成员取消，其他成员是否停止；
- **M03**：Provider 不支持 usage 时 UI 是否显示 `unavailable`；
- **M04**：固定 Generation 后后台切换，当前搜索是否仍读旧代；
- **M05**：Generation 被清理后，报告是否 PARTIAL 而不是混读；
- **M06**：Web-only 下 Web 模型无法触发本地工具；
- **M07**：`business-flow` 空壳回归；
- **M08**：工具结果 `argsSummary` 不含密钥。

---

## 6. 批准范围与顺序

### 可以立即批准

| 任务 | 理由 |
| --- | --- |
| TF-V32-00 基线检查 | 必须先确认真实接入点 |
| TF-V32-01 接口冻结 | 先修 ProviderCapabilities/generation 冲突 |

### 接口冻结后再批准

- TF-V32-02 确定性报告；
- TF-V32-03 Budget Manager；
- TF-V32-05 Provider Tool Contract；
- TF-V32-04 FINALIZING（应在 05 之后，或明确两步）；
- TF-V32-06 状态机；
- TF-V32-07 Web-only；
- TF-V32-08 回归。

### 仍然暂缓

- Gate 1A Symbol Identity（独立）；
- Gate 3 Tree-sitter；
- Gate 4 Evidence Pack；
- Gate 5 Jury/Judge。

---

## 7. 最终意见

V3.2-R3 已经把上一轮六个 P0 转成了可执行接口和验收项，方向正确，可以作为正式实施基准。

但在写代码前必须解决：

1. `ProviderCapabilities` 同名冲突；
2. `generation` number/string 不一致；
3. 固定 Generation 没有查询入口；
4. 多成员预算作用域未定义；
5. TF-V32-04/05 顺序矛盾。

这五处不解决，TF-V32-00 的基线报告会写得很漂亮，但 TF-V32-03/04/05 会因为接口冲突返工。

**建议只批准 TF-V32-00 和 TF-V32-01；等接口冻结、基线报告确认后，再按修正后的顺序继续。**
