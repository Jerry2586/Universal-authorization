#!/usr/bin/env sh

appgog_backup_paths() {
  printf '%s\n' \
    var/data var/keys var/artifacts var/uploads \
    runtime/license runtime/build runtime/worker runtime/caddy-data runtime/caddy-config
}
