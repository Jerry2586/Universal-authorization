# Docker/Linux 部署说明

日期：2026-09-24。

APPGOG打包授权系统 v1.2.10 的正式生产路线只有统一 Docker Compose + Caddy。授权中心、客户打包中心、构建 Worker 和 Caddy 自动 HTTPS 均运行在唯一的 appgog 容器内；不再维护宝塔、aaPanel、1Panel、外部 Nginx/OpenResty 反向代理或面板证书流程。

## 1. 前置条件

- 一台全新的 Debian、Ubuntu、CentOS、RHEL、Rocky Linux、AlmaLinux 或 Fedora 服务器；
- root 或 sudo 权限；
- 两个不同域名，例如 `auth.example.com` 与 `build.example.com`；
- 两个 DNS A 记录均已指向服务器公网 IPv4；
- TCP 80、TCP 443、UDP 443 可由公网访问，且没有其他程序占用 80/443；
- 服务器至少能访问 jsDelivr、GitHub Release、配置的国内发布源或内置备用代理之一。

首次安装会检查端口、公网 IPv4 与 DNS。已有系统升级复用 `.env` 中的现有域名，不执行首装专用的 DNS 指向强制匹配，但仍执行容器健康检查和公网 HTTPS 检查。`--skip-dns-check` 只适用于明确的离线预装；跳过后 Caddy 在 DNS 生效前无法取得受信任证书。

## 2. 一条命令安装与升级（唯一推荐入口）

进入服务器 root 终端，执行：

```sh
sh -c 'command -v curl >/dev/null 2>&1 || { if command -v apt-get >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates; elif command -v dnf >/dev/null 2>&1; then dnf install -y curl ca-certificates; elif command -v yum >/dev/null 2>&1; then yum install -y curl ca-certificates; else echo "不支持的系统包管理器" >&2; exit 1; fi; }; curl -fsSL https://cdn.jsdelivr.net/gh/Jerry2586/Universal-authorization@main/install-docker.sh | sh'
```

这条命令长期不变。首次运行时，引导器识别系统和 CPU，补齐 CA、OpenSSL、下载与校验工具，获取最新正式 Release，验证 Ed25519 清单签名及 `.run` SHA-256，再由正式安装器补齐 Docker Engine、Compose v2.24+ 和 Buildx，提示输入两个真实域名并启动唯一的 appgog 容器。

今后发布更高版本后逐字重跑同一句命令：引导器读取 `/opt/appgog/current/package.json`，版本相同且运行健康时安全退出；目标版本更高则下载、验签，把整套程序写入新的 `/opt/appgog/releases/<版本>`，创建完整备份并原子切换 `current`。`.env`、日志与备份位于 `/opt/appgog/shared`，数据库、业务签名密钥、上传与构建成品保留在 Docker 数据卷；程序文件强制覆盖为发布版本，升级失败恢复旧链接和旧服务。目标版本更低时默认拒绝降级。

默认安装到 /opt/appgog，安装全局 appgog 管理命令。要求 x86_64/amd64 或 aarch64/arm64、至少 4 GiB 可用磁盘、可联网的软件源和镜像仓库。已有 Docker 会复用，缺失插件从其已配置软件源补齐，无法获得受支持版本时明确报错。

仓库是公开的。固定入口通过 jsDelivr 获取；正式版本同时发布源码 ZIP、版本化 `.run`、两份 SHA-256、`release-manifest.json`、Ed25519 清单签名和稳定 `install.sh`。引导器不信任下载站返回的文件名或哈希，只接受通过仓库内置公钥验证的签名清单。

下载正式包时默认依次尝试自有国内源、GitHub Release、`ghfast.top` 和 `gh-proxy.com`。所有备用来源都必须通过同一 Ed25519 签名和 SHA-256 校验。若有自有国内对象存储/CDN，把整套 Release 附件原样同步后执行：

```sh
curl -fsSL https://cdn.jsdelivr.net/gh/Jerry2586/Universal-authorization@main/install-docker.sh \
  | APPGOG_CHINA_RELEASE_BASE=https://download.example.cn/appgog/v1.2.10 sh
```

完全断网时可从 Release 下载版本化 `.run` 后上传执行。需要自动配置 Cloudflare DNS 时，可把固定命令结尾改为 `| sh -s -- --cloudflare-token TOKEN`；Token 仅存在于当前进程，不写入 `.env` 或日志。

构建前会真实拉取 Node 与 Caddy 镜像。当前配置或 Docker Hub 不可达时，安装器自动尝试 DaoCloud 官方公开镜像的推荐前缀与兼容前缀，只有两个镜像都可用才写回 `.env`。用户显式传入 `--docker-registry-mirror`、`--node-image` 或 `--caddy-image` 时保持人工配置优先；显式镜像不可用会停止并给出日志，不会静默替换。不会关闭 TLS 或启用不安全仓库。

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
appgog config
appgog services
appgog update
appgog repair-source
appgog uninstall
appgog doctor
```

不带参数执行 `appgog` 可打开交互式管理菜单。`appgog update` 与后台“在线更新”都会检查并安装经过 Ed25519 签名的 GitHub Release；首次安装和跨版本升级仍可直接重跑第 2 节的固定一行命令。`appgog repair-source` 重新下载当前版本并执行无缓存深度重建；`appgog uninstall` 会先备份，再移除程序、容器和镜像，但保留数据库卷、Key、上传、构建成品、`shared` 配置和备份。更新、修复和卸载分别写入独立日志。

## 5. 安全更新与自动恢复

正式跨版本更新直接重跑与首次安装完全相同的命令：

```sh
sh -c 'command -v curl >/dev/null 2>&1 || { if command -v apt-get >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates; elif command -v dnf >/dev/null 2>&1; then dnf install -y curl ca-certificates; elif command -v yum >/dev/null 2>&1; then yum install -y curl ca-certificates; else echo "不支持的系统包管理器" >&2; exit 1; fi; }; curl -fsSL https://cdn.jsdelivr.net/gh/Jerry2586/Universal-authorization@main/install-docker.sh | sh'
```

引导器只接受签名有效且版本更高的正式包。每次更新把完整程序部署到全新版本目录，用户、Key、公告、运营设置、上传、成品和数据库保持不变，其他程序文件由发布包完整覆盖。更新流程会先创建备份、构建版本化镜像、原子切换程序并执行健康检查；失败时自动恢复旧程序链接并尝试恢复上一健康镜像。公开管理菜单不提供手工镜像回滚，避免代码与数据库版本被错误组合。若需要灾难恢复，应在空部署中使用完整加密备份和对应签名版本验证后再切换 DNS。禁止执行 `docker compose down -v`。

旧版标准 Compose 部署可通过重跑安装器迁移：沿用相同项目名与九个命名卷，备份后停止旧容器，修复卷权限，新容器健康后移除旧容器。自定义挂载路径需人工映射。跨旧多容器版本的灾难恢复须使用对应签名源码与完整备份。

## 6. 备份与恢复

```sh
sh scripts/docker.sh backup
```

备份包含 SQLite 数据库及 WAL、Ed25519 签名密钥、内部凭证、主题源码、构建成品、上传文件和 Caddy 证书状态。当前版本使用 OpenSSL AES-256-CBC + PBKDF2（200,000 次迭代）输出 `.tar.gz.enc`，首次备份会生成权限为 600 的 `/opt/appgog/.backup-key`。备份文件与恢复密钥必须分别离线保存；只持有其中一项无法恢复。

在新空服务器上准备同版本代码和 `.env` 后，先恢复、不要先安装：

```sh
cd /opt/appgog
# 先把独立保存的恢复密钥放回 /opt/appgog/.backup-key 并 chmod 600
sh scripts/docker.sh restore /绝对路径/appgog-备份.tar.gz.enc
```

恢复器先解密到权限为 600 的临时文件，再拒绝路径穿越、符号链接、不完整备份、非空目标卷和运行中的业务服务；解密失败和恢复失败分别返回非零状态。旧版明文 `.tar.gz` 仅作为兼容输入，恢复后应立即创建新的加密备份。恢复完成后再切换 DNS；优先保留原授权域名，以免已发出的安装包无法连接授权中心。

整个容器使用只读根文件系统、移除 capabilities、no-new-privileges、2 GiB 内存、2 CPU、512 PID 和受限临时目录。四个进程共享 UID 和数据卷，角色环境变量分离不是文件系统安全隔离；Worker 不执行上传源码。维护时短暂创建同镜像辅助容器进行备份/权限修复，完成即移除，常驻只有一个容器。

## 7. 控制中心系统迁移

控制中心迁移用于把整套 APPGOG 从旧服务器搬到新服务器。它不同于客户产品迁机：控制中心迁移继承原数据库、管理员、License Key、上传、成品、配置、Caddy 状态和三类签名密钥，不修改客户业务域名或 Installation ID。

固定步骤：

1. 在新服务器执行第 2 节同一条一键命令，安装与旧服务器完全相同的 APPGOG 版本。
2. 确认新服务器可通过受信任 HTTPS 地址访问；源目标系统时间误差不超过 120 秒。
3. 登录新服务器 `/admin`，进入“系统迁移”，点击开启接收，复制 15 分钟有效的一次性配对码。
4. 登录旧服务器 `/admin` 的“系统迁移”，填写目标 HTTPS 地址和配对码并开始迁移。
5. 系统自动核对版本、磁盘、Docker、Compose 和时间，源端进入短暂只读并创建最终加密备份。
6. 备份按 64 MiB 分块传输，每块和整包分别校验 SHA-256；同序号失败分块可安全重传。
7. 目标先创建自己的回滚备份，再恢复源端持久数据、执行幂等迁移并完成健康检查。
8. 成功后源服务器进入数据库和 `source-fenced.json` 双重 Fenced；把原 `AUTH_DOMAIN` 与 `BUILD_DOMAIN` 的 DNS A 记录指向新服务器。
9. 确认两个公网 HTTPS、授权 API、后台和打包中心正常，再停止旧服务器。

迁移日志位于 `/opt/appgog/shared/logs/migration.log`，页面同时展示当前操作状态。源端任何失败都会尝试恢复 Active；目标恢复失败会使用迁移前备份回滚。受控人工回滚命令为：

```sh
appgog migration-rollback <迁移ID>
```

不要删除源数据、数据卷、`.env`、`.backup-key` 或旧服务器，直到新服务器完成公网验收。SQLite 最终切换需要短暂只读，不属于完全零停机迁移。

## 8. 跨服务器节点

默认正式路线是一台服务器的单容器。以下是高级扩展接口说明，不是默认安装步骤。需要拆分时，授权中心仍是唯一数据和签名源；打包中心与 Worker 使用后台生成的独立节点凭证，通过 HTTPS 下载源码、上传成品，不共享数据库或私钥。

```text
Caddy / HTTPS
  ├─ AUTH_DOMAIN  → 127.0.0.1:8787
  └─ BUILD_DOMAIN → 127.0.0.1:8788

build-center ── BUILD_CENTER_NODE_TOKEN ──→ license-center
build-worker ── WORKER_NODE_TOKEN ────────→ license-center
```

当前授权中心使用单机 SQLite。多个授权中心并行写入、自动数据库高可用、对象存储和分布式队列不属于当前版本已验证能力。

## 9. 故障诊断

```sh
sh scripts/docker.sh status
sh scripts/docker.sh doctor
docker compose logs --tail=100 appgog
docker compose exec -T appgog node scripts/docker/health.js
```

- Caddy 证书失败：确认两个 DNS A 记录、公网 80/443、系统时间和域名拼写；
- 固定入口下载失败：确认服务器可访问 jsDelivr；也可从最新 Release 下载 `install.sh` 后执行；
- GitHub Release 不通：引导器会自动尝试内置代理；有自有国内源时设置 `APPGOG_CHINA_RELEASE_BASE`；
- Docker 基础镜像报 `load metadata for`：直接重跑固定安装命令；自动探测详情在 `/opt/appgog/shared/logs/image-source-*.log`，构建重试详情在 `build-*.log`；
- 新容器显示 `unhealthy`：安装器允许生产数据库和服务最多 120 秒分别启动，并自动重试一次；仍失败会在回滚前保存 `startup-failure-*.log`，包含健康检查输出和最近 300 行容器日志；
- `无效的生产凭证 LICENSE_ENCRYPTION_KEY`：v1.2.4 会识别 v1.2.0 以前的身份格式，在尚无加密完整 Key 时自动补齐独立密钥；已有密文时拒绝盲目换钥并要求恢复原身份配置；
- `no such column: deleted_at`：v1.2.5 会独立核对已有生产数据库的实际表结构，只追加缺少的兼容列并保留管理员、Key、设置和全部业务数据；
- 签名或 SHA-256 失败：停止安装并检查发布源，不得跳过验证或手动执行可疑文件；
- 系统工具安装失败：检查发行版软件源和 DNS，修复后重跑完全相同的固定命令；
- 端口占用：停止原 Web 服务后重试，正式路线不与其他反向代理共享 80/443；
- 初始化失败：检查 `.env` 是否仍是示例域名、旧密钥是否缺失；不要删除数据卷重试；
- 任务排队：检查 Worker 日志和授权中心节点凭证；
- 控制中心迁移失败：查看 `/opt/appgog/shared/logs/migration.log` 和页面 operation 状态；保留源 `.env`、备份、同版本 Release 和全部密钥，不要删除数据卷或重新生成签名身份；
- 源端显示 Fenced：先确认目标是否已经健康接管。只有明确执行受控迁移回滚时才能运行 `appgog migration-rollback <迁移ID>`，不能删除 `source-fenced.json` 强行双写。

## 10. 真实环境验收边界

仓库自动测试覆盖稳定引导器结构、签名与哈希校验入口、配置生成、凭证保留、备份恢复防护、Caddy Compose、两阶段授权和构建流程。正式发布验收还必须在全新 VPS 上执行固定命令完成首装，再在同一 VPS 上逐字重跑同一句命令完成跨版本升级，并确认相同版本重跑安全退出、旧版本被拒绝、业务数据和管理员身份不变。真实公网 DNS、ACME、防火墙、不同 Linux 包管理器和 VPS 网络仍需端到端验证，不能由本地 Windows 测试替代。
