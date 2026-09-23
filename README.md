# APPGOG 主题授权与打包系统

这是一个可以直接安装运行的 APPGOG/Xboard 主题授权、打包和激活 CMS。一套源码支持四种角色：完整 CMS、授权中心、客户打包中心和构建 Worker。授权中心持有唯一数据库与签名私钥；打包中心只代理客户接口；独立 Worker 可通过节点凭证下载源码 ZIP、上传构建成品，不需要和授权中心共享磁盘。

## Linux 一行安装 + 专业管理菜单

在全新的 Debian、Ubuntu、CentOS、RHEL、Rocky Linux、AlmaLinux 或 Fedora 服务器上，以 root 身份执行一行命令：

```sh
curl -fsSL https://raw.githubusercontent.com/Jerry2586/Universal-authorization/main/scripts/install-linux.sh | sudo sh -s -- \
  --auth-domain sq.example.com \
  --build-domain db.example.com
```

若仓库不可公开访问，应把 `npm run cms:package` 生成的 ZIP 放到你控制的下载地址，然后额外传入 `--repository ZIP地址 --sha256 校验值`，避免在命令历史里暴露私有仓库 Token。

安装器会自动安装 Docker Engine 和 Compose v2、下载正式代码、生成只含两个域名的安全配置、构建并启动服务、安装全局 `appgog` 命令。交互安装也可以先下载项目，再执行：

```sh
sudo sh scripts/install-linux.sh
```

安装完成后输入 `appgog` 打开管理菜单，可查看状态、启停和重启服务、查看日志、保存域名配置、查看初始凭证、安全更新、完整备份、恢复和运行系统诊断。命令行模式同样可用：

```sh
appgog status
appgog logs build-worker
appgog update
appgog backup
appgog doctor
```

为避免破坏宝塔、aaPanel、1Panel、Nginx 或已有网站，一键安装器**不会抢占或修改 80/443**。安装后仍需把两个域名解析到服务器，并配置 HTTPS 反向代理到 `127.0.0.1:8787` 与 `127.0.0.1:8788`。管理菜单会持续显示正确目标。

## Docker 一体部署：只填写两个域名

一套代码自动部署 Node.js 运行环境、SQLite 数据库、授权中心、打包中心和 Worker。首次生成随机管理员密码与内部密钥，后续重建容器保留原身份和业务数据。手动 Docker 安装要求 Compose v2.24+，无需另外安装 Node.js 或 MySQL。

**完整傻瓜教程：[宝塔 / aaPanel / 1Panel / Docker 部署、更新和备份迁移](docs/宝塔-1Panel-Docker部署教程.md)。**

全新安装：解压 CMS ZIP 或下载本私有仓库到 /opt/appgog/APPGOG-CMS，然后执行：

```sh
cd /opt/appgog/APPGOG-CMS
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

在面板里做一次 DNS、SSL 和两个站点的反代配置：

| 域名 | 反向代理目标 | 入口 |
| --- | --- | --- |
| AUTH_DOMAIN | http://127.0.0.1:8787 | /admin |
| BUILD_DOMAIN | http://127.0.0.1:8788 | /build |

1Panel 的 OpenResty 若运行在独立 bridge 网络中，需要接入项目网络后用服务名反代，具体见完整教程。不要把 127.0.0.1 当成所有容器都通用的宿主机地址。

以后覆盖代码并保留 .env，然后执行：

```sh
# 构建新代码 → 完整备份 → 重建服务 → 健康检查
sh scripts/docker.sh update

# 单独备份（短暂停止写入）
sh scripts/docker.sh backup

# 新空服务器：先填写 .env，直接恢复，不要先 install
sh scripts/docker.sh restore /绝对路径/备份.tar.gz
```

备份包含数据库、签名密钥、内部凭证、上传源码和构建成品，请私密保存。更新不删除数据卷；不要执行 docker compose down -v。当前从源码构建镜像，尚未提供只执行 docker compose pull 的镜像发布方式。

**旧部署：不要覆盖原 .env。** 保留原秘密值、签名密钥和项目名 appgog，先完整备份，再按完整教程的“已有旧 Docker 部署升级”转换。新配置发现旧数据但缺少原凭证时会拒绝启动，避免原授权失效。

## 高级：CMS 手动安装与跨服务器分离部署

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
