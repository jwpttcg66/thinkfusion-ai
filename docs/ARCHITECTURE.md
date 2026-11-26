# ThinkFusion 代码架构（As-built）

本文描述当前仓库中实际存在的主要边界与请求链路，不把目标设计当成实现。
产品定位见 [PRODUCT.md](PRODUCT.md)，当前能力/缺口见
[implementation/STATUS.md](implementation/STATUS.md)，领域设计入口见
[architecture/README.md](architecture/README.md)。

## 1. 分层与边界

```text
React Renderer
  └─ task / conversation projections ← persisted events
      │ typed AgentApi (no Node access)
Preload / IPC
      │ validated arguments, trusted sender checks
Main Process
  ├─ ConversationRunner: route workspace + request lifecycle
  ├─ Collaboration: planner / participants / runner / replanning
  ├─ Engineering: plan → approval → Runtime → report → verify/review
  ├─ Debate / DMOCA / TDL / ECO: reusable collaboration policies and projections
  ├─ Providers / Web adapters / CLI agents
  └─ AgentStore, KnowledgeStore, MemoryStore, EvidencePackStore, feature stores
      │ task.run / step events / report
UtilityProcess Runtime
  └─ plan/grant validation → capability registry → local tools
```

| Layer | Code location | Responsibility |
| --- | --- | --- |
| Renderer | `desktop-agent-macos/src/renderer/` | Input, workspace views, live event and result projections |
| Shared contracts | `desktop-agent-macos/src/shared/` | IPC/event schemas, task/conversation types, pure projections and policies |
| Preload | `desktop-agent-macos/src/preload/` | Narrow typed API; renderer does not receive direct Node access |
| Main composition | `desktop-agent-macos/src/main/index.ts` | Instantiate stores/adapters/orchestrators and register IPC |
| Request routing | `desktop-agent-macos/src/main/conversation-runner.ts` | Workspace intent/routing and General/Knowledge/Engineering dispatch |
| Collaboration | `desktop-agent-macos/src/main/collaboration/` | Task planning, participants, scheduling, execution, result delivery |
| Engineering orchestration | `desktop-agent-macos/src/main/orchestrator.ts` | Plan lifecycle, approval, execution handoff, reports, review and resume |
| Provider boundary | `desktop-agent-macos/src/main/providers/`, `adapters/`, `execution/` | Cloud/local API, browser-backed pages, CLI planning/answer adapters |
| Local Runtime | `desktop-agent-macos/src/agent/` | Separate UtilityProcess; validates plan/grant and dispatches registered tools |

The concrete directory tree is the implementation map; this document intentionally does not copy full
file inventories or contracts.

## 2. Request flows

### General / Knowledge

1. `ConversationRunner` receives the submitted conversation and applies intent/workspace routing.
2. The relevant runner selects eligible web, local, cloud or CLI participants under the user's execution configuration.
3. Adapters send requests; collaboration/synthesis consumes returned answers and evidence.
4. `AgentStore` persists conversation messages/events; renderer projections display the same source events.

### Engineering

1. `ConversationRunner` performs the Engineering pre-route. Local/cloud/mixed routes use the selected model;
   web-only uses the rule fallback so a classification request does not pollute a web conversation.
2. `AgentOrchestrator` sends a plan request, parses the `desktop-agent/v1` block and validates it against schemas/capabilities.
3. User approval produces a scoped `TaskGrant`; the main process sends the plan to `agent-manager.ts`.
4. The UtilityProcess revalidates plan and grant, runs each step through the capability registry, and emits start/result/failure events.
5. The structured report feeds verification, independent review, delivery projection and (when enabled) context recovery.

No model text is executable code. The Runtime receives validated, approved plan data and rechecks the grant per step.

## 3. State and storage ownership

| Data | Owner | Notes |
| --- | --- | --- |
| Conversation/task lifecycle and main journal events | `AgentStore` | Main app history and run events |
| Local tool execution journal | Runtime DB via `src/agent/db.ts` | Step/run records; not a second task orchestrator |
| Long-term memory | `MemoryStore` / `MemoryService` | Separate governed store; not current-turn evidence |
| Evidence packs | `EvidencePackStore` | Source/evidence references and integrity material |
| Debate state | Debate store/orchestrator | Isolated debate lifecycle; collaboration invokes it when needed |
| Context checkpoints | owner-scoped checkpoint files + Journal pointer | No new task manager or Runtime; off by default unless configuration/environment enables it |

A summary is not execution evidence. A status label is not a substitute for the event/report that supports it.

## 4. Contracts and design references

- IPC/event contracts: `desktop-agent-macos/src/shared/contracts.ts` and `src/shared/schemas.ts`.
- Execution protocol: [desktop-agent-macos/docs/PROTOCOL.md](../desktop-agent-macos/docs/PROTOCOL.md).
- IPC boundary: [desktop-agent-macos/docs/IPC.md](../desktop-agent-macos/docs/IPC.md).
- Domain contracts: [spec/README.md](spec/README.md).
- Architecture target documents: [architecture/README.md](architecture/README.md).
- Architecture decisions: [adr/README.md](adr/README.md).

When implementation and a design snapshot disagree, use the current code/tests and
[implementation/STATUS.md](implementation/STATUS.md); update the design document only if its contract remains active.
