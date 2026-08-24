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

verify_endpoint() {
  ENDPOINT_PATH=$1
  EXPECTED_KIND=$2

  if ! docker compose exec -T app node -e '
const [endpointPath, expectedKind] = process.argv.slice(1);
const port = process.env.PORT || "3000";
const url = "http://127.0.0.1:" + port + endpointPath;
fetch(url)
  .then(async (response) => {
    const body = await response.text();
    if (response.status !== 200) {
      throw new Error(endpointPath + " 返回 HTTP " + response.status);
    }
    if (expectedKind === "html") {
      const contentType = response.headers.get("content-type") || "";
      const looksLikeHtml = contentType.toLowerCase().includes("text/html") || /<!doctype html|<html/i.test(body);
      if (!looksLikeHtml) {
        throw new Error(endpointPath + " 没有返回管理后台 HTML");
      }
    }
    console.log("验收通过：" + endpointPath + " -> HTTP " + response.status);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
' "$ENDPOINT_PATH" "$EXPECTED_KIND"; then
    show_logs_and_exit "部署验收失败：${ENDPOINT_PATH} 不可用。"
  fi
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

step '真实验收健康、就绪和 Web 管理后台'
verify_endpoint '/health' 'json'
verify_endpoint '/ready' 'json'
verify_endpoint '/admin/' 'html'

PORT=$(grep '^PORT=' .env | head -n 1 | cut -d '=' -f 2- || true)
PORT=${PORT:-3000}
SERVER_IP=${PUBLIC_HOST:-}
if [ -z "$SERVER_IP" ]; then
  SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
fi
SERVER_IP=${SERVER_IP:-服务器IP}

chmod +x show-admin-login.sh
PUBLIC_HOST="$SERVER_IP" ./show-admin-login.sh --write

printf '\033[32m  登录信息已保存：%s/admin-login.txt\n' "$PROJECT_DIRECTORY"
printf '  后台地址：http://%s:%s/admin/\n' "$SERVER_IP" "$PORT"
printf '  健康检查：http://%s:%s/health\n' "$SERVER_IP" "$PORT"
printf '  就绪检查：http://%s:%s/ready\n' "$SERVER_IP" "$PORT"
printf '  随时重新查看：cd %s && ./show-admin-login.sh\n' "$PROJECT_DIRECTORY"
printf '  查看日志：docker compose logs -f app\n'
printf '  停止服务：docker compose down\n'
printf '==================================================\033[0m\n'