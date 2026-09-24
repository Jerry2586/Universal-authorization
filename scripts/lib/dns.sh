#!/usr/bin/env sh

appgog_valid_domain() {
  value=${1:-}
  case "$value" in
    ''|*://*|*/*|*:*|*[!A-Za-z0-9.-]*|.*|*..*|*.example.com|example.com|*.your-domain.com|your-domain.com|*.) return 1 ;;
    *.*) return 0 ;;
    *) return 1 ;;
  esac
}
