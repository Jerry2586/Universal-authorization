#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL_ROOT=${APPGOG_INSTALL_DIR:-$(CDPATH= cd -- "$ROOT_DIR/.." && pwd)}
CONTROL_DIR="$INSTALL_ROOT/shared/update-control/migration"
STATUS_FILE="$CONTROL_DIR/status.json"
LOG_DIR="$INSTALL_ROOT/shared/logs"
LOG_FILE="$LOG_DIR/migration.log"
FENCE_FILE="$INSTALL_ROOT/shared/update-control/source-fenced.json"
DOCKER_SCRIPT="$ROOT_DIR/scripts/docker.sh"
COMPOSE_FILE="$ROOT_DIR/compose.yaml"
PROJECT=${APPGOG_PROJECT:-appgog}

mkdir -p "$CONTROL_DIR" "$LOG_DIR"
umask 077

compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"; }
fail() { log "失败：$*"; printf '错误：%s\n' "$*" >&2; return 1; }

write_status() {
  session_id=$1; operation_id=$2; state=$3; message=$4; migration_id=${5:-}; sha256=${6:-}
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  temporary="$STATUS_FILE.$$"
  jq -n --arg session_id "$session_id" --arg operation_id "$operation_id" --arg state "$state" \
    --arg message "$message" --arg migration_id "$migration_id" --arg sha256 "$sha256" \
    --arg updated_at "$now" --arg log_tail "$(tail -n 18 "$LOG_FILE" 2>/dev/null || true)" \
    '{schema:1,session_id:(if $session_id == "" then null else $session_id end),operation_id:$operation_id,
      migration_id:(if $migration_id == "" then null else $migration_id end),state:$state,message:$message,
      bundle_sha256:(if $sha256 == "" then null else $sha256 end),updated_at:$updated_at,log:($log_tail|split("\n"))}' > "$temporary"
  chmod 600 "$temporary" 2>/dev/null || true
  mv "$temporary" "$STATUS_FILE"
}

require_tools() {
  for tool in docker curl jq openssl sha256sum df date split; do command -v "$tool" >/dev/null 2>&1 || fail "缺少迁移依赖：$tool"; done
  docker info >/dev/null 2>&1 || fail 'Docker 服务不可用'
  docker compose version >/dev/null 2>&1 || fail 'Docker Compose 不可用'
}

current_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT_DIR/package.json" | head -n 1
}

clear_managed_volumes() {
  compose run --rm --no-deps -T --user 0 --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER --entrypoint sh appgog -c '
    set -eu
    for dir in /app/var/data /app/var/keys /app/var/artifacts /app/var/uploads /app/runtime/license /app/runtime/build /app/runtime/worker /app/runtime/caddy-data /app/runtime/caddy-config; do
      [ -d "$dir" ] || continue
      find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    done
  '
}

update_database_state() {
  action=$1; migration_id=$2; deployment_id=${3:-}; generation=${4:-}; sha256=${5:-}
  compose run --rm --no-deps -T appgog node scripts/docker/migration-state.js \
    "$action" "$migration_id" "$deployment_id" "$generation" "$sha256"
}

rollback_source() {
  migration_id=$1
  rm -f "$FENCE_FILE"
  update_database_state rollback-source "$migration_id" || true
  compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180 || true
}

transfer_source() {
  request=$1
  operation_id=$(jq -r '.id' "$request")
  migration_id=$(jq -r '.migration_id' "$request")
  target_url=$(jq -r '.target_url' "$request")
  pairing_code=$(jq -r '.pairing_code' "$request")
  source_deployment_id=$(jq -r '.source_deployment_id' "$request")
  generation=$(jq -r '.ownership_generation' "$request")
  version=$(current_version)
  source_done=false
  chunk_dir=''
  source_cleanup() {
    [ -z "$chunk_dir" ] || rm -rf -- "$chunk_dir"
    if [ "$source_done" != true ]; then
      write_status '' "$operation_id" rolled_back '迁移未完成，源服务器正在保持或恢复 Active' "$migration_id" || true
      rollback_source "$migration_id" || true
    fi
  }
  trap source_cleanup 0 1 2 15
  require_tools
  write_status '' "$operation_id" preflight '正在核对版本、架构、磁盘、Docker、Compose、时间与目标握手' "$migration_id"
  available_kb=$(df -Pk "$INSTALL_ROOT" | awk 'NR==2 {print $4}')
  [ "${available_kb:-0}" -ge 2097152 ] || fail '源服务器可用磁盘不足 2 GiB'
  body=$(jq -n --arg pairing_code "$pairing_code" --arg migration_id "$migration_id" \
    --arg source_deployment_id "$source_deployment_id" --arg source_version "$version" --argjson ownership_generation "$generation" \
    '{pairing_code:$pairing_code,migration_id:$migration_id,source_deployment_id:$source_deployment_id,
      source_version:$source_version,ownership_generation:$ownership_generation}')
  handshake=$(curl -fsS --connect-timeout 12 --max-time 45 -H 'content-type: application/json' \
    --data "$body" "$target_url/api/v1/control-migrations/handshake") || fail '目标服务器握手失败；请确认 HTTPS、配对码和防火墙'
  session_id=$(printf '%s' "$handshake" | jq -r '.session_id // empty')
  upload_token=$(printf '%s' "$handshake" | jq -r '.upload_token // empty')
  target_deployment_id=$(printf '%s' "$handshake" | jq -r '.target_deployment_id // empty')
  target_version=$(printf '%s' "$handshake" | jq -r '.target_version // empty')
  server_time=$(printf '%s' "$handshake" | jq -r '.server_time // empty')
  [ -n "$session_id" ] && [ -n "$upload_token" ] && [ -n "$target_deployment_id" ] || fail '目标握手响应不完整'
  [ "$target_version" = "$version" ] || fail "源目标版本不一致：源 v$version，目标 v${target_version:-未知}"
  if source_epoch=$(date -u +%s) && target_epoch=$(date -u -d "$server_time" +%s 2>/dev/null); then
    skew=$((source_epoch - target_epoch)); [ "$skew" -lt 0 ] && skew=$((-skew));
    [ "$skew" -le 120 ] || fail '源目标时间偏差超过 120 秒，请先同步 NTP'
  fi
  write_status "$session_id" "$operation_id" source_read_only '预检通过，源服务器进入只读切换并生成最终一致性快照' "$migration_id"
  update_database_state fence-source "$migration_id"
  before=$(find "$ROOT_DIR/backups" -maxdepth 1 -type f -name 'appgog-*.tar.gz.enc' -print 2>/dev/null | sort | tail -n 1 || true)
  if ! APPGOG_BACKUP_LEAVE_STOPPED=true sh "$DOCKER_SCRIPT" backup >> "$LOG_FILE" 2>&1; then
    fail '源服务器最终备份失败，已恢复原服务'
  fi
  bundle=$(find "$ROOT_DIR/backups" -maxdepth 1 -type f -name 'appgog-*.tar.gz.enc' -print 2>/dev/null | sort | tail -n 1 || true)
  [ -n "$bundle" ] && { [ "$bundle" != "$before" ] || [ -s "$bundle" ]; } || fail '未找到最终迁移备份'
  backup_key=$(tr -d '\r\n' < "$ROOT_DIR/.backup-key")
  bundle_sha256=$(sha256sum "$bundle" | awk '{print $1}')
  chunk_dir=$(mktemp -d "${TMPDIR:-/tmp}/appgog-migration-chunks.XXXXXX")
  split -b 64m -d -a 6 "$bundle" "$chunk_dir/chunk-"
  total_chunks=$(find "$chunk_dir" -maxdepth 1 -type f -name 'chunk-*' | wc -l | tr -d ' ')
  [ "${total_chunks:-0}" -gt 0 ] || fail '迁移包分块失败，未生成上传分块'
  chunk_number=0
  for chunk in "$chunk_dir"/chunk-*; do
    chunk_sha256=$(sha256sum "$chunk" | awk '{print $1}')
    write_status "$session_id" "$operation_id" uploading "正在上传迁移分块 $((chunk_number + 1))/$total_chunks" "$migration_id" "$bundle_sha256"
    if ! curl -fsS --connect-timeout 15 --max-time 1800 -X PUT \
      -H "Authorization: Bearer $upload_token" \
      -H "X-APPGOG-Chunk-SHA256: $chunk_sha256" \
      -H "X-APPGOG-Total-Chunks: $total_chunks" \
      -H 'Content-Type: application/octet-stream' --data-binary "@$chunk" \
      "$target_url/api/v1/control-migrations/$session_id/bundle/chunks/$chunk_number" >/dev/null; then
      fail "迁移包第 $((chunk_number + 1))/$total_chunks 块上传失败，源服务器已自动恢复"
    fi
    chunk_number=$((chunk_number + 1))
  done
  complete_body=$(jq -n --argjson total_chunks "$total_chunks" --arg total_sha256 "$bundle_sha256" --arg backup_key "$backup_key" \
    '{total_chunks:$total_chunks,total_sha256:$total_sha256,backup_key:$backup_key}')
  if ! curl -fsS --connect-timeout 15 --max-time 300 -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $upload_token" --data "$complete_body" \
    "$target_url/api/v1/control-migrations/$session_id/bundle/complete" >/dev/null; then
    fail '目标服务器合并或校验迁移分块失败，源服务器已自动恢复'
  fi
  rm -rf -- "$chunk_dir"
  chunk_dir=''
  write_status "$session_id" "$operation_id" target_restoring '目标服务器正在校验、恢复并执行健康检查' "$migration_id" "$bundle_sha256"
  attempts=0
  while [ "$attempts" -lt 180 ]; do
    attempts=$((attempts + 1))
    response=$(curl -fsS --connect-timeout 8 --max-time 20 -H "Authorization: Bearer $upload_token" \
      "$target_url/api/v1/control-migrations/$session_id/status" 2>/dev/null || true)
    state=$(printf '%s' "$response" | jq -r '.state // empty' 2>/dev/null || true)
    case "$state" in
      completed)
        jq -n --arg migration_id "$migration_id" --arg target_deployment_id "$target_deployment_id" \
          --argjson ownership_generation "$generation" --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          '{schema:1,migration_id:$migration_id,target_deployment_id:$target_deployment_id,
            ownership_generation:$ownership_generation,completed_at:$completed_at}' > "$FENCE_FILE"
        chmod 600 "$FENCE_FILE" 2>/dev/null || true
        write_status "$session_id" "$operation_id" completed '目标服务器已接管；源服务器已 Fenced，禁止双写' "$migration_id" "$bundle_sha256"
        log "迁移完成：$migration_id -> $target_deployment_id"
        source_done=true
        trap - 0 1 2 15
        return 0
        ;;
      failed|rolled_back)
        fail '目标服务器恢复失败，源服务器已自动恢复'
        ;;
    esac
    sleep 10
  done
  fail '等待目标服务器超时，源服务器已自动恢复'
}

restore_target_backup() {
  backup=$1; key_copy=$2
  compose stop >/dev/null 2>&1 || true
  clear_managed_volumes || true
  cp "$key_copy" "$ROOT_DIR/.backup-key"
  APPGOG_RESTORE_NO_START=true sh "$DOCKER_SCRIPT" restore "$backup" >> "$LOG_FILE" 2>&1 || true
  compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180 >> "$LOG_FILE" 2>&1 || true
}

import_target() {
  request=$1
  operation_id=$(jq -r '.id' "$request")
  session_id=$(jq -r '.session_id' "$request")
  migration_id=$(jq -r '.migration_id' "$request")
  bundle=$(jq -r '.bundle_path' "$request")
  source_key=$(jq -r '.backup_key_path' "$request")
  expected_sha=$(jq -r '.bundle_sha256' "$request")
  target_deployment_id=$(jq -r '.target_deployment_id' "$request")
  generation=$(jq -r '.ownership_generation' "$request")
  target_done=false
  target_cleanup() {
    if [ "$target_done" != true ]; then
      write_status "$session_id" "$operation_id" failed '目标服务器迁移未完成；源服务器应继续保持 Active' "$migration_id" "$expected_sha" || true
    fi
  }
  trap target_cleanup 0 1 2 15
  case "$bundle:$source_key" in
    "$CONTROL_DIR"/inbox/*:"$CONTROL_DIR"/inbox/*) ;;
    *) fail '迁移输入路径越界' ;;
  esac
  require_tools
  write_status "$session_id" "$operation_id" target_preflight '目标服务器正在校验迁移包、容量和运行环境' "$migration_id" "$expected_sha"
  actual_sha=$(sha256sum "$bundle" | awk '{print $1}')
  [ "$actual_sha" = "$expected_sha" ] || fail '迁移包 SHA-256 校验失败'
  bundle_bytes=$(wc -c < "$bundle")
  available_kb=$(df -Pk "$INSTALL_ROOT" | awk 'NR==2 {print $4}')
  required_kb=$((bundle_bytes / 1024 * 3 + 1048576))
  [ "$available_kb" -ge "$required_kb" ] || fail '目标服务器磁盘空间不足，至少需要迁移包三倍空间加 1 GiB'
  before=$(find "$ROOT_DIR/backups" -maxdepth 1 -type f -name 'appgog-*.tar.gz.enc' -print 2>/dev/null | sort | tail -n 1 || true)
  sh "$DOCKER_SCRIPT" backup >> "$LOG_FILE" 2>&1
  target_backup=$(find "$ROOT_DIR/backups" -maxdepth 1 -type f -name 'appgog-*.tar.gz.enc' -print 2>/dev/null | sort | tail -n 1 || true)
  [ -n "$target_backup" ] && { [ "$target_backup" != "$before" ] || [ -s "$target_backup" ]; } || fail '目标回滚备份创建失败'
  target_key_copy="$CONTROL_DIR/target-backup-key-$session_id"
  cp "$ROOT_DIR/.backup-key" "$target_key_copy"
  chmod 600 "$target_key_copy" 2>/dev/null || true
  write_status "$session_id" "$operation_id" restoring '已创建目标回滚点，正在恢复源服务器完整数据' "$migration_id" "$expected_sha"
  if ! compose stop >> "$LOG_FILE" 2>&1 \
    || ! clear_managed_volumes >> "$LOG_FILE" 2>&1 \
    || ! cp "$source_key" "$ROOT_DIR/.backup-key" \
    || ! APPGOG_RESTORE_NO_START=true sh "$DOCKER_SCRIPT" restore "$bundle" >> "$LOG_FILE" 2>&1 \
    || ! update_database_state activate-target "$migration_id" "$target_deployment_id" "$generation" "$expected_sha" >> "$LOG_FILE" 2>&1 \
    || ! compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 180 >> "$LOG_FILE" 2>&1; then
    write_status "$session_id" "$operation_id" rollback_required '目标恢复失败，正在恢复目标迁移前状态' "$migration_id" "$expected_sha"
    restore_target_backup "$target_backup" "$target_key_copy"
    write_status "$session_id" "$operation_id" failed '目标恢复失败且已回滚；源服务器可继续运行' "$migration_id" "$expected_sha"
    fail '目标服务器迁移失败并已回滚'
  fi
  write_status "$session_id" "$operation_id" completed '目标服务器已健康接管全部数据；现在可以切换 DNS' "$migration_id" "$expected_sha"
  log "目标接管完成：$migration_id generation=$generation"
  target_done=true
  trap - 0 1 2 15
}

request=${1:-}
[ -n "$request" ] && [ -f "$request" ] || { echo '用法：sh scripts/migration.sh /绝对路径/迁移请求.json' >&2; exit 1; }
action=$(jq -r '.action // empty' "$request")
case "$action" in
  transfer-source) transfer_source "$request" ;;
  import-target) import_target "$request" ;;
  *) fail '未知迁移动作' ;;
esac
