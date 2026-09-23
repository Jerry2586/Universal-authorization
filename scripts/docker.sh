#!/usr/bin/env sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"
compose() { docker compose -p "${APPGOG_PROJECT:-appgog}" -f "$ROOT_DIR/compose.yaml" "$@"; }
fail() { echo "错误：$*" >&2; exit 1; }
compose_version_supported() {
  version=$(docker compose version --short 2>/dev/null | sed 's/^v//; s/[^0-9.].*$//')
  old_ifs=$IFS; IFS=.; set -- $version; IFS=$old_ifs
  major=${1:-0}; minor=${2:-0}
  case "$major:$minor" in *[!0-9:]*|:) return 1 ;; esac
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 24 ]; }
}
require_docker() {
  command -v docker >/dev/null 2>&1 || fail '未安装 Docker，请先执行 sudo sh scripts/install-linux.sh。'
  docker compose version >/dev/null 2>&1 || fail '未安装 Docker Compose v2。'
  compose_version_supported || fail 'Docker Compose 必须为 2.24 或更高版本。'
  docker info >/dev/null 2>&1 || fail 'Docker 服务未运行，或当前用户没有访问 Docker 的权限。'
}
require_config() {
  if [ ! -f .env ]; then
    echo '请复制 .env.docker.example 为 .env，只填写 AUTH_DOMAIN 和 BUILD_DOMAIN。' >&2
    exit 1
  fi
}
backup() (
  umask 077
  mkdir -p backups
  target="backups/appgog-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
  # Stop writers before archiving SQLite (including WAL), files and secrets together.
  running=$(compose ps --status running --services)
  trap 'if [ -n "$running" ]; then compose start $running >/dev/null || true; fi' EXIT
  compose stop build-worker
  compose stop build-center
  compose stop license-center
  compose run --rm --no-deps -T --entrypoint tar initialize -C /app -czf - \
    var/data var/keys var/artifacts var/uploads runtime/license runtime/build runtime/worker > "$target.partial"
  mv "$target.partial" "$target"
  echo "完整备份：$ROOT_DIR/$target（含私钥和凭证，请私密保存）"
)
logs() {
  service=${2:-all}
  tail_count=${3:-100}
  case "$tail_count" in ''|0|*[!0-9]*) fail '日志行数必须是正整数。' ;; esac
  case "$service" in
    all) compose logs --tail "$tail_count" initialize license-center build-center build-worker ;;
    initialize|license-center|build-center|build-worker) compose logs --tail "$tail_count" "$service" ;;
    *) fail '服务名只能是 all、initialize、license-center、build-center 或 build-worker。' ;;
  esac
}
doctor() {
  failed=0
  echo '== APPGOG 系统诊断 =='
  if command -v docker >/dev/null 2>&1; then
    echo "[正常] Docker：$(docker --version 2>/dev/null || echo 已安装)"
  else
    echo '[失败] 未安装 Docker'
    failed=1
  fi
  if docker compose version >/dev/null 2>&1 && compose_version_supported; then
    echo "[正常] Compose：$(docker compose version --short 2>/dev/null || docker compose version)"
  else
    echo '[失败] 未安装 Docker Compose v2.24 或更高版本'
    failed=1
  fi
  if docker info >/dev/null 2>&1; then
    echo '[正常] Docker 服务可访问'
  else
    echo '[失败] Docker 服务未运行，或当前用户无权限'
    failed=1
  fi
  if [ -f .env ]; then
    echo '[正常] .env 已存在'
  else
    echo '[失败] .env 不存在'
    failed=1
  fi
  if [ -f compose.yaml ] && compose config --quiet >/dev/null 2>&1; then
    echo '[正常] Compose 配置可解析'
  else
    echo '[失败] Compose 配置无效'
    failed=1
  fi
  running=$(compose ps --status running --services 2>/dev/null | awk '$0 == "license-center" || $0 == "build-center" || $0 == "build-worker" { count += 1 } END { print count + 0 }')
  if [ "$running" -eq 3 ]; then
    echo '[正常] 三个业务服务均在运行'
  else
    echo "[失败] 业务服务仅运行 $running/3"
    failed=1
  fi
  echo
  compose ps -a 2>/dev/null || true
  echo
  df -h "$ROOT_DIR" 2>/dev/null || true
  [ "$failed" -eq 0 ] || return 1
}
usage() {
  cat <<'EOF'
用法：sh scripts/docker.sh <命令>

  install                 首次构建并安装
  start                   启动已有服务
  stop                    停止业务服务
  restart                 重建并重启已有服务
  update                  构建、完整备份并更新
  backup                  创建完整备份
  restore <备份路径>      向空部署恢复备份
  credentials             查看初始管理员凭证
  status                  查看容器状态
  logs [服务] [行数]      查看日志，默认 all 100
  doctor                  检查 Docker、配置和容器状态
EOF
}
case "${1:-help}" in
  install)
    require_docker
    require_config
    compose up -d --build --force-recreate --wait --wait-timeout 180
    echo '安装完成。用 sh scripts/docker.sh credentials 查看初始管理员账号密码。'
    ;;
  start)
    require_docker
    require_config
    compose up -d --no-build --pull never --wait --wait-timeout 180
    ;;
  stop)
    require_docker
    require_config
    compose stop build-worker build-center license-center
    ;;
  restart)
    require_docker
    require_config
    compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180
    ;;
  update)
    require_docker
    require_config
    compose build
    backup
    compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180
    compose ps
    ;;
  backup) require_docker; require_config; backup ;;
  restore)
    require_docker
    require_config
    [ -n "${2:-}" ] && [ -f "$2" ] || { echo '用法：sh scripts/docker.sh restore /绝对路径/备份.tar.gz' >&2; exit 1; }
    archive=$(CDPATH= cd -- "$(dirname -- "$2")" && pwd)/$(basename -- "$2")
    [ -z "$(compose ps --status running -q)" ] || { echo '恢复只能在未启动服务的新部署执行；现有数据不会被覆盖。' >&2; exit 1; }
    compose build
    compose run --rm --no-deps -T initialize node scripts/docker/restore.js - < "$archive"
    compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180
    ;;
  credentials)
    require_docker
    require_config
    compose run --rm --no-deps -T --entrypoint cat initialize /app/runtime/license/initial-admin.txt
    ;;
  status) require_docker; compose ps -a ;;
  logs) require_docker; require_config; logs "$@" ;;
  doctor) doctor ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 1 ;;
esac
