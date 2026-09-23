# APPGOG 主题授权与打包系统

这是一个可以直接安装运行的 APPGOG/Xboard 主题授权、打包和激活 CMS。一套源码支持四种角色：完整 CMS、授权中心、客户打包中心和构建 Worker。授权中心持有唯一数据库与签名私钥；打包中心只代理客户接口；独立 Worker 可通过节点凭证下载源码 ZIP、上传构建成品，不需要和授权中心共享磁盘。

## 服务器部署教程（宝塔 / 1Panel / Docker）

> 第一次部署从这里开始。下面的教程直接显示在仓库首页，无需打开其他文档。
> 更新日期：2026-09-23。示例域名必须替换成自己的域名。三种方式任选一种，不要重复安装。

### 1. 先弄清楚需要安装什么

| 项目 | 说明 |
| --- | --- |
| 服务器 | 一台 Linux 服务器；建议从 2 核、2 GB 内存和 20 GB 可用磁盘起步，按主题大小与构建数量扩容 |
| 部署环境 | Docker Engine + Docker Compose 插件；容器内自带 Node.js 24，宿主机不需要另装 Node.js |
| 数据库 | 自带 SQLite，首次启动自动创建，不需要购买或安装 MySQL、Redis、PHP |
| 授权后台 | 示例为 https://auth.example.com/admin，管理员账号密码登录 |
| 客户打包站 | 示例为 https://build.example.com/build，客户用固定 License Key 登录 |
| 后台构建服务 | Worker 自动处理打包任务，没有单独的登录页面或公网端口 |

这条 Docker 安装路线会在同一台服务器启动授权中心、打包中心、Worker 三个容器。源码仍是一套 CMS；以后跨服务器部署可使用下方「CMS 安装与分离部署」中的节点方式。

准备两个域名的 DNS A 记录，都指向服务器公网 IPv4。放行 80、443 以及你实际使用的 SSH/面板端口。8787、8788 用于反向代理，不需要给公网用户开放。

### 2. 下载源码（私有仓库必看）

本仓库是私有项目。没有仓库读取权限会出现 404 或 Repository not found，这不代表仓库不存在。

**方法 A：下载 ZIP，适合第一次安装。**

1. 用有权限的 GitHub 账号打开本仓库，点击绿色「Code」→「Download ZIP」。
2. 在宝塔或 1Panel 文件管理中创建 /opt/appgog，上传 ZIP 并解压。
3. 如果解压后多了一层 Universal-authorization-main 文件夹，把该文件夹里面的文件（包括隐藏文件）移到 /opt/appgog。
4. 最终必须能看到 /opt/appgog/compose.yaml、Dockerfile、package.json、apps 和 scripts。
5. 不要把源码目录设成公开静态网站根目录。

**方法 B：使用 Git，适合以后自动拉取更新。** 在服务器已经配置有读取本仓库权限的 SSH Key 后执行：

~~~bash
sudo mkdir -p /opt/appgog
sudo chown "$(id -un):$(id -gn)" /opt/appgog
git clone git@github.com:Jerry2586/Universal-authorization.git /opt/appgog
cd /opt/appgog
~~~

目录必须为空；已下载 ZIP 的目录不要再次执行 clone。也可以使用已经完成认证的 HTTPS Git 地址，不要把访问令牌写进命令、仓库文件或截图。

### 3. 准备 Docker 环境

- **宝塔用户：** 在软件商店安装 Docker 管理器和 Nginx，然后打开面板终端。
- **1Panel 用户：** 确认容器功能可用，并在应用商店安装 OpenResty，然后打开终端。
- **纯 Linux 用户：** 根据服务器系统安装 Docker Engine 和 Compose 插件；不要把 Ubuntu 的安装命令直接用于其他发行版。官方安装入口见本节末尾的参考资料。

在终端检查（没有 Docker 权限时使用 sudo，或切换到面板管理员终端）：

~~~bash
docker version
docker compose version
cd /opt/appgog
ls compose.yaml Dockerfile package.json scripts/install-cms.js
~~~

前两个命令应输出版本信息，最后一个命令应找到四个文件。此时还不启动服务。

### 4. 生成正式配置和首次管理员密码

**仅在全新安装、目录中不存在 .env 时执行下面的命令。** 先把两个 example.com 域名替换为自己的域名，再整段复制到 Linux 终端：

~~~bash
cd /opt/appgog
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/app" -w /app node:24-bookworm-slim \
  node scripts/install-cms.js \
  --role license-center \
  --public-url https://auth.example.com \
  --build-url https://build.example.com/build
~~~

命令会生成 .env，显示管理员账号 admin 和随机密码。**立即保存密码：没有统一的默认正式密码。** 安装器默认拒绝覆盖已有 .env，不要为了消除报错加 --force。

这里使用 license-center 角色，是因为仓库的 compose.yaml 另外启动了打包中心和 Worker；你无需再单独安装它们。

通过面板文件管理显示隐藏文件，编辑 /opt/appgog/.env，确认以下配置，并在末尾增加两个端口设置：

~~~dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://auth.example.com
BUILD_CENTER_PUBLIC_URL=https://build.example.com/build
LICENSE_PORT=127.0.0.1:8787
BUILD_PORT=127.0.0.1:8788
~~~

PUBLIC_BASE_URL 不能带 /admin；BUILD_CENTER_PUBLIC_URL 需要带 /build。不要把随机密钥替换成示例文字。两个端口设置使服务只监听宿主机回环地址，适用于本机 Nginx 或 host 网络模式的 OpenResty。

~~~bash
chmod 600 /opt/appgog/.env
cd /opt/appgog
docker compose config --quiet
docker compose up -d --build
docker compose ps
~~~

首次启动会下载镜像并构建，耗时取决于网络。应看到 license-center、build-center、build-worker；前两个等待健康检查后显示 healthy，Worker 显示运行中即可。

~~~bash
curl -f http://127.0.0.1:8787/health
curl -f http://127.0.0.1:8788/health
~~~

两条命令都应成功返回包含 ok 的 JSON。这里只验证服务；正式登录需要下面的 HTTPS 域名。

### 5A. 宝塔：配置两个网站和证书

完成前面的公共步骤后：

1. 进入「网站」，添加 auth.example.com。无需创建数据库或 PHP 运行环境。
2. 打开该站点设置的「反向代理」，添加代理，目标 URL 填 http://127.0.0.1:8787，代理目录为 /，发送域名填 $host。
3. 在该站点 Nginx 的 server 配置中设置 client_max_body_size 150m;，代理读取和发送超时可设为 300s。保存前检查配置，不要重复添加已有的同名指令。
4. 打开「SSL」，为这个域名申请证书，启用 HTTPS 和强制 HTTPS。
5. 再添加 build.example.com，目标 URL 换成 http://127.0.0.1:8788，其余步骤相同。
6. 代理不要缓存后台、登录接口或下载响应；保留 Host 和 X-Forwarded-Proto 等转发请求头。
7. 打开 https://auth.example.com/admin 和 https://build.example.com/build 验收。

面板版本不同，菜单名称可能略有区别。两个网站是反向代理站点，不要把 /opt/appgog 作为公开文件目录，也不要通过 file:// 打开 HTML。

### 5B. 1Panel：配置两个网站和证书

完成公共步骤后，容器已经由终端创建。在「容器」中查看即可；不要再建第二套编排。需要在面板导入时，选择原目录 /opt/appgog/compose.yaml，保持项目名 appgog 和同一份 .env。

1. 进入「网站」，确认 OpenResty 已安装并启动。
2. 创建「反向代理」类型网站，主域名填 auth.example.com，代理地址填 http://127.0.0.1:8787。
3. 再创建 build.example.com，代理地址填 http://127.0.0.1:8788。
4. 为两个域名申请证书，在网站 HTTPS 设置中选用证书并开启 HTTP 跳转 HTTPS。
5. 请求体大小设为至少 150 MB，转发时保留 Host、X-Forwarded-For、X-Forwarded-Proto；代理超时设为 300s。
6. 分别访问两个入口，并用步骤 6 验收。

**遇到代理 502 时先检查 OpenResty 网络模式：** 在容器详情中查看，或把实际容器名代入下面命令：

~~~bash
docker inspect --format '{{.HostConfig.NetworkMode}}' 实际OpenResty容器名
~~~

上述回环地址方案要求 OpenResty 使用 host 网络。如果是 bridge 网络，容器中的 127.0.0.1 指向容器自身，不能直接访问宿主机服务。首次新装时可选择 host 网络后再建站；已有网站不要直接改网络，以免中断其他服务，应规划共享 Docker 网络或可达的宿主机地址。不要用开放所有公网端口的方法解决。

### 5C. 纯 Docker：使用宿主机 Nginx 代理

Docker 容器已在步骤 4 启动。还需要宿主机 Nginx 或你已有的 HTTPS 网关来接入域名。以下 Nginx 示例放入两个站点的配置位置，不是 shell 命令：

~~~nginx
server {
    listen 80;
    server_name auth.example.com;
    client_max_body_size 150m;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
server {
    listen 80;
    server_name build.example.com;
    client_max_body_size 150m;
    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
~~~

在 Ubuntu / Debian、使用发行版 Nginx 和 Certbot 包的服务器上，可执行：

~~~bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
~~~

把上面的两段配置保存为 /etc/nginx/conf.d/appgog.conf，替换真实域名。检查并加载后申请证书：

~~~bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d auth.example.com -d build.example.com --redirect
sudo certbot renew --dry-run
~~~

域名需正确解析且 80/443 可达。按提示填写证书通知邮箱并确认条款。证书申请成功前不要把 HTTP 登录失败误认为密码错误。已使用宝塔或 1Panel 的服务器通过面板管理证书，不要额外安装一套 Nginx 抢占端口。

### 6. 安装成功后怎么用

1. 访问 https://auth.example.com/admin，使用步骤 4 保存的账号和密码登录。
2. 打开「CMS 与节点」，检查授权地址、客户打包地址和服务开关；后台已有的持久化设置也需要检查，不能假设改 .env 就覆盖了它们。
3. 上传一个已经能安装到 Xboard 的主题 ZIP，创建并发布版本。
4. 创建客户授权，绑定域名、设置更新期限和构建额度，保存只显示一次的固定 License Key。
5. 打开 https://build.example.com/build，用客户固定 Key 登录，不是管理员密码。
6. 选择版本并创建构建，等待完成，保存本次 Install Key，下载专属 ZIP。
7. 安装到 Xboard 后，在主题激活页填写固定 Key、这次的 Install Key 和后台地址。

### 7. 更新、备份与重启

**更新前先备份。** Docker 数据放在命名卷里，复制源码目录不等于备份数据库。请保留 .env 以及四个实际使用的卷：数据库、签名密钥、源码与成品、临时上传。

先在 /opt/appgog 执行 docker compose volumes -q 查看卷名（旧版 Compose 不支持时，用 docker volume ls 和 docker inspect 查看实际挂载）。默认项目名为 appgog，卷名通常是 appgog_appgog-db、appgog_appgog-keys、appgog_appgog-artifacts、appgog_appgog-uploads；下面命令仅在确认这四个卷就是当前服务所用卷之后执行。

在低峰期用管理员终端执行。备份期间网站会短暂不可用，四个打包命令全部成功后再进行源码更新：

~~~bash
cd /opt/appgog
BACKUP_DIR="/opt/appgog-backups/$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$BACKUP_DIR"
cp .env "$BACKUP_DIR/appgog.env"
cp compose.yaml "$BACKUP_DIR/compose.yaml"
# 更新前先拉取备份工具，避免停机后才等待下载
docker pull alpine:3.22
docker compose stop
# 若实际卷名不同，先替换下列卷名；不要对不存在的卷执行备份
for volume in appgog_appgog-db appgog_appgog-keys appgog_appgog-artifacts appgog_appgog-uploads; do
  docker volume inspect "$volume" >/dev/null || break
  docker run --rm --mount "type=volume,src=$volume,dst=/source,readonly" \
    -v "$BACKUP_DIR:/backup" alpine:3.22 \
    sh -c "cd /source && tar czf /backup/$volume.tar.gz ." || break
done
docker compose start
ls -lh "$BACKUP_DIR"
~~~

确认存在 .env 的备份、Compose 文件和四个非空 .tar.gz 文件，并记录当前源码版本。任一备份命令失败就先排查，不要继续更新。把备份复制到另一台设备；备份含密钥，不能放到可公开下载的目录。更详细说明见 [数据备份](docs/宝塔-1Panel-Docker部署教程.md#八数据备份)。

Git 安装方式更新：

~~~bash
cd /opt/appgog
git pull --ff-only
docker compose up -d --build
docker compose ps
~~~

ZIP 安装方式更新：下载新源码，先备份旧源码和配置，再替换应用文件，保留原 .env、compose 项目名 appgog 和数据卷，然后执行 docker compose up -d --build。不要重新运行安装器生成新密钥，也不要把旧 .env 换成示例配置。

~~~bash
# 查看日志（Ctrl+C 退出日志，不会停止容器）
docker compose logs -f --tail=100
# 临时停止 / 再启动
docker compose stop
docker compose start
# 仅修改应用代码后，重新构建并启动
docker compose up -d --build
~~~

不要执行 docker compose down -v：它会删除业务数据卷。修改 .env 后使用 up -d 重建配置，单纯 restart 不会加载新的 Compose 环境变量。当前没有自动数据库回滚功能，更新失败需依据备份和对应源码版本恢复。

### 8. 常见问题对照

| 现象 | 处理方式 |
| --- | --- |
| GitHub 404 / Repository not found | 使用有私有仓库读取权限的账号下载，或配置 SSH 仓库读取权限 |
| .env 已存在 | 已安装过；保留原配置，不要用 --force 覆盖 |
| 找不到 compose.yaml | 解压多了一层目录，或终端没有进入 /opt/appgog |
| 首次镜像下载失败 | 检查服务器到镜像仓库的网络，修复后重试，不要删除数据卷 |
| 生产环境 HTTPS / 密钥校验报错 | 查看 license-center 日志，核对正式域名与安装器生成的随机密钥 |
| 网站 502 | 先 curl 本机两个 health 地址，再核对代理端口；1Panel 检查 OpenResty 网络模式 |
| 登录后又回到登录页 | 使用 HTTPS 域名；检查代理、Cookie 与浏览器是否禁用了 Cookie |
| 上传 413 | Nginx/OpenResty 设置 client_max_body_size 150m;；应用默认 ZIP 上限为 128 MiB |
| 构建一直排队 | 查看 build-worker 日志，检查运行状态、WORKER_TOKEN、磁盘空间和卷挂载 |
| 改了 .env 密码仍登录不了 | 密码在首次初始化时写入数据库，之后改 .env 不会重置已有管理员密码 |
| 更新后看不到原数据 | 检查 Compose 项目名和挂载卷是否变化，不要急着初始化新数据库 |

~~~bash
cd /opt/appgog
docker compose logs --tail=100 license-center
docker compose logs --tail=100 build-center
docker compose logs --tail=100 build-worker
~~~

官方环境与面板资料（菜单可能随版本变化）：[Docker Engine 安装](https://docs.docker.com/engine/install/)、[Compose 插件](https://docs.docker.com/compose/install/linux/)、[宝塔反向代理](https://docs.bt.cn/user-guide/site/php/site-config/reverse-proxy)、[1Panel 创建网站](https://1panel.cn/docs/v2/user_manual/websites/website_create/)。

## CMS 安装与分离部署

普通用户在一台服务器完整安装：

```powershell
npm run cms:install -- --role all-in-one --public-url https://auth.example.com
npm run cms:start
```

完成后访问 `/admin`，打开“CMS 与节点”，即可管理平台域名、服务开关和独立节点。安装器会生成正式环境密钥和首个管理员密码；`.env` 已存在时默认拒绝覆盖。

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

生成可交付的干净 CMS 安装 ZIP（自动排除 `.env`、数据库、密钥、成品和 Git 历史）：

```powershell
npm run cms:package
```

输出目录为 `dist/`。

## 已完成的闭环

1. 卖家在 `/admin` 上传一个已经可以安装到 Xboard 的主题 ZIP，并发布版本。
2. 卖家给客户签发长期固定 License Key，并绑定一个域名。
3. 客户在 `/build` 使用固定 Key 登录，选择版本并提交打包。
4. 每次打包生成独立的 Build ID、Package ID、Package Secret 和一次性 Install Key。
5. 独立 Worker 检查 ZIP 安全性、注入激活运行时和构建清单，并生成客户专属 ZIP。
6. 客户下载安装包，并在主题激活页输入本次 Install Key、长期固定 Key 和 Xboard 后台地址。
7. 授权服务器校验包身份、域名和安装环境，签发 Ed25519 激活凭证。
8. 更新或重装时，客户继续使用长期固定 Key 重新打包，得到新的 ZIP 和新的 Install Key。

## 当前能力

- 长期固定 License Key、域名绑定、换域名、暂停、恢复、撤销和 Key 轮换。
- 每次构建独立身份和一次性 Install Key，Install Key 激活成功后不能重复使用。
- 激活凭证绑定域名、Xboard 后台 Origin、Installation ID、Build 和 Package。
- Ed25519 数字签名与本地验签；固定 Key、安装 Key、刷新 Secret 等只保存 HMAC 摘要。
- 管理员账号密码登录及所有者、授权运营、版本管理员、客服、审计角色；客户和管理员独立 HttpOnly Cookie 与 CSRF 防护，成员可停用并撤销会话。
- 客户打包站只接收固定 Key，不暴露内部客户编号、订单号或授权记录 ID；授权中心可审计成员操作。
- 已激活主题使用服务端签名的离线宽限；网络故障/服务端故障时限期可用，明确拒绝会锁定；初次激活仍必须在线。
- 版本公告由服务端签名，客户可在有效更新期内下载更新包或按策略重新构建历史版本回滚包。
- 管理后台可上传/发布主题 ZIP、签发授权、查看构建、激活和审计记录。
- 客户中心可查看授权、创建构建、查看进度、显示 Install Key 和下载成品。
- 安全 ZIP 解析：阻止目录穿越、加密 ZIP、压缩炸弹、符号链接、可执行文件和普通 PHP。
- 自动验证 Xboard 主题的 `config.json` 以及 `index.html` 或 `dashboard.blade.php`。
- 构建完成前验证实际成品 SHA-256 和 ZIP 结构。
- 授权中心只公开管理页面和授权 API；客户打包中心只公开客户页面并通过独立内部凭证代理客户接口。
- 独立 Worker 只领取构建任务和上报结果，不持有 Ed25519 签名私钥或管理员凭证。
- SQLite、本地文件存储和独立 Worker；均有可替换接口，便于以后迁移 PostgreSQL、S3 和容器 Worker。
- 27 个自动测试覆盖完整打包激活、双 Key、离线宽限、角色和会话隔离、CMS 节点凭证、版本签名、跨服务器构建、队列租约和失败回滚。

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

Linux、Docker Compose 和服务器面板部署见 `docs/deployment.md`；完整的宝塔、1Panel 和纯 Docker 操作步骤见 `docs/宝塔-1Panel-Docker部署教程.md`。

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
7. 把 ZIP 安装到 Xboard，在主题激活页填写本次 Install Key、固定 Key 和后台地址。

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

当前版本会对“已经能安装的 Xboard 主题 ZIP”进行安全检查、随机包身份注入、激活保护和重新打包；尚未对全部 JS/CSS 实施源码混淆或任意目录乱序。它不会执行用户上传的源码，也不会自动运行任意 Vue/npm 构建命令。独立 Worker 已支持通过授权中心 HTTP 接口传输源码和成品，可部署在另一台服务器；授权中心仍是单机 SQLite，不提供多授权中心并行写入或自动数据库高可用。

如果要直接上传 APPGOG 的原始 Vue 工程并自动编译，需要提供真实源码、依赖版本、构建命令和最终 Xboard 安装目录结构，再在现有 `BuildEngine` 接口后接入隔离容器构建适配器。网站、授权、Key、队列和激活流程无需推倒重做。

浏览器端保护可以增加普通复制和批量滥用的成本，但客户控制自己的服务器，不能承诺“绝对无法破解”或在同域名环境迁移时可靠识别服务器变化。高价值设置接口、主题启用按钮和服务端环境指纹仍需取得真实 APPGOG/Xboard 项目后对接服务端授权守卫。历史版本回滚包目前是重新构建旧版本，并不是自动备份/恢复 Xboard 数据。

详细规则见 [系统架构](docs/architecture.md)、[API 契约](docs/api-contract.md)、[拆分边界](docs/modular-boundaries.md) 和 [开发计划](docs/development-plan.md)。
