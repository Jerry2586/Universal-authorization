#!/usr/bin/env sh
# Runs after verify.sh built the image. CI projects and volumes are disposable.
set -eu
cd "$(dirname "$0")/../.."
[ "${GITHUB_ACTIONS:-}" = true ] || { echo '只允许在隔离 GitHub Actions 环境执行' >&2; exit 1; }
[ -f .env ] || { echo '先运行同机 Docker 验证并构建镜像' >&2; exit 1; }
test_root=$(mktemp -d)
cp .env "$test_root/original.env"
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    for role in license build; do
      case "$role" in license) compose_file=compose.license.yaml ;; build) compose_file=compose.build.yaml ;; esac
      [ ! -f "$test_root/$role.env" ] || docker compose -p "appgog-split-$role" --env-file "$test_root/$role.env" -f "$compose_file" logs --tail=120 appgog >&2 || true
    done
  fi
  for role in license build; do
    case "$role" in license) compose_file=compose.license.yaml ;; build) compose_file=compose.build.yaml ;; esac
    for suffix in "" -restore; do
      [ ! -f "$test_root/$role.env" ] || docker compose -p "appgog-split-$role$suffix" --env-file "$test_root/$role.env" -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || true
    done
  done
  cp "$test_root/original.env" .env
  # The container creates UID 1000-owned directories inside this disposable CI fixture.
  # Restore ownership before removal; do not change production directory permissions.
  sudo chown -R "$(id -u):$(id -g)" "$test_root"
  rm -rf "$test_root"
}
trap cleanup 0
trap 'exit 130' 2
trap 'exit 143' 15
for role in license build; do
  case "$role" in license) compose_file=compose.license.yaml ;; build) compose_file=compose.build.yaml ;; esac
  mkdir -p "$test_root/$role/update-control/requests" "$test_root/$role/security"
  chmod 777 "$test_root/$role/update-control" "$test_root/$role/update-control/requests" # isolated disposable CI fixture; production installer uses uid 1000 and 0770
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
  docker compose -p "appgog-split-$role" --env-file "$test_root/$role.env" -f "$compose_file" up -d --no-build --pull never --wait --wait-timeout 180
  docker compose -p "appgog-split-$role" --env-file "$test_root/$role.env" -f "$compose_file" exec -T appgog node scripts/docker/health.js
  if [ "$role" = build ]; then
    docker compose -p appgog-split-build --env-file "$test_root/build.env" -f "$compose_file" exec -T appgog node --input-type=module -e '
      const h = await (await fetch("http://127.0.0.1:8788/health")).json();
      if (!h.ok || h.paired !== false) process.exit(1);
      const business = await fetch("http://127.0.0.1:8788/build");
      if (business.status !== 503) process.exit(2);
    '
    docker compose -p appgog-split-build --env-file "$test_root/build.env" -f "$compose_file" exec -T appgog sh -c 'test ! -e /app/var/keys/ed25519-private.pem && test ! -e /app/var/data/appgog.sqlite'
  else
    docker compose -p appgog-split-license --env-file "$test_root/license.env" -f "$compose_file" exec -T appgog node --input-type=module -e '
      const h = await (await fetch("http://127.0.0.1:8787/health")).json();
      if (!h.ok) process.exit(1);
      try { await fetch("http://127.0.0.1:8788/health"); process.exit(2); } catch (e) { if (e.message !== "fetch failed") throw e; }
    '
  fi
  docker compose -p "appgog-split-$role" --env-file "$test_root/$role.env" -f "$compose_file" exec -T appgog node scripts/docker/backup-role-smoke.js create
  cp "$test_root/$role.env" .env
  APPGOG_PROJECT="appgog-split-$role" APPGOG_BACKUP_KEY_FILE="$test_root/$role.backup-key" sh scripts/docker.sh backup
  archive=$(find backups -maxdepth 1 -type f -name 'appgog-*.tar.gz.enc' -print | sort -r | head -n 1)
  [ -n "$archive" ] && [ -f "$archive" ] || { echo '角色备份未生成' >&2; exit 1; }
  archive="$PWD/$archive"
  APPGOG_BACKUP_KEY_FILE="$test_root/$role.backup-key" sh scripts/docker.sh backup-verify "$archive"
  if [ "$role" = license ]; then restore_http=18084; restore_https=18447; else restore_http=18085; restore_https=18448; fi
  APPGOG_PROJECT="appgog-split-$role-restore" APPGOG_BACKUP_KEY_FILE="$test_root/$role.backup-key" HTTP_PORT="$restore_http" HTTPS_PORT="$restore_https" sh scripts/docker.sh restore "$archive"
  docker compose -p "appgog-split-$role-restore" -f "$compose_file" exec -T appgog node scripts/docker/health.js
  docker compose -p "appgog-split-$role-restore" -f "$compose_file" exec -T appgog node scripts/docker/backup-role-smoke.js verify
  if [ "$role" = build ]; then
    docker compose -p appgog-split-build-restore -f "$compose_file" exec -T appgog node --input-type=module -e '
      const health = await (await fetch("http://127.0.0.1:8788/health")).json();
      if (!health.ok || health.paired !== false) process.exit(1);
      if ((await fetch("http://127.0.0.1:8788/build")).status !== 503) process.exit(2);
    '
  fi
  rm -f "$archive"
done
echo '独立授权/打包认证备份恢复、身份隔离与待配对业务封闭验证通过'
