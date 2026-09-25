# APPGOG打包授权系统 v1.2.17

这是一个可以直接安装运行的 APPGOG/Xboard 主题授权、打包和激活系统。一套源码支持四种角色：完整系统、授权中心、客户打包中心和构建 Worker。授权中心持有唯一数据库与签名私钥；打包中心只代理客户接口；独立 Worker 可通过节点凭证下载源码 ZIP、上传构建成品，不需要和授权中心共享磁盘。

## Linux 安装 + 专业管理菜单

默认只运行 **一个 appgog Docker 容器**，包含 Node.js、SQLite、授权中心、打包中心、Worker 和 Caddy HTTPS。宿主机不需要额外配置 Node.js、数据库或反向代理。

进入服务器的 root 终端，只复制下面这一条固定命令。首次执行自动安装，今后发布新版本后仍然逐字执行同一句命令自动升级：

```sh
sh -c 'command -v curl >/dev/null 2>&1 || { if command -v apt-get >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates; elif command -v dnf >/dev/null 2>&1; then dnf install -y curl ca-certificates; elif command -v yum >/dev/null 2>&1; then yum install -y curl ca-certificates; else echo "不支持的系统包管理器" >&2; exit 1; fi; }; curl -fsSL https://cdn.jsdelivr.net/gh/Jerry2586/Universal-authorization@main/install-docker.sh | sh'
```

引导器识别 Debian、Ubuntu、CentOS、RHEL、Rocky Linux、AlmaLinux、Fedora 和 Oracle Linux 以及 amd64/arm64，自动补齐 CA、OpenSSL、系统工具、Docker、Compose 和 Buildx。它获取最新正式 Release，先验证 Ed25519 清单签名，再校验 `.run` 的 SHA-256，最后下载安装包并部署。首次按提示填两个真实域名，安装器自动生成密钥和六位数字管理员密码、启动容器并检查公网 HTTPS。

默认使用 jsDelivr 获取固定引导器；引导器下载正式包时依次尝试配置的国内源、GitHub Release 和两个 GitHub 代理地址。无论来自哪个源，签名或哈希不匹配都会拒绝执行。自有国内对象存储可通过 `APPGOG_CHINA_RELEASE_BASE=https://你的国内地址` 配置。完全断网时仍可上传版本化 `.run` 离线安装。传入一次性 `--cloudflare-token` 后可自动创建或更新两个 A 记录；Token 不写入 `.env` 或日志。

安装器会在构建前真实拉取 Node 与 Caddy 基础镜像做网络探测。Docker Hub、DNS 或 TLS 链路不可用时，会自动改用 DaoCloud 公开维护的 Docker Hub 镜像路径，并把成功选择同步到升级后的 `.env`；构建发生临时网络错误会自动重试 3 次。整个过程不会关闭 TLS，也不会配置 `insecure-registries`。探测和构建分别写入 `shared/logs/image-source-*.log` 与 `shared/logs/build-*.log`。

重复执行同一命令时，引导器读取 `/opt/appgog/current/package.json`：版本相同且运行健康时安全退出；发现更高正式版本时下载并验签，把完整程序写入新的 `/opt/appgog/releases/<版本>`，创建备份并原子切换 `current`。`.env`、数据库、签名密钥、管理员身份、上传、构建成品和备份保留在 `/opt/appgog/shared` 与 Docker 数据卷中；升级失败会恢复旧程序链接和服务，默认拒绝自动降级。

仓库为公开仓库。每次正式版本同步更新 Git 源码、`main`、版本标签、GitHub Release、源码 ZIP、自解压 `.run`、两份 SHA-256、`release-manifest.json`、Ed25519 清单签名和稳定引导文件 `install.sh`。

仓库通过 `release-contract.json` 固定 Node、Caddy、Docker Compose 和 CPU 架构要求。打包脚本与 GitHub Actions 会同时校验源码、环境配置、文档、ZIP、`.run` 和签名清单；任一版本或环境不匹配都会直接停止发布。正式 Release 发布后使用 `node scripts/verify-published-release.js --tag v1.2.17` 从 GitHub API 返回的下载地址回取七个附件，再次验证 Latest 状态、附件数量、Ed25519 签名、ZIP/RUN 哈希和包内版本。完整强制规则见 `AGENTS.md` 与 `docs/release-policy.md`。

安装完成后输入 `appgog` 打开管理菜单，可查看状态、启停和重启服务、查看日志、保存域名配置、查看初始凭证、安全更新、完整备份、恢复和运行系统诊断。命令行模式同样可用：

```sh
appgog status
appgog logs build-worker
appgog update          # 检查签名 Release、完整备份并安全更新最新版本
appgog repair-source   # 重新下载当前版本并无缓存修复程序源码
appgog uninstall       # 卸载程序，保留数据库、Key、上传、成品、配置和备份
appgog backup
appgog doctor
```

跨服务器搬迁 APPGOG 控制中心时，先在新服务器用同一条固定命令安装完全相同的版本，再分别进入两台服务器管理后台的“系统迁移”：目标端开启一次性接收，源端填写目标 HTTPS 地址和配对码。系统会执行环境预检、最终加密备份、64 MiB 分块 SHA-256 传输、目标回滚点、恢复与健康检查；成功后源端自动 Fenced，最后只需把原授权/打包域名 DNS 指向新服务器。切换后的回滚采用目标 `migration-rollback-export` 与旧源 `migration-rollback-import` 两阶段交接，先冻结目标、回传最终数据，再由旧源取得更高所有权代次，禁止直接删除 Fenced 标记形成双写。

首次安装时，安装器会确认 80/443 未被其他服务占用、检查两个域名的 DNS A 记录是否指向当前服务器，并在支持的系统中开放防火墙端口。已有系统升级会复用并保留现有域名配置，不再被首装 DNS 指向检查错误拦截；升级完成后仍执行容器与公网 HTTPS 健康检查。随后由 Compose 内置 Caddy 自动申请和续期 HTTPS 证书，并分别代理授权中心与打包中心。正式生产路线不再依赖服务器面板、外部 Nginx/OpenResty 或手工证书流程。

## 高级维护：手动 Docker 部署

一个容器包含 Node.js 运行环境、SQLite 数据库、授权中心、打包中心、Worker 和 Caddy。首次生成随机管理员密码与内部密钥，后续重建容器保留原身份和业务数据。手动 Docker 安装要求 Compose v2.24+，无需另外安装 Node.js 或 MySQL。

完整安装、安全更新、备份和恢复步骤见 [Docker/Linux 部署说明](docs/deployment.md)。

只有需要离线维护或二次开发时才使用本节。标准首装和跨版本升级始终使用上方固定的一行命令。手动方式先解压正式发布 ZIP 或克隆公开仓库到 `/opt/appgog`，然后执行：

```sh
cd /opt/appgog
cp .env.docker.example .env
```

编辑 .env，只改两个域名：

```dotenv
AUTH_DOMAIN=sq.appgog.top
BUILD_DOMAIN=db.appgog.top
```

启动并查看随机生成的初始账号：

```sh
sh scripts/docker.sh install
sh scripts/docker.sh credentials
```

确认 DNS 已生效后启动。Caddy 自动提供以下 HTTPS 入口：

| 域名 | 内部目标 | 入口 |
| --- | --- | --- |
| AUTH_DOMAIN | 容器内 127.0.0.1:8787 | `https://AUTH_DOMAIN/admin` |
| BUILD_DOMAIN | 容器内 127.0.0.1:8788 | `https://BUILD_DOMAIN/build` |

手动更新必须先自行把服务器源码更新到目标版本并保留 `.env`，然后执行：

```sh
# 构建新代码 → 完整备份 → 重建服务 → 健康检查
sh scripts/docker.sh update

# 单独备份（短暂停止写入）
sh scripts/docker.sh backup

# 新空服务器：先填写 .env，直接恢复，不要先 install
sh scripts/docker.sh restore /绝对路径/备份.tar.gz
```

备份包含数据库、签名密钥、内部凭证、上传源码和构建成品，输出为 AES-256/PBKDF2 加密文件；首次备份生成 `.backup-key`，必须与备份分开离线保存。更新不删除数据卷；不要执行 docker compose down -v。当前从源码构建镜像，尚未提供只执行 docker compose pull 的镜像发布方式。

**旧部署：保留原 .env 和 Compose 项目名。** 安装器支持本仓库旧版标准命名卷迁移：备份、停止旧容器、修复卷权限、启动单容器，成功后移除旧容器而保留卷。自定义 bind mount 或改名数据卷需要按实际挂载迁移，不能当成空安装。部署失败由安装器内部自动恢复旧健康版本，不提供公开手工镜像回滚入口。

## 高级：手动安装与跨服务器分离部署

普通用户在一台服务器完整安装：

```powershell
npm run cms:install -- --role all-in-one --public-url https://auth.example.com
npm run cms:start
```

完成后访问 `/admin`，打开“系统与节点”，即可管理平台域名、服务开关和独立节点。安装器会生成正式环境密钥和首个管理员密码；`.env` 已存在时默认拒绝覆盖。

分离部署时，先安装唯一授权中心：

```powershell
npm run cms:install -- --role license-center --public-url https://auth.example.com
npm run cms:start
```

然后在授权后台创建 `build-center` 和 `worker` 节点，把只显示一次的凭证带到对应服务器：

```powershell
npm run cms:install -- --role build-center --license-url https://auth.example.com --node-token BLD_xxx
npm run cms:start

npm run cms:install -- --role worker --license-url https://auth.example.com --node-token WRK_xxx
npm run cms:start
```

生成可交付的干净 v1.2.17 安装 ZIP、版本化 `.run`、稳定 `install.sh` 和签名清单（自动排除 `.env`、数据库、密钥、旧制品和 Git 历史）：

```powershell
$env:APPGOG_RELEASE_SIGNING_PRIVATE_KEY_PATH = 'C:\安全目录\appgog-release-private.pem'
npm run cms:package
```

输出目录为 `dist/`。生产发布必须提供与 `scripts/release-public.pem` 匹配的 Ed25519 私钥；私钥只放在发布机安全目录，不进入仓库、ZIP、`.run` 或日志。默认缺少私钥会阻止正式制品验证；只有 CI/本地结构测试显式设置 `APPGOG_ALLOW_UNSIGNED_ARTIFACTS=1` 时才允许生成不带清单签名的非正式制品，禁止把它上传为 Release。

## 已完成的闭环

1. 卖家在 `/admin` 上传一个已经可以安装到 Xboard 的主题 ZIP，并发布版本。
2. 卖家给客户签发长期固定 License Key；可预先绑定域名，也可由客户首次登录后永久绑定。
3. 客户在 `/build` 使用固定 Key 登录，选择版本并提交打包。
4. 每次打包生成独立的 Build ID、Package ID、Package Secret 和一次性 Install Key。
5. 独立 Worker 检查 ZIP 安全性、移除 Source Map、注入每包水印、AES-256-GCM 加密身份载荷、随机运行时路径和构建清单，并生成客户专属 ZIP。
6. 客户下载安装包，在安装解锁页只输入本次一次性 Install Key；成功后 Key 立即作废，但正式功能仍锁定。
7. 客户首次进入 APPGOG 后台，只输入长期固定 License Key 完成正式激活。
8. 授权服务器校验 Install Receipt、包身份、域名和安装环境，签发 Ed25519 激活凭证。
9. 更新或重装时，客户继续使用长期固定 Key 重新打包，得到新的 ZIP 和新的 Install Key。

## 当前能力

- 长期固定 License Key 默认只允许停用、换绑或轮换；平台所有者也可通过当前密码和精确确认文本执行永久删除。永久删除会清理关联激活、构建、工单和文件，失败文件进入补偿清理，最终只保留匿名 Tombstone。
- 每次构建独立身份和一次性 Install Key，Install Key 完成安装解锁后立即作废；正式激活另行使用固定 License Key。
- 激活凭证绑定域名、Xboard 后台 Origin、服务器安装公钥指纹、Installation ID、Build 和 Package；安装、刷新和产品迁机使用一次性 Challenge Proof。
- Activation、Package 和 Notification 使用三套独立 Ed25519 密钥；固定 Key、安装 Key、刷新 Secret 等只保存 HMAC 摘要。
- 免费版、付费版和历史兼容版在签发或切换时固化能力与额度快照；授权中心额度、客户包运行时、SDK 和服务端 Guard 四层执行，不能通过修改套餐模板或前端按钮绕过。
- 客户包提供 `APPGOGLicense.hasCapability()` 与 `requireCapability()`；只有签名激活凭证含 `updates:read` 时才查询并展示签名版本通知。
- 管理员账号密码登录及所有者、授权运营、版本管理员、客服、审计角色；首次管理员密码和新建管理员密码均为六位数字，管理员可在用户中心自行改密；普通管理员可软删除，所有者和当前账号受保护。
- 客户打包站只接收固定 Key，不暴露内部客户编号、订单号或授权记录 ID；授权中心可审计成员操作。
- 已激活主题使用服务端签名的离线宽限；网络故障/服务端故障时限期可用，明确拒绝会锁定；初次激活仍必须在线。
- 运营公告可在后台编辑、启停并在客户打包页展示；版本公告由服务端签名，客户可在有效更新期内构建最新版本或重新构建当前版本。
- 客户打包中心与运营后台包含完整工单系统：分类、优先级、关联构建、连续对话、附件、指派、内部备注、双方关闭、管理员重开、状态流转和审计记录。
- 管理后台支持点击或拖拽真实上传主题 ZIP，显示进度，并从 `config.json`、文件名和根目录自动识别版本号与版本名称；冲突时拒绝发布。
- 部署域名和服务开关在网页中只读，只能通过 Linux `appgog config` 与 `appgog services` 调整。
- 客户中心可查看授权、过去 24 小时剩余额度、创建构建、查看进度、显示 Install Key，并通过 5 分钟短期会话票据下载成品。
- 安全 ZIP 解析：阻止目录穿越、加密 ZIP、压缩炸弹、符号链接、可执行文件和普通 PHP。
- 自动验证 Xboard 主题的 `config.json` 以及 `index.html` 或 `dashboard.blade.php`。
- 构建完成前验证实际成品 SHA-256、签名包身份、AES-256-GCM 加密包身份、逐文件摘要与 Package Secret HMAC；替换文件、清单、运行时、加密载荷或签名 Token 会被拒绝。
- 授权中心只公开管理页面和授权 API；客户打包中心只公开客户页面并通过独立内部凭证代理客户接口。
- 独立 Worker 只领取构建任务和上报结果，不持有 Ed25519 签名私钥或管理员凭证；Compose 默认启用只读根文件系统、移除 Linux capabilities、禁止提权并限制 CPU、内存和 PID。
- 管理后台提供独立“系统迁移”：同版本新服务器通过一次性配对接收完整持久数据，分块与整包双重 SHA-256 校验，目标失败自动回滚，成功后源端数据库与文件双重 Fenced，禁止双写。
- 客户产品迁机使用新 Installation Identity、候选激活、健康确认、唯一 Active 切换和有限窗口回滚；迁机 Challenge 只能消费一次。
- SQLite、本地文件存储和独立 Worker；均有可替换接口，便于以后迁移 PostgreSQL、S3 和容器 Worker。
- 自动测试覆盖两阶段授权、构建激活、权限和会话、队列租约、单容器进程监督、自解压包校验与部署数据保护。Linux CI 额外执行真实 Docker 安装、更新与备份恢复。

## 目录

```text
apps/
  license-api/       HTTP 服务、授权状态机、会话和管理/客户业务
  build-center/      独立客户入口与受限内部代理
  build-worker/      ZIP 检查、运行时注入与独立 Worker
  web/               首页、客户打包中心和管理员后台
packages/
  core/              Key、签名、加密、域名规范化与 ZIP 实现
  appgog-sdk/        激活凭证本地验签 SDK
  contracts/         跨模块数据契约
  ports/             BuildQueue、ArtifactStore、BuildEngine 接口
  adapters/          SQLite 队列与本地文件存储
docs/                架构、API、拆分边界和开发计划
scripts/             一键配置、启动和演示主题生成脚本
tests/               自动化测试
var/                 本地数据库、密钥、上传源包和构建成品
```

## 本地启动

要求 Node.js 24 或更高版本，不依赖第三方 npm 包。

首次运行：

```powershell
.\scripts\setup.ps1
.\scripts\start.ps1
```

`setup.ps1` 会生成 `.env`、随机安全凭证和管理员密码；`.env` 已被 Git 忽略。已有 `.env` 时不会覆盖。

Linux、Docker Compose、自动 HTTPS、安全更新和迁移见 `docs/deployment.md`。正式生产只支持统一 Docker/Caddy 路线。

也可以直接启动分层版本：

```powershell
npm run start:split
```

页面地址：

- 卖家管理后台：`http://127.0.0.1:8787/admin`
- 授权中心健康检查：`http://127.0.0.1:8787/health`
- 客户打包中心：`http://127.0.0.1:8788/build`
- 打包中心健康检查：`http://127.0.0.1:8788/health`

`npm start` 仍可运行兼容单体模式；分别部署时使用 `npm run start:license`、`npm run start:build` 和 `npm run start:worker`。独立服务必须共享相同的 `INTERNAL_SERVICE_TOKEN`，Worker 使用另一个 `WORKER_TOKEN`。

管理员用户名和密码来自 `.env` 的 `ADMIN_USERNAME`、`ADMIN_PASSWORD`。`ADMIN_TOKEN` 只用于自动化管理 API，不用于网页登录。

## 第一次使用

1. 打开 `/admin` 并使用管理员账号密码登录。
2. 上传一个可安装的 Xboard 主题 ZIP，填写版本号后发布。
3. 签发授权，填写客户标识、授权域名、更新截止时间和每日构建额度。
4. 保存只显示一次的长期固定 License Key。
5. 打开打包中心 `http://127.0.0.1:8788/build`，使用固定 Key 登录并创建构建。
6. 等待任务完成，保存一次性 Install Key 并下载专属 ZIP。
7. 把 ZIP 安装到 Xboard，先只填写一次性 Install Key 完成安装解锁。
8. 首次进入 APPGOG 后台，再填写长期固定 License Key 完成正式激活。

生成演示主题：

```powershell
npm run demo-theme
```

默认输出到 `var/demo/APPGOG-demo-theme.zip`。

## 验证

```powershell
npm test
```

## 准确的产品边界

当前版本会对“已经能安装的 Xboard 主题 ZIP”进行安全检查、删除 Source Map、为 JS/CSS 注入每包水印、对授权运行时执行每包标识符随机化，并生成随机保护目录与 AES-256-GCM 加密包身份载荷。它不会执行用户上传的源码，也不会自动运行任意 Vue/npm 构建命令；通用第三方业务 JS/CSS 也不会被激进改写，以避免破坏真实主题兼容性。独立 Worker 已支持通过授权中心 HTTP 接口传输源码和成品，可部署在另一台服务器；授权中心仍是单机 SQLite，不提供多授权中心并行写入或自动数据库高可用。

如果要直接上传 APPGOG 的原始 Vue 工程并自动编译，需要提供真实源码、依赖版本、构建命令和最终 Xboard 安装目录结构，再在现有 `BuildEngine` 接口后接入隔离容器构建适配器。网站、授权、Key、队列和激活流程无需推倒重做。

浏览器端保护可以增加普通复制和批量滥用的成本，但客户控制自己的服务器，不能承诺“绝对无法破解”或在同域名环境迁移时可靠识别服务器变化。高价值设置接口、主题启用按钮和服务端环境指纹仍需取得真实 APPGOG/Xboard 项目后对接服务端授权守卫。客户构建不提供历史版本降级；服务器升级失败恢复属于安装器内部的数据保护流程。

详细规则见 [系统架构](docs/architecture.md)、[API 契约](docs/api-contract.md)、[拆分边界](docs/modular-boundaries.md) 和 [开发计划](docs/development-plan.md)。
