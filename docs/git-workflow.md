# Git 工作流

本仓库的版本管理约定。首次克隆后**必须**执行一次初始化：

```bash
./scripts/git-setup.sh
```

它会把 `core.hooksPath` 指向 `.githooks/`、启用提交模板、写入一组别名。不做这一步，钩子不会生效（钩子目录不会被 Git 自动识别）。

---

## 1. 提交信息规范（Conventional Commits）

格式：`<type>(<scope>): <subject>`

| type | 用途 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 文档 |
| `style` | 格式调整，不影响逻辑 |
| `refactor` | 重构，不改变外部行为 |
| `perf` | 性能优化 |
| `test` | 测试 |
| `build` | 构建、依赖 |
| `ci` | CI 配置 |
| `chore` | 杂务（版本号、脚手架等） |
| `revert` | 回滚 |

规则（由 `.githooks/commit-msg` 强制）：

- type 必须在白名单内，冒号后必须有一个空格和内容；
- 首行不超过 100 字符，不以句号结尾；
- `Merge` / `Revert` / `fixup!` / `squash!` 开头的提交自动放行；
- 破坏性变更用 `!` 标注：`feat(api)!: drop v1 endpoints`。

示例：

```
feat(auth): 增加短信验证码登录
fix(order): 修复并发下重复下单
docs: 补充 Git 工作流说明
```

不想写多行说明时用单行提交即可；需要正文时直接 `git commit`（不带 `-m`），模板会带出注释引导。

## 2. 钩子（Hooks）

| 钩子 | 拦截内容 | 绕过 |
| --- | --- | --- |
| `commit-msg` | 提交信息不符合规范 | `git commit --no-verify` |
| `pre-commit` | 残留冲突标记、单文件 > 5MB、疑似密钥（私钥头 / AWS AK / GitHub token / `sk-`） | 同上 |
| `pre-push` | 直接推送或非快进推送 `main`（**默认关闭**） | `git push --no-verify` |

开启 main 保护：

```bash
git config hooks.protectMain true
```

这个钩子只保护推送，与第 3 节的 main 开发规则分开：无论钩子开关如何，`main` 都只接收已验证的任务分支合并，不在 `main` 直接提交代码。推送仍由用户执行。

## 3. 分支与 worktree 模型

```
main                         仅作为集成分支，只接受任务分支合并
  ├─ feat/<task> + worktree  新功能任务
  ├─ fix/<task> + worktree   缺陷修复任务
  └─ chore/<task> + worktree 文档与杂务任务
```

**每个新任务都必须有自己的 worktree 和分支。** 不在 `main` 工作区直接写代码；不同并发任务不能共用 worktree 或分支。创建任务工作区：

```bash
git worktree add -b feat/sms-login ../thinkfusion-sms-login main
cd ../thinkfusion-sms-login
# ... 在这个 worktree 开发、测试、提交 ...
```

任务分支从最新 `main` 提出；`main` 上禁止直接开发/提交、rebase、cherry-pick、reset。`main` 只通过 merge 接收经过验证的任务分支，使用 `--no-ff` 保留任务边界。

任务首次提交后的所有后续修改——评审意见、冲突修复、合并后的缺陷修复——都继续在该任务自己的 worktree/分支进行。任务未完成并通过测试、typecheck 前，不得合并到 `main` 或其他分支。合并后发现问题时，回原 worktree 增加修复提交，验证通过后再合并；不要在 `main` 或别人的任务分支直接补代码。

### 并发任务的集成顺序

按任务首次有效提交时间从早到晚排队。**后提交任务的负责人负责把自己的任务集成到已更新的 `main`，并修复自己的冲突或回归。**

例如 A 先提交、B 后提交：

1. 先把 A 合入 `main`，运行相关测试与 typecheck，确认 A 正常。
2. B 的负责人在 B 的 worktree 执行 `git merge main`，解决冲突，并验证 A、B 两项功能。
3. B 的负责人在自己的 worktree 修复自己引入的问题；所有相关测试与 typecheck 通过后，再提交修复并把 B 合入 `main`。
4. B 合并后发现问题，仍回 B 的 worktree 修复、验证、提交，再将修复合入 `main`。合并前确认 `main` 工作区干净；未通过验证的任务不得合入；任务确认完成前不要删除对应 worktree。

`git worktree list` 查看所有工作区；任务合并并确认完成后，再清理已合并分支与 worktree。

## 4. 版本发布

`VERSION` 存当前版本号，`CHANGELOG.md` 存变更记录，两者由脚本维护，不要手改。

```bash
./scripts/release.sh patch --dry-run   # 预览
./scripts/release.sh patch             # 0.1.0 -> 0.1.1
./scripts/release.sh minor             # 0.1.0 -> 0.2.0
./scripts/release.sh major             # 0.1.0 -> 1.0.0
```

脚本会：检查工作区干净 → 计算新版本号 → 从上一个 tag 起抓取 `feat/fix/perf/refactor` 提交生成条目 → 更新 `CHANGELOG.md` 与 `VERSION` → 提交 `chore(release): vX.Y.Z` → 打附注 tag。

推送到远程：

```bash
git push && git push --tags
```

## 5. 常用别名

`scripts/git-setup.sh` 写入的别名：

| 别名 | 等价于 |
| --- | --- |
| `git st` | `status -sb` |
| `git lg` | 图形化全部分支日志 |
| `git co` | `checkout` |
| `git br` | `branch -vv` |
| `git unstage <file>` | `reset HEAD --` |
| `git last` | 查看最后一次提交的改动 |
| `git amend` | 修改上次提交，不改信息 |
| `git pushf` | `push --force-with-lease` |
| `git gone` | 清理远程已删除的本地分支 |

## 6. 冲突与回滚

```bash
git rerere status          # 已开启 rerere，重复冲突自动复用解法
git merge --abort          # 放弃合并
git restore --staged <f>   # 取消暂存
git revert <sha>           # 生成反向提交（历史保留，推荐）
git reset --hard <sha>     # 丢弃之后的提交（仅本地未推送时使用）
```

`merge.conflictStyle` 已设为 `zdiff3`，冲突处会额外显示原始版本，比默认的 `merge` 样式更容易判断该保留哪边。

## 7. 换行符

`.gitattributes` 统一 `eol=lf`，Windows 脚本保留 `CRLF`，二进制文件不做转换。这样在 macOS / Linux / Windows 之间协作不会出现整文件 diff。
