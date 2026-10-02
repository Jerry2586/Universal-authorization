#!/usr/bin/env sh

# Read the immutable deployment role without executing any value from .env.
appgog_deployment_role() {
  appgog_role_env=${1:-}
  appgog_role_value=''
  if [ -n "$appgog_role_env" ] && [ -f "$appgog_role_env" ]; then
    appgog_role_value=$(sed -n 's/^[[:space:]]*APPGOG_DEPLOYMENT_ROLE[[:space:]]*=[[:space:]]*//p' "$appgog_role_env" | tail -n 1 | tr -d '\r')
  fi
  [ -n "$appgog_role_value" ] || appgog_role_value=all
  case "$appgog_role_value" in
    all|license|build) printf '%s\n' "$appgog_role_value" ;;
    *)
      printf '错误：部署角色无效：%s；只允许 all、license 或 build。\n' "$appgog_role_value" >&2
      return 1
      ;;
  esac
}

appgog_compose_file() {
  appgog_role_root=${1:-}
  appgog_role_env=${2:-}
  [ -n "$appgog_role_root" ] || {
    printf '错误：无法解析角色 Compose，程序目录为空。\n' >&2
    return 1
  }
  appgog_role=$(appgog_deployment_role "$appgog_role_env") || return 1
  case "$appgog_role" in
    all) appgog_role_compose="$appgog_role_root/compose.yaml" ;;
    license) appgog_role_compose="$appgog_role_root/compose.license.yaml" ;;
    build) appgog_role_compose="$appgog_role_root/compose.build.yaml" ;;
  esac
  [ -f "$appgog_role_compose" ] || {
    printf '错误：角色 Compose 文件不存在：%s（角色 %s）。\n' "$appgog_role_compose" "$appgog_role" >&2
    return 1
  }
  printf '%s\n' "$appgog_role_compose"
}

appgog_require_control_role() {
  case "${1:-}" in
    all|license) return 0 ;;
    build)
      printf '错误：独立打包机不持有授权控制中心，禁止执行控制中心迁移。\n' >&2
      return 1
      ;;
    *)
      printf '错误：部署角色无效，无法判定控制中心权限。\n' >&2
      return 1
      ;;
  esac
}
