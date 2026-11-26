# 真机复验：折叠正文可在框内滚动

- 时间：2026-11-26T10:12:52.854Z → 2026-11-26T10:13:03.347Z
- 隔离 userData `/tmp/tf-scroll-userdata`；只清 CDP 端口 9333，未动用户 5173 实例
- 真实 store：用户 5173 实例在跑，哈希 `70a83635c2c3` → `70a83635c2c3`（一致）；隔离实例数据在 `/tmp/tf-scroll-userdata`

## 测量结果

| 元素     | overflow-y | max-height | scrollHeight / clientHeight | 设置 scrollTop 后 | 可滚 |
| ------ | ---------- | ---------- | --------------------------- | -------------- | -- |
| stream | auto       | 148.8px    | 744 / 149                   | 32             | 是  |
| member | auto       | 97.2px     | 778 / 97                    | 32             | 是  |

截图：`01-scroll-probe.png`

