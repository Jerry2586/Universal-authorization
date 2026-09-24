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
build_with_retry() {
  mkdir -p "$ROOT_DIR/logs"
  build_log="$ROOT_DIR/logs/build-$(date -u +%Y%m%dT%H%M%SZ).log"
  attempt=1
  max_attempts=${APPGOG_BUILD_ATTEMPTS:-3}
  case "$max_attempts" in ''|*[!0-9]*) fail 'APPGOG_BUILD_ATTEMPTS 必须是正整数' ;; esac
  [ "$max_attempts" -gt 0 ] || fail 'APPGOG_BUILD_ATTEMPTS 必须大于 0'
  while [ "$attempt" -le "$max_attempts" ]; do
    echo "构建镜像（第 $attempt/$max_attempts 次），日志：$build_log"
    if [ "${APPGOG_NO_CACHE:-false}" = true ]; then
      if compose build --no-cache > "$build_log.attempt" 2>&1; then
        cat "$build_log.attempt" >> "$build_log"; rm -f "$build_log.attempt"; return 0
      fi
    else
      if compose build > "$build_log.attempt" 2>&1; then
        cat "$build_log.attempt" >> "$build_log"; rm -f "$build_log.attempt"; return 0
      fi
    fi
    tee -a "$build_log" < "$build_log.attempt" >&2
    rm -f "$build_log.attempt"
    if [ "$attempt" -lt "$max_attempts" ]; then
      echo '构建失败，等待 5 秒后自动重试。' >&2
      sleep 5
    fi
    attempt=$((attempt + 1))
  done
  if grep -Eiq 'load metadata for|docker\.io|registry-1\.docker\.io|auth\.docker\.io|TLS handshake timeout|x509|no such host|i/o timeout|network is unreachable|connection refused' "$build_log"; then
    fail "基础镜像仓库、DNS 或 TLS 网络不可用。请重新执行同一条一键安装命令，让安装器重新探测镜像源。完整日志：$build_log"
  fi
  fail "Docker 镜像构建失败。完整日志：$build_log"
}
startup_wait_timeout() {
  value=${APPGOG_COMPOSE_WAIT_TIMEOUT:-360}
  case "$value" in ''|*[!0-9]*) fail 'APPGOG_COMPOSE_WAIT_TIMEOUT 必须是正整数秒数' ;; esac
  [ "$value" -ge 60 ] || fail 'APPGOG_COMPOSE_WAIT_TIMEOUT 不能少于 60 秒'
  printf '%s' "$value"
}
capture_startup_failure() {
  attempt_label=$1
  mkdir -p "$ROOT_DIR/logs"
  target="$ROOT_DIR/logs/startup-failure-$(date -u +%Y%m%dT%H%M%SZ)-$attempt_label.log"
  container=$(compose ps -a -q appgog 2>/dev/null || true)
  {
    echo "APPGOG 启动失败诊断（$attempt_label）"
    echo "时间：$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo
    compose ps -a 2>&1 || true
    if [ -n "$container" ]; then
      echo
      docker inspect --format '容器状态={{.State.Status}} 退出码={{.State.ExitCode}} OOM={{.State.OOMKilled}} 错误={{.State.Error}}' "$container" 2>&1 || true
      docker inspect --format '{{if .State.Health}}健康状态={{.State.Health.Status}}{{range .State.Health.Log}}{{printf "\n[%s] exit=%d %s" .End .ExitCode .Output}}{{end}}{{end}}' "$container" 2>&1 || true
      echo
      echo '最近容器日志：'
      docker logs --timestamps --tail 300 "$container" 2>&1 || true
    fi
  } > "$target"
  chmod 600 "$target" 2>/dev/null || true
  echo "启动失败诊断已保存：$target" >&2
  tail -n 120 "$target" >&2 || true
}
start_candidate() {
  wait_timeout=$(startup_wait_timeout)
  compose up -d --no-build --pull never --force-recreate --wait --wait-timeout "$wait_timeout" appgog
}
prepare_update_control() {
  compose run --rm --no-deps -T --user 0 --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --entrypoint sh appgog -c \
    'mkdir -p /app/var/update-control/requests && chown -R 1000:1000 /app/var/update-control && chmod 770 /app/var/update-control /app/var/update-control/requests'
}
project_containers() {
  docker ps "$@" --filter "label=com.docker.compose.project=${APPGOG_PROJECT:-appgog}" --format '{{.ID}} {{.Label "com.docker.compose.service"}}' |
    awk '$2 ~ /^(appgog|initialize|license-center|build-center|build-worker|caddy)$/ { print $1 }'
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
  running=$(project_containers)
  trap 'rm -f "$plain" "$encrypted"; if [ -n "$running" ]; then docker start $running >/dev/null || true; fi' 0
  [ -z "$running" ] || docker stop $running >/dev/null
  compose run --rm --no-deps -T --user 0 --cap-add DAC_OVERRIDE --entrypoint tar appgog -C /app -czf - \
    var/data var/keys var/artifacts var/uploads runtime/license runtime/build runtime/worker runtime/caddy-data runtime/caddy-config > "$plain"
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$plain" -out "$encrypted"
  rm -f "$plain"
  mv "$encrypted" "$target"
  echo "加密完整备份：$ROOT_DIR/$target"
  echo "恢复密钥：$BACKUP_KEY_FILE（请单独离线保存，不要和备份放在同一位置）"
)
validate_mounts() {
  for container in $(project_containers -a); do
    docker inspect --format '{{range .Mounts}}{{.Type}} {{if .Name}}{{.Name}}{{else}}-{{end}} {{println .Destination}}{{end}}' "$container" |
      while read -r kind name destination; do
        expected=''
        case "$destination" in
          /app/var/data) expected=appgog-db ;;
          /app/var/keys) expected=appgog-keys ;;
          /app/var/artifacts) expected=appgog-artifacts ;;
          /app/var/uploads) expected=appgog-uploads ;;
          /app/runtime/license) expected=appgog-license-config ;;
          /app/runtime/build) expected=appgog-build-config ;;
          /app/runtime/worker) expected=appgog-worker-config ;;
          /data|/app/runtime/caddy-data) expected=appgog-caddy-data ;;
          /config|/app/runtime/caddy-config) expected=appgog-caddy-config ;;
          /app/var|/app/runtime|/app) fail '检测到自定义数据挂载，请先迁移到标准命名卷，禁止空卷覆盖旧实例。' ;;
        esac
        if [ -n "$expected" ]; then
          [ "$kind" = volume ] && [ "$name" = "${APPGOG_PROJECT:-appgog}_$expected" ] || fail "检测到自定义数据卷：$destination；请先映射原数据。"
        fi
      done || return 1
  done
}
deploy() (
  # Build before interrupting the running installation. Keep only single-container rollback images.
  validate_mounts
  previous=$(compose ps -a -q appgog)
  previous_image=''
  if [ -n "$previous" ]; then previous_image=$(docker inspect --format '{{.Image}}' "$previous"); fi
  build_with_retry
  image_name=$(compose config --images | head -n 1)
  [ -z "$previous_image" ] || docker tag "$previous_image" appgog-platform:rollback
  existing=$(project_containers -a)
  if [ -n "$existing" ] || docker volume inspect "${APPGOG_PROJECT:-appgog}_appgog-db" >/dev/null 2>&1; then
    backup
  fi
  legacy=$(docker ps -a --filter "label=com.docker.compose.project=${APPGOG_PROJECT:-appgog}" --format '{{.ID}} {{.Label "com.docker.compose.service"}}' | awk '$2 ~ /^(initialize|license-center|build-center|build-worker|caddy)$/ {print $1}')
  running=$(project_containers)
  switched=false
  runtime_backup=''
  cleanup_deploy() {
    if [ "$switched" = false ] && [ -n "$runtime_backup" ]; then
      compose run --rm --no-deps -T --user 0 --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER --entrypoint tar appgog -C /app -xzf - < "$runtime_backup" || {
        echo '旧运行配置恢复失败，保留停止状态；请使用完整备份恢复。' >&2
        rm -f "$runtime_backup"
        return
      }
    fi
    if [ "$switched" = false ] && [ -n "$running" ]; then docker start $running >/dev/null || true; fi
    [ -z "$runtime_backup" ] || rm -f "$runtime_backup"
  }
  trap cleanup_deploy 0
  [ -z "$running" ] || docker stop $running >/dev/null
  if [ -n "$legacy" ]; then
    umask 077
    runtime_candidate=$(mktemp)
    if ! compose run --rm --no-deps -T --user 0 --cap-add DAC_OVERRIDE --entrypoint tar appgog -C /app -czf - runtime/license runtime/build runtime/worker > "$runtime_candidate"; then
      rm -f "$runtime_candidate"
      fail '无法保存旧运行配置，停止迁移。'
    fi
    runtime_backup=$runtime_candidate
  fi
  # Old Caddy ran as root. Only this short maintenance helper owns elevated capabilities.
  compose run --rm --no-deps -T --user 0 --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --entrypoint sh appgog -c \
    'mkdir -p /app/var/update-control/requests && chown -R 1000:1000 /app/var/data /app/var/keys /app/var/artifacts /app/var/uploads /app/var/update-control /app/runtime/license /app/runtime/build /app/runtime/worker /app/runtime/caddy-data /app/runtime/caddy-config && chmod 770 /app/var/update-control /app/var/update-control/requests'
  if ! start_candidate; then
    capture_startup_failure first
    compose stop appgog || true
    echo '新版本首次启动未通过健康检查，自动重试一次。' >&2
    if ! start_candidate; then
      capture_startup_failure second
      compose stop appgog || true
      if [ -n "$previous_image" ]; then
        docker tag "$previous_image" "$image_name"
        if start_candidate; then switched=true
        else echo '原版本自动恢复也未通过健康检查，请立即查看启动失败诊断和加密备份。' >&2; fi
      fi
      fail '安装/更新健康检查失败；已尝试恢复原服务，数据备份保留在 backups，详细原因已保存到 logs/startup-failure-*.log。'
    fi
    echo '新版本第二次启动已恢复正常。'
  fi
  switched=true
  [ -z "$legacy" ] || docker rm $legacy >/dev/null
  compose ps
)
logs() {
  service=${2:-all}
  tail_count=${3:-100}
  case "$tail_count" in ''|0|*[!0-9]*) fail '日志行数必须是正整数。' ;; esac
  case "$service" in
    all|initialize|license-center|build-center|build-worker|caddy|appgog) compose logs --tail "$tail_count" appgog ;;
    *) fail '日志参数只能是 all、appgog 或逻辑组件名称。' ;;
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
  running=$(compose ps --status running --services 2>/dev/null | awk '$0 == "appgog" { count += 1 } END { print count + 0 }')
  if [ "$running" -eq 1 ] && compose ps --status running appgog 2>/dev/null | grep -q '(healthy)'; then
    echo '[正常] 单一 appgog 容器运行，内部四个进程健康'
  else
    echo "[失败] appgog 单容器未达到健康状态"
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
  if compose run --rm --no-deps -T --entrypoint sh appgog -c '
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
  compose run --rm --no-deps -T --entrypoint sh appgog -c '
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
  install|update)
    require_docker
    require_config
    deploy
    echo '单容器安装完成。用 sh scripts/docker.sh credentials 查看初始管理员账号密码。'
    ;;
  start)
    require_docker
    require_config
    prepare_update_control
    compose up -d --no-build --pull never --wait --wait-timeout 180
    ;;
  stop)
    require_docker
    require_config
    compose stop appgog
    ;;
  restart)
    require_docker
    require_config
    prepare_update_control
    compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180
    ;;

  backup) require_docker; require_config; backup ;;
  restore)
    require_docker
    require_config
    [ -n "${2:-}" ] && [ -f "$2" ] || { echo '用法：sh scripts/docker.sh restore /绝对路径/备份.tar.gz.enc' >&2; exit 1; }
    archive=$(CDPATH= cd -- "$(dirname -- "$2")" && pwd)/$(basename -- "$2")
    [ -z "$(compose ps --status running -q)" ] || { echo '恢复只能在未启动服务的新部署执行；现有数据不会被覆盖。' >&2; exit 1; }
    build_with_retry
    prepare_update_control
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
        if ! compose run --rm --no-deps -T appgog node scripts/docker/restore.js - < "$decrypted"; then
          fail '备份内容校验或恢复失败；目标部署必须为空，且备份必须完整。'
        fi
        rm -f "$decrypted"
        trap - 0 1 2 15
        ;;
      *)
        echo '警告：正在恢复旧版未加密备份；恢复后请立即创建新的 .enc 加密备份。' >&2
        compose run --rm --no-deps -T appgog node scripts/docker/restore.js - < "$archive"
        ;;
    esac
    compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180
    ;;
  credentials)
    require_docker
    require_config
    compose run --rm --no-deps -T --entrypoint cat appgog /app/runtime/license/initial-admin.txt
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
