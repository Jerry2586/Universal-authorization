#!/usr/bin/env sh
set -eu
SOCKET=${APPGOG_HOST_SCAN_SOCKET:-/run/appgog-security/scan.sock}
[ "$(id -u)" -eq 0 ] || { echo 'Run as root to inspect the host agent' >&2; exit 1; }
[ -S "$SOCKET" ] || { echo 'Host security agent unavailable: socket missing' >&2; exit 1; }
command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || {
  echo 'curl and jq are required; rerun the Linux installer to repair dependencies' >&2; exit 1;
}
case "${1:-}" in
  status) ;;
  scan)
    [ "$#" -eq 1 ] || exit 2
    code=$(curl --silent --show-error --unix-socket "$SOCKET" --max-time 5 -o /dev/null -w '%{http_code}' -X POST 'http://localhost/scan') || exit 1
    case "$code" in
      202) echo 'Host scan started; run appgog security-local status for results'; exit 0 ;;
      409) echo 'Host scan already running'; exit 0 ;;
      429) echo 'Host scan cooldown active (60 seconds)' >&2; exit 1 ;;
      *) echo "Host scan rejected: HTTP $code" >&2; exit 1 ;;
    esac ;;
  *) echo 'Usage: appgog security-local status|scan' >&2; exit 2 ;;
esac
[ "$#" -eq 1 ] || exit 2
result=$(curl --silent --show-error --fail --unix-socket "$SOCKET" --max-time 5 'http://localhost/status') || exit 1
printf '%s\n' "$result" | jq -r '"Scan: \(.state) (\(.checked_at // "never"))", (.checks[]? | "  [\(.state)] \(.name): \(.detail)")'
# Missing and unfinished reports are not healthy; incomplete checks never become a clean status.
printf '%s\n' "$result" | jq -e '.state == "finished" and (.checked_at | type == "string") and (.checks | type == "array" and length > 0) and all(.checks[]; .state == "ok")' >/dev/null || {
  echo 'Host scan has findings, is incomplete, or cannot establish a clean result' >&2; exit 1;
}
checked_at=$(printf '%s\n' "$result" | jq -er '.checked_at | select(type == "string")') || exit 1
checked_epoch=$(date -u -d "$checked_at" +%s 2>/dev/null) || { echo 'Host scan timestamp invalid' >&2; exit 1; }
now_epoch=$(date -u +%s)
[ "$checked_epoch" -le "$((now_epoch + 120))" ] && [ "$checked_epoch" -ge "$((now_epoch - 900))" ] || {
  echo 'Host scan is stale or timestamp is in the future' >&2; exit 1;
}