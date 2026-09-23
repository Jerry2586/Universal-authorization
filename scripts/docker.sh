#!/usr/bin/env sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"
BACKUP_KEY_FILE=${APPGOG_BACKUP_KEY_FILE:-$ROOT_DIR/.backup-key}
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
  command -v openssl >/dev/null 2>&1 || fail '创建加密备份需要 OpenSSL。'
  mkdir -p backups
  if [ ! -f "$BACKUP_KEY_FILE" ]; then
    openssl rand -base64 48 > "$BACKUP_KEY_FILE"
    chmod 600 "$BACKUP_KEY_FILE" 2>/dev/null || true
    echo "已生成独立备份恢复密钥：$BACKUP_KEY_FILE（必须与备份分开保存）"
  fi
  [ -r "$BACKUP_KEY_FILE" ] || fail "无法读取备份恢复密钥：$BACKUP_KEY_FILE"
  target="backups/appgog-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz.enc"
  plain="$target.partial.tar.gz"
  encrypted="$target.partial"
  # Stop writers before archiving SQLite (including WAL), files and secrets together.
  running=$(compose ps --status running --services)
  trap 'rm -f "$plain" "$encrypted"; if [ -n "$running" ]; then compose start $running >/dev/null || true; fi' EXIT
  compose stop caddy
  compose stop build-worker
  compose stop build-center
  compose stop license-center
  compose run --rm --no-deps -T --entrypoint tar initialize -C /app -czf - \
    var/data var/keys var/artifacts var/uploads runtime/license runtime/build runtime/worker runtime/caddy-data runtime/caddy-config > "$plain"
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$plain" -out "$encrypted"
  rm -f "$plain"
  mv "$encrypted" "$target"
  echo "加密完整备份：$ROOT_DIR/$target"
  echo "恢复密钥：$BACKUP_KEY_FILE（请单独离线保存，不要和备份放在同一位置）"
)
logs() {
  service=${2:-all}
  tail_count=${3:-100}
  case "$tail_count" in ''|0|*[!0-9]*) fail '日志行数必须是正整数。' ;; esac
  case "$service" in
    all) compose logs --tail "$tail_count" initialize license-center build-center build-worker caddy ;;
    initialize|license-center|build-center|build-worker|caddy) compose logs --tail "$tail_count" "$service" ;;
    *) fail '服务名只能是 all、initialize、license-center、build-center、build-worker 或 caddy。' ;;
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
  running=$(compose ps --status running --services 2>/dev/null | awk '$0 == "license-center" || $0 == "build-center" || $0 == "build-worker" || $0 == "caddy" { count += 1 } END { print count + 0 }')
  if [ "$running" -eq 4 ]; then
    echo '[正常] 三个业务服务与 HTTPS 入口均在运行'
  else
    echo "[失败] 核心服务仅运行 $running/4"
    failed=1
  fi
  echo
  compose ps -a 2>/dev/null || true
  echo
  df -h "$ROOT_DIR" 2>/dev/null || true
  if command -v free >/dev/null 2>&1; then
    echo
    free -h 2>/dev/null || true
  fi
  if [ -f .env ]; then
    auth_domain=$(sed -n 's/^AUTH_DOMAIN=//p' .env | tail -n 1)
    build_domain=$(sed -n 's/^BUILD_DOMAIN=//p' .env | tail -n 1)
    for domain in "$auth_domain" "$build_domain"; do
      if getent ahostsv4 "$domain" >/dev/null 2>&1; then
        echo "[正常] DNS A 记录可解析：$domain"
      else
        echo "[失败] DNS A 记录不可解析：$domain"
        failed=1
      fi
      endpoint="https://$domain/health"
      if curl -fsS --max-time 10 "$endpoint" >/dev/null 2>&1; then
        echo "[正常] 公网 HTTPS：$endpoint"
      else
        echo "[失败] 公网 HTTPS 不可用：$endpoint"
        failed=1
      fi
      if command -v openssl >/dev/null 2>&1; then
        cert_end=$(openssl s_client -connect "$domain:443" -servername "$domain" </dev/null 2>/dev/null \
          | openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//' || true)
        if [ -n "$cert_end" ]; then echo "[正常] TLS 证书到期：$domain → $cert_end"
        else echo "[失败] 无法读取 TLS 证书：$domain"; failed=1
        fi
      fi
    done
  fi
  if compose run --rm --no-deps -T --entrypoint sh initialize -c '
    test -s /app/var/keys/ed25519-private.pem && test -s /app/var/keys/ed25519-public.pem &&
    test "$(stat -c %a /app/var/keys/ed25519-private.pem 2>/dev/null)" = 600
  ' >/dev/null 2>&1; then
    echo '[正常] Ed25519 签名密钥完整，私钥权限为 600'
  else
    echo '[失败] 签名密钥缺失、损坏或私钥权限不安全'
    failed=1
  fi
  latest_backup=$(find backups -maxdepth 1 -type f -name 'appgog-*.tar.gz.enc' -print 2>/dev/null | sort -r | head -n 1 || true)
  if [ -n "$latest_backup" ]; then echo "[正常] 最近加密备份：$latest_backup"
  else echo '[提示] 尚未创建加密完整备份'
  fi
  [ "$failed" -eq 0 ] || return 1
}
diagnostics() (
  umask 077
  mkdir -p logs
  target="logs/diagnostic-$(date -u +%Y%m%dT%H%M%SZ)-$$.txt"
  {
    echo 'APPGOG 诊断报告'
    echo "生成时间：$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "系统：$(uname -a 2>/dev/null || echo unknown)"
    echo "Docker：$(docker --version 2>/dev/null || echo unavailable)"
    echo "Compose：$(docker compose version 2>/dev/null || echo unavailable)"
    echo
    echo '== 容器状态 =='
    compose ps -a 2>&1 || true
    echo
    echo '== 磁盘 =='
    df -h "$ROOT_DIR" 2>&1 || true
    echo
    echo '== 内存 =='
    free -h 2>&1 || true
    echo
    echo '== Docker 占用 =='
    docker system df 2>&1 || true
    echo
    echo '== 公网入口 =='
    auth_domain=$(sed -n 's/^AUTH_DOMAIN=//p' .env | tail -n 1)
    build_domain=$(sed -n 's/^BUILD_DOMAIN=//p' .env | tail -n 1)
    for domain in "$auth_domain" "$build_domain"; do
      echo "$domain DNS: $(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
      if command -v openssl >/dev/null 2>&1; then
        openssl s_client -connect "$domain:443" -servername "$domain" </dev/null 2>/dev/null \
          | openssl x509 -noout -subject -dates 2>/dev/null || true
      fi
      curl -fsSI --max-time 10 "https://$domain/health" 2>&1 | sed -n '1,5p' || true
    done
  } > "$target"
  echo "诊断报告：$ROOT_DIR/$target（不包含 .env、凭证或业务日志）"
)
repair_permissions() {
  [ -f .env ] && chmod 600 .env 2>/dev/null || true
  mkdir -p backups logs
  chmod 700 backups logs 2>/dev/null || true
  compose run --rm --no-deps -T --entrypoint sh initialize -c '
    chmod 700 /app/var/keys /app/runtime/license /app/runtime/build /app/runtime/worker 2>/dev/null || true
    find /app/var/keys -type f -exec chmod 600 {} + 2>/dev/null || true
    find /app/runtime/license /app/runtime/build /app/runtime/worker -type f -exec chmod 600 {} + 2>/dev/null || true
  '
  echo 'APPGOG 配置、备份目录和密钥文件权限已按最小权限修复。'
}
cleanup_images() {
  docker image prune -f
}
usage() {
  cat <<'EOF'
用法：sh scripts/docker.sh <命令>

  install                 首次构建并安装
  start                   启动已有服务
  stop                    停止业务服务
  restart                 重建并重启已有服务
  update                  构建、完整备份并更新
  rollback                回滚到最近一次更新前镜像
  backup                  创建完整备份
  restore <备份路径>      向空部署恢复备份（.enc 需要独立恢复密钥）
  credentials             查看初始管理员凭证
  status                  查看容器状态
  logs [服务] [行数]      查看日志，默认 all 100
  doctor                  检查 Docker、配置和容器状态
  diagnostics             导出脱敏诊断报告
  repair-permissions      修复配置与密钥文件权限
  cleanup-images          清理未被使用的悬空镜像
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
    compose stop caddy build-worker build-center license-center
    ;;
  restart)
    require_docker
    require_config
    compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180
    ;;
  update)
    require_docker
    require_config
    backup
    image_name=${APPGOG_IMAGE:-appgog-platform:local}
    if docker image inspect "$image_name" >/dev/null 2>&1; then docker tag "$image_name" appgog-platform:rollback; fi
    compose build
    if ! compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180; then
      echo '更新健康检查失败，正在自动回滚镜像...' >&2
      if docker image inspect appgog-platform:rollback >/dev/null 2>&1; then
        docker tag appgog-platform:rollback "$image_name"
        compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180
      fi
      fail '更新失败，已尝试恢复更新前镜像；请运行 doctor 和 logs。'
    fi
    compose ps
    ;;
  rollback)
    require_docker
    require_config
    docker image inspect appgog-platform:rollback >/dev/null 2>&1 || fail '没有可用的更新前回滚镜像。'
    image_name=${APPGOG_IMAGE:-appgog-platform:local}
    backup
    docker tag appgog-platform:rollback "$image_name"
    compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180
    ;;
  backup) require_docker; require_config; backup ;;
  restore)
    require_docker
    require_config
    [ -n "${2:-}" ] && [ -f "$2" ] || { echo '用法：sh scripts/docker.sh restore /绝对路径/备份.tar.gz.enc' >&2; exit 1; }
    archive=$(CDPATH= cd -- "$(dirname -- "$2")" && pwd)/$(basename -- "$2")
    [ -z "$(compose ps --status running -q)" ] || { echo '恢复只能在未启动服务的新部署执行；现有数据不会被覆盖。' >&2; exit 1; }
    compose build
    case "$archive" in
      *.enc)
        command -v openssl >/dev/null 2>&1 || fail '恢复加密备份需要 OpenSSL。'
        [ -r "$BACKUP_KEY_FILE" ] || fail "缺少备份恢复密钥：$BACKUP_KEY_FILE。请从独立安全位置复制后重试。"
        umask 077
        decrypted=$(mktemp "${TMPDIR:-/tmp}/appgog-restore.XXXXXX.tar.gz") || fail '无法创建恢复临时文件。'
        trap 'rm -f "$decrypted"' 0 1 2 15
        if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$archive" -out "$decrypted"; then
          fail '备份解密失败；请检查备份文件与独立恢复密钥是否匹配。'
        fi
        if ! compose run --rm --no-deps -T initialize node scripts/docker/restore.js - < "$decrypted"; then
          fail '备份内容校验或恢复失败；目标部署必须为空，且备份必须完整。'
        fi
        rm -f "$decrypted"
        trap - 0 1 2 15
        ;;
      *)
        echo '警告：正在恢复旧版未加密备份；恢复后请立即创建新的 .enc 加密备份。' >&2
        compose run --rm --no-deps -T initialize node scripts/docker/restore.js - < "$archive"
        ;;
    esac
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
  diagnostics) require_docker; require_config; diagnostics ;;
  repair-permissions) require_docker; require_config; repair_permissions ;;
  cleanup-images) require_docker; cleanup_images ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 1 ;;
esac
