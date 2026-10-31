# v0.6.0 Delivery Status

This file records what is actually implemented and what is not verified. Nothing
here should be read as a claim of production readiness.

## Implemented and verified in source

| Area | Status | Where |
| --- | --- | --- |
| Task / Round / Plan / Report data model | Done | `src/shared/contracts.ts` |
| Explicit task state machine with illegal-transition rejection | Done | `src/main/task-manager.ts` |
| Persistence of tasks, rounds, plans, reports, events | Done (JSON journal) | `src/main/store.ts` |
| Closed loop: prompt → send → capture → parse → approve → execute → report → next round | Done, **verified live** | `src/main/orchestrator.ts` |
| Auto-send to DeepSeek with pre-send snapshot | Done, verified live | `src/main/deepseek-adapter.ts` |
| Answer attribution (bubble-first, protocol marker, completeness, stability) | Done, verified live | `src/main/deepseek-adapter.ts` |
| Structured protocol parsing without fences, with brace scanning | Done | `src/shared/protocol.ts` |
| Echo stripping by contiguous region | Done | `src/shared/protocol.ts` |
| Zod validation of every IPC input | Done | `src/shared/schemas.ts`, `src/main/index.ts` |
| Plan content hash + 10 min expiry + single approval | Done | `src/main/orchestrator.ts` |
| Three permission presets enforced in two layers | Done | `src/agent/policy.ts` + `src/main/orchestrator.ts` |
| Serial step execution with structured StepResult | Done, verified live | `src/agent/index.ts` |
| Write verification by sha256 re-read | Done | `src/agent/verify.ts` |
| Auto report send-back + next round | Done, verified live | `src/main/orchestrator.ts` |
| Clarification round (`clarification_required`) | Done, verified live | `src/main/orchestrator.ts` |
| `awaiting_clarification` as its own state | Done, verified live | `src/main/task-manager.ts`, `src/renderer/src/App.tsx` |
| Chronological execution log, tail-following | Done, verified live | `src/renderer/src/components/ExecutionLog.tsx` |
| Task cancel (runtime flag + wait abort) | Done | `src/main/orchestrator.ts`, `src/agent/index.ts` |
| Serialised page access across concurrent rounds | Done | `src/main/orchestrator.ts` |
| Task history, replay of persisted events, delete local record | Done | `src/main/index.ts`, `src/renderer/src/App.tsx` |
| Three-pane UI (history / workbench / embedded DeepSeek) | Done, verified live | `src/renderer/src/` |
| Dockable composer pinned to the bottom | Done, verified live | `src/renderer/src/App.tsx` |
| Draggable split with clamped native view bounds | Done, verified live | `src/shared/layout.ts`, `src/main/index.ts` |
| Page diagnostics panel (selector hit counts, view bounds) | Done | `src/renderer/src/components/DiagnosticsPanel.tsx` |

## Verified in this environment

Environment: macOS arm64, Electron 45.1.0, 1560×928 window, embedded page logged
in to DeepSeek.

- `npm run typecheck` — clean (main/preload, agent runtime, renderer).
- `npm test` — 24 protocol tests, 27 adapter tests, 8 state-machine tests, all passing.
- `npm run build` — `electron-vite build` + agent runtime compile succeed.
- `npm run check:layout` — 15 + 9 live layout assertions passing.
- `npm run check:drag` — 16 live drag assertions passing.
- `npm run e2e:live` — **the full loop reaches `completed`** against the real
  DeepSeek session: submit → plan → approve → execute `fs.list` → structured
  report → next round → `task_complete`.

The last end-to-end run completed in **two rounds with the first plan accepted**.
Before the prompt was taught that `args.path` must be relative to the workspace,
every task burned a round on `GRANT_INVALID` and only succeeded on the retry.

## NOT verified

- **A real mouse drag.** The live drag check drives synthetic pointer events,
  which bypass macOS native hit-testing. The gesture is designed around that
  (`app:drag-page` parks the native view outside the window for the duration),
  but the gesture itself is not covered by a test.
- **Rendering, as pixels.** Screenshots are blocked in this environment, so every
  visual claim here is a measured assertion (positions, widths, visibility), not
  a looked-at screen. `check-split.mjs` skips the page's `innerWidth` assertion
  when the window is occluded, because Chromium does not relayout hidden pages.
- **Crash recovery.** A task interrupted mid-execution stays in `executing` and
  needs manual handling; there is no `NEEDS_RECONCILIATION` flow yet.
- **Per-tool approval UI.** Approval is whole-plan only.
- **Audit chain / signed logs.** Events are persisted, not tamper-evident.
- **macOS Seatbelt profile** on the runtime process.
- **Packaging, signing, notarization.** `npm run package:mac` has not been run.
- **Accessibility helper** beyond reading the frontmost app's tree; requires TCC
  permission and is not in the automated checks.

## Deliberate deviations from the v0.6.0 spec

| Spec item | Deviation | Why |
| --- | --- | --- |
| SQLite persistence (§15.1) | Atomic JSON journal | Avoids node-gyp / native addon install on Apple Silicon; single-writer local use only. Replace before high-volume use. |
| `planning → completed` | Added to the transition table | Needed for "planner says the task is already done" before any step ran; the orchestrator still checks for pending rounds first. |
| `roundId` required in plan | Required and validated | Spec §7.4 asks for it; a plan without a matching roundId is rejected rather than guessed. |
| Fixed split ratio | User-draggable split | The embedded page is a real web app laid out for a full window; how much room it gets is a judgement call, so it is a control. The clamp stays in the main process. |

## Next steps (in order)

1. Replace the JSON journal with SQLite once the loop is stable.
2. Add crash recovery with `RecoveryState` (§14.3).
3. Per-step approval, so a plan can be approved once and still stop before a
   destructive step.
4. Run `package:mac` and record signing / notarization results.
5. Watch the selectors: the probe reports hit counts per candidate, and any of
   them going to zero is the signal that DeepSeek changed its markup.
