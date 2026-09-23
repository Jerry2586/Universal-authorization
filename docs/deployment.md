# 部署说明

日期：2026-09-23。

需要从空服务器开始逐步操作时，请直接阅读 [宝塔、1Panel 与 Docker 完整部署教程](宝塔-1Panel-Docker部署教程.md)。

## 跨服务器节点拓扑（高级）

当前可运行版本由三个独立进程组成：

```text
反向代理 / HTTPS
  ├─ admin.example.com  → license-center:8787
  └─ build.example.com  → build-center:8788

build-center ── BUILD_CENTER_NODE_TOKEN ──→ license-center
build-worker ── WORKER_NODE_TOKEN ────────→ license-center
build-worker ── HTTPS 下载源码/上传成品 ──→ license-center
数据库 appgog-db / 签名密钥 appgog-keys ── 只挂授权中心
```

客户站不要反向代理授权中心的管理路由。授权中心和客户打包中心应使用两个独立域名；Cookie、限流和访问日志也因此自然隔离。

## 一套 CMS 的四种安装角色

```text
all-in-one      完整安装：后台、授权接口、客户打包页、内置 Worker
license-center  唯一授权中心：数据库、签名私钥、节点管理
build-center    独立客户打包站：只保存节点凭证，不保存客户库和私钥
worker          独立构建节点：通过 HTTPS 传输源码和成品
```

完整安装：

```sh
npm run cms:install -- --role all-in-one --public-url https://auth.example.com
npm run cms:start
```

拆分服务器时，先安装授权中心，再在后台“CMS 与节点”创建节点。把一次性显示的节点凭证复制到目标服务器：

```sh
npm run cms:install -- --role build-center --license-url https://auth.example.com --node-token BLD_xxx
npm run cms:install -- --role worker --license-url https://auth.example.com --node-token WRK_xxx
```

## 默认：Docker 一体安装

新 compose.yaml 一次启动初始化任务、授权中心、打包中心和共享文件卷的 Worker。仅填写 .env.docker.example 的两个域名，然后执行 sh scripts/docker.sh install。默认直接采用正式模式，自动生成内部秘密值和签名密钥。初始化任务以应用用户运行，完成后正常退出；业务进程只挂载各自必需的配置卷。

更新使用 sh scripts/docker.sh update；完整备份使用 backup；新空服务器恢复使用 restore。详细命令及旧安装迁移请见前面的完整教程。新部署不再运行旧的开发配置生成流程。

旧手工 Compose 保留在 compose.legacy.yaml；不要与新版同时启动。下面的节点凭证拓扑用于跨服务器部署，默认单机 Compose 使用自动生成的 INTERNAL_SERVICE_TOKEN / WORKER_TOKEN 和共享成品卷。

## 宝塔、1Panel、aaPanel

三类面板都使用同一份 `compose.yaml`，不维护三套业务代码：

1. 在面板中创建一个站点目录并上传本项目。
2. 使用面板的 Docker Compose/编排功能导入 `compose.yaml`，或在面板终端执行安装脚本。
3. 为授权中心和客户打包中心分别创建反向代理站点。
4. 将 `.env` 作为敏感配置管理，不要放入公开网站目录或备份下载目录。

面板只是部署入口，授权、签名、构建和激活逻辑仍由同一套服务负责。

## 当前数据层边界

当前可运行数据层是授权中心单机 SQLite，适合单授权中心或小规模部署。使用节点凭证时，Worker 通过授权中心 HTTPS 接口下载源码并上传成品，因此跨服务器不要求共享卷，也不接触数据库和签名私钥。旧版 `WORKER_TOKEN + 共享卷` 模式仍保留兼容。若需要多个授权中心并行写入、海量任务或自动故障转移，仍需完成 PostgreSQL migration、对象存储和分布式队列。
