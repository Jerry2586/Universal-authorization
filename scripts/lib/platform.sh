#!/usr/bin/env sh

appgog_supported_arch() {
  case "${1:-}" in x86_64|amd64|aarch64|arm64) return 0 ;; *) return 1 ;; esac
}

appgog_arch_family() {
  case "${1:-}" in x86_64|amd64) printf 'amd64' ;; aarch64|arm64) printf 'arm64' ;; *) return 1 ;; esac
}
