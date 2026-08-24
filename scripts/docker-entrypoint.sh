#!/bin/sh
set -eu

echo "[一键部署] 正在执行数据库迁移..."
pnpm db:migrate

if [ -n "${ADMIN_BOOTSTRAP_EMAIL:-}" ] && [ -n "${ADMIN_BOOTSTRAP_PASSWORD:-}" ]; then
  echo "[一键部署] 正在初始化 Web 管理员..."
  pnpm admin:bootstrap
fi

echo "[一键部署] 数据库迁移完成，正在启动授权服务器..."
exec pnpm start
