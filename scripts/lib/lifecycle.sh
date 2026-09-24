#!/usr/bin/env sh

appgog_source_fence_path() {
  install_root=$1
  printf '%s/shared/update-control/source-fenced.json' "${install_root%/}"
}
