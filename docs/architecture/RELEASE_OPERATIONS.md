# P6 发布与运维设计

状态：**设计稿完成（2026-11-18）；方向确认；P0 门禁未过；未实施。**
评审快照：`2d05b12`（当前 HEAD 见 git log）；代码基线：`cd30be3`。
设计分支：`product-v3`。
前置：P0–P5 完成；V3 功能门禁通过。

P6 不是产品功能阶段，而是把 V3 交付给真实用户所需的发布、迁移、备份、诊断与回滚。

---

## 1. 版本与发布

- **产品版本**：V3（产品线）；**应用版本**：SemVer（当前 `0.3.0`）。
- `VERSION` 与 `desktop-agent-macos/package.json` 必须一致；不一致时以 `VERSION` 为准并阻断发布。
- 发布标签：`v<app-version>`（附注 tag），不把 `V3` 当 SemVer。
- 发布说明：从上次 tag 到本次的 `feat/fix` 摘要 + 已知问题 + 数据迁移说明。

```ts
export interface ReleaseManifest {
  productLine: 'V3';
  appVersion: string;
  tag: string;
  commit: string;
  builtAt: number;
  artifacts: Array<{ name: string; sha256: string; size: number }>;
  dataSchema: number;
  notes: string;
}
```

---

## 2. 打包与签名

| 项 | 要求 |
| --- | --- |
| 平台 | macOS Apple Silicon（arm64） |
| 产物 | `.dmg` + `.zip` |
| 签名 | Developer ID Application；`codesign --deep --force --verify` |
| 公证 | `notarytool submit` + `stapler staple` |
| 校验 | 每个产物输出 SHA-256，写入 ReleaseManifest |
| 自动更新 | P6 不启用；升级由用户手动下载 |
| 依赖 | Node ≥ 22、Electron 45；打包不依赖本机 node_modules |

发布前必须在**干净机器/干净用户目录**安装一次，验证首次启动、登录、退出。

---

## 3. 数据与迁移

数据源：

```text
userData/
  agent-store.json      会话/任务/事件
  debates/*.json        辩论
  evidence-packs/       证据包
  knowledge/            知识卡（P2）
  settings.json         配置
```

规则：

- 每个存储有 `schemaVersion`；读取未知字段忽略，不崩溃。
- 升级前自动备份到 `userData/backups/<timestamp>/`（最多保留 3 份）。
- 迁移只做**加法**；删除/重命名字段必须保留只读兼容。
- 迁移失败不覆盖原文件；启动进入只读恢复模式，提示用户恢复备份。
- 降级：旧版本读到新字段必须忽略；无法忽略时明确拒绝启动，不静默损坏。

```ts
export interface MigrationStep {
  from: number;
  to: number;
  apply: (dir: string) => Promise<void>;
  reversible: boolean;
}
```

---

## 4. 备份与恢复

- 导出：把 `userData` 中非敏感数据打包为 `thinkfusion-backup-<date>.zip`；
- 可选包含证据包与知识卡；默认不含密钥/凭据；
- 导入：校验 schema、路径、哈希白名单，拒绝绝对路径与 `..`；
- 恢复前先备份当前状态；
- 恢复后重启，校验会话/知识/证据可读。

---

## 5. 诊断与日志

- 日志：主进程/运行时/通道分级；默认不记录用户正文；
- 诊断面板：通道状态、运行时状态、最近的失败原因；
- 崩溃：保留最小转储与时间线，不上传；
- 遥测：**默认关闭**；开启必须显式同意，且可关闭；
- 脱敏：路径、令牌、Cookie、页面正文按既有 `redact` 规则处理。

---

## 6. 回滚

| 层 | 回滚方式 |
| --- | --- |
| 功能 | Feature Flag（legacy/shadow/active） |
| 应用 | 重新安装上一个签名版本 |
| 数据 | 恢复升级前备份；迁移不可逆时在发布说明中标注 |
| 证据/知识 | 只读兼容；不删除旧记录 |

回滚演练必须在发布前做一次，记录步骤与结果。

---

## 7. 安全复核

- 密钥只存 Keychain/ApiKeyStore；不写入日志/备份；
- 代码签名与公证产物可验证；
- TCC/辅助功能权限按需申请，拒绝时给出可执行提示；
- 默认无遥测、无外部上报；
- 删除/覆盖操作默认进废纸篓；永久删除需完全权限；
- 发布前跑 `test:security`、`test:prompt-policy`、`check:prompt-policy`。

---

## 8. 支持矩阵

| 项 | 范围 |
| --- | --- |
| macOS | 当前主版本及前两个大版本（发布时确认） |
| 芯片 | Apple Silicon arm64 |
| Node | ≥ 22.12（仅开发/构建） |
| Electron | 45.x |
| 模型 | Web / Local / Cloud / CLI 按 P5 能力表 |
| 语言 | 中文为主；代码/协议英文 |

---

## 9. V3 发布清单

- [ ] P0–P5 门禁全部通过
- [ ] 产品：无需选择协作模式；三空间可用；Debate 非入口
- [ ] 协作：DAG、重规划、并行/递进、失败记录、停止原因
- [ ] 证据：五类 EvidenceRef；可追溯；篡改可发现
- [ ] 工程：一次真实闭环；可回退
- [ ] 知识：二次复用 + 时效
- [ ] `VERSION` / `package.json` / tag 一致
- [ ] 签名 + 公证 + SHA-256
- [ ] 干净机器安装验证
- [ ] 备份/迁移/回滚演练
- [ ] 发布说明与已知问题

---

## 10. 风险

| 风险 | 对策 |
| --- | --- |
| 数据迁移损坏 | 先备份、只加不删、失败只读恢复 |
| 签名/公证失败 | 发布前在干净环境预演 |
| 版本号不一致 | `VERSION` 为准，发布脚本阻断 |
| 日志泄露正文/密钥 | 默认脱敏、默认无遥测 |
| 降级读不了新数据 | 未知字段忽略；无法兼容则拒绝启动 |
| 发布清单放水 | P6-08 门禁 + 清单签字 |
