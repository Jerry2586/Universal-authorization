#!/usr/bin/env sh

appgog_release_base() {
  source_name=$1; china_base=${2:-}; github_base=${3:-}; version=${4:-}
  case "$source_name" in
    china) [ -n "$china_base" ] || return 1; printf '%s' "${china_base%/}" ;;
    github)
      if [ -n "$github_base" ]; then printf '%s' "${github_base%/}"
      elif [ -n "$version" ]; then printf 'https://github.com/Jerry2586/Universal-authorization/releases/download/v%s' "${version#v}"
      else printf 'https://github.com/Jerry2586/Universal-authorization/releases/latest/download'; fi ;;
    *) return 1 ;;
  esac
}

appgog_latest_release_sources() {
  printf '%s\n' \
    'https://github.com/Jerry2586/Universal-authorization/releases/latest/download' \
    'https://ghfast.top/https://github.com/Jerry2586/Universal-authorization/releases/latest/download' \
    'https://gh-proxy.com/https://github.com/Jerry2586/Universal-authorization/releases/latest/download'
}
