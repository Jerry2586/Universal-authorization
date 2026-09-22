# 部署说明

日期：2026-09-23。

需要从空服务器开始逐步操作时，请直接阅读 [宝塔、1Panel 与 Docker 完整部署教程](宝塔-1Panel-Docker部署教程.md)。

## 单机正式拓扑

当前可运行版本由三个独立进程组成：

```text
反向代理 / HTTPS
  ├─ admin.example.com  → license-center:8787
  └─ build.example.com  → build-center:8788

build-center ── INTERNAL_SERVICE_TOKEN ──→ license-center
build-worker ── WORKER_TOKEN ────────────→ license-center
license-center + build-worker ── 仅共享 appgog-artifacts 成品卷
数据库 appgog-db / 签名密钥 appgog-keys ── 只挂授权中心
```

客户站不要反向代理授权中心的管理路由。授权中心和客户打包中心应使用两个独立域名；Cookie、限流和访问日志也因此自然隔离。

## Linux / Docker Compose

```sh
chmod +x scripts/install-linux.sh
./scripts/install-linux.sh
```

脚本只在 `.env` 不存在时创建随机凭证，不会覆盖已有配置。首次启动默认是本机开发模式。公网部署前必须：

1. 把 `NODE_ENV` 改为 `production`。
2. 把 `PUBLIC_BASE_URL` 改为授权 API 的真实 HTTPS 地址。
3. 把 `BUILD_CENTER_PUBLIC_URL` 改为真实 HTTPS 打包站地址（包含 `/build`），并为 8787 和 8788 分别配置 HTTPS 反向代理域名。
4. 防火墙只开放反向代理需要的端口；不要公开 SQLite 文件、密钥目录或 Docker 卷。
5. 保存 `.env`、`appgog-db`、`appgog-keys`、`appgog-artifacts` 卷的离线备份。

如果你此前使用旧版 `appgog-data` 单卷 Compose 部署，请先完整备份旧卷，手动将其 `data/`、`keys/`、`artifacts/`、`uploads/` 分别迁移到对应新卷后再启动新版；不要直接启动空的新卷，否则看起来会像新安装。旧卷不会被本次更新删除。

常用命令：

```sh
docker compose ps
docker compose logs -f --tail=200
docker compose up -d --build
docker compose down
```

`docker compose down` 不删除数据卷；不要使用 `down -v`，除非明确要永久删除数据库、签名密钥和构建成品。

## 宝塔、1Panel、aaPanel

三类面板都使用同一份 `compose.yaml`，不维护三套业务代码：

1. 在面板中创建一个站点目录并上传本项目。
2. 使用面板的 Docker Compose/编排功能导入 `compose.yaml`，或在面板终端执行安装脚本。
3. 为授权中心和客户打包中心分别创建反向代理站点。
4. 将 `.env` 作为敏感配置管理，不要放入公开网站目录或备份下载目录。

面板只是部署入口，授权、签名、构建和激活逻辑仍由同一套服务负责。

## 当前数据层边界

当前可运行数据层是 SQLite + 共享构建成品卷，适合单机或小规模部署。Docker 运行时 Worker 只挂载成品卷，不接触数据库与签名密钥卷。本机三进程开发启动器会限制传给 Worker 的环境变量，但同一系统用户仍可能直接读取本地 `.env` 和密钥文件，因此不等同于容器隔离。多机扩容前必须完成 PostgreSQL migration、对象存储和分布式队列。
