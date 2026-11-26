# Security model and limitations

## Trust boundaries

1. Model and web-page output is untrusted input. Only Engineering plan blocks are parsed against strict schemas; ordinary answers remain text. No model text is evaluated as JavaScript or shell.
2. The renderer has no Node integration and uses context-isolated preload IPC. Main-process IPC accepts calls only from the trusted main frame.
3. Each embedded Web source is restricted to that source's configured host allow-list; permission requests and unapproved popups/navigation are denied.
4. Agent execution is separated into an Electron UtilityProcess. The Runtime validates a strict task grant again before executing each step.
5. Tool names are allow-listed by the shared tool contract and Runtime registry. The surface includes file, command, desktop, collaboration and network capabilities; the exact set changes with releases. There is **no general upload tool**. The authoritative tool names and permission policy are in `src/shared/contracts.ts`, `src/agent/policy.ts` and the capability registry; do not rely on a copied numeric count. Model output becomes a step only after plan parsing, schema/grant validation and the selected approval policy.
6. `read-only` and `workspace-write` require a user confirmation before a plan starts. `danger-full-access` does **not**: that preset already means "every operation on this machine is allowed", so the plan is approved automatically once the optional plan review finishes, and steps are not prompted one by one (`stepApproval: 'off'`). The trade-off is deliberate and visible in the UI (`计划自动批准并执行，步骤不再逐次询问`); use that preset only for plans you would approve wholesale. A grant expires after 30 minutes; staged plans expire after 10 minutes.

## Permission presets

- `read-only`: `fs.list`, `fs.readFile`, `fs.stat`, `fs.readImage`, `fs.tree`, `fs.search`, `fs.find`, `system.info`, `process.list`, `clipboard.read`. File reads are capped at 256 KiB; images at 1.5 MiB. Every command, capture, launch, write, edit, move, copy, remove, notification, clipboard write and `web.fetch` step is rejected twice: once by `assertGrant` (tool not in `READ_ONLY_TOOLS`) and once by the tool itself.
- `workspace-write`: the tools allowed by the workspace-write grant inside the selected directory; traversal and observed symlink components are rejected. New files use exclusive creation; replacing an existing file requires the exact sha256 returned by the earlier `fs.readFile`, and `fs.edit` requires the literal to appear exactly once unless `replaceAll` is set. `fs.remove` moves the target to `~/.Trash` (rename, EXDEV falls back to copy + remove) — it never unlinks. `shell.run` is restricted to an allow-list of read/build commands with **no shell composition characters** (`;`, `&`, `|`, `>`, `<`, backticks, `$(`), so `ls $(rm -rf .)` cannot borrow the prefix of a permitted command. `app.open` can only launch a short list of common GUI apps, and only open files inside the workspace. `process.kill` is refused: use `job.kill` on a job this app started.
- `danger-full-access`: removes the app-level workspace path boundary, runs `shell.run` through a real `/bin/sh -c`, allows `process.kill` and `fs.remove({ permanent: true })`. It still refuses unrecoverable operations (`sudo`, `mkfs`, `dd of=/dev/…`, `rm -rf /` or `~`, fork bombs, `shutdown`/`reboot`, `killall`, `chmod -R 777 /`). It does not elevate the process, bypass POSIX permissions, or grant macOS TCC permissions. **This is the only preset that runs a plan without a confirmation click and without per-step prompts** (`shared/approval.ts`): the remaining guards are the allow-list, `ALWAYS_FORBIDDEN`, the Runtime's per-step grant validation, `read-only`-style path checks removed only where this preset says so, and the 30-minute grant expiry. Plan review (when enabled) still runs before execution.

## Built-in tool security

`shell.run`, `screen.capture` and `app.open` exist because "read a file" is not enough to
be useful on a real machine. They are the largest attack surface in the app, so their
rules are stated here rather than only in code:

- **`shell.run`** — argv is always `/bin/sh -c <command>`, in an authorized `cwd`, with a
  minimal environment (no API keys) and a 300 s ceiling; the whole process group is killed
  on timeout and output is capped at 64 KiB. The command string is first checked against
  `ALWAYS_FORBIDDEN` (unrecoverable operations) in **every** preset, then:
  `read-only` rejects outright; `workspace-write` requires an allow-list prefix and rejects
  shell composition characters; `danger-full-access` runs it. A non-zero exit code is
  reported as a failed step, never as success.
- **`screen.capture`** — writes a PNG through `/usr/sbin/screencapture`, then verifies the
  file exists, is non-empty, and has a valid PNG header before reporting width/height/sha256.
  A missing Screen Recording TCC grant produces a real error with the fix path, not a fake
  success. Default output goes to `~/Library/Application Support/ThinkFusion/captures`.
- **`app.open`** — `/usr/bin/open` only, no shell. In `workspace-write` the app must be on a
  short GUI allow-list and any path must resolve inside the workspace; terminal-style apps
  are deliberately excluded because launching one would bypass the `shell.run` policy. The
  result includes whether the process is actually running (`pgrep`), so "the command exited
  zero" is not mistaken for "the app opened".

## Fixed test execution

`test.run` maps a small fixed set of command strings (`npm test`, `npm run typecheck`, `npm run build`, `npm run build:agent`, `npm run test:protocol`) to hard-coded argv arrays. It runs with `shell: false`, no user-supplied arguments, a minimal environment (no API keys), a 120-second limit, and capped output. The real exit code, stdout/stderr, duration and working directory go into the execution report; a non-zero exit marks the step failed. The model never supplies a command line.

## Engineering analysis and scans

`scanProject` (analysis chain) and `fs.tree` / `fs.search` (runtime) read only text files inside the authorized root. They skip `node_modules`, `.git`, build outputs, symlinks, binaries, `.env`, key/certificate/credential-like names, and files above the size cap. Scan depth, file count, total bytes and excerpt length are bounded. Files found in the project (including README text) are data, never instructions that can raise permissions.

## macOS privacy permissions

Accessibility, Screen Recording, Automation, and Full Disk Access are separate macOS TCC permissions. This application does not silently grant or bypass them. The Accessibility helper can read the frontmost app and its accessibility tree, and — only after a task grant and a fresh snapshot — perform an allow-listed press, value write, key, scroll, drag, or focus. It still has no shell. Coordinate actions are refused when the snapshot is missing, expired, or the frontmost app changed. `screen.capture` and `computer.screenshot` require Screen Recording; when it is missing, the step fails with the System Settings path instead of returning a blank or wallpaper-only image.

## Embedded page isolation

Each configured Web provider runs in its own `WebContentsView` with sandboxing, context isolation and Node integration disabled; its persistent partition is keyed by source id, permission handlers deny requests, and navigation is restricted to that source's host allow-list. It has no preload script, so it has no access to `window.agentAPI` even by injection — it is a different webContents from the app renderer, and `trustedUiSender` would reject it anyway.

Two consequences worth stating plainly:

- The page is a **native view laid over the window**, not an iframe. It is not subject to the app's CSP, and the app cannot read or style it. Everything the app knows about it comes from `executeJavaScript` probes in the main process.
- Anything a Web source renders is untrusted. The app never executes page text; it extracts JSON, validates it against a strict schema, and shows the plan to the user before anything runs.

The split width is proposed by the renderer but clamped in the main process (`computeSplit`), so a compromised renderer cannot make the page view spill past the window or squeeze the app column. While a divider drag is in progress the page view is parked outside the window; that is a layout mechanism, not an isolation boundary.

## Known limitations — do not treat as a security certification

- Electron UtilityProcess is process separation, not an OS sandbox. The Agent Runtime is not yet launched under a hardened macOS Seatbelt profile or isolated VM.
- Filesystem path validation plus `O_NOFOLLOW` reduces common traversal and symlink attacks but does not eliminate all concurrent TOCTOU races in a general Node filesystem implementation.
- Plan approval and step approval are separate gates. The exact policy is selected per task and preset; `danger-full-access` is explicitly broader and may auto-approve the plan with step approval disabled. Independent review is advisory: a "needs fix" verdict never starts a new plan or executes anything on its own.
- No signed append-only audit log, notarization, code-signing configuration, independent penetration test, or physical-device security verification is included.
- Web-source DOM adapters are heuristic and can break when a website changes; each source has its own profile and host allow-list.

Use a dedicated working directory with no secrets for testing. Do not grant `danger-full-access` to untrusted plans. Before production distribution, implement and verify OS-level sandboxing, signed audit records, per-action approvals, code signing/notarization, and independent security review.

## Human-verification challenges (2026-11-07)

When a site serves a human-verification challenge (click-the-image, slider), the driver
recognises it from profile-declared phrases (`ProviderProfile.challengeText`) and stops:
`getStatus()` reports the page as not ready with an explanation, and `sendMessage()`
throws before typing or clicking.

The app **never attempts to solve the challenge**. Recognition exists only so the user is
told what happened and where to click. Clicking through a challenge would be both
unreliable and outside what an automation should do with someone's account.
