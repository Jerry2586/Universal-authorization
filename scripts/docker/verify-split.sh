#!/usr/bin/env sh
# Runs after verify.sh built the image. CI projects and volumes are disposable.
set -eu
cd "$(dirname "$0")/../.."
[ "${GITHUB_ACTIONS:-}" = true ] || { echo '只允许在隔离 GitHub Actions 环境执行' >&2; exit 1; }
[ -f .env ] || { echo '先运行同机 Docker 验证并构建镜像' >&2; exit 1; }
test_root=$(mktemp -d)
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    for role in license build; do
      [ ! -f "$test_root/$role.env" ] || docker compose -p "appgog-split-$role" --env-file "$test_root/$role.env" -f compose.yaml logs --tail=120 appgog >&2 || true
    done
  fi
  for role in license build; do
    [ ! -f "$test_root/$role.env" ] || docker compose -p "appgog-split-$role" --env-file "$test_root/$role.env" -f compose.yaml down -v --remove-orphans >/dev/null 2>&1 || true
  done
  rm -rf "$test_root"
}
trap cleanup 0
trap 'exit 130' 2
trap 'exit 143' 15
for role in license build; do
  mkdir -p "$test_root/$role/update-control/requests" "$test_root/$role/security"
  chown -R 1000:1000 "$test_root/$role/update-control"
  chmod 770 "$test_root/$role/update-control" "$test_root/$role/update-control/requests"
  if [ "$role" = license ]; then http_port=18081; https_port=18444; else http_port=18082; https_port=18445; fi
  cat > "$test_root/$role.env" <<EOF
AUTH_DOMAIN=sq.appgog.test
BUILD_DOMAIN=db.appgog.test
APPGOG_DEPLOYMENT_ROLE=$role
APPGOG_BUSINESS_PAIRED=false
APPGOG_SHARED_DIR=$test_root/$role
HTTP_PORT=$http_port
HTTPS_PORT=$https_port
EOF
  docker compose -p "appgog-split-$role" --env-file "$test_root/$role.env" -f compose.yaml up -d --no-build --pull never --wait --wait-timeout 180
  docker compose -p "appgog-split-$role" --env-file "$test_root/$role.env" -f compose.yaml exec -T appgog node scripts/docker/health.js
  if [ "$role" = build ]; then
    docker compose -p appgog-split-build --env-file "$test_root/build.env" -f compose.yaml exec -T appgog node --input-type=module -e '
      const h = await (await fetch("http://127.0.0.1:8788/health")).json();
      if (!h.ok || h.paired !== false) process.exit(1);
      const business = await fetch("http://127.0.0.1:8788/build");
      if (business.status !== 503) process.exit(2);
    '
    docker compose -p appgog-split-build --env-file "$test_root/build.env" -f compose.yaml exec -T appgog sh -c 'test ! -e /app/var/keys/ed25519-private.pem && test ! -e /app/var/data/appgog.sqlite'
  else
    docker compose -p appgog-split-license --env-file "$test_root/license.env" -f compose.yaml exec -T appgog node --input-type=module -e '
      const h = await (await fetch("http://127.0.0.1:8787/health")).json();
      if (!h.ok) process.exit(1);
      try { await fetch("http://127.0.0.1:8788/health"); process.exit(2); } catch (e) { if (e.message !== "fetch failed") throw e; }
    '
  fi
done
echo '独立授权机和待配对打包机容器健康、隔离和业务封闭验证通过'