# Docker/Linux 部署说明

日期：2026-10-02。

APPGOG打包授权系统 v1.2.68 的正式生产路线使用授权与打包同机的 Docker Compose + Caddy。分机部署和独立云端安全中心的实机验收仍在进行；以下分机与云端步骤只用于候选部署验证。

## 1. 前置条件

生产环境默认安装激活窗口为 3600 秒。确有业务需要时可通过 `INSTALL_ACTIVATION_WINDOW_SECONDS` 修改，但已开始的窗口会继续使用数据库中原截止时间，升级或重启不会重置。

- 一台全新的 Debian、Ubuntu、CentOS、RHEL、Rocky Linux、AlmaLinux 或 Fedora 服务器；
- root 或 sudo 权限；
- 两个不同域名，例如 `auth.example.com` 与 `build.example.com`；
- 同机部署时两个 DNS A 记录均指向同一台服务器；分机部署时各自指向对应服务器；
- TCP 80、TCP 443、UDP 443 可由公网访问，且没有其他程序占用 80/443；
- 服务器至少能访问 jsDelivr、GitHub Release、配置的国内发布源或内置备用代理之一。

首次安装会检查端口、公网 IPv4 与 DNS。已有系统升级复用 `.env` 中的现有域名，不执行首装专用的 DNS 指向强制匹配，但仍执行容器健康检查和公网 HTTPS 检查。`--skip-dns-check` 只适用于明确的离线预装；跳过后 Caddy 在 DNS 生效前无法取得受信任证书。

## 2. 一行命令安装与升级

主仓库为私有，公开的短入口只含验签安装器。三条命令分别用于同机、仅授权、仅打包；在 root 终端选择本机角色执行，今后更新重复同一行。短命令固定使用本站域名 `sq.appgog.top` 和 `db.appgog.top`；首次读取私有 Release 时在终端隐藏输入本仓库的只读令牌。主仓库改为公开后同一命令直接读取公开 Release。安装器验证 Ed25519 签名与 `.run` SHA-256，补齐环境并部署。其他域名需传完整 `--role`、`--auth-domain` 和 `--build-domain` 参数。

若系统尚未安装 curl，Debian/Ubuntu 先执行 `apt-get update && apt-get install -y curl ca-certificates`；RHEL 系执行 `dnf install -y curl ca-certificates`（旧系统用 `yum`）。下载引导器需要 `curl`，下载后缺失的 OpenSSL、校验工具、Docker Engine、Compose v2.24+ 和 Buildx 会自动补齐。仅推送源码不产生正式更新。

今后发布更高版本后，使用签名 Release 的 `install.sh` 或后台助手：引导器读取 `/opt/appgog/current/package.json`，版本相同且运行健康时安全退出；目标版本更高则下载、验签，把整套程序写入新的 `/opt/appgog/releases/<版本>`，创建完整备份并原子切换 `current`。`.env`、日志与备份位于 `/opt/appgog/shared`，数据库、业务签名密钥、上传与构建成品保留在 Docker 数据卷；程序文件强制覆盖为发布版本，升级失败恢复旧链接和旧服务。目标版本更低时默认拒绝降级。

默认安装到 /opt/appgog，安装全局 appgog 管理命令。要求 x86_64/amd64 或 aarch64/arm64、至少 4 GiB 可用磁盘、可联网的软件源和镜像仓库。已有 Docker 会复用，缺失插件从其已配置软件源补齐，无法获得受支持版本时明确报错。

正式版本同时发布源码 ZIP、版本化 `.run`、两份 SHA-256、`release-manifest.json`、Ed25519 清单签名和稳定 `install.sh`。引导器不信任下载站返回的文件名或哈希，只接受通过仓库内置公钥验证的签名清单。

配置只读仓库令牌后，引导器通过 GitHub Release API 获取正式包，不通过第三方 GitHub 代理。所有备用来源都必须通过同一 Ed25519 签名和 SHA-256 校验。若有自有国内对象存储/CDN，把整套 Release 附件原样同步后执行：

```sh
sudo env APPGOG_CHINA_RELEASE_BASE=https://download.example.cn/appgog/v1.2.68 sh ./install.sh
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

备份包含 SQLite 数据库及 WAL、Ed25519 签名密钥、内部凭证、主题源码、构建成品、上传文件和 Caddy 证书状态。当前版本使用 OpenSSL AES-256-CBC + PBKDF2（200,000 次迭代）加密，再以独立派生的 HMAC-SHA256 子密钥认证版本头、认证盐及全部密文，输出 `.tar.gz.enc`。首次备份会生成权限为 600 的独立密钥；签名发布布局保存在 `/opt/appgog/shared/.backup-key`，手动 Docker 布局保存在项目目录下 `.backup-key`。备份文件与恢复密钥必须分别离线保存；只持有其中一项无法恢复。

在新空服务器上准备同版本代码和 `.env` 后，先恢复、不要先安装：

```sh
cd /opt/appgog
# 先把独立保存的恢复密钥放回上述部署布局的密钥路径，并 chmod 600
sh scripts/docker.sh backup-verify /绝对路径/appgog-备份.tar.gz.enc
sh scripts/docker.sh restore /绝对路径/appgog-备份.tar.gz.enc
```

恢复器先在私有临时目录认证完整密文，认证成功后才解密到权限为 600 的临时文件，再拒绝路径穿越、符号链接、不完整备份、非空目标卷和运行中的业务服务；认证、解密或恢复失败均返回非零状态。旧版 CBC 加密备份及明文 `.tar.gz` 默认拒绝；确认可信来源后可从 Linux 高级菜单第 10 项受控恢复，或显式设置 `APPGOG_ALLOW_LEGACY_BACKUP=true`。恢复后应立即创建新的认证备份。认证通过只证明密文字节与密钥一致，业务可恢复仍须实际演练；参见 [本地备份认证与受控恢复](local-backup-integrity.md)。恢复完成后再切换 DNS；优先保留原授权域名，以免已发出的安装包无法连接授权中心。

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

### 独立授权服务器：执行授权安装命令

两个域名分别解析到授权服务器和打包服务器。在授权服务器执行一行命令（首装和更新都用这一行）：

```sh
curl -fsSL https://jerry2586.github.io/i/i.sh | sh -s -- license
```

`--role license` 仅启动授权服务；`--auth-domain` 是本机授权域名；`--build-domain` 是另一台打包机的域名。安装器只检查本机授权域名的 HTTPS/DNS。运行 `sudo appgog`，选 **18 → 2** 签发打包节点与 Worker 身份，生成 root:600 的私有 JSON 配对包；记录文件只保存两个节点 ID。私有文件不可放入 Git、日志或公开目录。

### 独立打包服务器：执行打包安装命令

在打包服务器执行一行命令（首装和更新都用这一行）：

```sh
curl -fsSL https://jerry2586.github.io/i/i.sh | sh -s -- build
```

`--role build` 启动打包中心和 Worker；`--auth-domain` 指向授权服务器；`--build-domain` 是本机打包域名。尚未配对时只提供健康接口，业务和 Worker 不运行。将授权机的私有配对包经可信通道复制到打包机，设置 root 所有、权限 0600；在打包机运行 `sudo appgog` 选 **18 → 2**，输入配对包绝对路径导入。系统验证授权机公网 TLS、版本和双节点凭据，重启后如打包中心公网健康检查失败则恢复原配置。两台服务器的菜单 **18 → 1** 显示配对状态；授权机菜单 **18 → 3** 撤销身份并阻断远端业务。升级时安排两机维护窗口并保持相同正式版，不能在其中一台直接改为同机角色。菜单 **14** 分别卸载本机程序并保留本机数据；签发中断留下的待核对标记需先在授权后台核对或撤销节点后处理。

### 同一服务器：执行原一键安装命令（首装与更新通用）

两个业务域名都指向这台服务器时，在该服务器执行：

```sh
curl -fsSL https://jerry2586.github.io/i/i.sh | sh -s -- all
```

`--role all` 同时运行授权、打包和 Worker。菜单 **18** 会显示同机无需配对；现有同机安装升级时保留角色、数据库、签名密钥和配置。当前私有 Release 首次需要仓库只读令牌；各节点重复原命令即可获取签名 Latest 版本。仅本地源码验证可用 `scripts/install-linux.sh --source-dir <已核验源码目录> --role <角色>`，不能代替签名生产包。

后续云端安全中心对接步骤：
1. 在一台独立的干净 Linux 服务器，从可信的安全中心源码执行 `sudo bash scripts/install-linux.sh --host security.example.com`。在此服务器上，从经签名验证的 APPGOG 同版本源码运行 `node scripts/create-baseline.js <已验签源码路径> > /root/appgog-baseline.json`；不得用曾疑似失守的业务节点生成基线。使用云端仓库的 `scripts/enroll-node.sh` 分别注册 `license-center` 和 `build-center` 的公网 `https://域名/health`。
2. 在安全中心服务器上用 `scripts/export-business-bundle.sh all|license|build /root/新目录` 导出独立配对包，私密传输；同机使用 `all`，分机各用自己的 `license`、`build` 包。业务机上执行 `sudo appgog security-connect https://security.example.com:9443 /root/对应配对包 <独立获取的CA-SHA256指纹>`。配对先验证服务器 CA、域名、客户端证书和令牌，再写入配置并重启；摘要不匹配则恢复先前配置。
3. 业务机执行 `sudo appgog security-doctor`；授权机最终必须看到两个节点的报告新鲜、摘要匹配以及外部 HTTPS 探测健康。打包机只持有自己的上报身份，云端 reader 身份留在授权机。云端使用 `scripts/rotate-identity.sh stage|commit <角色>` 分阶段更新证书和令牌，更新业务配对并验证后再撤销旧身份。

授权机和打包机均由宿主 systemd 代理开机执行首次固定范围扫描，此后约每五分钟复查；本地管理员手动检查共用同一锁和冷却。节点定期将状态、检查时间和计数经 mTLS 上报云端，详情仅留本机；云端超过十五分钟未见有效扫描或超过两分钟未收到节点报告时标为过期。云端的宿主结果是节点自报，不能独立证明节点未失守；本地候选已增加独立 root 事故菜单：默认只告警，管理员明确启用后仅在病毒阳性与程序基线偏移同时出现时隔离本机 APPGOG 容器；不会自动删除文件、卷或重建业务。离线验签修复只恢复程序文件且保持隔离。操作与恢复条件见 [本地安全事故处置](local-security-response.md)。请先完成 Linux systemd、ClamAV、两/三机 TLS 与恢复演练再用于生产。

每台业务服务器重跑同一安装命令进行升级，安全中心升级运行自身安装脚本。备份/恢复须按本文件第 6 节执行；分机分别备份和恢复自身角色的卷与 `.env`，不可把授权密钥导入打包机。认证连通性验收包含正确与错误令牌、身份交叉使用、证书与域名验证、断线恢复、两种拓扑的首装和升级；没有真实 Linux 服务器的记录不能算完成生产验收。
每台业务机的 `sudo appgog` 菜单 17 和命令 `sudo appgog security-local scan|status` 分别启动本地固定范围扫描、查看报告；云端身份诊断与配对独立显示。首次配对需要由云端服务器控制台取得 CA 证书 SHA-256 指纹，不能仅从收到的身份包读取后照抄；若已有 CA 变化，配对会拒绝，必须离线核对事件并安排审计后的 CA 恢复。普通网络失联只报告异常，不永久锁死管理入口。配对中的重启会短暂停服务，应在维护窗口进行。

## 仓库改为私有时的在线安全更新

主仓库当前是私有仓库。三条短命令从公开的、只含验签安装器的 `Jerry2586/i` 获取入口。首次安装若检测到 GitHub 私有仓库，安装器在交互式终端隐藏输入只读令牌。改为公开仓库时，同样命令无需令牌。v1.2.61 起在线更新助手和安装器会优先使用 GitHub Release API；在业务服务器上为 `Jerry2586/Universal-authorization` 配置仅 `Contents: Read` 的细粒度、限定仓库访问令牌，保存为 `/etc/appgog/github-release.token`，所有者为 root、权限为 600。不要把令牌写入 `.env`、网页、URL、命令行参数或仓库。用受控的交互式编辑器写入令牌后执行：

```sh
install -d -m 700 /etc/appgog
# 用受控编辑器创建 /etc/appgog/github-release.token，文件仅一行令牌
chown root:root /etc/appgog/github-release.token
chmod 600 /etc/appgog/github-release.token
systemctl restart appgog-update-helper.service
```

已部署 v1.2.61 及之后的更新助手支持私有仓库认证；首次将令牌放入该文件后可继续使用菜单和后台更新。新版本完成发布、签名附件核验和服务器升级之后，后台“检查更新”才能经只读令牌访问私有 Release。令牌失效会明确视为发布源失败，不允许跳过 Ed25519 和 SHA-256 校验；若仍失败，请检查独立更新日志 `shared/logs/update.log`、令牌范围及服务器 GitHub API 出站连接。
