# APPGOG 主题授权与打包系统

这是一个可以本地直接运行的 APPGOG/Xboard 主题授权、打包和激活平台。默认按三个进程运行：授权中心 CMS、客户打包中心、构建 Worker。授权中心持有 SQLite 与签名私钥，Worker 只共享成品目录；客户站只通过内部代理使用客户接口。当前为单机部署架构，跨机器扩容仍需要数据库、队列和对象存储适配。

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
- 26 个自动测试覆盖完整打包激活、双 Key、离线宽限、角色和会话隔离、版本签名、跨进程构建、队列租约和失败回滚。

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

当前版本会对“已经能安装的 Xboard 主题 ZIP”进行安全检查、随机包身份注入、激活保护和重新打包；尚未对全部 JS/CSS 实施源码混淆或任意目录乱序。它不会执行用户上传的源码，也不会自动运行任意 Vue/npm 构建命令。当前独立 Worker 使用共享本地成品目录，因此适合单机三进程部署；多机部署前需替换对象存储、数据库和队列。

如果要直接上传 APPGOG 的原始 Vue 工程并自动编译，需要提供真实源码、依赖版本、构建命令和最终 Xboard 安装目录结构，再在现有 `BuildEngine` 接口后接入隔离容器构建适配器。网站、授权、Key、队列和激活流程无需推倒重做。

浏览器端保护可以增加普通复制和批量滥用的成本，但客户控制自己的服务器，不能承诺“绝对无法破解”或在同域名环境迁移时可靠识别服务器变化。高价值设置接口、主题启用按钮和服务端环境指纹仍需取得真实 APPGOG/Xboard 项目后对接服务端授权守卫。历史版本回滚包目前是重新构建旧版本，并不是自动备份/恢复 Xboard 数据。

详细规则见 [系统架构](docs/architecture.md)、[API 契约](docs/api-contract.md)、[拆分边界](docs/modular-boundaries.md) 和 [开发计划](docs/development-plan.md)。
