#!/usr/bin/env sh
set -u

resolve_root() {
  if [ -n "${APPGOG_ROOT:-}" ]; then
    CDPATH= cd -- "$APPGOG_ROOT" 2>/dev/null && pwd
    return
  fi
  script_path=$0
  if command -v readlink >/dev/null 2>&1; then
    resolved=$(readlink -f "$script_path" 2>/dev/null || true)
    [ -z "$resolved" ] || script_path=$resolved
  fi
  CDPATH= cd -- "$(dirname -- "$script_path")/.." 2>/dev/null && pwd
}

ROOT_DIR=$(resolve_root) || {
  echo '无法定位 APPGOG 安装目录。请设置 APPGOG_ROOT。' >&2
  exit 1
}
case "$ROOT_DIR" in */releases/*) INSTALL_ROOT=${ROOT_DIR%/releases/*} ;; *) INSTALL_ROOT=$ROOT_DIR ;; esac
SHARED_DIR="$INSTALL_ROOT/shared"
DOCKER_SCRIPT="$ROOT_DIR/scripts/docker.sh"
ENV_FILE="$ROOT_DIR/.env"
OPERATIONS_LOG="$SHARED_DIR/logs/operations.log"

[ -f "$DOCKER_SCRIPT" ] && [ -f "$ROOT_DIR/compose.yaml" ] || {
  echo "APPGOG 安装目录无效：$ROOT_DIR" >&2
  exit 1
}

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BLUE='\033[1;34m'; GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'; DIM='\033[2m'; RESET='\033[0m'
else
  BLUE=''; GREEN=''; YELLOW=''; RED=''; DIM=''; RESET=''
fi

say_ok() { printf '%b[成功]%b %s\n' "$GREEN" "$RESET" "$*"; }
say_warn() { printf '%b[提示]%b %s\n' "$YELLOW" "$RESET" "$*"; }
say_error() { printf '%b[失败]%b %s\n' "$RED" "$RESET" "$*" >&2; }

tty_read() {
  prompt_text=$1
  REPLY_VALUE=''
  if { [ -t 0 ] || [ -t 1 ]; } && [ -r /dev/tty ]; then
    printf '%s' "$prompt_text" >/dev/tty
    IFS= read -r REPLY_VALUE </dev/tty || true
  else
    printf '%s' "$prompt_text"
    IFS= read -r REPLY_VALUE || true
  fi
}

pause_menu() {
  tty_read '按回车键继续...'
}

confirm() {
  tty_read "$1 [y/N] "
  case "$REPLY_VALUE" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

run_docker() {
  umask 077
  mkdir -p "$SHARED_DIR/logs"
  printf '%s actor=%s command=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(id -un 2>/dev/null || echo unknown)" "$1" >> "$OPERATIONS_LOG"
  (cd "$ROOT_DIR" && sh "$DOCKER_SCRIPT" "$@")
}

run_signed_installer() {
  requested=${1:-}; repair=${2:-false}; log_name=${3:-update.log}
  mkdir -p "$SHARED_DIR/logs"
  bootstrap=$(mktemp) || return 1
  cp "$ROOT_DIR/install-docker.sh" "$bootstrap" || { rm -f "$bootstrap"; return 1; }
  chmod 700 "$bootstrap"
  if [ -n "$requested" ]; then
    APPGOG_VERSION="$requested" APPGOG_INSTALL_DIR="$INSTALL_ROOT" APPGOG_REPAIR_SOURCE="$repair" \
      sh "$bootstrap" --install-dir "$INSTALL_ROOT" --non-interactive --no-menu 2>&1 | tee -a "$SHARED_DIR/logs/$log_name"
  else
    APPGOG_INSTALL_DIR="$INSTALL_ROOT" sh "$bootstrap" --install-dir "$INSTALL_ROOT" --non-interactive --no-menu 2>&1 | tee -a "$SHARED_DIR/logs/$log_name"
  fi
  result=$?; rm -f "$bootstrap"; return "$result"
}

online_update() { run_signed_installer '' false update.log; }

repair_source() {
  version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT_DIR/package.json" | head -n 1)
  [ -n "$version" ] || { say_error '无法识别当前版本。'; return 1; }
  run_signed_installer "$version" true repair.log
}

uninstall_keep_data() {
  [ "$(id -u)" -eq 0 ] || { say_error '卸载需要使用 root 或 sudo。'; return 1; }
  case "$INSTALL_ROOT" in /opt/appgog|/srv/appgog|/home/*/appgog) ;; *) say_error "拒绝卸载非标准目录：$INSTALL_ROOT"; return 1 ;; esac
  mkdir -p "$SHARED_DIR/logs"
  uninstall_log="$SHARED_DIR/logs/uninstall.log"
  printf '%s 开始保留数据卸载\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$uninstall_log"
  run_docker backup 2>&1 | tee -a "$uninstall_log" || return 1
  (cd "$ROOT_DIR" && docker compose -p "${APPGOG_PROJECT:-appgog}" -f compose.yaml down --remove-orphans) 2>&1 | tee -a "$uninstall_log"
  image=$(sed -n 's/^APPGOG_IMAGE=//p' "$ENV_FILE" | tail -n 1)
  [ -z "$image" ] || docker image rm "$image" >> "$uninstall_log" 2>&1 || true
  systemctl disable --now appgog-update-helper.service >> "$uninstall_log" 2>&1 || true
  rm -f /etc/systemd/system/appgog-update-helper.service /usr/local/bin/appgog
  systemctl daemon-reload >/dev/null 2>&1 || true
  resolved_releases=$(CDPATH= cd -- "$INSTALL_ROOT/releases" 2>/dev/null && pwd || true)
  [ "$resolved_releases" = "$INSTALL_ROOT/releases" ] || { say_error '版本目录校验失败，已停止删除源码。'; return 1; }
  rm -rf "$INSTALL_ROOT/releases"
  rm -f "$INSTALL_ROOT/current"
  printf '%s 卸载完成，Docker 数据卷与 shared 目录已保留\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$uninstall_log"
  say_ok "程序已卸载；数据库、Key、上传、构建成品、配置和备份仍保留。日志：$uninstall_log"
}

env_value() {
  key=$1
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$key=//p" "$ENV_FILE" | tail -n 1
}

set_env_value() {
  key=$1; value=$2
  temp_path=$(mktemp "$ROOT_DIR/.env.tmp.XXXXXX") || return 1
  awk -v key="$key" -v value="$value" '
    BEGIN { seen = 0 }
    index($0, key "=") == 1 { if (!seen) print key "=" value; seen = 1; next }
    { print }
    END { if (!seen) print key "=" value }
  ' "$ENV_FILE" > "$temp_path" || { rm -f "$temp_path"; return 1; }
  chmod 600 "$temp_path" 2>/dev/null || true
  mv "$temp_path" "$ENV_FILE"
}

valid_domain() {
  value=$1
  case "$value" in
    ''|*://*|*/*|*:*|*[!A-Za-z0-9.-]*|.*|*.) return 1 ;;
  esac
  case "$value" in *.*) return 0 ;; *) return 1 ;; esac
}

cloudflare_request() {
  token=$1; method=$2; path=$3; data=${4:-}
  if [ -n "$data" ]; then
    curl -fsS --max-time 20 -X "$method" "https://api.cloudflare.com/client/v4$path" \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data "$data"
  else
    curl -fsS --max-time 20 -X "$method" "https://api.cloudflare.com/client/v4$path" \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json'
  fi
}

cloudflare_zone_id() {
  token=$1; domain=$2; zone=$domain
  while printf '%s' "$zone" | grep -q '\.'; do
    response=$(cloudflare_request "$token" GET "/zones?name=$zone&status=active&per_page=1") || return 1
    id=$(printf '%s' "$response" | jq -r 'if .success then (.result[0].id // empty) else empty end')
    [ -z "$id" ] || { printf '%s' "$id"; return 0; }
    zone=${zone#*.}
  done
  return 1
}

cloudflare_upsert() {
  token=$1; domain=$2; ip=$3
  zone_id=$(cloudflare_zone_id "$token" "$domain") || { say_error "Cloudflare 未找到 $domain 的 Zone 或 Token 权限不足。"; return 1; }
  response=$(cloudflare_request "$token" GET "/zones/$zone_id/dns_records?type=A&name=$domain&per_page=1") || return 1
  record_id=$(printf '%s' "$response" | jq -r 'if .success then (.result[0].id // empty) else empty end')
  payload=$(jq -nc --arg name "$domain" --arg content "$ip" '{type:"A",name:$name,content:$content,ttl:1,proxied:false}')
  if [ -n "$record_id" ]; then response=$(cloudflare_request "$token" PUT "/zones/$zone_id/dns_records/$record_id" "$payload") || return 1
  else response=$(cloudflare_request "$token" POST "/zones/$zone_id/dns_records" "$payload") || return 1; fi
  [ "$(printf '%s' "$response" | jq -r '.success')" = true ] || return 1
  say_ok "Cloudflare DNS 已更新：$domain -> $ip"
}

package_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT_DIR/package.json" | head -n 1
}

latest_backup_name() {
  latest=$(find "$ROOT_DIR/backups" -maxdepth 1 -type f -name 'appgog-*.tar.gz.enc' -print 2>/dev/null | sort -r | head -n 1 || true)
  [ -n "$latest" ] && basename -- "$latest" || printf '尚无加密备份'
}

config_security_state() {
  [ -f "$ENV_FILE" ] || { printf '.env 缺失'; return; }
  mode=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)
  case "$mode" in 600|400) printf '.env 权限 %s' "$mode" ;; '') printf '.env 权限待检查' ;; *) printf '.env 权限过宽（%s）' "$mode" ;; esac
}

service_state() {
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    SERVICE_STATE='Docker 不可用'
    SERVICE_COLOR=$RED
    return
  fi
  container=$(cd "$ROOT_DIR" && docker compose -p "${APPGOG_PROJECT:-appgog}" -f compose.yaml ps -a -q appgog 2>/dev/null)
  health=''
  [ -z "$container" ] || health=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null)
  case "$health" in
    'running healthy') SERVICE_STATE='正常（1 个容器，全部进程健康）'; SERVICE_COLOR=$GREEN ;;
    running*) SERVICE_STATE='启动中或健康检查未通过'; SERVICE_COLOR=$YELLOW ;;
    *) SERVICE_STATE='已停止'; SERVICE_COLOR=$RED ;;
  esac
}

header() {
  auth_domain=$(env_value AUTH_DOMAIN)
  build_domain=$(env_value BUILD_DOMAIN)
  version=$(package_version)
  [ -n "$version" ] || version='unknown'
  service_state
  command -v clear >/dev/null 2>&1 && clear 2>/dev/null || true
  printf '%b' "$BLUE"
  printf '%s\n' '╔══════════════════════════════════════════════════════╗'
  printf '%s\n' '║          APPGOG打包授权系统 管理中心                 ║'
  printf '%s\n' '╠══════════════════════════════════════════════════════╣'
  printf '║  版本：%-16s 安装目录：%-19s ║\n' "$version" "$(basename "$ROOT_DIR")"
  printf '%s\n' '╚══════════════════════════════════════════════════════╝'
  printf '%b' "$RESET"
  printf '运行状态：%b%s%b\n' "$SERVICE_COLOR" "$SERVICE_STATE" "$RESET"
  printf '授权中心：%bhttps://%s/admin%b\n' "$GREEN" "${auth_domain:-未配置}" "$RESET"
  printf '打包中心：%bhttps://%s/build%b\n' "$GREEN" "${build_domain:-未配置}" "$RESET"
  printf '更新状态：本地 v%s（安全更新需人工确认）\n' "$version"
  printf '最近备份：%s\n' "$(latest_backup_name)"
  printf '安全状态：%s；DNS/HTTPS/证书请运行 appgog doctor\n\n' "$(config_security_state)"
}

show_status() {
  header
  run_docker status
}

configure_domains() {
  [ -f "$ENV_FILE" ] || {
    say_error '.env 不存在，请重新运行一键安装器。'
    return 1
  }
  old_auth=$(env_value AUTH_DOMAIN)
  old_build=$(env_value BUILD_DOMAIN)
  printf '当前授权域名：%s\n当前打包域名：%s\n' "${old_auth:-未配置}" "${old_build:-未配置}"
  tty_read "新的授权域名 [${old_auth:-无}]："
  new_auth=${REPLY_VALUE:-$old_auth}
  tty_read "新的打包域名 [${old_build:-无}]："
  new_build=${REPLY_VALUE:-$old_build}
  valid_domain "$new_auth" || { say_error '授权域名格式无效；只填写域名，不要包含 https://、端口或路径。'; return 1; }
  valid_domain "$new_build" || { say_error '打包域名格式无效；只填写域名，不要包含 https://、端口或路径。'; return 1; }
  [ "$new_auth" != "$new_build" ] || { say_error '授权域名与打包域名必须不同。'; return 1; }

  if confirm '域名是否由 Cloudflare 托管，并自动更新两个 A 记录？'; then
    command -v jq >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || { say_error 'Cloudflare 自动 DNS 需要 jq 和 curl。'; return 1; }
    tty_read 'Cloudflare API Token（仅本次使用，不保存）：'
    cf_token=$REPLY_VALUE
    [ -n "$cf_token" ] || { say_error 'Cloudflare API Token 不能为空。'; return 1; }
    public_ip=$(curl -4fsS --max-time 10 https://api.ipify.org 2>/dev/null || curl -4fsS --max-time 10 https://ifconfig.me/ip 2>/dev/null || true)
    [ -n "$public_ip" ] || { say_error '无法检测公网 IPv4。'; return 1; }
    cloudflare_upsert "$cf_token" "$new_auth" "$public_ip" || return 1
    cloudflare_upsert "$cf_token" "$new_build" "$public_ip" || return 1
    cf_token=''; unset cf_token REPLY_VALUE
  fi

  printf '\n配置差异：\n  - AUTH_DOMAIN=%s\n  + AUTH_DOMAIN=%s\n  - BUILD_DOMAIN=%s\n  + BUILD_DOMAIN=%s\n' \
    "$old_auth" "$new_auth" "$old_build" "$new_build"
  confirm '确认保存配置？' || { say_warn '已取消，没有修改配置。'; return 0; }

  umask 077
  mkdir -p "$ROOT_DIR/backups"
  backup_path="$ROOT_DIR/backups/env-$(date -u +%Y%m%dT%H%M%SZ)-$$.bak"
  cp "$ENV_FILE" "$backup_path" || return 1
  temp_path=$(mktemp "$ROOT_DIR/.env.tmp.XXXXXX") || return 1
  awk -v auth="$new_auth" -v build="$new_build" '
    BEGIN { seen_auth = 0; seen_build = 0 }
    /^[[:space:]]*AUTH_DOMAIN=/ {
      if (!seen_auth) print "AUTH_DOMAIN=" auth
      seen_auth = 1
      next
    }
    /^[[:space:]]*BUILD_DOMAIN=/ {
      if (!seen_build) print "BUILD_DOMAIN=" build
      seen_build = 1
      next
    }
    { print }
    END {
      if (!seen_auth) print "AUTH_DOMAIN=" auth
      if (!seen_build) print "BUILD_DOMAIN=" build
    }
  ' "$ENV_FILE" > "$temp_path" || { rm -f "$temp_path"; return 1; }
  chmod 600 "$temp_path" 2>/dev/null || true
  mv "$temp_path" "$ENV_FILE"
  say_ok "配置已保存；原配置备份在 $backup_path"
  say_warn '请先确保新域名 DNS 指向本服务器；应用配置后 Caddy 会自动申请新证书。已交付安装包仍指向原授权域名。'
  if confirm '现在执行安全更新并应用配置？'; then
    run_docker update
  fi
}

configure_services() {
  [ -f "$ENV_FILE" ] || { say_error '.env 不存在，请重新运行一键安装器。'; return 1; }
  printf '%s\n' '服务开关只影响 APPGOG 业务入口，不会删除任何授权、Key、主题或构建数据。'
  for item in \
    'LICENSE_SERVICE_ENABLED:授权与激活服务' \
    'CUSTOMER_LOGIN_ENABLED:客户 Key 登录' \
    'BUILD_CENTER_ENABLED:客户打包中心' \
    'NEW_BUILDS_ENABLED:接收新构建' \
    'WORKER_ENABLED:Worker 构建服务'; do
    key=${item%%:*}; label=${item#*:}; current=$(env_value "$key"); [ -n "$current" ] || current=true
    tty_read "$label [$current]（true/false）："
    value=${REPLY_VALUE:-$current}
    case "$value" in true|false) ;; *) say_error "$label 只能填写 true 或 false"; return 1 ;; esac
    set_env_value "$key" "$value" || return 1
  done
  say_ok '服务开关已写入 .env。'
  if confirm '现在重建并应用服务开关？'; then run_docker update; fi
}

logs_menu() {
  printf '%s\n' '1. 全部服务' '2. 初始化服务' '3. 授权中心' '4. 打包中心' '5. 构建 Worker' '6. HTTPS/Caddy' '0. 返回'
  tty_read '请选择日志来源：'
  case "$REPLY_VALUE" in
    1) service=all ;; 2) service=initialize ;; 3) service=license-center ;;
    4) service=build-center ;; 5) service=build-worker ;; 6) service=caddy ;; 0|'') return 0 ;;
    *) say_error '无效选项。'; return 1 ;;
  esac
  run_docker logs "$service" 150
}

restore_menu() {
  printf '可用备份：\n'
  find "$ROOT_DIR/backups" -maxdepth 1 -type f \( -name 'appgog-*.tar.gz.enc' -o -name 'appgog-*.tar.gz' \) -print 2>/dev/null | sort -r | head -n 10 || true
  tty_read '请输入要恢复的备份绝对路径（留空取消）：'
  archive=$REPLY_VALUE
  [ -n "$archive" ] || return 0
  [ -f "$archive" ] || { say_error '备份文件不存在。'; return 1; }
  printf '%b%s%b\n' "$RED" '恢复只允许在未启动的新空部署中执行，不能覆盖现有数据。' "$RESET"
  confirm '确认继续恢复？' || return 0
  run_docker restore "$archive"
}

advanced_menu() {
  while :; do
    header
    printf '%s\n' '高级工具' '  1. 系统诊断' '  2. 导出脱敏诊断报告' '  3. 修复配置与密钥权限' '  4. 清理悬空 Docker 镜像' '  5. Docker 磁盘占用' '  6. 检查 Compose 配置' '  7. 显示安装目录' '  8. 查看帮助' '  0. 返回主菜单'
    tty_read '请选择：'
    case "$REPLY_VALUE" in
      1) run_docker doctor; pause_menu ;;
      2) run_docker diagnostics; pause_menu ;;
      3) confirm '确认按最小权限修复 APPGOG 配置与密钥文件？' && run_docker repair-permissions; pause_menu ;;
      4) confirm '确认只清理未被任何容器使用的悬空镜像？' && run_docker cleanup-images; pause_menu ;;
      5) docker system df; pause_menu ;;
      6) (cd "$ROOT_DIR" && docker compose -p "${APPGOG_PROJECT:-appgog}" -f compose.yaml config --quiet) && say_ok 'Compose 配置有效'; pause_menu ;;
      7) printf '%s\n' "$ROOT_DIR"; pause_menu ;;
      8) usage; pause_menu ;;
      0|'') return 0 ;;
      *) say_error '无效选项。'; pause_menu ;;
    esac
  done
}

main_menu() {
  while :; do
    header
    printf '%s\n' \
      '  1. 查看系统状态' \
      '  2. 启动全部服务' \
      '  3. 停止全部服务' \
      '  4. 重启全部服务' \
      '  5. 查看服务日志' \
      '  6. 修改并保存域名配置' \
      '  7. 配置业务服务开关' \
      '  8. 查看初始管理员凭证' \
      '  9. 安全更新当前版本' \
      ' 10. 创建完整备份' \
      ' 11. 从完整备份恢复' \
      ' 12. 回滚最近一次更新' \
      ' 13. 系统诊断与高级工具' \
      ' 14. 修复系统源码' \
      ' 15. 卸载系统（保留数据）' \
      '  0. 退出'
    printf '\n%b危险操作会再次要求确认；更新前自动创建完整备份。%b\n\n' "$DIM" "$RESET"
    tty_read '请选择：'
    case "$REPLY_VALUE" in
      1) show_status; pause_menu ;;
      2) run_docker start; pause_menu ;;
      3) confirm '确认停止全部业务服务？' && run_docker stop; pause_menu ;;
      4) confirm '确认重启全部服务？' && run_docker restart; pause_menu ;;
      5) logs_menu; pause_menu ;;
      6) configure_domains; pause_menu ;;
      7) configure_services; pause_menu ;;
      8) run_docker credentials; pause_menu ;;
      9) confirm '确认检查签名 Release、完整备份并更新到最新版本？' && online_update; pause_menu ;;
      10) run_docker backup; pause_menu ;;
      11) restore_menu; pause_menu ;;
      12) confirm '确认先备份当前状态，再回滚到最近一次更新前镜像？' && run_docker rollback; pause_menu ;;
      13) advanced_menu ;;
      14) confirm '确认重新下载当前签名版本、备份并深度重建源码？' && repair_source; pause_menu ;;
      15) confirm '确认卸载程序但保留数据库、Key、上传、构建成品、配置和备份？' && uninstall_keep_data; return 0 ;;
      0|'') printf '已退出 APPGOG 管理中心。\n'; return 0 ;;
      *) say_error '无效选项。'; pause_menu ;;
    esac
  done
}

usage() {
  cat <<'EOF'
APPGOG 管理命令

  appgog                 打开交互式管理菜单
  appgog install         首次安装失败后重新构建并完成安装
  appgog status          查看容器状态
  appgog start           启动服务
  appgog stop            停止服务
  appgog restart         重启服务
  appgog logs [服务]     查看日志
  appgog config          修改并保存两个域名
  appgog services        配置授权、登录、打包、构建和 Worker 开关
  appgog credentials     查看初始管理员凭证
  appgog update          下载签名 Release、完整备份并更新
  appgog repair-source   重新下载当前版本并深度修复源码
  appgog uninstall       卸载程序并保留业务数据与备份
  appgog rollback        回滚到最近一次更新前镜像
  appgog backup          创建 AES-256 加密完整备份
  appgog restore <文件>  从备份恢复到空部署
  appgog doctor          系统诊断
  appgog diagnostics     导出不含凭证的诊断报告
  appgog repair          修复配置与密钥权限
  appgog cleanup         清理悬空 Docker 镜像
  appgog help            显示帮助
EOF
}

case "${1:-menu}" in
  menu) main_menu ;;
  install|status|start|stop|restart|rollback|backup|credentials|doctor|diagnostics) run_docker "$1" ;;
  update) online_update ;;
  repair-source) repair_source ;;
  uninstall) confirm '确认卸载程序但保留全部业务数据？' && uninstall_keep_data ;;
  repair) run_docker repair-permissions ;;
  cleanup) run_docker cleanup-images ;;
  logs) shift; run_docker logs "${1:-all}" "${2:-100}" ;;
  config) configure_domains ;;
  services) configure_services ;;
  restore) [ -n "${2:-}" ] || { usage >&2; exit 1; }; run_docker restore "$2" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 1 ;;
esac
