#!/usr/bin/env sh
set -eu

INSTALL_DIR=${APPGOG_INSTALL_DIR:-/opt/appgog}
REPOSITORY=${APPGOG_REPOSITORY:-}
VERSION=${APPGOG_VERSION:-}
SOURCE_SHA256=${APPGOG_SOURCE_SHA256:-}
SOURCE_MODE=${APPGOG_SOURCE:-auto}
CHINA_RELEASE_BASE=${APPGOG_CHINA_RELEASE_BASE:-}
GITHUB_RELEASE_BASE=${APPGOG_GITHUB_RELEASE_BASE:-}
CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN:-}
DOCKER_REGISTRY_MIRROR=${APPGOG_DOCKER_REGISTRY_MIRROR:-}
NODE_IMAGE_EXPLICIT=false
CADDY_IMAGE_EXPLICIT=false
[ "${APPGOG_NODE_IMAGE+x}" = x ] && NODE_IMAGE_EXPLICIT=true
[ "${APPGOG_CADDY_IMAGE+x}" = x ] && CADDY_IMAGE_EXPLICIT=true
NODE_IMAGE=${APPGOG_NODE_IMAGE:-node:24-bookworm-slim}
CADDY_IMAGE=${APPGOG_CADDY_IMAGE:-caddy:2.10}
IMAGE_PULL_TIMEOUT=${APPGOG_IMAGE_PULL_TIMEOUT:-180}
AUTH_DOMAIN=${AUTH_DOMAIN:-}
BUILD_DOMAIN=${BUILD_DOMAIN:-}
SOURCE_DIR=${APPGOG_SOURCE_DIR:-}
SKIP_DOCKER=${APPGOG_SKIP_DOCKER_INSTALL:-false}
SKIP_START=false
SKIP_DNS_CHECK=false
NON_INTERACTIVE=false
OPEN_MENU=true
UPGRADE_MODE=false
REPAIR_SOURCE=${APPGOG_REPAIR_SOURCE:-false}
STAGED_RELEASE=''
PREVIOUS_RELEASE=''

usage() {
  cat <<'EOF'
APPGOG Linux 一键安装器

  sudo sh scripts/install-linux.sh
  sudo sh APPGOG-Packaging-Licensing-System-<版本>.run
  重复运行会保留配置并检查、补齐缺失依赖。

参数：
  --auth-domain DOMAIN       授权中心域名
  --build-domain DOMAIN      客户打包中心域名
  --install-dir PATH         安装目录（默认 /opt/appgog）
  --repository URL           Git 仓库或 .tar.gz/.tgz/.zip 发布包
  --version REF              Git 分支、标签或提交
  --sha256 HASH              校验下载发布包的 SHA-256
  --source MODE              下载源：auto、china 或 github（默认 auto）
  --china-base URL           国内对象存储/CDN 的发布文件基础地址
  --cloudflare-token TOKEN   自动创建/更新两个域名的 Cloudflare A 记录
  --docker-registry-mirror URL  配置 Docker Hub 国内镜像地址
  --node-image IMAGE         Node 基础镜像（可指定国内 registry）
  --caddy-image IMAGE        Caddy 基础镜像（可指定国内 registry）
  --source-dir PATH          从本地源码复制安装
  --skip-docker-install      不自动安装 Docker
  --skip-start               不启动容器
  --skip-dns-check           仅用于离线预装；跳过 DNS 指向检查
  --non-interactive          禁止交互
  --no-menu                  完成后不打开菜单
EOF
}

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --auth-domain) [ "$#" -ge 2 ] || fail '--auth-domain 缺少值'; AUTH_DOMAIN=$2; shift 2 ;;
    --build-domain) [ "$#" -ge 2 ] || fail '--build-domain 缺少值'; BUILD_DOMAIN=$2; shift 2 ;;
    --install-dir) [ "$#" -ge 2 ] || fail '--install-dir 缺少值'; INSTALL_DIR=$2; shift 2 ;;
    --repository) [ "$#" -ge 2 ] || fail '--repository 缺少值'; REPOSITORY=$2; shift 2 ;;
    --version) [ "$#" -ge 2 ] || fail '--version 缺少值'; VERSION=$2; shift 2 ;;
    --sha256) [ "$#" -ge 2 ] || fail '--sha256 缺少值'; SOURCE_SHA256=$2; shift 2 ;;
    --source) [ "$#" -ge 2 ] || fail '--source 缺少值'; SOURCE_MODE=$2; shift 2 ;;
    --china-base) [ "$#" -ge 2 ] || fail '--china-base 缺少值'; CHINA_RELEASE_BASE=$2; shift 2 ;;
    --cloudflare-token) [ "$#" -ge 2 ] || fail '--cloudflare-token 缺少值'; CLOUDFLARE_API_TOKEN=$2; shift 2 ;;
    --docker-registry-mirror) [ "$#" -ge 2 ] || fail '--docker-registry-mirror 缺少值'; DOCKER_REGISTRY_MIRROR=$2; shift 2 ;;
    --node-image) [ "$#" -ge 2 ] || fail '--node-image 缺少值'; NODE_IMAGE=$2; NODE_IMAGE_EXPLICIT=true; shift 2 ;;
    --caddy-image) [ "$#" -ge 2 ] || fail '--caddy-image 缺少值'; CADDY_IMAGE=$2; CADDY_IMAGE_EXPLICIT=true; shift 2 ;;
    --source-dir) [ "$#" -ge 2 ] || fail '--source-dir 缺少值'; SOURCE_DIR=$2; shift 2 ;;
    --skip-docker-install) SKIP_DOCKER=true; shift ;;
    --skip-start) SKIP_START=true; shift ;;
    --skip-dns-check) SKIP_DNS_CHECK=true; shift ;;
    --non-interactive) NON_INTERACTIVE=true; shift ;;
    --no-menu) OPEN_MENU=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
done

case "$SOURCE_MODE" in auto|china|github) ;; *) fail '--source 只能是 auto、china 或 github' ;; esac

INSTALL_ROOT=$INSTALL_DIR
RELEASES_DIR=$INSTALL_ROOT/releases
SHARED_DIR=$INSTALL_ROOT/shared
CURRENT_LINK=$INSTALL_ROOT/current

[ "$(id -u)" -eq 0 ] || fail '请使用 root 或 sudo 运行。'
[ "$(uname -s 2>/dev/null || true)" = Linux ] || fail '仅支持 Linux。'
ARCH=$(uname -m 2>/dev/null || true)
case "$ARCH" in
  x86_64|amd64|aarch64|arm64) ;;
  *) fail "不支持的 CPU 架构：${ARCH:-unknown}；仅支持 x86_64/amd64 和 aarch64/arm64。" ;;
esac
case "$INSTALL_DIR" in /|''|/opt|/usr|/var|/home) fail '安装目录过于宽泛。' ;; /*) ;; *) fail '安装目录必须是绝对路径。' ;; esac
[ -r /etc/os-release ] || fail '无法识别 Linux 发行版。'
. /etc/os-release
DISTRO=${ID:-unknown}

compose_supported() {
  command -v docker >/dev/null 2>&1 || return 1
  version=$(docker compose version --short 2>/dev/null | sed 's/^v//; s/[^0-9.].*$//')
  old_ifs=$IFS; IFS=.; set -- $version; IFS=$old_ifs
  major=${1:-0}; minor=${2:-0}
  case "$major:$minor" in *[!0-9:]*|:) return 1 ;; esac
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 24 ]; }
}
install_packages() {
  missing=false
  for tool in curl git tar gzip unzip openssl getent ss jq sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || missing=true
  done
  [ -s /etc/ssl/certs/ca-certificates.crt ] || [ -s /etc/pki/tls/certs/ca-bundle.crt ] || missing=true
  [ "$missing" = true ] || return 0
  log '补齐缺失的系统工具与 CA 证书'
  case "$DISTRO" in
    ubuntu|debian)
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git tar gzip unzip openssl iproute2 jq coreutils
      ;;
    centos|rhel|rocky|almalinux|fedora|ol)
      manager=dnf; command -v dnf >/dev/null 2>&1 || manager=yum
      "$manager" install -y ca-certificates curl git tar gzip unzip openssl iproute jq coreutils
      ;;
    *) fail "不支持自动安装依赖的发行版：$DISTRO" ;;
  esac
}

repair_docker_plugins() {
  log '保留现有 Docker Engine，补齐 Compose 和 Buildx 插件'
  case "$DISTRO" in
    ubuntu|debian)
      apt-get update
      packages=''
      if ! compose_supported; then
        if apt-cache show docker-compose-plugin >/dev/null 2>&1; then packages="$packages docker-compose-plugin"
        elif apt-cache show docker-compose-v2 >/dev/null 2>&1; then packages="$packages docker-compose-v2"
        else fail '现有软件源没有 Compose v2，请配置与现有 Docker 对应的软件源后重试。'; fi
      fi
      if ! docker buildx version >/dev/null 2>&1; then
        if apt-cache show docker-buildx-plugin >/dev/null 2>&1; then packages="$packages docker-buildx-plugin"
        elif apt-cache show docker-buildx >/dev/null 2>&1; then packages="$packages docker-buildx"
        else fail '现有软件源没有 Buildx，请配置与现有 Docker 对应的软件源后重试。'; fi
      fi
      [ -z "$packages" ] || DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove $packages
      ;;
    centos|rhel|rocky|almalinux|fedora|ol)
      manager=dnf; command -v dnf >/dev/null 2>&1 || manager=yum
      packages=''
      compose_supported || packages="$packages docker-compose-plugin"
      docker buildx version >/dev/null 2>&1 || packages="$packages docker-buildx-plugin"
      [ -z "$packages" ] || "$manager" install -y $packages
      ;;
    *) fail "无法为 $DISTRO 自动补齐 Docker 插件" ;;
  esac
}
install_docker() {
  if command -v docker >/dev/null 2>&1; then
    if ! compose_supported || ! docker buildx version >/dev/null 2>&1; then
      [ "$SKIP_DOCKER" = false ] || fail 'Docker 插件缺失，且已禁用自动安装。'
      repair_docker_plugins
    fi
    if ! docker info >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker; fi
    docker info >/dev/null 2>&1 || fail 'Docker 已安装但服务不可访问。'
    compose_supported || fail '补齐后 Compose 仍低于 2.24 或不可用。'
    docker buildx version >/dev/null 2>&1 || fail '补齐后 Buildx 仍不可用。'
    log "复用现有 Docker：$(docker --version)"
    return
  fi
  [ "$SKIP_DOCKER" = false ] || fail '未安装 Docker，且已禁用自动安装。'
  log '安装 Docker Engine 与 Compose v2'
  install_packages
  case "$DISTRO" in
    ubuntu|debian)
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/$DISTRO/gpg" -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      arch=$(dpkg --print-architecture)
      codename=${VERSION_CODENAME:-}
      [ -n "$codename" ] || fail '无法识别系统代号。'
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$arch" "$DISTRO" "$codename" > /etc/apt/sources.list.d/docker.list
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    centos|rhel|rocky|almalinux|fedora|ol)
      manager=dnf; command -v dnf >/dev/null 2>&1 || manager=yum
      "$manager" install -y dnf-plugins-core 2>/dev/null || "$manager" install -y yum-utils
      repo_os=centos
      [ "$DISTRO" = fedora ] && repo_os=fedora
      [ "$DISTRO" = rhel ] && repo_os=rhel
      "$manager" config-manager --add-repo "https://download.docker.com/linux/$repo_os/docker-ce.repo"
      "$manager" install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
  esac
  systemctl enable --now docker
  compose_supported || fail 'Docker 安装后 Compose 仍低于 2.24 或不可用。'
  docker buildx version >/dev/null 2>&1 || fail 'Docker 安装后 Buildx 仍不可用。'
}

configure_registry_mirror() {
  [ -n "$DOCKER_REGISTRY_MIRROR" ] || return 0
  case "$DOCKER_REGISTRY_MIRROR" in https://*|http://*) ;; *) fail 'Docker 镜像地址必须使用 http:// 或 https://' ;; esac
  mkdir -p /etc/docker
  if [ -s /etc/docker/daemon.json ]; then
    cp -p /etc/docker/daemon.json "/etc/docker/daemon.json.appgog.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    jq --arg mirror "$DOCKER_REGISTRY_MIRROR" '. + {"registry-mirrors": ((.["registry-mirrors"] // []) + [$mirror] | unique)}' \
      /etc/docker/daemon.json > /etc/docker/daemon.json.appgog.tmp || fail '现有 Docker daemon.json 不是有效 JSON'
  else
    jq -n --arg mirror "$DOCKER_REGISTRY_MIRROR" '{"registry-mirrors":[$mirror]}' > /etc/docker/daemon.json.appgog.tmp
  fi
  mv /etc/docker/daemon.json.appgog.tmp /etc/docker/daemon.json
  chmod 600 /etc/docker/daemon.json
  if command -v systemctl >/dev/null 2>&1; then systemctl restart docker
  elif command -v service >/dev/null 2>&1; then service docker restart
  else fail 'Docker registry mirror 已写入，但系统没有可用的 Docker 服务管理命令。'; fi
  docker info >/dev/null 2>&1 || fail 'Docker registry mirror 配置后 Docker 服务未能恢复；原配置备份位于 /etc/docker/daemon.json.appgog.bak.*'
  log 'Docker registry mirror 已配置'
}

valid_image_ref() {
  case "$1" in ''|*[!A-Za-z0-9._:/@+-]*) return 1 ;; *) return 0 ;; esac
}

pull_image_with_timeout() {
  image=$1
  if command -v timeout >/dev/null 2>&1; then
    timeout "$IMAGE_PULL_TIMEOUT" docker pull --quiet "$image"
  else
    docker pull --quiet "$image"
  fi
}

probe_image_pair() {
  candidate_node=$1
  candidate_caddy=$2
  candidate_name=$3
  printf '\n[%s] Node: %s\n[%s] Caddy: %s\n' "$candidate_name" "$candidate_node" "$candidate_name" "$candidate_caddy" >> "$IMAGE_SOURCE_LOG"
  if pull_image_with_timeout "$candidate_node" >> "$IMAGE_SOURCE_LOG" 2>&1 \
    && pull_image_with_timeout "$candidate_caddy" >> "$IMAGE_SOURCE_LOG" 2>&1; then
    NODE_IMAGE=$candidate_node
    CADDY_IMAGE=$candidate_caddy
    log "基础镜像源可用：$candidate_name"
    return 0
  fi
  printf '[%s] 不可用\n' "$candidate_name" >> "$IMAGE_SOURCE_LOG"
  return 1
}

select_base_images() {
  [ "$SKIP_START" = false ] || { log '按要求不启动容器，跳过基础镜像网络探测'; return 0; }
  valid_image_ref "$NODE_IMAGE" || fail 'Node 基础镜像地址包含非法字符'
  valid_image_ref "$CADDY_IMAGE" || fail 'Caddy 基础镜像地址包含非法字符'
  case "$IMAGE_PULL_TIMEOUT" in ''|*[!0-9]*) fail 'APPGOG_IMAGE_PULL_TIMEOUT 必须是正整数秒数' ;; esac
  [ "$IMAGE_PULL_TIMEOUT" -gt 0 ] || fail 'APPGOG_IMAGE_PULL_TIMEOUT 必须大于 0'
  IMAGE_SOURCE_LOG="$SHARED_DIR/logs/image-source-$(date -u +%Y%m%dT%H%M%SZ).log"
  : > "$IMAGE_SOURCE_LOG"
  chmod 600 "$IMAGE_SOURCE_LOG" 2>/dev/null || true

  log '检测 Docker 基础镜像网络（Node + Caddy）'
  if probe_image_pair "$NODE_IMAGE" "$CADDY_IMAGE" '当前配置'; then return 0; fi
  if [ "$NODE_IMAGE_EXPLICIT" = true ] || [ "$CADDY_IMAGE_EXPLICIT" = true ]; then
    fail "手工指定的基础镜像不可用，未自动覆盖。详情：$IMAGE_SOURCE_LOG"
  fi

  if [ "$NODE_IMAGE" != 'node:24-bookworm-slim' ] || [ "$CADDY_IMAGE" != 'caddy:2.10' ]; then
    if probe_image_pair 'node:24-bookworm-slim' 'caddy:2.10' 'Docker Hub'; then return 0; fi
  fi
  if probe_image_pair 'm.daocloud.io/docker.io/library/node:24-bookworm-slim' 'm.daocloud.io/docker.io/library/caddy:2.10' 'DaoCloud 国内镜像'; then return 0; fi
  if probe_image_pair 'docker.m.daocloud.io/library/node:24-bookworm-slim' 'docker.m.daocloud.io/library/caddy:2.10' 'DaoCloud 兼容镜像'; then return 0; fi

  printf '\nDocker Hub 与受控备用镜像均不可用。请检查服务器 DNS、系统时间、HTTPS 出站 443、Docker daemon 代理和防火墙。\n' >> "$IMAGE_SOURCE_LOG"
  fail "无法读取 Node/Caddy 基础镜像；没有关闭 TLS 或启用不安全仓库。详情：$IMAGE_SOURCE_LOG"
}

valid_domain() {
  case "$1" in example.com|*.example.com|your-domain.com|*.your-domain.com|''|*://*|*/*|*:*|*[!A-Za-z0-9.-]*|.*|*.) return 1 ;; *.*) return 0 ;; *) return 1 ;; esac
}

public_ipv4() {
  curl -4fsS --max-time 10 https://api.ipify.org 2>/dev/null || curl -4fsS --max-time 10 https://ifconfig.me/ip 2>/dev/null || true
}

cloudflare_request() {
  method=$1; path=$2; data=${3:-}
  if [ -n "$data" ]; then
    curl -fsS --max-time 20 -X "$method" "https://api.cloudflare.com/client/v4$path" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' --data "$data"
  else
    curl -fsS --max-time 20 -X "$method" "https://api.cloudflare.com/client/v4$path" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json'
  fi
}

cloudflare_zone_id() {
  domain=$1; zone=$domain
  while printf '%s' "$zone" | grep -q '\.'; do
    response=$(cloudflare_request GET "/zones?name=$zone&status=active&per_page=1") || return 1
    id=$(printf '%s' "$response" | jq -r 'if .success then (.result[0].id // empty) else empty end')
    [ -z "$id" ] || { printf '%s' "$id"; return 0; }
    zone=${zone#*.}
  done
  return 1
}

cloudflare_upsert_record() {
  domain=$1; ip=$2
  zone_id=$(cloudflare_zone_id "$domain") || fail "Cloudflare 未找到 $domain 所属的活动 Zone，或 API Token 权限不足。"
  response=$(cloudflare_request GET "/zones/$zone_id/dns_records?type=A&name=$domain&per_page=1") || fail "Cloudflare 查询 $domain 失败。"
  record_id=$(printf '%s' "$response" | jq -r 'if .success then (.result[0].id // empty) else empty end')
  payload=$(jq -nc --arg name "$domain" --arg content "$ip" '{type:"A",name:$name,content:$content,ttl:1,proxied:false}')
  if [ -n "$record_id" ]; then
    response=$(cloudflare_request PUT "/zones/$zone_id/dns_records/$record_id" "$payload") || fail "Cloudflare 更新 $domain 失败。"
  else
    response=$(cloudflare_request POST "/zones/$zone_id/dns_records" "$payload") || fail "Cloudflare 创建 $domain 失败。"
  fi
  [ "$(printf '%s' "$response" | jq -r '.success')" = true ] || fail "Cloudflare 写入 $domain 失败：$(printf '%s' "$response" | jq -r '.errors[0].message // "未知错误"')"
  log "Cloudflare DNS 已指向 $ip：$domain"
}

configure_cloudflare_dns() {
  [ -n "$CLOUDFLARE_API_TOKEN" ] || return 0
  ip=$(public_ipv4)
  [ -n "$ip" ] || fail '无法检测公网 IPv4，不能自动配置 Cloudflare DNS。'
  cloudflare_upsert_record "$AUTH_DOMAIN" "$ip"
  cloudflare_upsert_record "$BUILD_DOMAIN" "$ip"
  CLOUDFLARE_API_TOKEN=''
  unset CLOUDFLARE_API_TOKEN
}

preflight_network() {
  disk_path=$(dirname -- "$INSTALL_DIR")
  while [ ! -d "$disk_path" ] && [ "$disk_path" != / ]; do disk_path=$(dirname -- "$disk_path"); done
  available_kb=$(df -Pk "$disk_path" 2>/dev/null | awk 'NR == 2 { print $4 }')
  case "$available_kb" in ''|*[!0-9]*) fail "无法检查安装目录所在磁盘：$disk_path" ;; esac
  [ "$available_kb" -ge 4194304 ] || fail '安装磁盘可用空间不足 4 GiB；请清理空间后重试。'
  owned=$(docker ps -q --filter "label=com.docker.compose.project=${APPGOG_PROJECT:-appgog}" --filter label=com.docker.compose.service=appgog)
  legacy=$(docker ps -q --filter "label=com.docker.compose.project=${APPGOG_PROJECT:-appgog}" --filter label=com.docker.compose.service=caddy)
  if [ -z "$owned$legacy" ] && command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)(80|443)$' && fail '80 或 443 端口已被占用；统一 Docker HTTPS 入口需要独占这两个端口。'
  fi
  [ "$SKIP_DNS_CHECK" = false ] || return 0
  public_ip=$(public_ipv4)
  [ -n "$public_ip" ] || fail '无法检测服务器公网 IPv4；可在离线预装时显式使用 --skip-dns-check。'
  for domain in "$AUTH_DOMAIN" "$BUILD_DOMAIN"; do
    resolved=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u || true)
    [ -n "$resolved" ] || fail "域名 $domain 尚未解析。请先配置 DNS A 记录指向 $public_ip。"
    printf '%s\n' "$resolved" | grep -Fx "$public_ip" >/dev/null || fail "域名 $domain 未指向本机公网地址 $public_ip。"
  done
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw allow 443/udp >/dev/null
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-service=http >/dev/null
    firewall-cmd --permanent --add-service=https >/dev/null
    firewall-cmd --permanent --add-port=443/udp >/dev/null
    firewall-cmd --reload >/dev/null
  fi
}

verify_download() {
  file=$1
  [ -n "$SOURCE_SHA256" ] || return 0
  case "$SOURCE_SHA256" in *[!A-Fa-f0-9]*|'') fail 'SHA-256 必须是 64 位十六进制值。' ;; esac
  [ "${#SOURCE_SHA256}" -eq 64 ] || fail 'SHA-256 必须是 64 位十六进制值。'
  actual=$(sha256sum "$file" | awk '{ print $1 }')
  [ "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" = "$(printf '%s' "$SOURCE_SHA256" | tr 'A-F' 'a-f')" ] || fail '发布包 SHA-256 校验失败。'
}

release_base() {
  source_name=$1
  case "$source_name" in
    china) [ -n "$CHINA_RELEASE_BASE" ] || return 1; printf '%s' "${CHINA_RELEASE_BASE%/}" ;;
    github)
      if [ -n "$GITHUB_RELEASE_BASE" ]; then printf '%s' "${GITHUB_RELEASE_BASE%/}"
      elif [ -n "$VERSION" ]; then printf 'https://github.com/Jerry2586/Universal-authorization/releases/download/v%s' "${VERSION#v}"
      else printf 'https://github.com/Jerry2586/Universal-authorization/releases/latest/download'; fi ;;
  esac
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
prompt_domain() {
  variable=$1; label=$2; eval "current=\${$variable}"
  while ! valid_domain "$current"; do
    [ "$NON_INTERACTIVE" = false ] || fail "$label 无效或缺失。"
    { [ -t 0 ] || [ -t 1 ]; } && [ -r /dev/tty ] || fail "没有交互终端；请通过 --auth-domain 和 --build-domain 提供域名。"
    printf '%s（不含 https:// 和路径）：' "$label" >/dev/tty
    IFS= read -r current </dev/tty || true
  done
  eval "$variable=\$current"
}

detect_local_source() {
  [ -n "$SOURCE_DIR" ] && return
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
  candidate=$(CDPATH= cd -- "$script_dir/.." 2>/dev/null && pwd || true)
  if [ -f "$candidate/compose.yaml" ] && [ -f "$candidate/package.json" ]; then SOURCE_DIR=$candidate; fi
}

prepare_shared_layout() {
  mkdir -p "$RELEASES_DIR" "$SHARED_DIR/backups" "$SHARED_DIR/logs" "$SHARED_DIR/update-control/requests"
  chmod 700 "$SHARED_DIR" "$SHARED_DIR/backups" "$SHARED_DIR/logs" "$SHARED_DIR/update-control" 2>/dev/null || true
  chown -R 1000:1000 "$SHARED_DIR/update-control" 2>/dev/null || true
  chmod 770 "$SHARED_DIR/update-control" "$SHARED_DIR/update-control/requests" 2>/dev/null || true
  if [ ! -f "$SHARED_DIR/.env" ] && [ -f "$INSTALL_ROOT/.env" ]; then cp -p "$INSTALL_ROOT/.env" "$SHARED_DIR/.env"; fi
  if [ ! -f "$SHARED_DIR/.backup-key" ] && [ -f "$INSTALL_ROOT/.backup-key" ]; then cp -p "$INSTALL_ROOT/.backup-key" "$SHARED_DIR/.backup-key"; fi
  for directory in backups logs; do
    if [ -d "$INSTALL_ROOT/$directory" ] && [ ! -L "$INSTALL_ROOT/$directory" ]; then
      find "$INSTALL_ROOT/$directory" -mindepth 1 -maxdepth 1 -exec mv -n {} "$SHARED_DIR/$directory/" \; 2>/dev/null || true
    fi
  done
}

stage_release() {
  project_root=$1
  [ -f "$project_root/compose.yaml" ] && [ -f "$project_root/scripts/docker.sh" ] || fail '不是有效的 APPGOG 项目源码。'
  package_version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$project_root/package.json" | head -n 1)
  [ -n "$package_version" ] || fail 'package.json 缺少版本号。'
  release_name=$package_version
  if [ -e "$RELEASES_DIR/$release_name" ]; then release_name="$package_version-repair-$(date -u +%Y%m%dT%H%M%SZ)"; fi
  stage_dir="$RELEASES_DIR/.staging-$release_name-$$"
  final_dir="$RELEASES_DIR/$release_name"
  rm -rf "$stage_dir"
  mkdir -p "$stage_dir"
  staging=$(mktemp)
  tar -C "$project_root" --exclude=.git --exclude=.env --exclude=.backup-key --exclude=backups --exclude=logs --exclude=dist \
    --exclude=node_modules --exclude=runtime --exclude=var -cf "$staging" .
  tar -C "$stage_dir" -xf "$staging"
  rm -f "$staging"
  ln -s "$SHARED_DIR/.env" "$stage_dir/.env"
  ln -s "$SHARED_DIR/backups" "$stage_dir/backups"
  ln -s "$SHARED_DIR/logs" "$stage_dir/logs"
  ln -s "$SHARED_DIR/.backup-key" "$stage_dir/.backup-key"
  mv "$stage_dir" "$final_dir"
  STAGED_RELEASE=$final_dir
  log "程序文件已完整写入独立版本目录：$STAGED_RELEASE"
}

copy_local_source() {
  source_root=$(CDPATH= cd -- "$SOURCE_DIR" 2>/dev/null && pwd) || fail "源码目录不存在：$SOURCE_DIR"
  stage_release "$source_root"
}

copy_release_root() {
  project_root=$1
  stage_release "$project_root"
}

download_source() {
  mkdir -p "$INSTALL_ROOT"
  temp_dir=''
  case "$REPOSITORY" in
    '')
      temp_dir=$(mktemp -d); trap '[ -z "$temp_dir" ] || rm -rf "$temp_dir"' EXIT INT TERM
      download_signed_release "$temp_dir"
      unzip -q "$temp_dir/source.zip" -d "$temp_dir/unpacked"
      project_file=$(find "$temp_dir/unpacked" -mindepth 1 -maxdepth 3 -type f -name compose.yaml -print -quit)
      [ -n "$project_file" ] || fail '签名发布包中没有 compose.yaml。'
      project_root=$(dirname -- "$project_file")
      copy_release_root "$project_root"
      ;;
    *.tar.gz|*.tgz)
      temp_dir=$(mktemp -d); trap '[ -z "$temp_dir" ] || rm -rf "$temp_dir"' EXIT INT TERM
      curl -fL "$REPOSITORY" -o "$temp_dir/source.tar.gz"
      verify_download "$temp_dir/source.tar.gz"
      mkdir -p "$temp_dir/unpacked"
      tar -xzf "$temp_dir/source.tar.gz" -C "$temp_dir/unpacked"
      project_file=$(find "$temp_dir/unpacked" -mindepth 1 -maxdepth 3 -type f -name compose.yaml -print -quit)
      [ -n "$project_file" ] || fail '发布包中没有 compose.yaml。'
      project_root=$(dirname -- "$project_file")
      copy_release_root "$project_root"
      ;;
    *.zip)
      temp_dir=$(mktemp -d); trap '[ -z "$temp_dir" ] || rm -rf "$temp_dir"' EXIT INT TERM
      curl -fL "$REPOSITORY" -o "$temp_dir/source.zip"
      verify_download "$temp_dir/source.zip"
      unzip -q "$temp_dir/source.zip" -d "$temp_dir/unpacked"
      project_file=$(find "$temp_dir/unpacked" -mindepth 1 -maxdepth 3 -type f -name compose.yaml -print -quit)
      [ -n "$project_file" ] || fail '发布包中没有 compose.yaml。'
      project_root=$(dirname -- "$project_file")
      copy_release_root "$project_root"
      ;;
    *)
      temp_dir=$(mktemp -d); trap '[ -z "$temp_dir" ] || rm -rf "$temp_dir"' EXIT INT TERM
      if [ -n "$VERSION" ]; then
        GIT_TERMINAL_PROMPT=0 git clone "$REPOSITORY" "$temp_dir/repository"
        git -C "$temp_dir/repository" checkout "$VERSION"
      else
        GIT_TERMINAL_PROMPT=0 git clone --depth 1 "$REPOSITORY" "$temp_dir/repository"
      fi
      copy_release_root "$temp_dir/repository"
      ;;
  esac
  [ -n "$STAGED_RELEASE" ] && [ -f "$STAGED_RELEASE/compose.yaml" ] && [ -f "$STAGED_RELEASE/scripts/appgog.sh" ] || fail '下载内容不是有效安装包。'
}

write_env() {
  package_version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$STAGED_RELEASE/package.json" | head -n 1)
  [ -n "$package_version" ] || fail 'package.json 缺少版本号。'
  if [ -f "$SHARED_DIR/.env" ]; then
    env_temp=$(mktemp)
    if grep -q '^APPGOG_VERSION=' "$SHARED_DIR/.env"; then
      sed "s/^APPGOG_VERSION=.*/APPGOG_VERSION=$package_version/" "$SHARED_DIR/.env" > "$env_temp"
    else
      cp "$SHARED_DIR/.env" "$env_temp"
      printf 'APPGOG_VERSION=%s\n' "$package_version" >> "$env_temp"
    fi
    if grep -q '^APPGOG_SHARED_DIR=' "$env_temp"; then
      sed "s|^APPGOG_SHARED_DIR=.*|APPGOG_SHARED_DIR=$SHARED_DIR|" "$env_temp" > "$env_temp.next" && mv "$env_temp.next" "$env_temp"
    else printf 'APPGOG_SHARED_DIR=%s\n' "$SHARED_DIR" >> "$env_temp"; fi
    if grep -q '^APPGOG_IMAGE=' "$env_temp"; then
      sed "s|^APPGOG_IMAGE=.*|APPGOG_IMAGE=appgog-platform:$package_version|" "$env_temp" > "$env_temp.next" && mv "$env_temp.next" "$env_temp"
    else printf 'APPGOG_IMAGE=appgog-platform:%s\n' "$package_version" >> "$env_temp"; fi
    if grep -q '^APPGOG_NODE_IMAGE=' "$env_temp"; then
      sed "s|^APPGOG_NODE_IMAGE=.*|APPGOG_NODE_IMAGE=$NODE_IMAGE|" "$env_temp" > "$env_temp.next" && mv "$env_temp.next" "$env_temp"
    else printf 'APPGOG_NODE_IMAGE=%s\n' "$NODE_IMAGE" >> "$env_temp"; fi
    if grep -q '^APPGOG_CADDY_IMAGE=' "$env_temp"; then
      sed "s|^APPGOG_CADDY_IMAGE=.*|APPGOG_CADDY_IMAGE=$CADDY_IMAGE|" "$env_temp" > "$env_temp.next" && mv "$env_temp.next" "$env_temp"
    else printf 'APPGOG_CADDY_IMAGE=%s\n' "$CADDY_IMAGE" >> "$env_temp"; fi
    cat "$env_temp" > "$SHARED_DIR/.env"
    rm -f "$env_temp"
    chmod 600 "$SHARED_DIR/.env"
    log "保留已有 .env 并同步版本号为 $package_version；域名修改请使用 appgog config"
    return
  fi
  umask 077
  printf 'AUTH_DOMAIN=%s\nBUILD_DOMAIN=%s\nAPPGOG_VERSION=%s\nAPPGOG_IMAGE=appgog-platform:%s\nAPPGOG_SHARED_DIR=%s\nAPPGOG_NODE_IMAGE=%s\nAPPGOG_CADDY_IMAGE=%s\nLICENSE_SERVICE_ENABLED=true\nCUSTOMER_LOGIN_ENABLED=true\nBUILD_CENTER_ENABLED=true\nNEW_BUILDS_ENABLED=true\nWORKER_ENABLED=true\n' \
    "$AUTH_DOMAIN" "$BUILD_DOMAIN" "$package_version" "$package_version" "$SHARED_DIR" "$NODE_IMAGE" "$CADDY_IMAGE" > "$SHARED_DIR/.env"
  chmod 600 "$SHARED_DIR/.env" 2>/dev/null || true
}

activate_release() {
  if [ -L "$CURRENT_LINK" ]; then PREVIOUS_RELEASE=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true); fi
  next_link="$INSTALL_ROOT/.current.$$"
  rm -f "$next_link"
  ln -s "$STAGED_RELEASE" "$next_link"
  mv -Tf "$next_link" "$CURRENT_LINK"
}

restore_previous_release() {
  [ -n "$PREVIOUS_RELEASE" ] || return 0
  next_link="$INSTALL_ROOT/.current.rollback.$$"
  ln -s "$PREVIOUS_RELEASE" "$next_link"
  mv -Tf "$next_link" "$CURRENT_LINK"
  (cd "$CURRENT_LINK" && sh scripts/docker.sh restart) >/dev/null 2>&1 || true
}

install_command() {
  command_path="$CURRENT_LINK/scripts/appgog.sh"
  chmod 755 "$command_path" "$CURRENT_LINK/scripts/docker.sh" "$CURRENT_LINK/scripts/install-linux.sh" "$CURRENT_LINK/scripts/update-helper.sh"
  if [ -e /usr/local/bin/appgog ] || [ -L /usr/local/bin/appgog ]; then
    existing=$(readlink -f /usr/local/bin/appgog 2>/dev/null || true)
    case "$existing" in
      "$INSTALL_ROOT"/*) ;;
      *) fail '/usr/local/bin/appgog 已被其他程序占用。' ;;
    esac
  fi
  temp_link=/usr/local/bin/.appgog.$$
  rm -f "$temp_link"; ln -s "$command_path" "$temp_link"; mv -f "$temp_link" /usr/local/bin/appgog
}

install_update_helper() {
  command -v systemctl >/dev/null 2>&1 || { log '系统未使用 systemd，在线更新助手未自动启用；命令行更新仍可用'; return 0; }
  unit=/etc/systemd/system/appgog-update-helper.service
  unit_temp="$unit.$$"
  cat > "$unit_temp" <<EOF
[Unit]
Description=APPGOG restricted signed update helper
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$CURRENT_LINK/scripts/update-helper.sh --daemon $INSTALL_ROOT
Restart=always
RestartSec=3
User=root
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$unit_temp"
  mv "$unit_temp" "$unit"
  systemctl daemon-reload
  systemctl enable appgog-update-helper.service >/dev/null
  if [ "${APPGOG_HELPER_ACTIVE:-false}" != true ]; then systemctl restart appgog-update-helper.service; fi
}

print_result() {
  cat <<EOF

============================================================
APPGOG 安装完成

管理后台：https://$AUTH_DOMAIN/admin
客户中心：https://$BUILD_DOMAIN/build
安装目录：$INSTALL_ROOT
当前版本：$CURRENT_LINK
管理菜单：appgog

输入 appgog credentials 查看初始管理员账号密码。
单一 appgog 容器，Caddy 自动申请并续期 HTTPS 证书。
============================================================
EOF
}

wait_public_https() {
  for endpoint in "https://$AUTH_DOMAIN/health" "https://$BUILD_DOMAIN/health"; do
    attempts=0
    until curl -fsS --max-time 10 "$endpoint" >/dev/null 2>&1; do
      attempts=$((attempts + 1))
      if [ "$attempts" -ge 36 ]; then
        printf '错误：公网 HTTPS 健康检查失败：%s。请检查 DNS、80/443 防火墙和 Caddy 日志。\n' "$endpoint" >&2
        return 1
      fi
      sleep 5
    done
    log "公网 HTTPS 已就绪：$endpoint"
  done
}

prepare_shared_layout
if [ -f "$SHARED_DIR/.env" ]; then
  UPGRADE_MODE=true
  AUTH_DOMAIN=$(sed -n 's/^AUTH_DOMAIN=//p' "$SHARED_DIR/.env" | tail -n 1)
  BUILD_DOMAIN=$(sed -n 's/^BUILD_DOMAIN=//p' "$SHARED_DIR/.env" | tail -n 1)
  if [ "$NODE_IMAGE_EXPLICIT" = false ]; then
    existing_node_image=$(sed -n 's/^APPGOG_NODE_IMAGE=//p' "$SHARED_DIR/.env" | tail -n 1)
    [ -z "$existing_node_image" ] || NODE_IMAGE=$existing_node_image
  fi
  if [ "$CADDY_IMAGE_EXPLICIT" = false ]; then
    existing_caddy_image=$(sed -n 's/^APPGOG_CADDY_IMAGE=//p' "$SHARED_DIR/.env" | tail -n 1)
    [ -z "$existing_caddy_image" ] || CADDY_IMAGE=$existing_caddy_image
  fi
fi
log "检测系统：${PRETTY_NAME:-$DISTRO}"
install_packages
prompt_domain AUTH_DOMAIN '授权中心域名'
prompt_domain BUILD_DOMAIN '客户打包中心域名'
[ "$AUTH_DOMAIN" != "$BUILD_DOMAIN" ] || fail '两个域名必须不同。'
install_docker
configure_registry_mirror
configure_cloudflare_dns
preflight_network
detect_local_source
if [ -n "$SOURCE_DIR" ]; then
  log "从本地源码安装到 $INSTALL_DIR"; copy_local_source
else
  log '下载并校验 APPGOG 正式发布包'; install_packages; download_source
fi

select_base_images
write_env
activate_release

if [ "$SKIP_START" = false ]; then
  if [ "$UPGRADE_MODE" = true ]; then
    log '检测到已有安装：创建完整备份、构建新版本并安全升级'
    if [ "$REPAIR_SOURCE" = true ]; then
      if ! (cd "$CURRENT_LINK" && APPGOG_NO_CACHE=true sh scripts/docker.sh update); then restore_previous_release; fail '源码修复失败，已恢复原版本。'; fi
    else
      if ! (cd "$CURRENT_LINK" && sh scripts/docker.sh update); then restore_previous_release; fail '升级失败，已恢复原版本。'; fi
    fi
  else
    log '构建镜像并启动 APPGOG'
    if ! (cd "$CURRENT_LINK" && sh scripts/docker.sh install); then restore_previous_release; fail '安装失败。'; fi
  fi
  if ! wait_public_https; then restore_previous_release; fail '部署健康检查失败，已恢复旧版本（如存在）。'; fi
  install_command
  install_update_helper
fi
if [ "$SKIP_START" = false ]; then print_result
else log '源码与环境已准备；按要求未启动，尚未验证公网 HTTPS。'
fi

if [ "$OPEN_MENU" = true ] && [ "$NON_INTERACTIVE" = false ] && { [ -t 0 ] || [ -t 1 ]; } && [ -r /dev/tty ]; then
  exec /usr/local/bin/appgog </dev/tty >/dev/tty
fi
