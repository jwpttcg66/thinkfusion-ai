# 发布与维护

## 1. 名字与标识

| 位置 | 值 |
| --- | --- |
| GitHub 仓库 | `jwpttcg66/thinkfusion-ai`（Public） |
| 产品名（`build.productName`） | `ThinkFusion` |
| 包名（`package.json` `name`） | `thinkfusion-ai` |
| Bundle ID（`build.appId`） | `com.thinkfusion.app` |
| License | MIT（版权人暂写 `ThinkFusion contributors`） |

**改名会移动应用数据目录。** Electron 的 `userData` 由 `productName` / `name` 决定，
现在是 `~/Library/Application Support/ThinkFusion`。再改名时同样要先退出应用再复制，
否则新目录会被建成空的、登录态和任务历史全丢：

```bash
cp -R ~/Library/Application\ Support/<旧名字> ~/Library/Application\ Support/ThinkFusion
```

## 2. 历史里清掉过什么

公开仓库不该带本机路径，所以首次推送前重写过一次历史：

- `.workbuddy-ai/` 整个目录（本地工作日志）从所有提交中移除
- `mock-api.ts`、`HARNESS_BASELINE.md` 里的 `/Users/<用户名>/...` 换成 `/Users/example/workspace`
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

`.github/workflows/ci.yml` 在 push / PR 时跑 typecheck、59 项离线测试和构建。

两个坑已经绕开了：Electron 二进制对 typecheck / test / bundle 都不必要
（`ELECTRON_SKIP_BINARY_DOWNLOAD` 提到 job 级），而 `npm run build` 的 `prebuild`
会去下载它，所以构建步骤用 `npm run build --ignore-scripts`。

需要真实页面的检查（`scripts/check-*.mjs`）不在 CI 里，见
[`desktop-agent-macos/docs/TEST_PLAN.md`](../desktop-agent-macos/docs/TEST_PLAN.md)。

## 5. 待定

- **版权人**：`LICENSE` 现在是 `Copyright (c) 2026 ThinkFusion contributors`，
  要写个人或组织名就改这一行。
- **版本标签**：本地只有旧的 `v0.1.0`，`package.json` 是 `0.6.0`。
  要对齐就打 `git tag -a v0.6.0 -m "ThinkFusion v0.6.0"`；标签推上去不方便改，不想发 Release 就先别打。
