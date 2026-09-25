#!/usr/bin/env sh
set -eu

PROJECT='Jerry2586/Universal-authorization'
DEFAULT_INSTALL_DIR=${APPGOG_INSTALL_DIR:-/opt/appgog}
SOURCE_MODE=${APPGOG_SOURCE:-auto}
CHINA_RELEASE_BASE=${APPGOG_CHINA_RELEASE_BASE:-}
GITHUB_RELEASE_BASE=${APPGOG_GITHUB_RELEASE_BASE:-}
REQUESTED_VERSION=${APPGOG_VERSION:-}

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

# Stable entrypoint always resolves a signed release, independent of working directory.
# Explicit local builds use scripts/install-linux.sh --source-dir.

[ "$(id -u)" -eq 0 ] || fail '请使用 root 运行，或在命令末尾使用 | sudo sh。'
[ "$(uname -s 2>/dev/null || true)" = Linux ] || fail '仅支持 Linux。'
[ -r /etc/os-release ] || fail '无法识别 Linux 发行版。'
. /etc/os-release
DISTRO=${ID:-unknown}
ARCH=$(uname -m 2>/dev/null || true)
case "$ARCH" in x86_64|amd64|aarch64|arm64) ;; *) fail "不支持的 CPU 架构：${ARCH:-unknown}" ;; esac

expect=''
for argument do
  if [ -n "$expect" ]; then
    case "$expect" in
      source) SOURCE_MODE=$argument ;;
      china) CHINA_RELEASE_BASE=$argument ;;
      version) REQUESTED_VERSION=$argument ;;
      install_dir) DEFAULT_INSTALL_DIR=$argument ;;
    esac
    expect=''
    continue
  fi
  case "$argument" in
    --source) expect=source ;;
    --china-base) expect=china ;;
    --version) expect=version ;;
    --install-dir) expect=install_dir ;;
  esac
done
[ -z "$expect" ] || fail "参数 --$expect 缺少值。"
case "$SOURCE_MODE" in auto|china|github) ;; *) fail '--source 只能是 auto、china 或 github。' ;; esac
case "$DEFAULT_INSTALL_DIR" in /|''|/opt|/usr|/var|/home) fail '安装目录过于宽泛。' ;; /*) ;; *) fail '安装目录必须是绝对路径。' ;; esac

install_bootstrap_tools() {
  missing=false
  for tool in curl openssl sha256sum sed grep sort mktemp; do
    command -v "$tool" >/dev/null 2>&1 || missing=true
  done
  [ -s /etc/ssl/certs/ca-certificates.crt ] || [ -s /etc/pki/tls/certs/ca-bundle.crt ] || missing=true
  [ "$missing" = true ] || return 0
  log '识别服务器环境并补齐下载安装所需工具'
  case "$DISTRO" in
    ubuntu|debian)
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl coreutils grep sed
      ;;
    centos|rhel|rocky|almalinux|fedora|ol)
      manager=dnf; command -v dnf >/dev/null 2>&1 || manager=yum
      "$manager" install -y ca-certificates curl openssl coreutils grep sed
      ;;
    *) fail "不支持自动补齐环境的发行版：$DISTRO" ;;
  esac
}

download_file() {
  url=$1
  output=$2
  curl -fsSL --connect-timeout 15 --max-time 300 --retry 2 --retry-delay 2 "$url" -o "$output"
}

json_string() {
  key=$1
  file=$2
  sed -n "s/^[[:space:]]*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n 1
}

write_release_public_key() {
  destination=$1
  cat > "$destination" <<'EOF'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASovXSUYB8pbR/a1ChjO/OFlqQhHECKP5lh0FzJ2ypvI=
-----END PUBLIC KEY-----
EOF
}

try_release_base() {
  base=${1%/}
  rm -f "$WORK_DIR/release-manifest.json" "$WORK_DIR/release-manifest.json.sig" "$WORK_DIR/installer.run"
  log "尝试签名发布源：$base"
  download_file "$base/release-manifest.json" "$WORK_DIR/release-manifest.json" || return 1
  download_file "$base/release-manifest.json.sig" "$WORK_DIR/release-manifest.json.sig" || return 1
  openssl pkeyutl -verify -pubin -inkey "$WORK_DIR/release-public.pem" -rawin \
    -in "$WORK_DIR/release-manifest.json" -sigfile "$WORK_DIR/release-manifest.json.sig" >/dev/null 2>&1 || return 1

  TARGET_VERSION=$(json_string version "$WORK_DIR/release-manifest.json")
  RUN_NAME=$(json_string run_name "$WORK_DIR/release-manifest.json")
  RUN_SHA256=$(json_string run_sha256 "$WORK_DIR/release-manifest.json")
  printf '%s\n' "$TARGET_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || return 1
  [ "$RUN_NAME" = "APPGOG-Packaging-Licensing-System-$TARGET_VERSION.run" ] || return 1
  case "$RUN_NAME" in APPGOG-Packaging-Licensing-System-*.run) ;; *) return 1 ;; esac
  case "$RUN_NAME" in *[!A-Za-z0-9._-]*) return 1 ;; esac
  printf '%s\n' "$RUN_SHA256" | grep -Eq '^[0-9a-fA-F]{64}$' || return 1
  [ -z "$REQUESTED_VERSION" ] || [ "${REQUESTED_VERSION#v}" = "$TARGET_VERSION" ] || return 1

  download_file "$base/$RUN_NAME" "$WORK_DIR/installer.run" || return 1
  printf '%s  %s\n' "$RUN_SHA256" "$WORK_DIR/installer.run" | sha256sum -c - >/dev/null 2>&1 || return 1
  SELECTED_RELEASE_BASE=$base
  return 0
}

version_base_path='releases/latest/download'
if [ -n "$REQUESTED_VERSION" ]; then version_base_path="releases/download/v${REQUESTED_VERSION#v}"; fi
[ -n "$GITHUB_RELEASE_BASE" ] || GITHUB_RELEASE_BASE="https://github.com/$PROJECT/$version_base_path"

install_bootstrap_tools
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' 0
trap 'exit 130' 2
trap 'exit 143' 15
write_release_public_key "$WORK_DIR/release-public.pem"
TARGET_VERSION=''; RUN_NAME=''; RUN_SHA256=''; SELECTED_RELEASE_BASE=''

case "$SOURCE_MODE" in
  china)
    [ -n "$CHINA_RELEASE_BASE" ] || fail '强制国内源时必须提供 --china-base URL。'
    try_release_base "$CHINA_RELEASE_BASE" || fail '国内发布源不可用或签名校验失败。'
    ;;
  github)
    try_release_base "$GITHUB_RELEASE_BASE" || fail 'GitHub 发布源不可用或签名校验失败。'
    ;;
  auto)
    if [ -n "$CHINA_RELEASE_BASE" ] && try_release_base "$CHINA_RELEASE_BASE"; then :
    elif try_release_base "$GITHUB_RELEASE_BASE"; then :
    elif try_release_base "https://ghfast.top/$GITHUB_RELEASE_BASE"; then :
    elif try_release_base "https://gh-proxy.com/$GITHUB_RELEASE_BASE"; then :
    else fail '国内源、GitHub 与备用代理源均不可用，或发布签名校验失败。'
    fi
    ;;
esac

installed_version=''
installed_package="$DEFAULT_INSTALL_DIR/package.json"
installed_env="$DEFAULT_INSTALL_DIR/.env"
[ ! -f "$DEFAULT_INSTALL_DIR/current/package.json" ] || installed_package="$DEFAULT_INSTALL_DIR/current/package.json"
[ ! -f "$DEFAULT_INSTALL_DIR/shared/.env" ] || installed_env="$DEFAULT_INSTALL_DIR/shared/.env"
if [ -f "$installed_env" ] && [ -f "$installed_package" ]; then
  installed_version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$installed_package" | head -n 1)
fi
running_env_version=''
running_image_version=''
running_health='missing'
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  running_container=$(docker ps -a --filter "label=com.docker.compose.project=${APPGOG_PROJECT:-appgog}" --filter 'label=com.docker.compose.service=appgog' --format '{{.ID}}' | head -n 1)
  if [ -n "$running_container" ]; then
    running_env_version=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$running_container" 2>/dev/null | sed -n 's/^APPGOG_VERSION=//p' | tail -n 1)
    running_health=$(docker inspect --format '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}{{else}}stopped{{end}}' "$running_container" 2>/dev/null || printf 'unknown')
    running_package="$WORK_DIR/running-package.json"
    if docker cp "$running_container:/app/package.json" "$running_package" >/dev/null 2>&1; then
      running_image_version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$running_package" | head -n 1)
    fi
  fi
fi
if [ -n "$installed_version" ]; then
  if [ "$installed_version" = "$TARGET_VERSION" ]; then
    if [ "$running_image_version" = "$TARGET_VERSION" ] && [ "$running_env_version" = "$TARGET_VERSION" ] && [ "$running_health" = healthy ]; then
      if [ "${APPGOG_REPAIR_SOURCE:-false}" != true ]; then
        log "APPGOG v$TARGET_VERSION 源码与运行镜像一致，且服务状态正常，无需重复部署。"
        exit 0
      fi
      log "APPGOG v$TARGET_VERSION 状态正常，但已请求深度修复，将重新下载并无缓存构建。"
    fi
    log "磁盘源码已是 v$TARGET_VERSION，但运行镜像版本为 ${running_image_version:-未知}、环境版本为 ${running_env_version:-未知}、状态为 $running_health；将自动修复并重新部署。"
  else
    highest=$(printf '%s\n%s\n' "$installed_version" "$TARGET_VERSION" | sort -V | tail -n 1)
    [ "$highest" = "$TARGET_VERSION" ] || fail "拒绝自动降级：已安装 v$installed_version，下载源提供 v$TARGET_VERSION。"
    log "检测到已有 APPGOG v$installed_version，将升级到 v$TARGET_VERSION"
  fi
else
  log "准备首次部署 APPGOG v$TARGET_VERSION"
fi

log "安装包签名与 SHA-256 校验通过：$RUN_NAME"
sh "$WORK_DIR/installer.run" "$@"
