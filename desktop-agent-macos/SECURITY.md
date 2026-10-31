# Security model and limitations

## Trust boundaries

1. DeepSeek page text is untrusted input. It is parsed as a strict JSON plan; it is never evaluated as JavaScript or shell.
2. The renderer has no Node integration and uses context-isolated preload IPC. Main-process IPC accepts calls only from the trusted main frame.
3. The embedded web workspace is restricted to `https://chat.deepseek.com`; popups and navigation to other origins are denied.
4. Agent execution is separated into an Electron UtilityProcess. The Runtime validates a strict task grant again before executing each step.
5. Tool names are allow-listed. This build has bounded directory listing and file reading, directory creation, and exclusive file creation. It has no shell, process launch, delete, overwrite, or upload tool.
6. Every permission preset requires a user confirmation before a plan starts. A grant expires after 30 minutes; staged plans expire after 10 minutes.

## Permission presets

- `read-only`: `fs.list` and `fs.readFile` only. File reads are capped at 256 KiB.
- `workspace-write`: reads and writes are confined to the selected directory; traversal and observed symlink components are rejected. New files use exclusive creation and `O_NOFOLLOW` when supported.
- `danger-full-access`: removes the app-level workspace path boundary for the allow-listed filesystem tools. It does not elevate the process, bypass POSIX permissions, or grant macOS TCC permissions. The user must still confirm the plan.

## macOS privacy permissions

Accessibility, Screen Recording, Automation, and Full Disk Access are separate macOS TCC permissions. This application does not silently grant or bypass them. The current Accessibility helper only reads the frontmost app and its accessibility tree.

## Embedded page isolation

The DeepSeek page runs in its own `WebContentsView` with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, a dedicated `persist:deepseek` partition, permission handlers that deny every request, and navigation restricted to `https://chat.deepseek.com`. It has no preload script, so it has no access to `window.agentAPI` even by injection — it is a different webContents from the app renderer, and `trustedUiSender` would reject it anyway.

Two consequences worth stating plainly:

- The page is a **native view laid over the window**, not an iframe. It is not subject to the app's CSP, and the app cannot read or style it. Everything the app knows about it comes from `executeJavaScript` probes in the main process.
- Anything the page renders is untrusted. The app never executes page text; it extracts JSON, validates it against a strict schema, and shows the plan to the user before anything runs.

The split width is proposed by the renderer but clamped in the main process (`computeSplit`), so a compromised renderer cannot make the page view spill past the window or squeeze the app column. While a divider drag is in progress the page view is parked outside the window; that is a layout mechanism, not an isolation boundary.

## Known limitations — do not treat as a security certification

- Electron UtilityProcess is process separation, not an OS sandbox. The Agent Runtime is not yet launched under a hardened macOS Seatbelt profile or isolated VM.
- Filesystem path validation plus `O_NOFOLLOW` reduces common traversal and symlink attacks but does not eliminate all concurrent TOCTOU races in a general Node filesystem implementation.
- Approval is at whole-plan level, not per-tool/per-step. There is no one-shot escalation workflow.
- No signed append-only audit log, notarization, code-signing configuration, independent penetration test, or physical-device security verification is included.
- The embedded DeepSeek DOM adapter is heuristic and can break when the website changes.

Use a dedicated working directory with no secrets for testing. Do not grant `danger-full-access` to untrusted plans. Before production distribution, implement and verify OS-level sandboxing, signed audit records, per-action approvals, code signing/notarization, and independent security review.
