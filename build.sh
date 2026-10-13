#!/usr/bin/env bash
set -euo pipefail
AGENT_ROOT="$(cd "$(dirname "$0")" && pwd)"
source "$AGENT_ROOT/agent-common.sh"
requested=""
case "${1:-}" in
  codex|claude|all) requested="$1"; shift ;;
  --help|-h) agent_usage ./build.sh '[--install|--uninstall]'; exit 0 ;;
  --install|--uninstall|"") ;;
  *) agent_usage ./build.sh '[--install|--uninstall]'; exit 2 ;;
esac
if [[ $# -gt 1 ]] || [[ $# -eq 1 && "$1" != --install && "$1" != --uninstall ]]; then
  agent_usage ./build.sh '[--install|--uninstall]'; exit 2
fi
agent_select "$requested"
agent_require_sources
while IFS= read -r edition; do
  "$AGENT_ROOT/editions/$edition/build.sh" "$@"
done < <(agent_editions)
