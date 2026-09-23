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
sh scripts/docker.sh backup
archive=$(find "$PWD/backups" -name '*.tar.gz.enc' | sort | tail -n 1)
[ -n "$archive" ] && [ -f "$archive" ] || { echo '未生成加密备份'; exit 1; }
APPGOG_PROJECT=appgog-restore HTTP_PORT=18080 HTTPS_PORT=18443 sh scripts/docker.sh restore "$archive"
APPGOG_PROJECT=appgog-restore HTTP_PORT=18080 HTTPS_PORT=18443 docker compose -p appgog-restore exec -T appgog node scripts/docker/smoke.js verify
# Changing only the domain must reload runtime config without rotating identity.
printf 'AUTH_DOMAIN=new.appgog.test\nBUILD_DOMAIN=db.appgog.test\n' > .env
sh scripts/docker.sh install
docker compose exec -T appgog node scripts/docker/smoke.js verify https://new.appgog.test
echo 'Docker 首次安装、实际打包、更新保留、备份恢复、域名重载通过'
