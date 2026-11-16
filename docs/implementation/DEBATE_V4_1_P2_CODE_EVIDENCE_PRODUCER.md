# P2 工程证据生产者：代码引用识别与源码定位

- 分支 / 工作树：`evidence-producer` / `/Users/yalla/data/localLab/thinkfusion-ai-evidence-producer`
- 起点：`main` = `929d5a7`（P2 Foundation tag）
- 本轮范围：**候选发现 + 仓库定位**，不接每轮 Pack，不建 Claim 关联

---

## 1. 为什么先做这一层

P2 Foundation 只能冻结「辩论开始时的仓库状态」。要生成每轮工程证据，必须先回答：

1. 这条发言/主张引用了哪个文件？
2. 行号是否真实存在？
3. 读到的内容是否来自同一份 Git 基准？

这一步只解决 1/2 的候选与定位；**不判断证据是否支持主张**。模型说
`src/a.ts:10` 只证明「这里确实有这段代码」，不证明这句话正确。

---

## 2. 已实现

`src/main/evidence-pack/code-references.ts`：

| 能力 | 规则 |
| --- | --- |
| 候选格式 | `path:line`、`path:line-end`、`path#Lx`、`path#Lx-Ly` |
| 路径候选 | 反引号里的纯路径只产生 `path-only` 候选 |
| URL 排除 | `https://.../a.ts:1` 不当成本地引用 |
| 路径安全 | 拒绝绝对路径、`..`、反斜杠、越出仓库 |
| 文件校验 | 必须是普通文件；符号链接、二进制/非 UTF-8 拒绝 |
| 行号校验 | 1 ≤ start ≤ end ≤ 文件行数；越界直接失败 |
| 内容 | 只返回定位到的片段 + sha256，不返回整文件 |
| 错误 | 逐条返回；批量调用保留 `resolved / errors` |

**候选 ≠ 证据**：`resolveCodeReference` 只证明文件与行号存在；要把结果变成
`CodeEvidence`，还需要基准确认与 Claim 关联判断。

---

## 3. 测试

`npm run test:code-references`：**6/6 通过**。

覆盖：

- `path:line` / `#Lx-Ly` 提取与去重；
- URL 不误判；
- 行号、内容、hash 与文件一致；
- 绝对路径、穿越、缺失、符号链接拒绝；
- 越界、二进制、只有路径无行号不产生证据；
- 批量调用把有效引用与错误分开。

---

## 4. 仍缺的三层

| 层 | 状态 | 说明 |
| --- | --- | --- |
| 基准确认 | NOT DONE | 当前读取工作区内容；还没有验证它与开场 Pack/commit 一致 |
| 每轮 Pack | NOT DONE | 需要把 resolved 引用按轮写入 Evidence Pack |
| Claim↔Pack 关联 | NOT DONE | 需要显式判断支持/反驳/上下文，不能自动生成 |

下一步顺序：

1. 用开场 Pack 的 commit/dirty 指纹校验 resolved 内容确实来自同一基准；
2. 把 resolved 引用转成 Pack 条目（`source-code` / 行范围 / hash）；
3. 每轮生成增量 Pack；
4. 用显式规则生成 `ClaimEvidenceLink(source: 'pack')`，并保留候选与最终关系两套状态。

在第 4 步完成前，不能宣称「工程辩论闭环」。
