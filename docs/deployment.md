# Docker/Linux 部署说明

日期：2026-10-01。

APPGOG打包授权系统 v1.2.63 的正式生产路线使用授权与打包同机的 Docker Compose + Caddy。分机部署和独立云端安全中心的实机验收仍在进行；以下分机与云端步骤只用于候选部署验证。

## 1. 前置条件

生产环境默认安装激活窗口为 3600 秒。确有业务需要时可通过 `INSTALL_ACTIVATION_WINDOW_SECONDS` 修改，但已开始的窗口会继续使用数据库中原截止时间，升级或重启不会重置。

- 一台全新的 Debian、Ubuntu、CentOS、RHEL、Rocky Linux、AlmaLinux 或 Fedora 服务器；
- root 或 sudo 权限；
- 两个不同域名，例如 `auth.example.com` 与 `build.example.com`；
- 两个 DNS A 记录均已指向服务器公网 IPv4；
- TCP 80、TCP 443、UDP 443 可由公网访问，且没有其他程序占用 80/443；
- 服务器至少能访问 jsDelivr、GitHub Release、配置的国内发布源或内置备用代理之一。

首次安装会检查端口、公网 IPv4 与 DNS。已有系统升级复用 `.env` 中的现有域名，不执行首装专用的 DNS 指向强制匹配，但仍执行容器健康检查和公网 HTTPS 检查。`--skip-dns-check` 只适用于明确的离线预装；跳过后 Caddy 在 DNS 生效前无法取得受信任证书。

## 2. 私有仓库安装与升级

从已登录的私有 GitHub Release 下载正式签名 `.run`，上传到服务器并在 root 终端执行（替换版本号）：

```sh
sudo sh ./APPGOG-Packaging-Licensing-System-<版本>.run
```

若系统尚未安装 curl，Debian/Ubuntu 先执行 `apt-get update && apt-get install -y curl ca-certificates`；RHEL 系先执行 `dnf install -y curl ca-certificates`（旧系统用 `yum`）。首次升级至支持私有源的正式签名版后，按本页末尾配置只读 Release 令牌。后续从已登录的 GitHub Release 下载 `install.sh` 并执行 `sudo sh ./install.sh`，或使用后台更新助手；单独推送源码不会产生正式更新。

正式签名版的 `.run` 首次运行时识别系统和 CPU，补齐 CA、OpenSSL、下载与校验工具，获取最新正式 Release，验证 Ed25519 清单签名及 `.run` SHA-256，再由正式安装器补齐 Docker Engine、Compose v2.24+ 和 Buildx，提示输入两个真实域名并启动唯一的 appgog 容器。

今后发布更高版本后，使用签名 Release 的 `install.sh` 或后台助手：引导器读取 `/opt/appgog/current/package.json`，版本相同且运行健康时安全退出；目标版本更高则下载、验签，把整套程序写入新的 `/opt/appgog/releases/<版本>`，创建完整备份并原子切换 `current`。`.env`、日志与备份位于 `/opt/appgog/shared`，数据库、业务签名密钥、上传与构建成品保留在 Docker 数据卷；程序文件强制覆盖为发布版本，升级失败恢复旧链接和旧服务。目标版本更低时默认拒绝降级。

默认安装到 /opt/appgog，安装全局 appgog 管理命令。要求 x86_64/amd64 或 aarch64/arm64、至少 4 GiB 可用磁盘、可联网的软件源和镜像仓库。已有 Docker 会复用，缺失插件从其已配置软件源补齐，无法获得受支持版本时明确报错。

仓库是私有的，引导脚本必须从已登录的私有 Release 获取；正式版本同时发布源码 ZIP、版本化 `.run`、两份 SHA-256、`release-manifest.json`、Ed25519 清单签名和稳定 `install.sh`。引导器不信任下载站返回的文件名或哈希，只接受通过仓库内置公钥验证的签名清单。

配置只读仓库令牌后，引导器通过 GitHub Release API 获取正式包，不通过第三方 GitHub 代理。所有备用来源都必须通过同一 Ed25519 签名和 SHA-256 校验。若有自有国内对象存储/CDN，把整套 Release 附件原样同步后执行：

```sh
sudo env APPGOG_CHINA_RELEASE_BASE=https://download.example.cn/appgog/v1.2.63 sh ./install.sh
```

完全断网时可从 Release 下载版本化 `.run` 后上传执行。需要自动配置 Cloudflare DNS 时，可在安装器交互提示中提供凭据；不要把 Token 写进命令行参数。

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
sudo sh ./APPGOG-Packaging-Licensing-System-<版本>.run
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

迁移日志位于 `/opt/appgog/shared/logs/migration.log`，页面同时展示当前操作状态。源端任何失败都会尝试恢复 Active；目标恢复失败会使用迁移前备份回滚。目标已经接管后如需回滚，必须执行两阶段安全交接：

```sh
# 1. 在当前 Active 目标服务器执行；成功后目标保持 Fenced 和停止
appgog migration-rollback-export <迁移ID>

# 2. 把导出目录中的备份、独立密钥和 manifest 安全传到旧源固定目录
/opt/appgog/shared/update-control/migration/rollback-inbox/<迁移ID>/

# 3. 在旧源服务器执行；默认读取上述固定目录中的三份文件
appgog migration-rollback-import <迁移ID>
```

导入会校验迁移 ID、文件名、固定目录和整包 SHA-256，恢复目标产生的最终数据，再把所有权 generation 提升一代。失败时自动恢复旧源导入前的 Fenced 数据并保持服务停止；禁止直接删除 `source-fenced.json`、复制旧数据库后强行启动或让两边同时写入。

不要删除源数据、数据卷、`.env`、`.backup-key` 或旧服务器，直到新服务器完成公网验收。SQLite 最终切换需要短暂只读，不属于完全零停机迁移。

客户 Xboard 服务器迁移还必须单独保留 `storage/app/private/appgog-license-bridge/` 与原 Laravel `APP_KEY`。该目录包含以 `APP_KEY` 加密的安装私钥、安装窗口和激活刷新状态；两者缺一都不能还原原 Installation ID。不要只复制主题目录，也不要在目标服务器自动生成新密钥冒充原安装；跨服务器应使用客户产品迁机流程生成新的 Installation ID 并完成唯一 Active 交接。

## 8. 分机部署与独立云端配对（候选版本）

同机：业务服务器安装 `--role all`（默认），同时运行授权、打包、Worker；安全中心在另一台 Linux 服务器。三服务器：分别在授权机和打包机安装 `--role license`、`--role build`；安全中心在第三台服务器。两种模式的授权数据库、业务签名私钥都只在授权机，打包机仅持有独立服务节点凭据。同机或分机的业务节点由云端的独立证书和令牌识别。

1. 先在授权机用签名正式版安装授权角色。只有本地源码验证时，才执行版本化 `scripts/install-linux.sh --source-dir <已核验源码目录> --role license --auth-domain auth.example.com --build-domain build.example.com`。正式发布后，请从已登录的私有 GitHub Release 获取签名 `.run` 和 `install.sh`；在服务器配置下面的只读 Release 令牌，再以 `sudo sh ./install.sh --role license --auth-domain auth.example.com --build-domain build.example.com` 执行。两个域名分别解析到对应业务服务器。
2. 在授权后台的服务节点管理接口 `POST /web/admin/cms/nodes` 分别创建 `build-center` 与 `worker` 两个活跃节点。每个 `node_credential` 只返回一次；在私有的 root 可读文件写入两行 `BUILD_CENTER_NODE_TOKEN=BLD_...` 和 `WORKER_NODE_TOKEN=WRK_...`，权限设为 `0600`。如轮换，先更新打包机凭据再验证，然后撤销旧节点；服务端单个节点的令牌轮换是即时撤销，须安排维护窗口。
3. 在打包机用同一版本的稳定入口，追加 `--role build --auth-domain auth.example.com --build-domain build.example.com --node-credentials-file /root/appgog-node.env`。旧版本没有分机角色时不能在原卷上直接切换。安装器会检测当前角色，升级时保留原 `.env`、业务卷、云端证书与令牌。
4. 在一台独立的干净 Linux 服务器，从可信的安全中心源码执行 `sudo bash scripts/install-linux.sh --host security.example.com`。在此服务器上，从经签名验证的 APPGOG 同版本源码运行 `node scripts/create-baseline.js <已验签源码路径> > /root/appgog-baseline.json`；不得用曾疑似失守的业务节点生成基线。使用云端仓库的 `scripts/enroll-node.sh` 分别注册 `license-center` 和 `build-center` 的公网 `https://域名/health`。
5. 在安全中心服务器上用 `scripts/export-business-bundle.sh all|license|build /root/新目录` 导出独立配对包，私密传输；同机使用 `all`，分机各用自己的 `license`、`build` 包。业务机上执行 `sudo sh scripts/security-connect.sh --cloud-url https://security.example.com:9443 --bundle-dir /root/对应配对包`。配对先验证服务器 CA、域名、客户端证书和令牌，再写入配置并重启；摘要不匹配则恢复先前配置。
6. 业务机执行 `sudo sh scripts/security-doctor.sh`；授权机最终必须看到两个节点的报告新鲜、摘要匹配以及外部 HTTPS 探测健康。打包机只持有自己的上报身份，云端 reader 身份留在授权机。云端使用 `scripts/rotate-identity.sh stage|commit <角色>` 分阶段更新证书和令牌，更新业务配对并验证后再撤销旧身份。

每台业务服务器重跑同一安装命令进行升级，安全中心升级运行自身安装脚本。备份/恢复须按本文件第 6 节执行；分机分别备份和恢复自身角色的卷与 `.env`，不可把授权密钥导入打包机。认证连通性验收包含正确与错误令牌、身份交叉使用、证书与域名验证、断线恢复、两种拓扑的首装和升级；没有真实 Linux 服务器的记录不能算完成生产验收。
## 私有 GitHub Release 的在线安全更新

仓库设为私有后，公开的 `releases/latest/download` 和第三方代理不能获取附件。v1.2.61 起在线更新助手和安装器会优先使用 GitHub Release API；在业务服务器上为 `Jerry2586/Universal-authorization` 配置仅 `Contents: Read` 的细粒度、限定仓库访问令牌，保存为 `/etc/appgog/github-release.token`，所有者为 root、权限为 600。不要把令牌写入 `.env`、网页、URL、命令行参数或仓库。用受控的交互式编辑器写入令牌后执行：

```sh
install -d -m 700 /etc/appgog
# 用受控编辑器创建 /etc/appgog/github-release.token，文件仅一行令牌
chown root:root /etc/appgog/github-release.token
chmod 600 /etc/appgog/github-release.token
systemctl restart appgog-update-helper.service
```

旧的 v1.2.60 更新助手尚不支持私有仓库认证，因此首次切换需要从已登录的 GitHub Release 手动取得**完整签名版本**并走离线 `.run` 升级流程。新版本完成发布、签名附件核验和服务器升级之后，后台“检查更新”才能经只读令牌访问私有 Release。令牌失效会明确视为发布源失败，不允许跳过 Ed25519 和 SHA-256 校验；若仍失败，请检查独立更新日志 `shared/logs/update.log`、令牌范围及服务器 GitHub API 出站连接。
