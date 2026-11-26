# ThinkFusion AI

**Many Minds. One Intelligent Workflow.**

ThinkFusion is a multi-model collaboration work platform. Users state a goal; the system coordinates web, local, cloud and CLI participants, tools and knowledge sources, preserves execution evidence, and delivers inspectable results. Debate and review are optional behaviours, not mandatory stages.

## Documentation

- [中文 README](README.zh-CN.md) — quick start and repository overview
- [Product direction](docs/PRODUCT.md)
- [As-built architecture](docs/ARCHITECTURE.md)
- [Current implementation status and gaps](docs/implementation/STATUS.md) — the only status authority
- [Documentation map](docs/README.md)
- [Application IPC and protocol docs](desktop-agent-macos/docs/README.md)

## Quick start

Requirements: macOS, Node.js `>=22.12`, npm `>=10`.

```bash
cd desktop-agent-macos
npm install --no-audit --no-fund
npm run typecheck
npm test
npm run dev
```

Current capability boundaries, test evidence and known gaps are in the status board, not duplicated here.
