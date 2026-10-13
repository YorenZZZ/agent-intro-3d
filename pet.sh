#!/usr/bin/env bash
set -euo pipefail
AGENT_ROOT="$(cd "$(dirname "$0")" && pwd)"
source "$AGENT_ROOT/agent-common.sh"
requested=""
case "${1:-}" in codex|claude|all) requested="$1"; shift ;; esac
agent_select "$requested"
agent_require_sources
while IFS= read -r edition; do
  "$AGENT_ROOT/editions/$edition/pet.sh" "$@"
done < <(agent_editions)
