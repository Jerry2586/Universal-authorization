#!/usr/bin/env sh
set -eu
# Private bundle is copied through a trusted channel, never passed as a CLI secret.
root=${APPGOG_INSTALL_DIR:-/opt/appgog}
file=${1:-}
[ "$(id -u)" -eq 0 ] || { echo '必须使用 root' >&2; exit 1; }
[ -n "$file" ] && [ -f "$file" ] && [ ! -L "$file" ] || { echo '配对包必须是普通文件' >&2; exit 1; }
[ "$(stat -c %u "$file")" = 0 ] || { echo '配对包必须归 root 所有' >&2; exit 1; }
case "$(stat -c %a "$file")" in 400|600) ;; *) echo '配对包权限只能为 0400/0600' >&2; exit 1 ;; esac
cd "$root/current"
envfile="$root/shared/.env"
[ -f "$envfile" ] && [ "$(sed -n 's/^APPGOG_DEPLOYMENT_ROLE=//p' "$envfile" | tail -n 1)" = build ] || { echo '仅独立打包机可导入' >&2; exit 1; }
command -v jq >/dev/null && command -v curl >/dev/null || { echo '缺少 jq 或 curl' >&2; exit 1; }
version=$(jq -er '.version' package.json)
auth=$(sed -n 's/^AUTH_DOMAIN=//p' "$envfile" | tail -n 1)
build=$(sed -n 's/^BUILD_DOMAIN=//p' "$envfile" | tail -n 1)
jq -e --arg a "https://$auth" --arg b "https://$build" --arg v "$version" '
 .format == 1 and .auth_url == $a and .build_url == $b and .version == $v and
 (.BUILD_CENTER_NODE_TOKEN | test("^BLD_[A-Za-z0-9_-]{40,}$")) and
 (.WORKER_NODE_TOKEN | test("^WRK_[A-Za-z0-9_-]{40,}$")) and
 .BUILD_CENTER_NODE_TOKEN != .WORKER_NODE_TOKEN
' "$file" >/dev/null || { echo '配对包域名、版本或节点凭据不匹配' >&2; exit 1; }
umask 077
tmp=$(mktemp -d "$root/shared/.business-pair.XXXXXXXX")
needs_rollback=false
cleanup() {
  result=$?
  trap - 0
  if [ "$needs_rollback" = true ]; then
    mv "$tmp/old-env" "$envfile" || echo '无法自动恢复旧配置，请立即人工处理' >&2
    sh scripts/docker.sh restart >/dev/null 2>&1 || echo '旧配置已还原，但服务需要人工重启' >&2
  fi
  rm -rf "$tmp"
  exit "$result"
}
trap cleanup 0
trap 'exit 130' 2
trap 'exit 143' 15
# curl reads the authorization header from a private config file, never from argv.
printf 'header = "Authorization: Bearer %s"\n' "$(jq -r '.BUILD_CENTER_NODE_TOKEN' "$file")" > "$tmp/build-curl"
printf 'header = "Authorization: Bearer %s"\n' "$(jq -r '.WORKER_NODE_TOKEN' "$file")" > "$tmp/worker-curl"
status=$(curl -sS --fail-with-body --max-time 15 --proto '=https' --tlsv1.2 --config "$tmp/build-curl" -o "$tmp/health" -w '%{http_code}' "https://$auth/health") || { echo '授权 HTTPS 健康检查失败' >&2; exit 1; }
[ "$status" = 200 ] && jq -e --arg v "$version" '.ok == true and .version == $v' "$tmp/health" >/dev/null || { echo '授权版本不匹配' >&2; exit 1; }
status=$(curl -sS --max-time 15 --proto '=https' --tlsv1.2 --config "$tmp/build-curl" -o "$tmp/response" -w '%{http_code}' "https://$auth/web/session?actor=customer") || exit 1
[ "$status" = 401 ] && jq -e '.error.code == "SESSION_REQUIRED"' "$tmp/response" >/dev/null || { echo '打包节点凭据未获授权' >&2; exit 1; }
status=$(curl -sS --max-time 15 --proto '=https' --tlsv1.2 --config "$tmp/worker-curl" -o "$tmp/response" -w '%{http_code}' "https://$auth/api/v1/worker/jobs/pair-probe-nonexistent/source") || exit 1
[ "$status" = 409 ] && jq -e '.error.code == "BUILD_LEASE_INVALID"' "$tmp/response" >/dev/null || { echo 'Worker 凭据未获授权' >&2; exit 1; }
cp -p "$envfile" "$tmp/old-env"
awk '!/^(BUILD_CENTER_NODE_TOKEN|WORKER_NODE_TOKEN|APPGOG_BUSINESS_PAIRED)=/' "$envfile" > "$tmp/new-env"
printf 'BUILD_CENTER_NODE_TOKEN=%s\nWORKER_NODE_TOKEN=%s\nAPPGOG_BUSINESS_PAIRED=true\n' "$(jq -r '.BUILD_CENTER_NODE_TOKEN' "$file")" "$(jq -r '.WORKER_NODE_TOKEN' "$file")" >> "$tmp/new-env"
chmod 600 "$tmp/new-env"
needs_rollback=true
mv "$tmp/new-env" "$envfile"
if ! sh scripts/docker.sh restart >/dev/null; then
  echo '业务配对启动失败，正在恢复原配置' >&2
  exit 1
fi
status=$(curl -sS --max-time 15 --proto '=https' --tlsv1.2 "https://$build/health" -o "$tmp/response" -w '%{http_code}') || status=000
if [ "$status" != 200 ] || ! jq -e --arg v "$version" '.ok == true and .version == $v and .upstream_version == $v' "$tmp/response" >/dev/null; then
  echo '公网打包健康检查失败，正在恢复原配置' >&2
  exit 1
fi
needs_rollback=false
echo '授权与打包两个节点均已验证；打包中心已激活。请安全销毁传输中的配对包副本。'
