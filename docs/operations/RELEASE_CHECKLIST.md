# V3 发布清单

日期：2026-11-20。
对应：P6-08 发布门禁、`release-ops/gate.ts`。

## 1. 代码与测试

- [ ] `npm run typecheck`
- [ ] `npm run test:core`
- [ ] 全量分组回归（不含 live/需登录项）
- [ ] P0–P5 门禁记录

## 2. 版本与产物

- [ ] `VERSION` = `package.json` = tag（`v<version>`）
- [ ] `dmg` + `zip` 产物
- [ ] 每个产物 SHA-256 写入 ReleaseManifest
- [ ] Developer ID 签名
- [ ] `notarytool` 公证 + `stapler`
- [ ] 干净机器安装通过

## 3. 数据

- [ ] 升级前备份
- [ ] 迁移脚本可重复
- [ ] 备份/恢复钻取
- [ ] 回滚到上一版本演练

## 4. 安全

- [ ] 仓库无密钥
- [ ] 密钥只存 Keychain
- [ ] 默认无遥测
- [ ] 删除默认废纸篓
- [ ] `test:security`、`test:prompt-policy`

## 5. 发布

- [ ] 发布说明与已知问题
- [ ] 支持矩阵确认
- [ ] 门禁 7 项全绿
