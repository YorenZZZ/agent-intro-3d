#!/usr/bin/env bash
# Shared command-line selection, kept at the repository root so a sparse
# clone can show the menu before downloading either edition's assets.

agent_usage() {
  echo "usage: $1 [codex|claude|all] $2" >&2
}

agent_select() {
  local requested="${1:-}" choice previous
  case "$requested" in
    codex|claude|all) AGENT_EDITION="$requested"; return ;;
    "") ;;
    *) echo "unknown edition: $requested (choose codex, claude, or all)" >&2; return 2 ;;
  esac
  previous="$(git -C "$AGENT_ROOT" config --get agentIntro.edition 2>/dev/null || true)"
  case "$previous" in codex|claude|all) ;; *) previous=codex ;; esac
  echo "选择 Agent Intro 3D 版本：" >&2
  echo "  1) Codex" >&2
  echo "  2) Claude" >&2
  echo "  3) 全部" >&2
  printf '输入 1/2/3 或版本名（回车默认 %s，q 退出）：' "$previous" >&2
  if ! IFS= read -r choice; then
    echo >&2
    echo "没有收到选择；请在命令中指定 codex、claude 或 all。" >&2
    return 2
  fi
  case "$choice" in
    1|codex|Codex) AGENT_EDITION=codex ;;
    2|claude|Claude) AGENT_EDITION=claude ;;
    3|all|全部) AGENT_EDITION=all ;;
    "") AGENT_EDITION="$previous" ;;
    q|Q) return 3 ;;
    *) echo "无效选择：$choice" >&2; return 2 ;;
  esac
}

agent_editions() {
  case "$AGENT_EDITION" in
    all) printf '%s\n' codex claude ;;
    *) printf '%s\n' "$AGENT_EDITION" ;;
  esac
}

agent_require_sources() {
  local edition
  while IFS= read -r edition; do
    if [[ ! -f "$AGENT_ROOT/editions/$edition/build.sh" ]]; then
      echo "尚未下载 $edition 版；先运行 ./pull.sh $AGENT_EDITION。" >&2
      return 1
    fi
  done < <(agent_editions)
}
