# P6-06 回滚钻取记录

日期：2026-11-20。
基线：`main` + P6 回滚模块。
目标：验证应用回滚（active→legacy）与数据回滚（备份→恢复）。

## 1. 场景

| 场景 | 动作 | 期望 | 结果 |
| --- | --- | --- | --- |
| 应用回滚 | `active` → `legacy` | 读回 legacy | 通过 |
| 模式文件损坏 | 写入非 JSON | 回 legacy，不抛 | 通过 |
| 数据回滚 | 备份 `pack.json` → 删除 → 恢复 | 内容回到 `{"v":1}` | 通过 |
| 路径安全 | 备份含 `..` | 拒绝 | 通过（单元测试） |

## 2. 执行

```bash
cd desktop-agent-macos
npm run build:test
node --test scripts/check-rollback-drill.mjs
```

结果：**2/2 通过**（含多断言）。

## 3. 结论

应用与数据回滚路径可用；正式发布前仍需在干净机器上做一次完整升级/回滚。
