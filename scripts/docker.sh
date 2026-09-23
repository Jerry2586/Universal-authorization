#!/usr/bin/env sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"
compose() { docker compose -p "${APPGOG_PROJECT:-appgog}" -f "$ROOT_DIR/compose.yaml" "$@"; }
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
case "${1:-help}" in
  install|start)
    require_config
    compose up -d --build --force-recreate --wait --wait-timeout 180
    echo '安装完成。用 sh scripts/docker.sh credentials 查看初始管理员账号密码。'
    ;;
  update)
    require_config
    compose build
    backup
    compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180
    compose ps
    ;;
  backup) require_config; backup ;;
  restore)
    require_config
    [ -n "${2:-}" ] && [ -f "$2" ] || { echo '用法：sh scripts/docker.sh restore /绝对路径/备份.tar.gz' >&2; exit 1; }
    archive=$(CDPATH= cd -- "$(dirname -- "$2")" && pwd)/$(basename -- "$2")
    [ -z "$(compose ps --status running -q)" ] || { echo '恢复只能在未启动服务的新部署执行；现有数据不会被覆盖。' >&2; exit 1; }
    compose build
    compose run --rm --no-deps -T initialize node scripts/docker/restore.js - < "$archive"
    compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180
    ;;
  credentials)
    compose run --rm --no-deps -T --entrypoint cat initialize /app/runtime/license/initial-admin.txt
    ;;
  status) compose ps -a ;;
  *) echo '用法：sh scripts/docker.sh {install|update|backup|restore 备份路径|credentials|status}' ;;
esac
