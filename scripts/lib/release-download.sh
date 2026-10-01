#!/usr/bin/env sh

appgog_release_base() {
  source_name=$1; china_base=${2:-}; github_base=${3:-}; version=${4:-}
  case "$source_name" in
    china) [ -n "$china_base" ] || return 1; printf '%s' "${china_base%/}" ;;
    github)
      if appgog_private_release_enabled; then
        if [ -n "$version" ]; then printf 'appgog-private-github:v%s' "${version#v}"
        else printf 'appgog-private-github:latest'; fi
      elif [ -n "$github_base" ]; then printf '%s' "${github_base%/}"
      elif [ -n "$version" ]; then printf 'https://github.com/Jerry2586/Universal-authorization/releases/download/v%s' "${version#v}"
      else printf 'https://github.com/Jerry2586/Universal-authorization/releases/latest/download'; fi ;;
    *) return 1 ;;
  esac
}

appgog_private_release_enabled() {
  [ -s "${APPGOG_GITHUB_TOKEN_FILE:-/etc/appgog/github-release.token}" ]
}

# Only the GitHub API receives this token. Curl suppresses Authorization across origins on redirects.
appgog_private_release_file() (
  version=$1; name=$2; destination=$3
  case "$name" in
    release-manifest.json|release-manifest.json.sig|APPGOG-Packaging-Licensing-System-*.run|APPGOG-Packaging-Licensing-System-*.zip) ;;
    *) return 1 ;;
  esac
  token_file=${APPGOG_GITHUB_TOKEN_FILE:-/etc/appgog/github-release.token}
  [ -r "$token_file" ] || return 1
  [ "$(stat -c %u "$token_file")" = "$(id -u)" ] || return 1
  case "$(stat -c %a "$token_file")" in 600|400) ;; *) return 1 ;; esac
  umask 077
  scratch=$(mktemp -d) || return 1
  trap 'rm -rf "$scratch"' 0
  token=$(tr -d '\r\n' < "$token_file")
  case "$token" in ''|*[!A-Za-z0-9_]*) return 1 ;; esac
  printf 'Authorization: Bearer %s\n' "$token" > "$scratch/headers"
  unset token
  api=https://api.github.com/repos/Jerry2586/Universal-authorization/releases
  if [ "$version" = latest ]; then endpoint=$api/latest
  else
    printf "%s\n" "$version" | grep -Eq "^v[0-9]+\.[0-9]+\.[0-9]+$" || return 1
    endpoint=$api/tags/$version
  fi
  curl --proto =https --proto-redir =https -fsSL --connect-timeout 15 --max-time 180 --retry 2 \
    -H @"$scratch/headers" -H 'Accept: application/vnd.github+json' \
    "$endpoint" -o "$scratch/release" || return 1
  asset=$(jq -er --arg name "$name" '.assets[] | select(.name == $name and .state == "uploaded") | .url' "$scratch/release") || return 1
  printf "%s\n" "$asset" | grep -Eq "^$api/assets/[0-9]+$" || return 1
  curl --proto =https --proto-redir =https -fsSL --connect-timeout 15 --max-time 300 --retry 2 \
    -H @"$scratch/headers" -H 'Accept: application/octet-stream' \
    "$asset" -o "$destination"
)

appgog_download_release_file() {
  base=$1; name=$2; destination=$3
  case "$base" in
    appgog-private-github:*)
      appgog_private_release_file "${base#appgog-private-github:}" "$name" "$destination" ;;
    *) curl --proto =https --proto-redir =https -fsSL --connect-timeout 12 --max-time 180 --retry 2 "${base%/}/$name" -o "$destination" ;;
  esac
}

appgog_latest_release_sources() {
  if appgog_private_release_enabled; then
    printf '%s\n' 'appgog-private-github:latest' \
      'https://github.com/Jerry2586/Universal-authorization/releases/latest/download'
    return
  fi
  printf '%s\n' \
    'https://github.com/Jerry2586/Universal-authorization/releases/latest/download' \
    'https://ghfast.top/https://github.com/Jerry2586/Universal-authorization/releases/latest/download' \
    'https://gh-proxy.com/https://github.com/Jerry2586/Universal-authorization/releases/latest/download'
}
