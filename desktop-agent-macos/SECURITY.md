# Security model and limitations

## Trust boundaries

1. DeepSeek page text is untrusted input. It is parsed as a strict JSON plan; it is never evaluated as JavaScript or shell.
2. The renderer has no Node integration and uses context-isolated preload IPC. Main-process IPC accepts calls only from the trusted main frame.
3. The embedded web workspace is restricted to `https://chat.deepseek.com`; popups and navigation to other origins are denied.
4. Agent execution is separated into an Electron UtilityProcess. The Runtime validates a strict task grant again before executing each step.
5. Tool names are allow-listed. This build has bounded directory listing, file reading, recursive tree listing, content search, filename glob search, directory creation, exclusive file creation, hash-checked file replacement, a fixed set of test commands, a permission-tiered shell, screen capture, and application launch. It has **no delete tool, no upload tool, and no way for the model to name a shell command outside the documented policy** (see "Local harness tools" below). Page text still never becomes a command: the model can only emit a `shell.run` step with a `command` string, the Runtime re-validates that string against the preset policy before spawning anything, and the user approves the whole plan first.
6. Every permission preset requires a user confirmation before a plan starts. A grant expires after 30 minutes; staged plans expire after 10 minutes.

## Permission presets

- `read-only`: `fs.list`, `fs.readFile`, `fs.tree`, `fs.search`, `fs.find` only. File reads are capped at 256 KiB. Every command, capture, launch, write and `test.run` step is rejected twice: once by `assertGrant` (tool not in `READ_ONLY_TOOLS`) and once by the tool itself.
- `workspace-write`: all eleven tools inside the selected directory; traversal and observed symlink components are rejected. New files use exclusive creation; replacing an existing file requires the exact sha256 returned by the earlier `fs.readFile`, and lands via a same-directory temp file + atomic rename. `shell.run` is restricted to an allow-list of read/build commands with **no shell composition characters** (`;`, `&`, `|`, `>`, `<`, backticks, `$(`), so `ls $(rm -rf .)` cannot borrow the prefix of a permitted command. `app.open` can only launch a short list of common GUI apps, and only open files inside the workspace.
- `danger-full-access`: removes the app-level workspace path boundary and runs `shell.run` through a real `/bin/sh -c`. It still refuses unrecoverable operations (`sudo`, `mkfs`, `dd of=/dev/…`, `rm -rf /` or `~`, fork bombs, `shutdown`/`reboot`, `killall`, `chmod -R 777 /`). It does not elevate the process, bypass POSIX permissions, or grant macOS TCC permissions. The user must still confirm the plan.

## V2.1 local harness tools

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

## V2.1 test execution

`test.run` maps a small fixed set of command strings (`npm test`, `npm run typecheck`, `npm run build`, `npm run build:agent`, `npm run test:protocol`) to hard-coded argv arrays. It runs with `shell: false`, no user-supplied arguments, a minimal environment (no API keys), a 120-second limit, and capped output. The real exit code, stdout/stderr, duration and working directory go into the execution report; a non-zero exit marks the step failed. The model never supplies a command line.

## V2.1 engineering scans

`scanProject` (analysis chain) and `fs.tree` / `fs.search` (runtime) read only text files inside the authorized root. They skip `node_modules`, `.git`, build outputs, symlinks, binaries, `.env`, key/certificate/credential-like names, and files above the size cap. Scan depth, file count, total bytes and excerpt length are bounded. Files found in the project (including README text) are data, never instructions that can raise permissions.

## macOS privacy permissions

Accessibility, Screen Recording, Automation, and Full Disk Access are separate macOS TCC permissions. This application does not silently grant or bypass them. The Accessibility helper only reads the frontmost app and its accessibility tree. `screen.capture` requires Screen Recording; when it is missing, the step fails with the System Settings path instead of returning a blank or wallpaper-only image.

## Embedded page isolation

The DeepSeek page runs in its own `WebContentsView` with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, a dedicated `persist:deepseek` partition, permission handlers that deny every request, and navigation restricted to `https://chat.deepseek.com`. It has no preload script, so it has no access to `window.agentAPI` even by injection — it is a different webContents from the app renderer, and `trustedUiSender` would reject it anyway.

Two consequences worth stating plainly:

- The page is a **native view laid over the window**, not an iframe. It is not subject to the app's CSP, and the app cannot read or style it. Everything the app knows about it comes from `executeJavaScript` probes in the main process.
- Anything the page renders is untrusted. The app never executes page text; it extracts JSON, validates it against a strict schema, and shows the plan to the user before anything runs.

The split width is proposed by the renderer but clamped in the main process (`computeSplit`), so a compromised renderer cannot make the page view spill past the window or squeeze the app column. While a divider drag is in progress the page view is parked outside the window; that is a layout mechanism, not an isolation boundary.

## Known limitations — do not treat as a security certification

- Electron UtilityProcess is process separation, not an OS sandbox. The Agent Runtime is not yet launched under a hardened macOS Seatbelt profile or isolated VM.
- Filesystem path validation plus `O_NOFOLLOW` reduces common traversal and symlink attacks but does not eliminate all concurrent TOCTOU races in a general Node filesystem implementation.
- Approval is at whole-plan level, not per-tool/per-step. There is no one-shot escalation workflow. V2.1's independent review is advisory: a "needs fix" verdict never starts a new plan or executes anything on its own.
- No signed append-only audit log, notarization, code-signing configuration, independent penetration test, or physical-device security verification is included.
- The embedded DeepSeek DOM adapter is heuristic and can break when the website changes.

Use a dedicated working directory with no secrets for testing. Do not grant `danger-full-access` to untrusted plans. Before production distribution, implement and verify OS-level sandboxing, signed audit records, per-action approvals, code signing/notarization, and independent security review.

## Human-verification challenges (2026-11-07)

When a site serves a human-verification challenge (click-the-image, slider), the driver
recognises it from profile-declared phrases (`ProviderProfile.challengeText`) and stops:
`getStatus()` reports the page as not ready with an explanation, and `sendMessage()`
throws before typing or clicking.

The app **never attempts to solve the challenge**. Recognition exists only so the user is
told what happened and where to click. Clicking through a challenge would be both
unreliable and outside what an automation should do with someone's account.
