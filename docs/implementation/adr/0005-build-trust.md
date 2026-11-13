# ADR-0005：构建信任边界

- 状态：Proposed
- 日期：2026-11-12
- 适用：Gate 0 ADR / Gate 2

## 背景

工程智能需要 classpath 才能做精确语义分析，但 Maven/Gradle 导入会执行工程代码：

- Gradle Tooling API 会执行 `build.gradle` / `build.gradle.kts`；
- Maven 生命周期可能触发插件、注解处理器、依赖下载；
- 未来若引入任何 Java 语义服务，其 Maven/Gradle 导入同样受此约束。

当前 0.2.0 没有构建执行边界。V2 提出 Level 0/1/2，方向正确，需要映射到现有 `TaskGrant` / 审批 / 沙箱。

## 决策

| 级别 | 能力 | 默认 | 实现 |
| --- | --- | --- | --- |
| Level 0 | 静态读取、搜索、Tree-sitter 解析、读 pom/gradle 文本 | 允许 | `project.read`，只读，路径范围校验 |
| Level 1 | 受控依赖读取、离线 classpath 提取 | 受限 | 用户显式开启；不执行构建脚本；只读已知 lock/依赖文件 |
| Level 2 | 执行构建脚本、测试、工程命令 | 必须审批 | 现有 `TaskGrant` + `stepApproval` + 沙箱；每次授权有 TTL |

规则：

- 默认不执行未知工程的构建脚本；不因为“需要依赖”自动运行 Maven/Gradle。
- 首次 Level 2 必须显示：将执行哪个命令、哪个目录、可能联网、可能执行插件。
- `Gradle offline` 不等于安全：offline 只影响依赖下载，构建脚本仍会执行。
- 构建失败/拒绝后，回退 Tree-sitter 语法索引；证据标明 `classpath: unresolved`。
- 不把构建输出直接当事实；classpath 结果记录来源、命令、时间、fingerprint。
- Git 读取使用只读参数；不执行任意 git alias；限制输出大小。

## 映射现有治理

- `permissionPreset`：`read-only` 只能 Level 0；`workspace-write` 仍需逐次审批 Level 2。
- `TaskGrant.allowedTools` 增加明确的构建工具名，不把 `shell.run` 当作通用构建入口。
- `TaskGrant.expiresAt` / `grantVersion` 继续生效；执行中的授权不可由 UI 改写。
- 所有构建命令进 Journal/Trace，失败原因给用户看。

## Spike 结果（2026-11-12）

`npm run spike:build-trust`：

- 只做静态扫描：识别 Gradle 工程，不执行 `build.gradle`，无 `EXECUTED` 标记；
- `--approve`：执行自定义 task，`EXECUTED` 标记出现；
- 两次结果均为 PASS。

Maven 插件样本尚未跑；Gate 0B 继续补。

## 验收

- 含自定义 Gradle task 的样本工程：默认不执行；用户拒绝后仍能静态索引。
- Maven 插件样本：默认不执行；确认后才执行；有超时/取消。
- 构建失败：不破坏索引；UI 显示 `classpath: unresolved`。
- 无 Podman / 无 JDK 环境：Core 仍可用。
