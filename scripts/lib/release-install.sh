#!/usr/bin/env sh

verify_download() {
  file=$1
  [ -n "$SOURCE_SHA256" ] || return 0
  case "$SOURCE_SHA256" in *[!A-Fa-f0-9]*|'') fail 'SHA-256 必须是 64 位十六进制值。' ;; esac
  [ "${#SOURCE_SHA256}" -eq 64 ] || fail 'SHA-256 必须是 64 位十六进制值。'
  actual=$(sha256sum "$file" | awk '{ print $1 }')
  [ "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" = "$(printf '%s' "$SOURCE_SHA256" | tr 'A-F' 'a-f')" ] || fail '发布包 SHA-256 校验失败。'
}

release_base() {
  appgog_release_base "$1" "$CHINA_RELEASE_BASE" "$GITHUB_RELEASE_BASE" "$VERSION"
}

download_file() {
  url=$1; target=$2
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 12 --max-time 600 "$url" -o "$target"
}

download_signed_release_from() {
  source_name=$1; target_dir=$2
  base=$(release_base "$source_name") || return 1
  log "尝试 $source_name 发布源：$base"
  download_file "$base/release-manifest.json" "$target_dir/release-manifest.json" || return 1
  download_file "$base/release-manifest.json.sig" "$target_dir/release-manifest.json.sig" || return 1
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
  public_key="$script_dir/release-public.pem"
  [ -r "$public_key" ] || fail "缺少发布签名公钥：$public_key"
  openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
    -in "$target_dir/release-manifest.json" -sigfile "$target_dir/release-manifest.json.sig" >/dev/null 2>&1 || return 1
  manifest_version=$(jq -r '.version // empty' "$target_dir/release-manifest.json")
  zip_name=$(jq -r '.zip_name // empty' "$target_dir/release-manifest.json")
  SOURCE_SHA256=$(jq -r '.zip_sha256 // empty' "$target_dir/release-manifest.json")
  [ -n "$manifest_version" ] && [ -n "$zip_name" ] || return 1
  [ -z "$VERSION" ] || [ "${VERSION#v}" = "$manifest_version" ] || fail "发布清单版本 $manifest_version 与要求版本 ${VERSION#v} 不一致。"
  download_file "$base/$zip_name" "$target_dir/source.zip" || return 1
  verify_download "$target_dir/source.zip"
  log "已验证 Ed25519 发布签名与 SHA-256：v$manifest_version"
}

download_signed_release() {
  target_dir=$1
  case "$SOURCE_MODE" in
    china) download_signed_release_from china "$target_dir" || fail '国内发布源下载或签名校验失败。' ;;
    github) download_signed_release_from github "$target_dir" || fail 'GitHub 发布源下载或签名校验失败。' ;;
    auto)
      if [ -n "$CHINA_RELEASE_BASE" ] && download_signed_release_from china "$target_dir"; then return 0; fi
      rm -f "$target_dir/release-manifest.json" "$target_dir/release-manifest.json.sig" "$target_dir/source.zip"
      download_signed_release_from github "$target_dir" || fail '国内源与 GitHub 均不可用。完全断网时请使用完整 .run 离线安装包。'
      ;;
  esac
}
