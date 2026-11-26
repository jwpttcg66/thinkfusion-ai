# 发布与维护

## 1. 名字与标识

| 位置 | 值 |
| --- | --- |
| GitHub 仓库 | `jwpttcg66/thinkfusion-ai`（Public） |
| 产品名（`build.productName`） | `ThinkFusion` |
| 包名（`package.json` `name`） | `thinkfusion-ai` |
| Bundle ID（`build.appId`） | `com.thinkfusion.app` |
| License | MIT（版权人暂写 `ThinkFusion contributors`） |

**改名会移动应用数据目录。** 主进程显式设置了 `app.setPath('userData', …)`，目录名是
`thinkfusion-ai`（不是 `productName`）：当前真实数据在
`~/Library/Application Support/thinkfusion-ai`。本机同时存在 `…/ThinkFusion`，
但那里没有 `agent-store.json`——按旧文档往 `ThinkFusion` 拷会拿到空历史。
再改名时同样要先退出应用再复制：

```bash
cp -R ~/Library/Application\ Support/thinkfusion-ai ~/Library/Application\ Support/<新名字>
```

验收/测试实例可用 `THINKFUSION_USER_DATA` 指定独立目录，避免写到真实历史。

## 2. 历史里清掉过什么

公开仓库不该带本机路径，所以首次推送前重写过一次历史：

- `.workbuddy-ai/` 整个目录（本地工作日志）从所有提交中移除
- `mock-api.ts`、`desktop-agent-macos/docs/archive/research/HARNESS_COMPARISON-2026-11-07.md` 里的 `/Users/<用户名>/...` 换成 `/Users/example/workspace`
  与 `~/data/dsh-src`

复查（应当只剩示例路径）：

```bash
git grep -n "/Users/" -- . | grep -v example
git grep -nE "(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)" -- .
```

## 3. 推送

本机 SSH 密钥需先在 <https://github.com/settings/keys> 注册（`~/.ssh/id_ed25519.pub`）：

```bash
git remote add origin git@github.com:jwpttcg66/thinkfusion-ai.git
git push -u origin main
```

## 4. CI

`.github/workflows/ci.yml` 在 push / PR 时跑 `typecheck`、`npm run verify`（32 个 test 脚本）和构建。

两个坑已经绕开了：Electron 二进制对 typecheck / test / bundle 都不必要
（`ELECTRON_SKIP_BINARY_DOWNLOAD` 提到 job 级），而 `npm run build` 的 `prebuild`
会去下载它，所以构建步骤用 `npm run build --ignore-scripts`。

需要真实页面的检查（`scripts/check-*.mjs`）不在 CI 里，见
[`desktop-agent-macos/docs/TEST_PLAN.md`](../desktop-agent-macos/docs/TEST_PLAN.md)。

## 5. 待定

- **版权人**：`LICENSE` 现在是 `Copyright (c) 2026 ThinkFusion contributors`，
  要写个人或组织名就改这一行。
- **版本标签**：`package.json` 是 `0.3.0`，仓库里的标签是辩论基线
  `debate-v4.1-p0-baseline-20261116` / `debate-v4.1-p2-foundation`，没有 `v0.3.0`。
  要对齐就打 `git tag -a v0.3.0 -m "ThinkFusion v0.3.0"`；标签推上去不方便改，不想发 Release 就先别打。
