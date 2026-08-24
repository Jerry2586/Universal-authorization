#!/bin/sh
set -eu

echo "[一键部署] 正在执行数据库迁移..."
pnpm db:migrate

echo "[一键部署] 数据库迁移完成，正在启动授权服务器..."
exec pnpm start
