# ThinkFusion AI

**Many Minds. One Better Answer.**

ThinkFusion AI is an open-source collective intelligence platform designed to bring together
ideas, knowledge, and perspectives from multiple AI models and web sources to produce deeper
insights and better answers.

Instead of relying on a single AI model or information source, ThinkFusion AI collects diverse
viewpoints, analyzes agreements and disagreements, identifies missing information, and
synthesizes them into a unified, well-reasoned result.

**中文文档：[README.zh-CN.md](README.zh-CN.md)**

---

## Core Capabilities

- **Multi-AI Aggregation** — Gather responses and insights from multiple AI models.
- **Web Intelligence** — Extract and summarize information from web pages and online sources.
- **Perspective Analysis** — Compare different viewpoints, identify consensus, and detect contradictions.
- **Knowledge Synthesis** — Combine complementary ideas into a more comprehensive answer.
- **Critical Reasoning** — Challenge assumptions, identify gaps, and improve the quality of conclusions.
- **Knowledge Indexing** — Organize, index, and retrieve accumulated knowledge.
- **Iterative Refinement** — Continuously refine conclusions through additional research and analysis.

## Vision

Turn fragmented information and diverse perspectives into collective intelligence.
ThinkFusion AI aims to make the combined intelligence of multiple AI systems and knowledge
sources more useful than any single response.

**Many Minds. One Better Answer.**

---

## What this is, precisely

A question goes in. ThinkFusion has several AIs answer it **independently**, isolates the claims
they actually disagree on, runs a targeted debate, checks those claims against evidence, and
returns a conclusion that keeps its disagreements and uncertainty. **Only when the work actually
has to touch local files** does it produce an approvable execution plan.

> Verifiable multi-model deliberation + **Optional** Local Agent Runtime

The `Optional` is still the load-bearing word. The local runtime is a subsystem, not the product:
without it, Q&A, debate and conclusions still work.

The target shape is in [docs/PRODUCT.md](docs/PRODUCT.md), the architecture in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the version roadmap in
[docs/ROADMAP.md](docs/ROADMAP.md), and every document in [docs/README.md](docs/README.md).

## What actually works today

The capabilities above describe what the platform is *for*. Here is what the code currently does,
stated plainly — a README that promises more than the repository delivers is just marketing:

| Capability | Status |
| --- | --- |
| Independent answers from several channels | ✅ Web AI pages, no API key; the question goes out verbatim, channels cannot see each other |
| Several pages at once | ✅ Right-edge rail; per-page cookies and host allow-list |
| Claim extraction / dispute detection | ✅ Debate engine, pointing at the two specific sentences |
| Targeted debate and revision | ✅ Challenge, counter-example, revision; six collaboration strategies |
| Judges and direction verdicts | ✅ supports / contradicts / context, with confidence and limitations |
| Evidence packs and content hashes | ✅ Evidence and execution attestations enter the Item Hash; tampering is detectable |
| Real execution-evidence producer | ✅ Code ready; not yet wired into the debate orchestrator |
| Knowledge-learning space | 🟡 Multi-round research and page-body extraction work; indexing and cross-session reuse land in 0.4 |
| Engineering space | ✅ Disk-backed evidence, plan review, approved execution; code intelligence V3.2 |
| Local execution runtime | ✅ 27 allow-listed tools; approval, path checks, sha256 re-verify |
| External CLI agents | ✅ Qoder / Claude as channels |
| Knowledge indexing / cross-session evidence | ⏳ 0.4 |
| External fact verification | ⏳ 0.3.3 |

Stated as one line: **the debate and evidence chain already run; what is missing is putting the
verdicts in front of the user (0.3.x) and indexing evidence across sessions (0.4).**

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
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | Positioning, principles, success criteria |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Five layers, three protocols, two main chains |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Where we are, what is next, how completion is judged |
| [`docs/README.md`](docs/README.md) | Full index: specs, ADRs, testing, app-level docs |
| [`PROTOCOL.md`](desktop-agent-macos/docs/PROTOCOL.md) | Protocol vocabulary, three-stage parsing, echo stripping, reply attribution |
| [`IPC.md`](desktop-agent-macos/docs/IPC.md) | Channel list, trust checks, why some arguments are literals |
| [`TEST_PLAN.md`](desktop-agent-macos/docs/TEST_PLAN.md) | What offline tests cover, what live checks assert, what neither can prove |

## Contributing

Run `./scripts/git-setup.sh` once after cloning to enable the commit-convention hooks and aliases;
conventions are in [`docs/git-workflow.md`](docs/git-workflow.md).

## Roadmap

0.3.x is about **verifiability**: put verdicts, evidence and execution attestations in front of
the user so every conclusion can be traced to its evidence. After that: knowledge learning
(0.4: indexing, reuse, knowledge maps), engineering capability (0.5: code intelligence, review,
verifiable changes) and channel/model expansion (0.6). Completion criteria are in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## License

MIT
