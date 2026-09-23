# Docker/Linux 部署说明

日期：2026-09-23。

APPGOG打包授权系统 v1.0.0 的正式生产路线只有统一 Docker Compose + Caddy。授权中心、客户打包中心、构建 Worker 和 Caddy 自动 HTTPS 均运行在唯一的 appgog 容器内；不再维护宝塔、aaPanel、1Panel、外部 Nginx/OpenResty 反向代理或面板证书流程。

## 1. 前置条件

- 一台全新的 Debian、Ubuntu、CentOS、RHEL、Rocky Linux、AlmaLinux 或 Fedora 服务器；
- root 或 sudo 权限；
- 两个不同域名，例如 `auth.example.com` 与 `build.example.com`；
- 两个 DNS A 记录均已指向服务器公网 IPv4；
- TCP 80、TCP 443、UDP 443 可由公网访问，且没有其他程序占用 80/443；
- 自解压 .run 安装文件或具备授权访问权限的源码仓库。

安装器会检查端口、公网 IPv4 与 DNS。`--skip-dns-check` 只适用于明确的离线预装；跳过后 Caddy 在 DNS 生效前无法取得受信任证书。

## 2. 单文件自动安装（推荐）

本机执行 npm run cms:package，将生成的 dist/APPGOG-Packaging-Licensing-System-1.0.0.run 上传到服务器 /root/，执行：

```sh
sudo sh /root/APPGOG-Packaging-Licensing-System-1.0.0.run
```

无需手动安装 unzip、解压或进入源码目录。安装文件包含源码和 SHA-256 校验，自动检查并补齐系统工具、Docker Engine、Compose v2.24+ 和 Buildx，自动构建并启动唯一的 appgog 容器。首次提示输入两个真实域名；重复运行从已有 .env 读取配置，保留数据与签名身份，并在更新前创建加密备份。

默认安装到 /opt/appgog，安装全局 appgog 管理命令。要求 x86_64/amd64 或 aarch64/arm64、至少 4 GiB 可用磁盘、可联网的软件源和镜像仓库。已有 Docker 会复用，缺失插件从其已配置软件源补齐，无法获得受支持版本时明确报错。

仓库是私有的，匿名 raw 下载会返回 404；必须先上传 .run 或经认证获取源码。源码方式只需在仓库根目录执行 sudo sh scripts/install-linux.sh --source-dir "$PWD"。本机 dist 不随 Git 推送上传。

## 3. 手动 Docker 安装

```sh
cd /opt/appgog
cp .env.docker.example .env
```

只修改两个域名：

```dotenv
AUTH_DOMAIN=auth.example.com
BUILD_DOMAIN=build.example.com
```

然后执行：

```sh
sh scripts/docker.sh install
sh scripts/docker.sh credentials
```

Caddy 自动提供：

- `https://auth.example.com/admin`：卖家管理后台；
- `https://auth.example.com/health`：授权中心健康检查；
- `https://build.example.com/build`：客户打包中心；
- `https://build.example.com/health`：打包中心健康检查。

8787、8788 和 8081 是容器内部端口，不映射到宿主机；对外只提供 80/443。

## 4. 管理命令

```sh
appgog status
appgog start
appgog stop
appgog restart
appgog logs caddy
appgog logs license-center
appgog credentials
appgog doctor
```

不带参数执行 `appgog` 可打开交互式管理菜单。状态页应显示一个 appgog 容器及健康状态；日志以内部组件名为前缀。

## 5. 更新与回滚

覆盖新版本代码时必须保留 `.env`、数据卷和 `backups` 目录，然后执行：

```sh
sh scripts/docker.sh update
```

更新流程会先构建新镜像并创建完整备份，再切换服务并执行健康检查。健康检查失败时会尝试恢复带有 `appgog-platform:rollback` 标签的上一镜像。需要手工回滚时执行：

```sh
sh scripts/docker.sh rollback
```

镜像回滚不等于数据库降级。若新版本执行了不兼容的数据迁移，应在空项目中恢复升级前备份和对应代码版本，验证后再切换 DNS。禁止执行 `docker compose down -v`。

旧版标准 Compose 部署可通过重跑安装器迁移：沿用相同项目名与九个命名卷，备份后停止旧容器，修复卷权限，新容器健康后移除旧容器。自定义挂载路径需人工映射。跨旧多容器版本的回退须使用对应旧源码与完整备份，不能使用单容器镜像 rollback。

## 6. 备份与恢复

```sh
sh scripts/docker.sh backup
```

备份包含 SQLite 数据库及 WAL、Ed25519 签名密钥、内部凭证、主题源码、构建成品、上传文件和 Caddy 证书状态。v1.0.0 使用 OpenSSL AES-256-CBC + PBKDF2（200,000 次迭代）输出 `.tar.gz.enc`，首次备份会生成权限为 600 的 `/opt/appgog/.backup-key`。备份文件与恢复密钥必须分别离线保存；只持有其中一项无法恢复。

在新空服务器上准备同版本代码和 `.env` 后，先恢复、不要先安装：

```sh
cd /opt/appgog
# 先把独立保存的恢复密钥放回 /opt/appgog/.backup-key 并 chmod 600
sh scripts/docker.sh restore /绝对路径/appgog-备份.tar.gz.enc
```

恢复器先解密到权限为 600 的临时文件，再拒绝路径穿越、符号链接、不完整备份、非空目标卷和运行中的业务服务；解密失败和恢复失败分别返回非零状态。旧版明文 `.tar.gz` 仅作为兼容输入，恢复后应立即创建新的加密备份。恢复完成后再切换 DNS；优先保留原授权域名，以免已发出的安装包无法连接授权中心。

整个容器使用只读根文件系统、移除 capabilities、no-new-privileges、2 GiB 内存、2 CPU、512 PID 和受限临时目录。四个进程共享 UID 和数据卷，角色环境变量分离不是文件系统安全隔离；Worker 不执行上传源码。维护时短暂创建同镜像辅助容器进行备份/权限修复，完成即移除，常驻只有一个容器。

## 7. 跨服务器节点

默认正式路线是一台服务器的单容器。以下是高级扩展接口说明，不是默认安装步骤。需要拆分时，授权中心仍是唯一数据和签名源；打包中心与 Worker 使用后台生成的独立节点凭证，通过 HTTPS 下载源码、上传成品，不共享数据库或私钥。

```text
Caddy / HTTPS
  ├─ AUTH_DOMAIN  → 127.0.0.1:8787
  └─ BUILD_DOMAIN → 127.0.0.1:8788

build-center ── BUILD_CENTER_NODE_TOKEN ──→ license-center
build-worker ── WORKER_NODE_TOKEN ────────→ license-center
```

当前授权中心使用单机 SQLite。多个授权中心并行写入、自动数据库高可用、对象存储和分布式队列不属于 v1.0.0 已验证能力。

## 8. 故障诊断

```sh
sh scripts/docker.sh status
sh scripts/docker.sh doctor
docker compose logs --tail=100 appgog
docker compose exec -T appgog node scripts/docker/health.js
```

- Caddy 证书失败：确认两个 DNS A 记录、公网 80/443、系统时间和域名拼写；
- 下载脚本返回 404：私有仓库需要认证，改用第 2 节的 ZIP 或已认证源码安装；
- 新版 .run 会自动补齐 unzip；若工具安装失败，检查发行版软件源和网络，修复后重跑同一命令；
- ZIP 文件不存在：检查是否已上传到 `/root/`，以及文件名是否一致；Git 推送不会上传本机 `dist`；
- 端口占用：停止原 Web 服务后重试，正式路线不与其他反向代理共享 80/443；
- 初始化失败：检查 `.env` 是否仍是示例域名、旧密钥是否缺失；不要删除数据卷重试；
- 任务排队：检查 Worker 日志和授权中心节点凭证；
- 迁移服务器：保留原 `.env`、备份和同版本发布 ZIP，避免生成新签名身份。

## 9. 真实环境验收边界

仓库自动测试覆盖配置生成、凭证保留、备份恢复防护、Caddy Compose、两阶段授权和构建流程。真实公网 DNS 解析、ACME 证书签发、防火墙行为、不同 Linux 发行版包管理器和 VPS 网络环境仍必须在目标服务器上执行一次端到端验收，不能由本地 Windows 测试替代。
