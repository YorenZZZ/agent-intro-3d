#!/usr/bin/env bash
# The sidebar pet's switches, from a clone of this repository:
#
#   ./pet.sh show         show her in Claude's sidebar (also ends "hide for 1 hour")
#   ./pet.sh hide         hide her; the intro still plays when Claude starts
#   ./pet.sh quota on     clicking her shows the quota bubble (the default)
#   ./pet.sh quota off    clicking her only gets her reaction, no bubble
#   ./pet.sh status       what is set now
#
# They are the app's own settings (the defaults domain below, the same keys
# its right-click menu writes): a running app picks a change up within a
# second, nothing needs restarting.
set -euo pipefail

domain="io.github.yorenzzz.claude-intro-3d"
app="/Applications/Claude Intro 3D.app"

# on/off for a boolean key, or $2 when it was never set.
read_switch() {
  case "$(defaults read "$domain" "$1" 2>/dev/null || true)" in
    1) echo on ;;
    0) echo off ;;
    *) echo "$2" ;;
  esac
}

status() {
  local shown quota snooze
  shown="$(read_switch petEnabled on)"
  quota="$(read_switch petQuotaOnClick on)"
  snooze="$(defaults read "$domain" petSnoozeUntil 2>/dev/null || true)"
  if [[ "$shown" == off ]]; then
    echo "宠物：已隐藏（./pet.sh show 显示）"
  elif [[ -n "$snooze" ]] && (( ${snooze%.*} > $(date +%s) )); then
    echo "宠物：暂时隐藏到 $(date -r "${snooze%.*}" '+%H:%M')（./pet.sh show 立即显示）"
  else
    echo "宠物：显示"
  fi
  if [[ "$quota" == on ]]; then echo "点击显示额度：开"; else echo "点击显示额度：关"; fi
  [[ -d "$app" ]] || echo "提示：还没安装 App，先运行 ./build.sh --install"
}

case "${1:-}" in
  show)
    defaults write "$domain" petEnabled -bool true
    defaults delete "$domain" petSnoozeUntil 2>/dev/null || true
    status
    ;;
  hide)
    defaults write "$domain" petEnabled -bool false
    defaults delete "$domain" petSnoozeUntil 2>/dev/null || true
    status
    ;;
  quota)
    case "${2:-}" in
      on) defaults write "$domain" petQuotaOnClick -bool true ;;
      off) defaults write "$domain" petQuotaOnClick -bool false ;;
      *) echo "usage: ./pet.sh quota on|off" >&2; exit 2 ;;
    esac
    status
    ;;
  status)
    status
    ;;
  *)
    echo "usage: ./pet.sh show | hide | quota on|off | status" >&2
    exit 2
    ;;
esac
