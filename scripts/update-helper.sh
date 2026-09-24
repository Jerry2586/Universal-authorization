#!/usr/bin/env sh
set -eu

INSTALL_ROOT=${2:-${APPGOG_INSTALL_DIR:-/opt/appgog}}
CONTROL_DIR="$INSTALL_ROOT/shared/update-control"
REQUEST_DIR="$CONTROL_DIR/requests"
STATUS_FILE="$CONTROL_DIR/status.json"
LOG_FILE="$INSTALL_ROOT/shared/logs/update.log"
CURRENT_LINK="$INSTALL_ROOT/current"
RELOAD_HELPER=false
. "$CURRENT_LINK/scripts/lib/release-download.sh"

mkdir -p "$REQUEST_DIR" "$(dirname -- "$LOG_FILE")"
chown -R 1000:1000 "$CONTROL_DIR" 2>/dev/null || true
chmod 770 "$CONTROL_DIR" "$REQUEST_DIR" 2>/dev/null || true

current_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$CURRENT_LINK/package.json" 2>/dev/null | head -n 1
}

latest_version() {
  jq -r '.latest_version // empty' "$STATUS_FILE" 2>/dev/null || true
}

write_status() {
  state=$1; message=$2; latest=${3:-$(latest_version)}
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  tail_text=$(tail -n 12 "$LOG_FILE" 2>/dev/null || true)
  temporary="$STATUS_FILE.$$"
  jq -n --arg state "$state" --arg message "$message" --arg heartbeat "$now" \
    --arg current "$(current_version)" --arg latest "$latest" --arg log "$tail_text" \
    --arg install_root "$INSTALL_ROOT" --arg helper_pid "$$" \
    '{schema:1,state:$state,message:$message,heartbeat_at:$heartbeat,updated_at:$heartbeat,current_version:$current,latest_version:(if $latest == "" then null else $latest end),last_log:$log,install_root:$install_root,helper_pid:$helper_pid}' > "$temporary"
  chown 1000:1000 "$temporary" 2>/dev/null || true
  chmod 660 "$temporary" 2>/dev/null || true
  mv "$temporary" "$STATUS_FILE"
}

healthcheck() {
  [ -s "$STATUS_FILE" ] || { printf '状态文件不存在或为空：%s\n' "$STATUS_FILE" >&2; return 1; }
  jq -e --arg install_root "$INSTALL_ROOT" '
    .schema == 1
    and (.state | type == "string" and length > 0)
    and (.heartbeat_at | type == "string" and length > 0)
    and (.current_version | type == "string" and length > 0)
    and .install_root == $install_root
  ' "$STATUS_FILE" >/dev/null 2>&1 || {
    printf '状态文件格式、版本或安装目录不匹配：%s\n' "$STATUS_FILE" >&2
    return 1
  }
}

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"
}

check_update() {
  work=$(mktemp -d)
  trap 'rm -rf "$work"' 0 1 2 15
  public_key="$CURRENT_LINK/scripts/release-public.pem"
  for base in $(appgog_latest_release_sources); do
    rm -f "$work/manifest" "$work/signature"
    if curl -fL --connect-timeout 12 --max-time 180 --retry 2 "$base/release-manifest.json" -o "$work/manifest" \
      && curl -fL --connect-timeout 12 --max-time 180 --retry 2 "$base/release-manifest.json.sig" -o "$work/signature" \
      && openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin -in "$work/manifest" -sigfile "$work/signature" >/dev/null 2>&1; then
      jq -r '.version // empty' "$work/manifest"
      rm -rf "$work"; trap - 0 1 2 15
      return 0
    fi
  done
  rm -rf "$work"; trap - 0 1 2 15
  return 1
}

run_installer() {
  requested=${1:-}
  bootstrap=$(mktemp)
  cp "$CURRENT_LINK/install-docker.sh" "$bootstrap"
  chmod 700 "$bootstrap"
  if [ -n "$requested" ]; then
    APPGOG_VERSION="$requested" APPGOG_INSTALL_DIR="$INSTALL_ROOT" APPGOG_HELPER_ACTIVE=true APPGOG_REPAIR_SOURCE=${APPGOG_REPAIR_SOURCE:-false} \
      sh "$bootstrap" --install-dir "$INSTALL_ROOT" --non-interactive --no-menu
  else
    APPGOG_INSTALL_DIR="$INSTALL_ROOT" APPGOG_HELPER_ACTIVE=true \
      sh "$bootstrap" --install-dir "$INSTALL_ROOT" --non-interactive --no-menu
  fi
  rm -f "$bootstrap"
}

process_request() {
  request=$1
  action=$(jq -r '.action // empty' "$request")
  version=$(jq -r '.version // empty' "$request")
  case "$action" in
    check-update)
      write_status running '正在校验最新签名发布清单'
      if latest=$(check_update); then log "检查更新完成：v$latest"; write_status succeeded "最新签名版本为 v$latest" "$latest"
      else log '检查更新失败：所有发布源不可用或签名校验失败'; write_status failed '发布源不可用或签名校验失败'; fi
      ;;
    install-version)
      write_status running '正在备份、下载、构建并切换新版本'
      if run_installer "$version" >> "$LOG_FILE" 2>&1; then latest=${version:-$(current_version)}; log "在线更新完成：v$latest"; write_status succeeded "已更新到 v$latest" "$latest"; RELOAD_HELPER=true
      else log '在线更新失败，安装器已执行自动回滚'; write_status failed '更新失败，已保留旧版本和完整数据'; fi
      ;;
    repair-current)
      version=$(current_version)
      write_status running "正在重新下载并深度修复 v$version" "$version"
      if APPGOG_REPAIR_SOURCE=true run_installer "$version" >> "$LOG_FILE" 2>&1; then log "源码修复完成：v$version"; write_status succeeded "v$version 源码修复完成" "$version"; RELOAD_HELPER=true
      else log '源码修复失败，已恢复原版本'; write_status failed '源码修复失败，原版本仍可使用' "$version"; fi
      ;;
    transfer-source|import-target)
      write_status running '正在执行受控服务器迁移'
      if APPGOG_INSTALL_DIR="$INSTALL_ROOT" sh "$CURRENT_LINK/scripts/migration.sh" "$request" >> "$LOG_FILE" 2>&1; then
        log "服务器迁移动作完成：$action"; write_status succeeded '服务器迁移动作已完成'
      else
        log "服务器迁移动作失败：$action"; write_status failed '服务器迁移失败；请查看独立迁移日志'
      fi
      ;;
    *) log "拒绝未知更新动作：$action"; write_status failed '更新请求无效' ;;
  esac
}

case "${1:-}" in
  --daemon) ;;
  --healthcheck) healthcheck; exit $? ;;
  *) echo '此脚本由 appgog-update-helper.service 管理。' >&2; exit 1 ;;
esac

write_status idle '在线更新助手已就绪'
while :; do
  request=$(find "$REQUEST_DIR" -maxdepth 1 -type f -name '*.json' -print 2>/dev/null | sort | head -n 1 || true)
  if [ -n "$request" ]; then
    processing="$request.processing"
    mv "$request" "$processing"
    process_request "$processing"
    rm -f "$processing"
    if [ "$RELOAD_HELPER" = true ]; then exec "$CURRENT_LINK/scripts/update-helper.sh" --daemon "$INSTALL_ROOT"; fi
  else
    state=$(jq -r '.state // "idle"' "$STATUS_FILE" 2>/dev/null || echo idle)
    message=$(jq -r '.message // "在线更新助手已就绪"' "$STATUS_FILE" 2>/dev/null || echo '在线更新助手已就绪')
    write_status "$state" "$message"
    sleep 5
  fi
done
