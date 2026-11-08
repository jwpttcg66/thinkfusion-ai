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

A question or a task goes in. ThinkFusion decides what kind of thing it is, organises several AIs
and sources to think about it, cross-examines their answers, and synthesises something better than
any one reply. **Only when the work actually has to touch local files** does it produce an
approvable execution plan.

> AI Orchestrator + Multi-AI Collaboration + Knowledge Synthesis + **Optional** Local Agent Runtime

The `Optional` is the load-bearing word. The local Agent runtime is a subsystem, not the product —
and today the code has that backwards: every task is forced through a fixed "you are a planning
engine, emit `desktop-agent/v1` JSON" prompt, which leaves a research question with nowhere to land.

Three documents define the target, and they are written to be checked against the code rather than
skimmed:

| Document | What it settles |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | What the product is and is not; five task types; the principles that decide trade-offs |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The five layers, the `AiChannel` abstraction, three protocols, two state machines, the migration path |
| [docs/ROADMAP.md](docs/ROADMAP.md) | P0–P6 with completion criteria, not feature lists |

## What actually works today

The capabilities above describe what the platform is *for*. Here is what the code currently does,
stated plainly — a README that promises more than the repository delivers is just marketing:

| Capability | Status |
| --- | --- |
| Collect a viewpoint from one source | ✅ A web AI page in a real browser view — no API key needed |
| Turn that reply into a checkable plan | ✅ Strict schema; a plan that fails validation is rejected outright, not "best-effort repaired" |
| Keep several AI pages open at once | ✅ One rail of buttons on the right edge switches which page is on screen; each page keeps its own cookies and its own host allow-list |
| **Ask a question without producing a plan** | ✅ A question goes out as a question; the answer contains no protocol block |
| **Decide what kind of task this is** | ✅ Rule-based router: answer / research / compare / extract / workspace |
| Collect from multiple sources | ✅ Channel abstraction in place (DeepSeek + a ChatGPT profile), per-channel queue, global concurrency cap |
| Perspective analysis / cross-challenge | ✅ Rule-based v1: consensus, disputes, coverage gaps, single-source claims; unsegmentable text is labelled degraded |
| Knowledge synthesis | ⏳ Not yet. Competing plans are never merged or voted on |
| Knowledge indexing | ⏳ Not yet. Task history is stored, but nothing is indexed for retrieval |
| Iterative refinement | ✅ Execution reports are fed back into the page, round after round, until the task completes |

Stated as one line: **the execution subsystem is mature; orchestration and synthesis now have a first
version; indexing and autonomous multi-round research do not exist yet.**

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

- **Offline, 154 assertions**: protocol 24, page-channel timing 34, source config 24, display
  name 10, synthesis 16, selector repair 10, conversation runner 10, intent 9, page text 9,
  state machine 8. CI runs these on every push — see
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
- **Live, 236 assertions**: page pane 71, settings 74, sources 27, split layout 16, app column
  10, drag 16, conversation 12, new-task feedback 10. These need a running app and a signed-in
  page, so they are run by hand; the scripts read real state over CDP instead of pixels.
- What these tests **cannot** prove is written down in
  [`TEST_PLAN.md`](desktop-agent-macos/docs/TEST_PLAN.md) — that list is part of the deliverable.

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
docs/                  repository workflow docs (commit conventions, branching, release)
scripts/               versioning infrastructure (hooks, release scripts)
```

Adding an AI site is one file in `adapters/providers/` (selectors + hosts) plus one line in its
`index.ts`. A participant is not a page driver: `ProviderSubAgent` owns identity, session and
health, `BrowserAdapter` owns the DOM, and the Master Agent owns the budget for a round.

The multi-round debate engine is implemented in `src/main/debate/` (claims, disputes,
challenges, revisions, argument graph, three independent judges, evidence from page citations,
six collaboration strategies). Web channels receive only the user's original question — no
`system` prompt and no other participant's answer. For configuration, migration, tests and
operations see [`DEBATE_RUNBOOK.md`](docs/implementation/DEBATE_RUNBOOK.md); the 15 acceptance
criteria are tracked in
[`DEBATE_ACCEPTANCE.md`](docs/architecture/DEBATE_ACCEPTANCE.md).

## Documentation

| Document | Contents |
| --- | --- |
| [`PROTOCOL.md`](desktop-agent-macos/docs/PROTOCOL.md) | Protocol vocabulary, three-stage parsing, echo stripping, reply attribution |
| [`IPC.md`](desktop-agent-macos/docs/IPC.md) | Channel list, trust checks, why some arguments are literals |
| [`TEST_PLAN.md`](desktop-agent-macos/docs/TEST_PLAN.md) | What offline tests cover, what live checks assert, what neither can prove |
| [`HARNESS_BASELINE.md`](desktop-agent-macos/docs/HARNESS_BASELINE.md) | What design was borrowed, what is explicitly not depended on |
| [`DEBATE_RUNBOOK.md`](docs/implementation/DEBATE_RUNBOOK.md) | Debate engine: configuration, migration, test map, operations |
| [`DEBATE_ACCEPTANCE.md`](docs/architecture/DEBATE_ACCEPTANCE.md) | AC-01 ~ AC-15 status with evidence |

## Contributing

Run `./scripts/git-setup.sh` once after cloning to enable the commit-convention hooks and aliases;
conventions are in [`docs/git-workflow.md`](docs/git-workflow.md).

## Roadmap

- [ ] **Wire a second source** — the channel layer is already decoupled from Electron
- [x] **Cross-challenge** — the debate engine's challenge round feeds each participant the
      prior round and asks it to point at specific claims; web channels stay isolated (first round only)
- [x] **Plan fusion** — the lead agent produces a five-section synthesis (conclusion / agreement /
      disagreement / open questions / debate topics); evidence-ranked verdicts come from the three judges
- [ ] Knowledge indexing and retrieval over accumulated tasks
- [ ] Evidence de-duplication that reads page bodies, not just URLs (currently only URL/fingerprint)
- [ ] Fact-accuracy and calibration baselines (needs a human-labelled dataset)
- [ ] Crash recovery: interrupted execution lands in a review state instead of sticking at `executing`
- [ ] Per-step approval: stop before a dangerous step even after the plan is approved
- [ ] Packaging, signing, notarization

## License

MIT
