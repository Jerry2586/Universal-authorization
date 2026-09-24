#!/usr/bin/env sh

appgog_require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '缺少必需命令：%s\n' "$1" >&2
    return 1
  }
}

appgog_positive_integer() {
  case "${1:-}" in ''|0|*[!0-9]*) return 1 ;; *) return 0 ;; esac
}
