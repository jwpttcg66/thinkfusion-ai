# ThinkFusion AI

**Many Minds. One Intelligent Workflow.**

ThinkFusion AI is an open-source multi-model collaborative intelligence work platform. It brings
together multiple AI models, tools and knowledge sources, organises their collaboration around a
user's goal, and works through exploration, synthesis and evidence verification from problem
understanding to final delivery.

It does not have models take turns opining. It has them genuinely work on the same task:
**the user states a goal, ThinkFusion organises the collaboration; models decide how to explore,
the system coordinates, gathers evidence, verifies and delivers.**

**中文文档：[README.zh-CN.md](README.zh-CN.md)**

---

## Core Capabilities

- **Dynamic collaboration** — who participates, how work is split, parallel or progressive, is
  decided by the task, not by one fixed pipeline.
- **Multi-model evidence** — web, local, cloud and CLI agents contribute different views and
  evidence, not just different prose.
- **Evidence and verification** — conclusions bind to sources, versions and execution
  attestations; anything unverifiable is labelled as an assertion.
- **Knowledge learning** — research results accumulate, index and get reused with timestamps.
- **Engineering workspace** — code understanding, design, changes, tests, review and rollback.
- **General collaboration** — Q&A, comparisons, planning and research.

## Vision

Organise many models, tools and knowledge sources into a team that can work toward a goal,
so the result is more reliable and more complete than any single model or single workflow.

**Many Minds. One Intelligent Workflow.**

---

## What this is, precisely

The user states a goal. ThinkFusion decides what the task needs, which models and tools should
participate, how to divide the work, keeps gathering evidence and verifying as it explores, and
delivers an answer, a research report, a knowledge map or an engineering change. Debate,
challenge, counter-examples and cross-review are available collaboration behaviours, not mandatory
stages of every task.

> Multi-model collaboration engine + **Optional** Local Agent Runtime

The `Optional` is still the load-bearing word. The local runtime is a subsystem, not the product:
without it, knowledge learning and general collaboration still work.

One engine, three workspaces: **knowledge learning** (research, accumulation, knowledge maps),
**engineering** (understanding, design, changes, verification) and **general collaboration**
(Q&A, analysis, comparison). See [docs/PRODUCT.md](docs/PRODUCT.md) for the target shape,
[docs/architecture/COLLABORATION_ARCHITECTURE.md](docs/architecture/COLLABORATION_ARCHITECTURE.md)
for the collaboration engine, and [docs/ROADMAP.md](docs/ROADMAP.md) for the roadmap.

## What actually works today

The capabilities above describe what the platform is *for*. Here is what the code currently does,
stated plainly — a README that promises more than the repository delivers is just marketing:

| Capability | Status |
| --- | --- |
| Independent answers from several channels | ✅ Web AI pages, no API key; the question goes out verbatim, channels cannot see each other |
| Several pages at once | ✅ Right-edge rail; per-page cookies and host allow-list |
| Debate engine (claims / disputes / revision / judges) | ✅ Available; to be demoted to an on-demand behaviour |
| Evidence packs and content hashes | ✅ Evidence and execution attestations enter the Item Hash; tampering is detectable |
| Real execution-evidence producer | ✅ Code ready; not yet wired into the orchestrator |
| Collaboration scheduling (task graph / re-planning) | ⏳ Design frozen, lands in P1 |
| Knowledge-learning space | 🟡 Multi-round research and page-body extraction work; indexing and reuse land in P2 |
| Engineering space | ✅ Partial: disk-backed evidence, plan review, approved execution, code intelligence V3.2 |
| Local execution runtime | ✅ 27 allow-listed tools; approval, path checks, sha256 re-verify |
| External CLI agents | ✅ Qoder / Claude as channels |
| Knowledge indexing / cross-session reuse | ⏳ P2 |
| Unified evidence references across spaces | ⏳ P4 |

Stated as one line: **the debate and evidence chain already run; the unified collaboration engine,
knowledge accumulation and the engineering loop are designed and frozen, waiting for P1–P4.**

## How it works

```
Your goal
   │
   ├─► Embedded web page (real browser view) ──► prompt sent ──► model reply
   │                                                │
   │                                    ┌───────────┘
   │                                    ▼
   │                    parse the protocol block from rendered text
   │                                    │
   │                        schema validation + conflict detection
   │                                    │
   │                          you approve (the whole plan)
   │                                    │
   │                       isolated runtime, serial execution
   │                       (path check / read-only or write / sha256 re-verify)
   │                                    │
   └────────────────────── execution report sent back, next round ◄──┘
```

Four decisions shape the design:

1. **The model channel is a web page, not an API.** Electron embeds a real `WebContentsView`,
   types the prompt, and reads the reply back. No key, no quota, no function calling.
2. **Parsing happens on rendered markdown.** Not on an API response — on the text a human would
   actually see in the chat box. That is the only interface a web AI guarantees.
3. **The text is untrusted input.** It is parsed as JSON and nothing else. It never becomes code,
   never becomes a shell command, and never touches the filesystem directly.
4. **Execution is a separate process.** A `UtilityProcess` receives an approved plan, re-verifies
   the authorization on every step, and runs inside a tool whitelist.

### Several pages, one planner

The right edge of the window is a rail of buttons, one per embedded page. Clicking one brings that
page to the front. The others are *parked offscreen, not destroyed* — a chat page that gets torn
down loses whatever the model was in the middle of writing.

One page on screen at a time is deliberate: two chat UIs side by side get half a window each, and a
half-width chat UI is worse than one you can switch to in a click.

The rail is DOM; the page is a native view painted above the DOM. So the view's bounds have to stop
`RAIL_WIDTH` short of the window edge — forget that and the buttons are invisible and unclickable,
with no error anywhere. `app:view-bounds` exists so that failure is observable instead of silent.

### The address is yours to change

Every provider is a row in 设置 · 模型 with an address and an on/off switch. Sites move, people run
regional mirrors, and an address baked into the bundle turns a working channel into a dead one with
no way back except a new release — so the shipped defaults live in `shared/sources.ts` and the user's
edits live in `userData/sources.json`, merged by one pure function.

Two rules are enforced in the main process rather than the renderer: an address has to be `https`,
and **at least one source has to stay on** — the agent needs somewhere to ask. Editing an address
reloads the same view rather than rebuilding it, because the login belongs to the source id, not to
the URL. A source that is off is not a channel: it disappears from the rail and from the readiness
count in the same step.

### How competing plans are handled

A single reply can contain several candidate plans. Today:

- **Exact duplicates** are tolerated and collapsed to one.
- **Mutually conflicting plans** are rejected, with the conflict count reported — the tool does not
  guess which one you meant.
- **Across rounds**, every plan is persisted with a content hash and stays approvable for 10 minutes,
  so history shows exactly what was approved at the time.

Actually *fusing* plans — deduplicating equivalent steps, detecting write-path collisions, ranking
by evidence — is the next milestone, not a finished feature.

## Security model

This is not a tool that trusts model output. The boundaries are explicit:

| Boundary | Measure |
| --- | --- |
| Web text | Treated as untrusted input; parsed as JSON only, never executed as code or commands |
| Renderer | No Node integration, `contextIsolation`, sandbox; IPC accepts the main frame only |
| Embedded page | One `WebContentsView` per source, each with its own persistent partition; all permission requests denied; host allow-list enforced on navigate, redirect and `window.open` |
| Execution process | Separate `UtilityProcess`; authorization re-checked before every step |
| Tool surface | 27 allow-listed tools: file read/write/stat/tree/search/find/image/edit/move/copy/trash-based remove, fixed test commands, tiered `shell.run` with background jobs, screen capture, app launch, clipboard, notifications, system info, process list/kill, and `web.fetch`. No upload. Shell is allow-listed read/build only under `workspace-write`; `danger-full-access` gives a real shell but still blocks unrecoverable operations |
| Approval | Every plan needs a human click; grants expire in 30 minutes, plans in 10 |

Details in [`SECURITY.md`](desktop-agent-macos/SECURITY.md).

## Quick start

Requirements: macOS (Apple Silicon), Node.js ≥ 22.12, Electron 45.

```bash
cd desktop-agent-macos
npm install --no-audit --no-fund
npm run typecheck
npm test          # 154 offline assertions, see Tests below
npm run dev
```

Once running, sign in to the AI page in the right-hand pane, type a goal in the bottom input,
pick a workspace, and approve the plan when it appears.

In development the app presents as **ThinkFusion**, not "Electron": macOS takes the Dock and
menu-bar label from the bundle, so `scripts/rename-dev-app.mjs` (run by `predev` and
`prestart:debug`) renames the Electron bundle and its executable, sets `CFBundleExecutable` /
the two name keys / `CFBundleIdentifier`, and rewrites `node_modules/electron/path.txt` to
match. Renaming only the plist keys is not enough — a process started from a shell has no
LaunchServices registration, so the Dock falls back to the executable's name on disk. The
packaged build gets its name from `build.productName` instead.

The icon is drawn by `scripts/make-icon.mjs` into `resources/icon.png`, which `iconutil`
turns into `resources/icon.icns` (sizes are listed in the script header). The packaged build
picks it up from `build.mac.icon`; for development the rename script copies it into the
Electron bundle and points `CFBundleIconFile` at it, because a runtime `app.dock.setIcon()`
does not survive a relaunch and never reaches a pinned Dock tile.

Live checks (app already running and signed in):

```bash
npm run start:debug                     # start with a CDP port
npm run check:pane                      # page status bar, 放大 / 吸附回来, 收起（在轨道顶部）, 更新样式
npm run check:sources                   # the rail really switches pages
npm run check:settings                  # the account row, 设置, editable name/addresses, on/off
npm run check:layout                    # split alignment + app column geometry
npm run check:drag                      # full drag interaction
npm run check:new-task                  # "new task" gives visible feedback
npm run check:conversation              # channel readiness and routing (sends nothing)
npm run e2e:live -- <workspace-dir>     # a real task through the whole chain
```

## Tests

- **Offline**: `npm test` runs every sub-script in `package.json` (protocol, adapter, state
  machine, debate, evidence packs, code intelligence). CI runs them on every push — see
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
- **Live checks**: these need a running app and signed-in pages, so they are run by hand; the
  scripts read real state over CDP instead of pixels. See
  [`TEST_PLAN.md`](desktop-agent-macos/docs/TEST_PLAN.md).
- What these tests **cannot** prove is written down in `TEST_PLAN.md` — that list is part of the
  deliverable.

## Repository layout

```
desktop-agent-macos/   Electron app: main / preload / renderer / isolated runtime
  src/main/            tasks, storage, orchestration, window split
    master-agent.ts    who joins a round, and when the round is over
    agents/            participants: SubAgent interface, ProviderSubAgent, registry
    adapters/browser/  the page driver and the adapter that wraps it (no site constants)
    adapters/providers/  one file per AI site: selectors + hosts
  src/agent/           isolated runtime: plan validation, tool execution, result verification
  src/renderer/        React three-pane UI
  src/shared/          protocol, IPC contracts, split geometry (shared by main and renderer)
  scripts/             offline tests + live checks (scripts/lib/cdp.mjs is the shared base)
packages/              reusable model-channel package (zero dependencies, Electron-free)
docs/                  product positioning, architecture, specs, ADRs, document index
scripts/               versioning infrastructure (hooks, release scripts)
```

Adding an AI site is one file in `adapters/providers/` (selectors + hosts) plus one line in its
`index.ts`. A participant is not a page driver: `ProviderSubAgent` owns identity, session and
health, `BrowserAdapter` owns the DOM, and the Master Agent owns the budget for a round.

The multi-round debate engine is implemented in `src/main/debate/` (claims, disputes,
challenges, revisions, argument graph, three independent judges, evidence from page citations,
six collaboration strategies). Web channels receive only the user's original question — no
`system` prompt and no other participant's answer. For configuration, migration, tests and
operations see [`DEBATE_RUNBOOK.md`](docs/spec/DEBATE_RUNBOOK.md); the 15 acceptance
criteria are tracked in
[`DEBATE_ENGINE_TASK_V1.0.md`](docs/spec/DEBATE_ENGINE_TASK_V1.0.md).

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | Positioning, three workspaces, principles, success criteria |
| [`docs/architecture/COLLABORATION_ARCHITECTURE.md`](docs/architecture/COLLABORATION_ARCHITECTURE.md) | Collaboration engine, task lifecycle, scheduling, evidence contracts |
| [`docs/architecture/ENGINEERING_WORKSPACE.md`](docs/architecture/ENGINEERING_WORKSPACE.md) | Engineering workspace, Agentic Search, CLI collaboration, safety |
| [`docs/architecture/MIGRATION_PLAN.md`](docs/architecture/MIGRATION_PLAN.md) | How debate / evidence / engineering code migrates |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Five layers, three protocols, two main chains |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | P0–P5: where we are, what is next, how completion is judged |
| [`docs/README.md`](docs/README.md) | Full index: design, specs, ADRs, testing, app-level docs |
| [`PROTOCOL.md`](desktop-agent-macos/docs/PROTOCOL.md) | Protocol vocabulary, three-stage parsing, echo stripping, reply attribution |
| [`IPC.md`](desktop-agent-macos/docs/IPC.md) | Channel list, trust checks, why some arguments are literals |
| [`TEST_PLAN.md`](desktop-agent-macos/docs/TEST_PLAN.md) | What offline tests cover, what live checks assert, what neither can prove |

## Contributing

Run `./scripts/git-setup.sh` once after cloning to enable the commit-convention hooks and aliases;
conventions are in [`docs/git-workflow.md`](docs/git-workflow.md).

## Roadmap

The product direction is frozen as a multi-model collaborative intelligence work platform: rebuild
the collaboration engine and task model first (P0), make dynamic collaboration work (P1), then add
knowledge learning (P2), the engineering workspace (P3), evidence and quality (P4), and channels and
models (P5). Debate is no longer the main line; it is one on-demand behaviour inside P1.
Completion criteria are in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## License

MIT
