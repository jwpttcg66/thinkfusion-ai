#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/resources"
swiftc "$ROOT/native/macos/ax-bridge.swift" -framework AppKit -framework ApplicationServices -o "$ROOT/resources/ax-bridge"
chmod 755 "$ROOT/resources/ax-bridge"
echo "Built $ROOT/resources/ax-bridge"
echo "For distribution, sign this helper with the same Developer ID Team as the app."
