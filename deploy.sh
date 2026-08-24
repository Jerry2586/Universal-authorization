#!/usr/bin/env sh
set -eu

PROJECT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIRECTORY"

step() {
  printf '\n\033[36m==> %s\033[0m\n' "$1"
}

show_logs_and_exit() {
  printf '\n\033[31m%s\033[0m\n' "$1"
  docker compose ps || true
  docker compose logs --tail 120 app || true
  exit 1
}

step '检查 Docker 环境'
if ! command -v docker >/dev/null 2>&1; then
  echo '没有找到 Docker。请先安装并启动 Docker，然后重新运行本脚本。'
  exit 1
fi

docker info >/dev/null 2>&1 || {
  echo 'Docker 服务没有运行。请启动 Docker，然后重新运行本脚本。'
  exit 1
}

docker compose version >/dev/null 2>&1 || {
  echo '当前 Docker 没有 Compose 插件，请安装 Docker Compose v2。'
  exit 1
}

step '自动生成或补全安全环境配置'
USER_ARGUMENTS=''
if command -v id >/dev/null 2>&1; then
  USER_ARGUMENTS="--user $(id -u):$(id -g)"
fi

# shellcheck disable=SC2086
docker run --rm $USER_ARGUMENTS \
  --mount "type=bind,source=$PROJECT_DIRECTORY,target=/workspace" \
  -w /workspace node:22-alpine node scripts/create-production-env.mjs

step '构建并启动 PostgreSQL、Redis 和授权服务器'
docker compose up -d --build --remove-orphans

step '等待授权服务器完成迁移并进入健康状态'
CONTAINER_ID=$(docker compose ps -q app)
[ -n "$CONTAINER_ID" ] || show_logs_and_exit '没有找到授权服务器容器。'

ATTEMPT=1
while [ "$ATTEMPT" -le 90 ]; do
  STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER_ID" 2>/dev/null || true)
  if [ "$STATUS" = 'healthy' ]; then
    break
  fi
  if [ "$STATUS" = 'unhealthy' ]; then
    show_logs_and_exit '授权服务器健康检查失败。'
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 2
done

[ "$ATTEMPT" -le 90 ] || show_logs_and_exit '等待授权服务器启动超时。'

PORT=$(grep '^PORT=' .env | head -n 1 | cut -d '=' -f 2- || true)
PORT=${PORT:-3000}

printf '\n\033[32m========================================\n'
printf '  通用 Key 授权服务器搭建成功\n'
printf '  健康检查：http://127.0.0.1:%s/health\n' "$PORT"
printf '  就绪检查：http://127.0.0.1:%s/ready\n' "$PORT"
printf '  查看日志：docker compose logs -f app\n'
printf '  停止服务：docker compose down\n'
printf '========================================\033[0m\n'
