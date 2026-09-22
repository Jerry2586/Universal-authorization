#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 Docker。请先由服务器面板或系统管理员安装 Docker Engine。" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "未找到 docker compose 插件。" >&2
  exit 1
fi

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'
  else
    node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"
  fi
}

if [ ! -f .env ]; then
  ADMIN_PASSWORD="Appgog-$(random_secret)"
  umask 077
  cat > .env <<EOF
NODE_ENV=development
LICENSE_PORT=8787
BUILD_PORT=8788
KEY_HASH_PEPPER=$(random_secret)
ADMIN_TOKEN=$(random_secret)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$ADMIN_PASSWORD
WORKER_TOKEN=$(random_secret)
SESSION_SECRET=$(random_secret)
DELIVERY_ENCRYPTION_KEY=$(random_secret)
INTERNAL_SERVICE_TOKEN=$(random_secret)
PUBLIC_BASE_URL=http://127.0.0.1:8787
BUILD_CENTER_PUBLIC_URL=http://127.0.0.1:8788/build
ACTIVATION_TOKEN_TTL_SECONDS=604800
OFFLINE_GRACE_SECONDS=2592000
BUILD_TICKET_TTL_SECONDS=900
WEB_SESSION_TTL_SECONDS=28800
MAX_SOURCE_UPLOAD_BYTES=134217728
EOF
  echo "已创建仅当前用户可读的 .env"
  echo "管理员账号: admin"
  echo "管理员密码: $ADMIN_PASSWORD"
  echo "请立即保存密码，并在公网部署前设置 NODE_ENV=production 与 HTTPS PUBLIC_BASE_URL。"
else
  echo ".env 已存在，保留原配置。"
fi

docker compose up -d --build
docker compose ps
echo "授权中心端口: ${LICENSE_PORT:-8787}"
echo "客户打包中心端口: ${BUILD_PORT:-8788}"
