#!/usr/bin/env sh
# Isolated CI only; refuses to run against an existing installation.
set -eu
cd "$(dirname "$0")/../.."
[ "${GITHUB_ACTIONS:-}" = true ] || { echo '只允许在隔离 GitHub Actions 环境执行'; exit 1; }
[ ! -e .env ] || { echo '已有 .env，拒绝测试'; exit 1; }
printf 'AUTH_DOMAIN=sq.appgog.test\nBUILD_DOMAIN=db.appgog.test\n' > .env
sh scripts/docker.sh install
[ "$(docker compose config --services)" = appgog ]
[ "$(docker compose ps --status running --services)" = appgog ]
docker compose exec -T appgog node scripts/docker/smoke.js create
sh scripts/docker.sh update
docker compose exec -T appgog node scripts/docker/smoke.js verify
# A broken candidate must emit diagnostics and restore the previous healthy image without losing data.
start_script=scripts/docker/start.js
start_script_backup=$(mktemp)
cp "$start_script" "$start_script_backup"
cleanup_verify_source() {
  if [ -f "$start_script_backup" ]; then cp "$start_script_backup" "$start_script"; rm -f "$start_script_backup"; fi
}
trap cleanup_verify_source 0 1 2 15
awk 'NR == 5 { print "throw new Error(\"APPGOG forced candidate startup failure\");" } { print }' "$start_script_backup" > "$start_script"
failure_logs_before=$(find "$PWD/logs" -maxdepth 1 -name 'startup-failure-*.log' 2>/dev/null | wc -l)
if APPGOG_BUILD_ATTEMPTS=1 APPGOG_COMPOSE_WAIT_TIMEOUT=60 sh scripts/docker.sh update; then
  echo '损坏候选版本不应通过更新健康检查' >&2
  exit 1
fi
cleanup_verify_source
failure_logs_after=$(find "$PWD/logs" -maxdepth 1 -name 'startup-failure-*.log' 2>/dev/null | wc -l)
[ "$failure_logs_after" -ge $((failure_logs_before + 2)) ] || { echo '候选启动失败未生成两次独立诊断'; exit 1; }
[ "$(docker compose ps --status running --services)" = appgog ] || { echo '候选失败后旧服务未恢复'; exit 1; }
docker compose exec -T appgog node scripts/docker/smoke.js verify
# Source repair uses a clean rebuild and must preserve the same persistent business data.
APPGOG_NO_CACHE=true sh scripts/docker.sh update
docker compose exec -T appgog node scripts/docker/smoke.js verify
sh scripts/docker.sh backup
archive=$(find "$PWD/backups" -name '*.tar.gz.enc' | sort | tail -n 1)
[ -n "$archive" ] && [ -f "$archive" ] || { echo '未生成加密备份'; exit 1; }
APPGOG_PROJECT=appgog-restore HTTP_PORT=18080 HTTPS_PORT=18443 sh scripts/docker.sh restore "$archive"
APPGOG_PROJECT=appgog-restore HTTP_PORT=18080 HTTPS_PORT=18443 docker compose -p appgog-restore exec -T appgog node scripts/docker/smoke.js verify
# Changing only the domain must reload runtime config without rotating identity.
printf 'AUTH_DOMAIN=new.appgog.test\nBUILD_DOMAIN=db.appgog.test\n' > .env
sh scripts/docker.sh install
docker compose exec -T appgog node scripts/docker/smoke.js verify https://new.appgog.test
echo 'Docker 首装、更新保留、失败回滚、源码修复、备份恢复、域名重载通过'
