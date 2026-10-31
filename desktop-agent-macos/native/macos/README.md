# macOS Accessibility helper

Build on macOS with Xcode Command Line Tools:

```bash
npm run build:ax:mac
```

The helper uses the macOS Accessibility API and currently implements read-only commands:
- `frontmostApplication`
- `focusedTree`

The Electron UI invokes these commands through `PlatformAccessibility` when the user presses **读取前台应用 / 控件树**. Grant Accessibility permission to the signed helper/application in System Settings > Privacy & Security > Accessibility. Depending on how the app is launched and signed, macOS may list the helper and the host app separately.

This release intentionally does not expose AXPress, AX set-value, keyboard injection or arbitrary actions to the Agent. Before adding them, implement target-app allow-lists, per-action policy checks, a fresh snapshot before acting, and post-action verification. For distribution, sign the helper and app with the same Developer ID team, enable hardened runtime as appropriate, and notarize the final app.
