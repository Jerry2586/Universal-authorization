#!/usr/bin/env sh

# Shared by the host helper and installer. Missing state means legacy/unlocked;
# unreadable or malformed state never grants permission to change versions.
appgog_check_version_lock() (
  lock_file="$1/shared/update-control/version-lock.json"
  target=$2
  [ -e "$lock_file" ] || return 0
  if ! jq -e '.schema == 1 and (.locked | type == "boolean") and (.version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+([-+][0-9A-Za-z.-]+)?$"))' "$lock_file" >/dev/null 2>&1; then
    printf '%s\n' '版本锁定记录无效，已拒绝部署；请在运营中心重新设置版本锁定。' >&2
    return 1
  fi
  [ "$(jq -r '.locked' "$lock_file")" = true ] || return 0
  locked_version=$(jq -r '.version' "$lock_file")
  if [ "$target" != "$locked_version" ]; then
    printf '当前已锁定 v%s，拒绝部署 %s；请先在运营中心解除版本锁定。\n' "$locked_version" "${target:-Latest}" >&2
    return 1
  fi
)
