#!/usr/bin/env sh

# Subshell keeps temporary paths, traps and environment out of the caller.
appgog_run_signed_update() (
  source_root=$1; install_root=$2; requested=${3:-}; repair=${4:-false}; output_log=$5
  work=$(mktemp -d) || exit 1
  trap 'rm -rf "$work"' 0
  trap 'exit 130' 2
  trap 'exit 143' 15
  cp "$source_root/install-docker.sh" "$work/install.sh" || exit 1
  mkdir -p "$(dirname -- "$output_log")" || exit 1
  # Explicit empty version clears an inherited pin when updating to Latest.
  {
    result=0
    APPGOG_VERSION="$requested" APPGOG_INSTALL_DIR="$install_root" APPGOG_REPAIR_SOURCE="$repair" \
      sh "$work/install.sh" --install-dir "$install_root" --non-interactive --no-menu || result=$?
    printf '%s\n' "$result" > "$work/result"
  } 2>&1 | tee -a "$output_log"
  stream_result=$?
  [ -s "$work/result" ] || exit 1
  result=$(cat "$work/result")
  [ "$result" -eq 0 ] || exit "$result"
  exit "$stream_result"
)
