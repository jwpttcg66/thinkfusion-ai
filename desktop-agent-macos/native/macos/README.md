# macOS Accessibility bridge

`ax-bridge.swift` is a helper process used by the Computer Use capability. It reads the frontmost application/accessibility tree and exposes a constrained set of actions: `press`, `setValue`, `keypress`, `scroll`, `drag` and `focus`.

## Build

```bash
npm run build:ax:mac
```

Requires macOS and Xcode Command Line Tools. The helper binary is built into the app resources by the packaging scripts.

## Safety model

- Accessibility and Screen Recording are separate macOS TCC permissions; the app does not grant or bypass them.
- Mutating actions require the task grant and the action allow-list in `src/agent/computer/`.
- Element-targeted actions use the snapshot element identity and reject stale/changed targets. Coordinate actions require explicit authorization and bounded coordinates.
- Keypresses use an allow-listed key map; this is not an unrestricted keyboard/shell interface.
- Runtime evidence and status are defined by the tool result/ExecutionReport; do not infer success from a helper process exit code alone.

The helper implements real actions as well as read-only inspection. Its current capabilities and known limitations are reflected in [implementation status](../../../docs/implementation/STATUS.md) and the [security model](../../SECURITY.md).
