# Docker/Linux 部署说明

日期：2026-09-23。

APPGOG打包授权系统 v1.0.0 的正式生产路线只有统一 Docker Compose + Caddy。授权中心、客户打包中心、构建 Worker 和自动 HTTPS 入口由同一份 `compose.yaml` 管理；不再维护宝塔、aaPanel、1Panel、外部 Nginx/OpenResty 反向代理或面板证书流程。

## 1. 前置条件

- 一台全新的 Debian、Ubuntu、CentOS、RHEL、Rocky Linux、AlmaLinux 或 Fedora 服务器；
- root 或 sudo 权限；
- 两个不同域名，例如 `auth.example.com` 与 `build.example.com`；
- 两个 DNS A 记录均已指向服务器公网 IPv4；
- TCP 80、TCP 443、UDP 443 可由公网访问，且没有其他程序占用 80/443；
- 正式发布 ZIP 或具备授权访问权限的源码仓库。

安装器会检查端口、公网 IPv4 与 DNS。`--skip-dns-check` 只适用于明确的离线预装；跳过后 Caddy 在 DNS 生效前无法取得受信任证书。

## 2. 一行安装

```sh
curl -fsSL https://raw.githubusercontent.com/Jerry2586/Universal-authorization/main/scripts/install-linux.sh | sudo sh -s -- \
  --auth-domain auth.example.com \
  --build-domain build.example.com
```

私有仓库建议先运行 `npm run cms:package`，把生成的 `APPGOG-Packaging-Licensing-System-1.0.0.zip` 与 `.sha256` 文件放到受控下载地址，再执行：

```sh
sudo sh scripts/install-linux.sh \
  --auth-domain auth.example.com \
  --build-domain build.example.com \
  --repository https://downloads.example.com/APPGOG-Packaging-Licensing-System-1.0.0.zip \
  --sha256 这里填写发布文件的SHA256
```

安装目录默认为 `/opt/appgog`。安装器会验证 x86_64/amd64 或 aarch64/arm64 架构、至少 4 GiB 可用空间、Docker Engine、Buildx 与 Compose v2，写入权限为 600 的 `.env`、初始化随机密钥和首个管理员、启动四个服务，并安装全局 `appgog` 管理命令。

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

内部的 `127.0.0.1:8787` 与 `127.0.0.1:8788` 只用于宿主机诊断，不是正式公网入口。

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

不带参数执行 `appgog` 可打开交互式管理菜单。状态页应显示授权中心、打包中心、Worker、Caddy 共四个服务。

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

构建 Worker 默认使用只读根文件系统、移除全部 Linux capabilities、`no-new-privileges`、1 GiB 内存、1.5 CPU、256 PID 和受限临时目录。真实生产仍应结合宿主机执行容器逃逸测试、网络出口策略和容量压测。

## 7. 跨服务器节点

默认正式路线是一台服务器的一体 Compose。需要拆分时，授权中心仍是唯一数据和签名源；打包中心与 Worker 使用后台生成的独立节点凭证，通过 HTTPS 下载源码、上传成品，不共享数据库或私钥。

```text
Caddy / HTTPS
  ├─ AUTH_DOMAIN  → license-center:8787
  └─ BUILD_DOMAIN → build-center:8788

build-center ── BUILD_CENTER_NODE_TOKEN ──→ license-center
build-worker ── WORKER_NODE_TOKEN ────────→ license-center
```

当前授权中心使用单机 SQLite。多个授权中心并行写入、自动数据库高可用、对象存储和分布式队列不属于 v1.0.0 已验证能力。

## 8. 故障诊断

```sh
sh scripts/docker.sh status
sh scripts/docker.sh doctor
docker compose logs --tail=100 initialize
docker compose logs --tail=100 caddy license-center build-center build-worker
```

- Caddy 证书失败：确认两个 DNS A 记录、公网 80/443、系统时间和域名拼写；
- 端口占用：停止原 Web 服务后重试，正式路线不与其他反向代理共享 80/443；
- 初始化失败：检查 `.env` 是否仍是示例域名、旧密钥是否缺失；不要删除数据卷重试；
- 任务排队：检查 Worker 日志和授权中心节点凭证；
- 迁移服务器：保留原 `.env`、备份和同版本发布 ZIP，避免生成新签名身份。

## 9. 真实环境验收边界

仓库自动测试覆盖配置生成、凭证保留、备份恢复防护、Caddy Compose、两阶段授权和构建流程。真实公网 DNS 解析、ACME 证书签发、防火墙行为、不同 Linux 发行版包管理器和 VPS 网络环境仍必须在目标服务器上执行一次端到端验收，不能由本地 Windows 测试替代。
