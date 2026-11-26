# P4 证据与质量

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


目标：让「凭什么」可走通，并让质量可回归。
前置：P2/P3 已有真实交付物（否则没有可验证对象）。
出口：跨空间同一套证据引用；质量门槛能拦住「无证据 → 判通过」。

---

## 1. 统一证据引用

不新建存储：`EvidenceRef` 是现有 `EvidencePack` 条目的**引用视图**。

| 现有 `EvidencePackItemKind` | `EvidenceRef.kind` | 说明 |
| --- | --- | --- |
| `source-file` | `code` | 文件片段 |
| `symbol` | `code` | 符号 |
| `call-edge` | `code` | 调用关系 |
| `dependency` | `code` | 依赖 |
| `git-commit` | `code` | 提交 |
| `test-result` | `execution` | 真实测试 |
| `command-result` | `execution` | 命令 |
| `doc-excerpt` | `web` | 网页/文档正文 |

规则：

- `EvidenceRef` 必须带顶层 `hash`、`source.capturedAt`、`trust`；`locator` 可选，没有 `itemHash` 字段。
- 跨空间复用同一条证据时复用同一个 `packId/itemId`，不复制内容。
- 旧 Pack 的 `context.kind='baseline'` 只作为历史读取；新代码写 `snapshot`。
- 不出现第三套哈希：统一用 `evidence-pack/hash.ts`。

验收：`check-evidence-ref.mjs`：8 类映射、哈希一致、旧 Pack 可读。

---

## 2. 验证计划

从交付物里的 Claim 出发：

```text
Claim
 ├─ 有代码位置？ → 代码核对（路径:行号 + 内容哈希）
 ├─ 有执行结果？ → attestation 校验
 ├─ 有网页来源？ → 来源可打开 + 时间/版本
 └─ 都没有？     → unverified（不默认成立）
```

- 验证者独立于提出者（换模型或换规则）。
- 每条 Verdict 记录：relation、confidence、limitations、evidenceRefs。
- `insufficient_evidence` 与 `unsupported` 必须分开。
- 验证失败不删除原 Claim，标 `unverified` 并保留。

验收：`check-verification-plan.mjs`：四类路径、unverified 保留、judge 复用。

---

## 3. 质量指标（初版，可调）

| 指标 | 定义 | 目标 |
| --- | --- | --- |
| Goal Completion | 已满足 acceptance 项 / 总项 | 发布场景 100%；shadow ≥ 90% |
| Evidence Coverage | 有关键 Claim 带证据的比例 | 通用/知识 ≥ 80%；工程「已修复」100% |
| Verification Coverage | 关键 Claim 已判定（非 unverified）比例 | ≥ 70%；工程改动的关键结论 100% |
| Uncertainty Honesty | 未核验项被显式标记的比例 | 100% |
| Collaboration Efficiency | 无新增信息的调用数 / 总调用 | ≤ 20%；简单问题 ≤ 2 次调用 |
| Replanning Quality | 产生有效新信息的重规划 / 总重规划 | ≥ 50%，且总次数 ≤ 2 |
| Engineering Success | 闭环场景通过 / 受控场景总数 | 100%（受控集） |

采集点：P0 事件（`goal.started / observation.recorded / plan.revised / goal.stopped /
deliverable.ready`），不在 UI 层另算。指标不达标时门禁失败，不靠人工解释。

---

## 4. 测试体系

### 4.1 分层

| 层 | 对象 | 运行 | 门禁 |
| --- | --- | --- | --- |
| Unit | domain / planner / scheduler / replanner / freshness | 每次提交 | 必须 |
| Integration | 编排 + mock agents；真实 Agent 可选 | 每次提交（mock） | 必须 |
| Live | 真实 Web / Local / Cloud / CLI | `TF_LIVE=1` 手动/夜间 | 发布前 |
| Scenario | 40 个真实任务 | 发布前 | 必须 |

### 4.2 Fixture 策略

- 工程场景：本地 5 个小仓库 fixture（Java/TS/Node/Maven/Gradle），带 dirty/clean 两态；
  测试脚本用 `mkdtemp` 复制，不污染仓库。
- 网页场景：录制的页面文本 fixture；live 只验证「取回答」，不读像素。
- CLI 场景：假 CLI（脚本）覆盖成功/失败/超时；真 CLI 只在 live 跑。
- 所有 live 测试必须能在无登录态时**明确跳过并说明**，不能假装通过。

### 4.3 稳定性

- 单次失败自动重跑一次；仍失败进入隔离清单，不无限重试。
- 时间相关断言用注入时钟，不用 `sleep` 猜。
- 性能预算：计划生成 ≤ 2s；引擎额外开销 ≤ 15%；单任务调用数有上限。

---

## 5. 场景矩阵（40）

### 通用（10）

| ID | 场景 | 期望 |
| --- | --- | --- |
| G01 | 简单事实问答 | 1–2 步，无辩论 |
| G02 | 技术比较 | 多来源 + 对比 + 关键结论验证 |
| G03 | 方案选择 | 取舍表 + 条件 |
| G04 | 网页提取 | 正文 + 出处 |
| G05 | 追问 | 带上下文，不重来 |
| G06 | 用户取消 | 停止派发，记录原因 |
| G07 | 预算耗尽 | 交付已知 + 缺口 |
| G08 | 无新增信息 | 停止，不硬凑 |
| G09 | 超长问题 | 计划可解释，不爆任务数 |
| G10 | 无法回答 | 明确说不能，不编造 |

### 知识（10）

| ID | 场景 | 期望 |
| --- | --- | --- |
| K01 | 首次主题研究 | 知识卡 + 地图 |
| K02 | 第二次复用 | 带时效复用 |
| K03 | 依据过期 | 标 stale |
| K04 | 结论被推翻 | supersedes，旧卡保留 |
| K05 | 缺口发现 | 补研究任务 |
| K06 | 多主题 | 卡片归属正确 |
| K07 | 来源冲突 | 保留分歧 |
| K08 | 无来源 | 标草稿/未核验 |
| K09 | 预算限制 | 停并说明 |
| K10 | 知识地图 | 三块可点通 |

### 工程（20）

| ID | 场景 | 期望 |
| --- | --- | --- |
| E01 | Java 调用链 | 路径:行号 |
| E02 | TS 影响面 | 引用与影响 |
| E03 | Node 测试 | 真实执行 |
| E04 | Maven 项目 | 构建/测试 |
| E05 | Gradle 项目 | 构建/测试 |
| E06 | 脏工作区 | S1 含 dirty |
| E07 | 测试通过 | attestation |
| E08 | 测试失败 | failed，不冒充 |
| E09 | 回滚 | 回 S1 |
| E10 | 权限拒绝 | 审批阶段拦 |
| E11 | 并发 worktree | 不共享目录 |
| E12 | CLI Executor | grant + worktree |
| E13 | LSP 不可用 | 降级文本并说明 |
| E14 | 影响面分析 | 文件/符号清单 |
| E15 | 评审阻断 | 意见回计划 |
| E16 | attestation 篡改 | 拒绝 |
| E17 | 崩溃恢复 | interrupted |
| E18 | 多任务合并 | 验证后合并 |
| E19 | 大仓库预算 | 有界搜索 |
| E20 | 无改动任务 | 不产生假 diff |

---

## 6. 发布判据

- 40 个场景中，受控集全部通过；live 场景在发布前至少跑一次并记录。
- 指标达标：Completion 100%、Evidence Coverage 工程 100%、Honesty 100%。
- 篡改证据必须被发现；未验证不得写成通过。
- 回滚演练通过：flag 关闭后旧路径可用，旧数据可读。

---

## 7. 任务清单

| ID | 任务 | 文件 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| P4-01 | EvidenceRef 映射 | `evidence-pack/mapping.ts` 增量 | P0 | 映射测试 |
| P4-02 | 验证计划 | `collaboration/verifier/*` | P1 | 四类路径测试 |
| P4-03 | 指标采集 | 事件 + 报表 | P4-02 | 指标测试 |
| P4-04 | 测试夹具 | `scripts/fixtures/*` | P4-01 | 夹具可复制 |
| P4-05 | 场景脚本 | `scripts/check-scenario-*.mjs` | P4-04 | 40 场景 |
| P4-06 | 门禁接线 | `package.json` | P4-05 | CI 脚本 |

---

## 8. 出口清单

- [ ] 8 类 Pack 条目映射到 5 类 EvidenceRef，哈希统一
- [ ] 旧 Pack 可读；新代码不写 `baseline` 上下文
- [ ] 四类验证路径可走通；unverified 保留并标记
- [ ] 指标有公式、采集点、阈值
- [ ] 40 场景可复跑；live 跳过有原因
- [ ] 门禁能拦住「无证据 → 通过」
- [ ] 回滚演练通过
