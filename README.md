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

## What actually works today

The capabilities above describe what the platform is *for*. Here is what the code currently does,
stated plainly — a README that promises more than the repository delivers is just marketing:

| Capability | Status |
| --- | --- |
| Collect a viewpoint from one source | ✅ A web AI page in a real browser view — no API key needed |
| Turn that reply into a checkable plan | ✅ Strict schema; a plan that fails validation is rejected outright, not "best-effort repaired" |
| Collect from multiple sources | ⏳ The channel layer is decoupled from Electron and ready, but only one channel is wired |
| Perspective analysis / cross-challenge | ⏳ Not yet. Conflicts are reported, not interrogated |
| Knowledge synthesis | ⏳ Not yet. Competing plans are never merged or voted on |
| Knowledge indexing | ⏳ Not yet. Task history is stored, but nothing is indexed for retrieval |
| Iterative refinement | ✅ Execution reports are fed back into the page, round after round, until the task completes |

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
| Embedded page | Separate `WebContentsView`, separate partition, all permission requests denied, target site only |
| Execution process | Separate `UtilityProcess`; authorization re-checked before every step |
| Tool surface | Whitelist: list directory, read file, create directory, exclusive file create. No shell, no delete, no overwrite |
| Approval | Every plan needs a human click; grants expire in 30 minutes, plans in 10 |

Details in [`SECURITY.md`](desktop-agent-macos/SECURITY.md).

## Quick start

Requirements: macOS (Apple Silicon), Node.js ≥ 22.12, Electron 45.

```bash
cd desktop-agent-macos
npm install --no-audit --no-fund
npm run typecheck
npm test          # protocol 24 + adapter 27 + state machine 8
npm run dev
```

Once running, sign in to the AI page in the right-hand pane, type a goal in the bottom input,
pick a workspace, and approve the plan when it appears.

Live checks (app already running and signed in):

```bash
npm run start:debug                     # start with a CDP port
npm run check:layout                    # split alignment + app column geometry
npm run check:drag                      # full drag interaction
npm run check:new-task                  # "new task" gives visible feedback
npm run e2e:live -- <workspace-dir>     # a real task through the whole chain
```

## Tests

- **Offline, 59 assertions**: protocol 24, page-channel timing 27, state machine 8.
  CI runs these on every push — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
- **Live, 50 assertions**: split layout 15, app column 9, drag 16, new-task feedback 10. These
  need a running app and a signed-in page, so they are run by hand; the scripts read real state
  over CDP instead of pixels.
- What these tests **cannot** prove is written down in
  [`TEST_PLAN.md`](desktop-agent-macos/docs/TEST_PLAN.md) — that list is part of the deliverable.

## Repository layout

```
desktop-agent-macos/   Electron app: main / preload / renderer / isolated runtime
  src/main/            tasks, storage, web adapter, orchestration, window split
  src/agent/           isolated runtime: plan validation, tool execution, result verification
  src/renderer/        React three-pane UI
  src/shared/          protocol, IPC contracts, split geometry (shared by main and renderer)
  scripts/             offline tests + live checks (scripts/lib/cdp.mjs is the shared base)
packages/              reusable model-channel package (zero dependencies, Electron-free)
docs/                  repository workflow docs (commit conventions, branching, release)
scripts/               versioning infrastructure (hooks, release scripts)
```

## Documentation

| Document | Contents |
| --- | --- |
| [`PROTOCOL.md`](desktop-agent-macos/docs/PROTOCOL.md) | Protocol vocabulary, three-stage parsing, echo stripping, reply attribution |
| [`IPC.md`](desktop-agent-macos/docs/IPC.md) | Channel list, trust checks, why some arguments are literals |
| [`TEST_PLAN.md`](desktop-agent-macos/docs/TEST_PLAN.md) | What offline tests cover, what live checks assert, what neither can prove |
| [`HARNESS_BASELINE.md`](desktop-agent-macos/docs/HARNESS_BASELINE.md) | What design was borrowed, what is explicitly not depended on |

## Contributing

Run `./scripts/git-setup.sh` once after cloning to enable the commit-convention hooks and aliases;
conventions are in [`docs/git-workflow.md`](docs/git-workflow.md).

## Roadmap

- [ ] **Wire a second source** — the channel layer is already decoupled from Electron
- [ ] **Cross-challenge** — feed A's plan to B and have B find the holes, instead of answering independently
- [ ] **Plan fusion** — deduplicate steps, detect write-path collisions, rank by evidence
- [ ] Knowledge indexing and retrieval over accumulated tasks
- [ ] Crash recovery: interrupted execution lands in a review state instead of sticking at `executing`
- [ ] Per-step approval: stop before a dangerous step even after the plan is approved
- [ ] Packaging, signing, notarization

## License

MIT
