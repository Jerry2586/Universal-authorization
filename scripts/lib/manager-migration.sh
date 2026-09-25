#!/usr/bin/env sh

migration_request() {
  action=$1; migration_id=$2; bundle=${3:-}; key=${4:-}; manifest=${5:-}
  printf '%s' "$migration_id" | grep -Eq '^mig_[0-9a-f]{32}$' || { say_error '迁移 ID 无效。'; return 1; }
  command -v jq >/dev/null 2>&1 || { say_error '缺少 jq，无法创建安全迁移请求。'; return 1; }
  command -v openssl >/dev/null 2>&1 || { say_error '缺少 OpenSSL，无法创建操作编号。'; return 1; }
  request_dir="$SHARED_DIR/update-control/migration/requests"
  mkdir -p "$request_dir"
  operation_id="op_$(openssl rand -hex 16)"
  request="$request_dir/$operation_id.json"
  jq -n --arg id "$operation_id" --arg action "$action" --arg migration_id "$migration_id" \
    --arg bundle_path "$bundle" --arg backup_key_path "$key" --arg manifest_path "$manifest" \
    '{id:$id,action:$action,migration_id:$migration_id,bundle_path:(if $bundle_path == "" then null else $bundle_path end),
      backup_key_path:(if $backup_key_path == "" then null else $backup_key_path end),
      manifest_path:(if $manifest_path == "" then null else $manifest_path end)}' > "$request"
  chmod 600 "$request" 2>/dev/null || true
  APPGOG_INSTALL_DIR="$INSTALL_ROOT" sh "$ROOT_DIR/scripts/migration.sh" "$request"
  result=$?
  rm -f "$request"
  return "$result"
}

migration_rollback_export() {
  [ "$(id -u)" -eq 0 ] || { say_error '安全回滚导出需要 root 或 sudo。'; return 1; }
  migration_id=${1:-}
  if [ -z "$migration_id" ]; then
    tty_read '请输入需要回滚的迁移 ID：'
    migration_id=$REPLY_VALUE
  fi
  printf '%b%s%b\n' "$RED" '此操作会停止当前 Active 目标服务器，并在最终数据导出后保持 Fenced。' "$RESET"
  confirm '确认开始安全回滚导出？' || return 0
  migration_request rollback-export-target "$migration_id"
}

migration_rollback_import() {
  [ "$(id -u)" -eq 0 ] || { say_error '安全回滚导入需要 root 或 sudo。'; return 1; }
  migration_id=${1:-}
  [ -n "$migration_id" ] || { say_error '必须提供迁移 ID。'; return 1; }
  inbox="$SHARED_DIR/update-control/migration/rollback-inbox/$migration_id"
  bundle=${2:-$inbox/control-rollback-$migration_id.tar.gz.enc}
  key=${3:-$inbox/control-rollback-$migration_id.backup-key}
  manifest=${4:-$inbox/control-rollback-$migration_id.manifest.json}
  case "$bundle:$key:$manifest" in "$inbox"/*:"$inbox"/*:"$inbox"/*) ;; *) say_error '文件必须位于该迁移的固定 rollback-inbox 目录。'; return 1 ;; esac
  printf '%b%s%b\n' "$RED" '此操作会用目标服务器最终快照覆盖旧源业务数据；失败时旧源保持 Fenced 和停止。' "$RESET"
  confirm '确认开始安全回滚导入？' || return 0
  migration_request rollback-import-source "$migration_id" "$bundle" "$key" "$manifest"
}
