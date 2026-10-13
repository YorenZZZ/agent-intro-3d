#!/usr/bin/env bash
# Choose and download only the requested edition(s), then optionally build.
set -euo pipefail
AGENT_ROOT="$(cd "$(dirname "$0")" && pwd)"
source "$AGENT_ROOT/agent-common.sh"

requested=""
update=true
action=""
for argument in "$@"; do
  case "$argument" in
    codex|claude|all)
      [[ -z "$requested" ]] || { agent_usage ./pull.sh '[--build|--install] [--no-update]'; exit 2; }
      requested="$argument"
      ;;
    --no-update) update=false ;;
    --build|--install)
      [[ -z "$action" ]] || { agent_usage ./pull.sh '[--build|--install] [--no-update]'; exit 2; }
      action="$argument"
      ;;
    --help|-h) agent_usage ./pull.sh '[--build|--install] [--no-update]'; exit 0 ;;
    *) agent_usage ./pull.sh '[--build|--install] [--no-update]'; exit 2 ;;
  esac
done
agent_select "$requested"
cd "$AGENT_ROOT"
git rev-parse --is-inside-work-tree >/dev/null
if [[ -n "$(git status --porcelain)" ]]; then
  echo '工作区有未提交改动；先提交或 stash，再切换或更新版本。' >&2
  exit 1
fi
if "$update"; then git pull --ff-only; fi

paths=()
while IFS= read -r edition; do paths+=("editions/$edition"); done < <(agent_editions)
git sparse-checkout set --cone -- "${paths[@]}"
git config --local agentIntro.edition "$AGENT_EDITION"
echo "已下载：$AGENT_EDITION"
if [[ -n "$action" ]]; then
  if [[ "$action" == --install ]]; then "$AGENT_ROOT/build.sh" "$AGENT_EDITION" --install
  else "$AGENT_ROOT/build.sh" "$AGENT_EDITION"; fi
else
  echo "安装：./build.sh $AGENT_EDITION --install"
fi
