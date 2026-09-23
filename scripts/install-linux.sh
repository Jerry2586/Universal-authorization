#!/usr/bin/env sh
set -eu

INSTALL_DIR=${APPGOG_INSTALL_DIR:-/opt/appgog}
REPOSITORY=${APPGOG_REPOSITORY:-https://github.com/Jerry2586/Universal-authorization.git}
VERSION=${APPGOG_VERSION:-}
SOURCE_SHA256=${APPGOG_SOURCE_SHA256:-}
AUTH_DOMAIN=${AUTH_DOMAIN:-}
BUILD_DOMAIN=${BUILD_DOMAIN:-}
SOURCE_DIR=${APPGOG_SOURCE_DIR:-}
SKIP_DOCKER=${APPGOG_SKIP_DOCKER_INSTALL:-false}
SKIP_START=false
SKIP_DNS_CHECK=false
NON_INTERACTIVE=false
OPEN_MENU=true

usage() {
  cat <<'EOF'
APPGOG Linux 一键安装器

  sudo sh scripts/install-linux.sh
  curl -fsSL <安装脚本地址> | sudo sh -s -- \
    --auth-domain auth.example.com --build-domain build.example.com

参数：
  --auth-domain DOMAIN       授权中心域名
  --build-domain DOMAIN      客户打包中心域名
  --install-dir PATH         安装目录（默认 /opt/appgog）
  --repository URL           Git 仓库或 .tar.gz/.tgz/.zip 发布包
  --version REF              Git 分支、标签或提交
  --sha256 HASH              校验下载发布包的 SHA-256
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
  case "$DISTRO" in
    ubuntu|debian)
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git tar gzip unzip openssl
      ;;
    centos|rhel|rocky|almalinux|fedora|ol)
      manager=dnf; command -v dnf >/dev/null 2>&1 || manager=yum
      "$manager" install -y ca-certificates curl git tar gzip unzip openssl
      ;;
    *) fail "不支持自动安装依赖的发行版：$DISTRO" ;;
  esac
}

install_docker() {
  if compose_supported; then
    if ! docker info >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker; fi
    docker info >/dev/null 2>&1 || fail 'Docker 已安装但服务不可访问。'
    docker buildx version >/dev/null 2>&1 || fail 'Docker Buildx 不可用；请安装 docker-buildx-plugin 后重试。'
    log "Docker 已安装：$(docker --version)"
    return
  fi
  [ "$SKIP_DOCKER" = false ] || fail 'Docker Compose v2 不可用。'
  if command -v docker >/dev/null 2>&1; then
    fail '检测到已有 Docker，但 Compose 低于 2.24 或不可用。为保护现有容器，安装器不会强制替换；请先升级 Docker Compose 后重试。'
  fi
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

valid_domain() {
  case "$1" in ''|*://*|*/*|*:*|*[!A-Za-z0-9.-]*|.*|*.) return 1 ;; *.*) return 0 ;; *) return 1 ;; esac
}

preflight_network() {
  disk_path=$(dirname -- "$INSTALL_DIR")
  while [ ! -d "$disk_path" ] && [ "$disk_path" != / ]; do disk_path=$(dirname -- "$disk_path"); done
  available_kb=$(df -Pk "$disk_path" 2>/dev/null | awk 'NR == 2 { print $4 }')
  case "$available_kb" in ''|*[!0-9]*) fail "无法检查安装目录所在磁盘：$disk_path" ;; esac
  [ "$available_kb" -ge 4194304 ] || fail '安装磁盘可用空间不足 4 GiB；请清理空间后重试。'
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)(80|443)$' && fail '80 或 443 端口已被占用；统一 Docker HTTPS 入口需要独占这两个端口。'
  fi
  [ "$SKIP_DNS_CHECK" = false ] || return 0
  public_ip=$(curl -4fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)
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

copy_local_source() {
  source_root=$(CDPATH= cd -- "$SOURCE_DIR" 2>/dev/null && pwd) || fail "源码目录不存在：$SOURCE_DIR"
  [ -f "$source_root/compose.yaml" ] && [ -f "$source_root/scripts/docker.sh" ] || fail '不是有效的 APPGOG 源码目录。'
  [ "$source_root" = "$INSTALL_DIR" ] && return
  [ ! -e "$INSTALL_DIR" ] || [ -z "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ] || fail "安装目录非空：$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  tar -C "$source_root" --exclude=.git --exclude=.env --exclude=backups --exclude=dist \
    --exclude=node_modules --exclude=runtime --exclude=var -cf - . | tar -C "$INSTALL_DIR" -xf -
}

download_source() {
  [ ! -e "$INSTALL_DIR" ] || [ -z "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ] || fail "安装目录非空：$INSTALL_DIR"
  mkdir -p "$(dirname -- "$INSTALL_DIR")"
  temp_dir=''
  case "$REPOSITORY" in
    *.tar.gz|*.tgz)
      temp_dir=$(mktemp -d); trap '[ -z "$temp_dir" ] || rm -rf "$temp_dir"' EXIT INT TERM
      curl -fL "$REPOSITORY" -o "$temp_dir/source.tar.gz"
      verify_download "$temp_dir/source.tar.gz"
      mkdir -p "$temp_dir/unpacked"
      tar -xzf "$temp_dir/source.tar.gz" -C "$temp_dir/unpacked"
      project_file=$(find "$temp_dir/unpacked" -mindepth 1 -maxdepth 3 -type f -name compose.yaml -print -quit)
      [ -n "$project_file" ] || fail '发布包中没有 compose.yaml。'
      project_root=$(dirname -- "$project_file")
      mkdir -p "$INSTALL_DIR"; cp -R "$project_root"/. "$INSTALL_DIR"/
      ;;
    *.zip)
      temp_dir=$(mktemp -d); trap '[ -z "$temp_dir" ] || rm -rf "$temp_dir"' EXIT INT TERM
      curl -fL "$REPOSITORY" -o "$temp_dir/source.zip"
      verify_download "$temp_dir/source.zip"
      unzip -q "$temp_dir/source.zip" -d "$temp_dir/unpacked"
      project_file=$(find "$temp_dir/unpacked" -mindepth 1 -maxdepth 3 -type f -name compose.yaml -print -quit)
      [ -n "$project_file" ] || fail '发布包中没有 compose.yaml。'
      project_root=$(dirname -- "$project_file")
      mkdir -p "$INSTALL_DIR"; cp -R "$project_root"/. "$INSTALL_DIR"/
      ;;
    *)
      if [ -n "$VERSION" ]; then
        GIT_TERMINAL_PROMPT=0 git clone "$REPOSITORY" "$INSTALL_DIR"
        git -C "$INSTALL_DIR" checkout "$VERSION"
      else
        GIT_TERMINAL_PROMPT=0 git clone --depth 1 "$REPOSITORY" "$INSTALL_DIR"
      fi
      ;;
  esac
  [ -f "$INSTALL_DIR/compose.yaml" ] && [ -f "$INSTALL_DIR/scripts/appgog.sh" ] || fail '下载内容不是有效安装包。'
}

write_env() {
  [ ! -f "$INSTALL_DIR/.env" ] || fail "为保护旧安装，不会覆盖 $INSTALL_DIR/.env"
  umask 077
  printf 'AUTH_DOMAIN=%s\nBUILD_DOMAIN=%s\nAPPGOG_VERSION=1.0.0\n' "$AUTH_DOMAIN" "$BUILD_DOMAIN" > "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env" 2>/dev/null || true
}

install_command() {
  command_path="$INSTALL_DIR/scripts/appgog.sh"
  chmod 755 "$command_path" "$INSTALL_DIR/scripts/docker.sh" "$INSTALL_DIR/scripts/install-linux.sh"
  if [ -e /usr/local/bin/appgog ] || [ -L /usr/local/bin/appgog ]; then
    existing=$(readlink /usr/local/bin/appgog 2>/dev/null || true)
    [ "$existing" = "$command_path" ] || fail '/usr/local/bin/appgog 已被其他程序占用。'
  fi
  temp_link=/usr/local/bin/.appgog.$$
  rm -f "$temp_link"; ln -s "$command_path" "$temp_link"; mv -f "$temp_link" /usr/local/bin/appgog
}

print_result() {
  cat <<EOF

============================================================
APPGOG 安装完成

管理后台：https://$AUTH_DOMAIN/admin
客户中心：https://$BUILD_DOMAIN/build
安装目录：$INSTALL_DIR
管理菜单：appgog

输入 appgog credentials 查看初始管理员账号密码。
统一 Docker 部署已通过 Caddy 自动申请并续期 HTTPS 证书。
============================================================
EOF
}

wait_public_https() {
  for endpoint in "https://$AUTH_DOMAIN/health" "https://$BUILD_DOMAIN/health"; do
    attempts=0
    until curl -fsS --max-time 10 "$endpoint" >/dev/null 2>&1; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 36 ] || fail "公网 HTTPS 健康检查失败：$endpoint。请检查 DNS、80/443 防火墙和 Caddy 日志。"
      sleep 5
    done
    log "公网 HTTPS 已就绪：$endpoint"
  done
}

log "检测系统：${PRETTY_NAME:-$DISTRO}"
prompt_domain AUTH_DOMAIN '授权中心域名'
prompt_domain BUILD_DOMAIN '客户打包中心域名'
[ "$AUTH_DOMAIN" != "$BUILD_DOMAIN" ] || fail '两个域名必须不同。'
install_docker
preflight_network
detect_local_source
if [ -n "$SOURCE_DIR" ]; then
  log "从本地源码安装到 $INSTALL_DIR"; copy_local_source
else
  log "从 $REPOSITORY 下载 APPGOG"; install_packages; download_source
fi

write_env
install_command

if [ "$SKIP_START" = false ]; then
  log '构建镜像并启动 APPGOG'
  (cd "$INSTALL_DIR" && sh scripts/docker.sh install)
  wait_public_https
fi
print_result

if [ "$OPEN_MENU" = true ] && [ "$NON_INTERACTIVE" = false ] && { [ -t 0 ] || [ -t 1 ]; } && [ -r /dev/tty ]; then
  exec /usr/local/bin/appgog </dev/tty >/dev/tty
fi
