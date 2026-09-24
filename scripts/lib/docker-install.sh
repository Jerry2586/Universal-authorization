#!/usr/bin/env sh

appgog_compose_version_supported() {
  required_minor=${1:-24}
  command -v docker >/dev/null 2>&1 || return 1
  compose_version=$(docker compose version --short 2>/dev/null | sed 's/^v//; s/[^0-9.].*$//')
  old_ifs=$IFS; IFS=.; set -- $compose_version; IFS=$old_ifs
  compose_major=${1:-0}; compose_minor=${2:-0}
  case "$compose_major:$compose_minor:$required_minor" in *[!0-9:]*) return 1 ;; esac
  [ "$compose_major" -gt 2 ] || { [ "$compose_major" -eq 2 ] && [ "$compose_minor" -ge "$required_minor" ]; }
}
