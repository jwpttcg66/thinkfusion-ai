# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versions follow
[Semantic Versioning](https://semver.org/). Entries are generated from
Conventional Commits by `scripts/release.sh`.

## v0.3.0 - 2026-11-18

- docs(product): 重新定位为「可验证的多模型审辩」——独立作答、定向辩论、证据校验、条件化结论；PRODUCT 只保留目标形态、取舍原则与成功判据
- docs(product): 补齐知识学习（0.4）与工程能力（0.5）两条后续主线的定位与判据，说明两个空间共用同一套证据链
- docs(roadmap): 重写为 0.3.x–1.0 的完成判据，现状与缺口分开写
- docs: 文档树收敛——删除阶段实现日志、回归产物、过期审计与 docx，保留规格 / ADR / 测试 / 索引；新增 `docs/README.md` 作为唯一入口
- docs: 修复文档、脚本与源码注释中指向已删除文件的链接
- feat(evidence-pack): 执行证据生产者与显式验证意图并入 main（ExecutionReport → ExecutionAttestation → Pack）
- chore: 版本号统一为 0.3.0（`VERSION`、`desktop-agent-macos/package.json`）

## v0.1.0 - 2026-10-31

- fix(scripts): keep the changelog title above the first release entry (aa83d53)
- feat(scripts): add one-step setup and semantic release (cecdbd4)
- feat(hooks): enforce commit conventions and block unsafe commits (d823d2b)
