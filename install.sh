#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/Jerry2586/Universal-authorization.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/universal-authorization}"
AUTO_INSTALL_DOCKER="${AUTO_INSTALL_DOCKER:-1}"

print_step() {
  printf '\n\033[36m==> %s\033[0m\n' "$1"
}

print_error() {
  printf '\n\033[31m错误：%s\033[0m\n' "$1" >&2
}

on_error() {
  local exit_code=$?
  print_error "安装在第 ${BASH_LINENO[0]:-未知} 行失败，退出码：${exit_code}"
  if command -v docker >/dev/null 2>&1 && [ -d "$INSTALL_DIR" ]; then
    (cd "$INSTALL_DIR" && docker compose ps && docker compose logs --tail 80 app) || true
  fi
  exit "$exit_code"
}
trap on_error ERR

usage() {
  cat <<'EOF'
通用 Key 授权服务器 Linux 一键安装器

用法：
  install.sh [选项]

选项：
  --dir PATH          安装目录，默认 /opt/universal-authorization
  --branch NAME       Git 分支，默认 main
  --repo URL          Git 仓库地址
  --skip-docker       不自动安装 Docker
  -h, --help          显示帮助

环境变量：
  INSTALL_DIR、BRANCH、REPOSITORY_URL、AUTO_INSTALL_DOCKER
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -ge 2 ] || { print_error '--dir 缺少路径'; exit 2; }
      INSTALL_DIR=$2
      shift 2
      ;;
    --branch)
      [ "$#" -ge 2 ] || { print_error '--branch 缺少分支名称'; exit 2; }
      BRANCH=$2
      shift 2
      ;;
    --repo)
      [ "$#" -ge 2 ] || { print_error '--repo 缺少仓库地址'; exit 2; }
      REPOSITORY_URL=$2
      shift 2
      ;;
    --skip-docker)
      AUTO_INSTALL_DOCKER=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      print_error "未知参数：$1"
      usage
      exit 2
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  print_error '请使用 root 权限运行。推荐命令：curl -fsSL 安装地址 | sudo bash'
  exit 1
fi

case "$INSTALL_DIR" in
  /*) ;;
  *)
    print_error '安装目录必须是绝对路径。'
    exit 1
    ;;
esac

case "$INSTALL_DIR" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|*'/../'*|*/..|*'/./'*|*/.)
    print_error "拒绝使用危险的安装目录：${INSTALL_DIR}"
    exit 1
    ;;
esac

if [ ! -r /etc/os-release ]; then
  print_error '无法识别 Linux 发行版：缺少 /etc/os-release'
  exit 1
fi

# shellcheck disable=SC1091
. /etc/os-release
OS_ID="${ID:-unknown}"
OS_LIKE="${ID_LIKE:-}"

install_base_tools() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y ca-certificates curl git
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl git
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates curl git
    return
  fi

  if command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install ca-certificates curl git
    return
  fi

  print_error "暂不支持自动安装基础工具的发行版：${OS_ID} ${OS_LIKE}"
  exit 1
}

install_compose_plugin() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y docker-compose-plugin || return 1
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y docker-compose-plugin || return 1
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y docker-compose-plugin || return 1
    return
  fi

  return 1
}

install_docker() {
  if [ "$AUTO_INSTALL_DOCKER" != '1' ]; then
    print_error '未检测到可用的 Docker/Compose，并且已经指定 --skip-docker。'
    exit 1
  fi

  if command -v docker >/dev/null 2>&1; then
    print_step 'Docker 已存在，尝试补装 Docker Compose 插件'
    install_compose_plugin || true
    return
  fi

  print_step '使用 Docker 官方测试环境安装脚本安装 Docker Engine 和 Compose'
  local installer
  installer=$(mktemp)
  curl --proto '=https' --tlsv1.2 -fsSL https://get.docker.com -o "$installer"
  sh "$installer"
  rm -f "$installer"
}

start_docker() {
  if docker info >/dev/null 2>&1; then
    return
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker; then
    :
  elif command -v service >/dev/null 2>&1; then
    service docker start
  fi

  local attempt=1
  while [ "$attempt" -le 30 ]; do
    if docker info >/dev/null 2>&1; then
      return
    fi
    attempt=$((attempt + 1))
    sleep 2
  done

  print_error 'Docker 服务启动超时，请检查系统日志。'
  exit 1
}

print_step "识别系统：${PRETTY_NAME:-$OS_ID}"
print_step '安装 Git、curl 和 CA 证书'
install_base_tools

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  install_docker
fi

if ! command -v docker >/dev/null 2>&1; then
  print_error 'Docker 安装失败。'
  exit 1
fi

start_docker

if ! docker compose version >/dev/null 2>&1; then
  print_error 'Docker Compose v2 插件不可用，请检查 Docker 软件源。'
  exit 1
fi

print_step "检查远端分支：${BRANCH}"
if ! git ls-remote --exit-code --heads "$REPOSITORY_URL" "refs/heads/$BRANCH" >/dev/null 2>&1; then
  print_error "远端分支不存在或当前无法访问：$BRANCH"
  exit 1
fi

print_step "拉取授权服务器源码到 ${INSTALL_DIR}"
if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR"

  if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
    print_error "${INSTALL_DIR} 中存在未提交的源码改动。为避免覆盖数据，安装器已停止。"
    exit 1
  fi

  git remote set-url origin "$REPOSITORY_URL"
  git fetch --prune origin "refs/heads/$BRANCH"
  FETCHED_COMMIT=$(git rev-parse --verify FETCH_HEAD)

  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git checkout "$BRANCH"
  else
    git checkout -b "$BRANCH" "$FETCHED_COMMIT"
    git config "branch.$BRANCH.remote" origin
    git config "branch.$BRANCH.merge" "refs/heads/$BRANCH"
  fi

  git merge --ff-only "$FETCHED_COMMIT"
elif [ -e "$INSTALL_DIR" ] && [ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  print_error "安装目录已经存在且不是 Git 仓库：${INSTALL_DIR}"
  exit 1
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 --branch "$BRANCH" "$REPOSITORY_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
chmod +x deploy.sh show-admin-login.sh scripts/docker-entrypoint.sh

SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
SERVER_IP=${SERVER_IP:-服务器IP}

print_step '开始构建并启动通用 Key 授权服务器'
PUBLIC_HOST="$SERVER_IP" ./deploy.sh

PORT=$(grep '^PORT=' .env | head -n 1 | cut -d '=' -f 2- || true)
PORT=${PORT:-3000}

printf '\n\033[32m  Linux 一键拉取和安装已经完成\033[0m\n'
printf '  安装目录：%s\n\n' "$INSTALL_DIR"

# 安装器必须在最终成功区直接显示可登录的真实凭据，用户无需再执行其他命令。
PUBLIC_HOST="$SERVER_IP" ./show-admin-login.sh --show

printf '  登录信息文件：%s/admin-login.txt\n' "$INSTALL_DIR"
printf '  随时查看账号密码：sudo cat %s/admin-login.txt\n' "$INSTALL_DIR"
printf '  或执行：cd %s && sudo ./show-admin-login.sh\n' "$INSTALL_DIR"
printf '  后台地址：http://%s:%s/admin/\n' "$SERVER_IP" "$PORT"
printf '  健康检查：http://%s:%s/health\n' "$SERVER_IP" "$PORT"
printf '  就绪检查：http://%s:%s/ready\n' "$SERVER_IP" "$PORT"
printf '  查看日志：cd %s && docker compose logs -f app\n' "$INSTALL_DIR"
printf '  更新程序：重新执行同一条一键安装命令\n'
printf '==================================================\033[0m\n'
