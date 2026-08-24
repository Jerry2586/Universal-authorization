#!/usr/bin/env sh
set -eu

PROJECT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE="$PROJECT_DIRECTORY/.env"
LOGIN_FILE="$PROJECT_DIRECTORY/admin-login.txt"
MODE=${1:-show}

if [ ! -f "$ENV_FILE" ]; then
  printf '错误：没有找到 %s，请先运行 ./deploy.sh 完成部署。\n' "$ENV_FILE" >&2
  exit 1
fi

read_env_value() {
  KEY=$1
  VALUE=$(grep "^${KEY}=" "$ENV_FILE" | head -n 1 | cut -d '=' -f 2- || true)
  printf '%s' "$VALUE"
}

PORT=$(read_env_value PORT)
PORT=${PORT:-3000}
ADMIN_EMAIL=$(read_env_value ADMIN_BOOTSTRAP_EMAIL)
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@example.com}
TENANT_CODE=$(read_env_value ADMIN_BOOTSTRAP_TENANT_CODE)
TENANT_CODE=${TENANT_CODE:-default}
ADMIN_PASSWORD=$(read_env_value ADMIN_BOOTSTRAP_PASSWORD)

if [ -z "$ADMIN_PASSWORD" ]; then
  printf '错误：.env 中没有 ADMIN_BOOTSTRAP_PASSWORD，无法显示管理员初始密码。\n' >&2
  exit 1
fi

SERVER_IP=${PUBLIC_HOST:-}
if [ -z "$SERVER_IP" ]; then
  SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
fi
SERVER_IP=${SERVER_IP:-服务器IP}

print_login_info() {
  cat <<EOF
==================================================
通用 Key 授权服务器后台登录信息

后台登录地址（本机）：http://127.0.0.1:${PORT}/admin/
后台登录地址（远程）：http://${SERVER_IP}:${PORT}/admin/
管理员账号：${ADMIN_EMAIL}
工作区代码：${TENANT_CODE}
管理员初始密码：${ADMIN_PASSWORD}

重要说明：
1. 第一次登录请使用上面的账号、工作区代码和初始密码。
2. 请妥善保管此随机初始密码，并限制凭据文件的访问权限。
3. 管理员已存在时，重新部署不会重置数据库密码；如果密码曾被运维重置，请使用重置后的密码。
4. 此文件包含敏感信息，不要上传、转发或提交到 Git。
==================================================
EOF
}

case "$MODE" in
  --write)
    umask 077
    print_login_info > "$LOGIN_FILE"
    chmod 600 "$LOGIN_FILE"
    cat "$LOGIN_FILE"
    ;;
  show|--show)
    print_login_info
    ;;
  *)
    printf '用法：%s [--show|--write]\n' "$0" >&2
    exit 2
    ;;
esac
