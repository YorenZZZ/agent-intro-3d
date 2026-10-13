#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT
cp "$root/tests/codex.test.swift" "$temp/main.swift"
swiftc -O -module-cache-path "$root/build/swift-module-cache" -o "$temp/check-codex" "$root/Sources/codex.swift" "$temp/main.swift"
"$temp/check-codex" "$@"
