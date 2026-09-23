#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
[ -f "$SCRIPT_DIR/scripts/install-linux.sh" ] || {
  echo '安装器不完整：缺少 scripts/install-linux.sh' >&2
  exit 1
}
exec sh "$SCRIPT_DIR/scripts/install-linux.sh" --source-dir "$SCRIPT_DIR" "$@"
