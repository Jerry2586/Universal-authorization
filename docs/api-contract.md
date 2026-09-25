# API 契约 v1

所有 JSON 错误使用统一格式：

```json
{ "error": { "code": "DOMAIN_MISMATCH", "message": "当前域名与打包授权域名不一致", "request_id": "0b71991d-4fd1-4b82-9284-b09fca8998c3" } }
```

所有响应返回 `X-Request-Id`。调用方可发送 8–128 位的 `X-Request-Id` 作为关联 ID；不合法或缺失时服务端生成 UUID。所有写请求都可用该 ID 关联运行日志、诊断日志和安全审计。支持跨域的公共接口允许 `X-Request-Id` 与 `Idempotency-Key` 请求头；真正的幂等操作仍由各自资源身份、状态机和固定分块序号保证，不能仅把请求 ID 当作幂等键。

## 客户产品安装与授权接口

| 方法和路径 | 身份 | 用途 |
|---|---|---|
| `POST /api/v1/install-windows/start` | 官方包证明 | 第一次点击“开始激活”时创建或读取不可重置的 60 分钟安装窗口 |
| `POST /api/v1/install-windows/expire` | 窗口 ID + 窗口 Token | 到期后读取服务端状态并取得 `deactivate_and_remove_theme` 安全清理指令 |
| `POST /api/v2/install-unlocks` | 窗口 + 一次性 Install Key + 官方包证明 | 新版安装包第一阶段解锁；窗口、Build、Package、域名和 Installation ID 必须完全一致 |
| `POST /api/v1/install-unlocks` | 历史安装包 | 保留旧客户端兼容；新包禁止调用此入口 |
| `POST /api/v1/activations` | Install Receipt + 固定 License Key | 第二阶段正式激活并签发能力快照 |
| `POST /api/v1/activations/recover` | 固定 Key + 原安装私钥 Challenge + 官方包证明 | 同服务器重装或凭证损坏后恢复，成功后轮换 Refresh Secret |
| `POST /api/v1/offline-licenses` | Active 激活 + Refresh Secret + 安装私钥 Challenge | 签发 `offline-license-v1` 文件，绑定服务器、域名、Build、Package 与套餐 |
| `POST /api/v1/product-migrations` | 源服务器安装私钥 | 为目标服务器新公钥签发短期迁机 Grant |
| `POST /api/v1/product-migrations/prepare` | 目标服务器安装私钥 | 创建候选激活，不影响源服务器 Active 状态 |
| `POST /api/v1/product-migrations/commit` | 目标服务器安装私钥 | 唯一 Active 切换并 Fenced 旧服务器 |
| `POST /api/v1/product-migrations/rollback` | 当前所有者安装私钥 | 在受控窗口内撤销候选或恢复源服务器 |

安装窗口 Token 必须由安装端在首次点击前生成并先持久化，再提交服务端。相同 Build 与 Installation ID 重试只能返回原窗口，不能生成新截止时间。超时清理由 Xboard 服务端桥执行；浏览器不得直接操作主题目录。

## Xboard APPGOG License Bridge

客户 ZIP 内置 `appgog-license/appgog-license-bridge.zip`。`index.html`、`editor.html` 与 `dashboard.blade.php` 必须注入同一授权运行时，主题管理后台不得绕过授权门。首次只能从已登录的 Xboard 管理员浏览器打开主题，运行时从 `XBOARD_ACCESS_TOKEN` 读取管理令牌，并仅向同源官方接口调用 `plugin/upload`、`plugin/install`、`plugin/enable` 与 `plugin/getPlugins`；令牌不得发送到 APPGOG 授权中心。插件健康检查通过前，浏览器不得调用 `install-windows/start`。

插件公开接口固定为：

| 方法和路径 | 返回边界 |
|---|---|
| `GET /api/v1/appgog-license-bridge/health` | 插件版本与公开 Installation ID/公钥 |
| `POST /api/v1/appgog-license-bridge/state/runtime` | 只返回 Activation ID、签名 Activation Token、Backend Origin、拒绝状态和非敏感窗口元数据 |
| `POST /api/v1/appgog-license-bridge/refresh` | 插件在服务端使用加密保存的 Refresh Secret 和安装私钥刷新，只向浏览器返回新签名 Token |
| `POST /api/v1/appgog-license-bridge/deactivate-theme` | 从插件加密状态读取窗口凭证，向授权中心确认固定清理指令后先切回原主题，再删除当前 APPGOG 主题 |

插件管理员接口为 `register`、`sign-challenge`、`state/read`、`state/write`，必须通过 Xboard `admin` 中间件。`state/runtime` 永远不得返回 `refresh_secret`、`install_receipt_secret` 或 `install_window_token`。

## 网页内部接口 `/web/*`

客户打包中心和卖家后台分别部署在两个入口；打包中心只代理客户路径，授权中心持有数据与管理员接口。本机同一主机不同端口时也使用不同的管理员/客户 HttpOnly、SameSite=Strict Cookie。登录后每个写操作还须带登录结果中的 `X-CSRF-Token`。这些接口供对应站点页面使用，不供安装后的主题调用。

| 方法和路径 | 身份 | 用途 |
|---|---|---|
| `POST /web/customer/login` | 固定 License Key | 输入 `{ "license_key": "..." }` 登录，返回 CSRF Token |
| `POST /web/admin/login` | 管理员账号密码 | 输入 `{ "username": "...", "password": "..." }` 登录 |
| `GET /web/session?actor=admin\|customer` | 对应已登录会话 | 当前身份和 CSRF Token；打包中心仅允许 customer |
| `POST /web/logout?actor=admin\|customer` | 对应已登录会话 | 退出并清除该身份 Cookie，不影响另一身份 |
| `GET /web/customer/overview` | 客户 | 当前授权、过去 24 小时已用/剩余构建额度、可用版本、最近构建与自己的工单 |
| `POST /web/customer/domain/bind` | 客户 | 首次绑定域名；仅未绑定状态可执行，输入 `{ "domain": "example.com" }` |
| `POST /web/customer/domain-migrations` | 客户 | 按后台冷却策略自助即时换绑域名；固定 Key 不变，旧 Activation 立即撤销 |
| `POST /web/customer/builds` | 客户 | 输入 `{ "version": "1.0.0", "domain": "demo.example.com" }` 创建任务 |
| `GET /web/customer/builds/{id}` | 所属客户 | 任务状态、成品 SHA-256 和本次 Install Key |
| `POST /web/customer/builds/{id}/download-ticket` | 所属客户 + CSRF | 创建约 5 分钟有效、不可猜测并绑定当前会话和构建任务的下载票据 |
| `GET /web/customer/builds/{id}/download?ticket=...` | 所属客户 + 有效票据 | 下载已完成 ZIP；返回 `X-Appgog-Sha256` |
| `POST /web/customer/tickets` | 客户 | 创建打包、构建、安装、授权或咨询工单，可关联自己的构建任务 |
| `GET /web/customer/tickets/{id}` | 所属客户 | 查看工单公开对话与附件，不返回内部备注 |
| `POST /web/customer/tickets/{id}/messages` | 所属客户 + CSRF | 继续回复工单 |
| `POST /web/customer/tickets/{id}/close` | 所属客户 + CSRF | 输入关闭原因并关闭自己的工单；关闭后不能继续回复 |
| `POST /web/customer/tickets/{id}/attachments?filename=...` | 所属客户 + CSRF | 上传 PNG/JPEG/WebP/TXT/LOG/PDF，单文件不超过 10 MB |
| `GET /web/admin/overview` | 管理员 | 统计、授权、版本、构建、工单、激活与审计 |
| `POST /web/admin/licenses` | 管理员 | 签发长期固定 Key；明文 Key 只在本次响应中显示 |
| `POST /web/admin/versions` | 管理员 | 登记尚未发布的草稿版本 |
| `POST /web/admin/versions/upload?product_code=appgog&version=1.0.0&display_name=APPGOG` | 管理员 | 请求体为 ZIP 原始字节，`Content-Type: application/zip`；检查并发布可安装主题版本 |
| `POST /web/admin/licenses/{id}/rotate-key` | 管理员 | 轮换固定 Key，返回只显示一次的新 Key |
| `POST /web/admin/licenses/{id}/key` | 授权管理员 + 当前密码 | 单独查看完整固定 Key，并写安全审计；列表接口仍只返回脱敏值 |
| `GET /web/admin/licenses/{id}/events` | `license.view` | 查看该授权的统一生命周期事件，不返回完整 Key、Secret 或 Token |
| `POST /web/admin/licenses/{id}/domain` | 管理员 | 输入 `{ "domain": "new.example.com" }` 换绑域名 |
| `POST /web/admin/licenses/{id}/plan` | 授权管理员 | 切换免费版、付费版或历史兼容版，并增加 License generation |
| `DELETE /web/admin/licenses/{id}` | 平台所有者 + 当前密码 + 精确确认文本 | 永久删除授权及关联业务记录/文件；失败文件进入补偿清理，不保留可识别业务数据 |
| `POST /web/admin/erasure-cleanup/retry` | 平台所有者 | 立即重试永久删除留下的文件补偿任务；系统启动时也会自动重试 |
| `POST /web/admin/domain-migrations/{id}/review` | 授权管理员 | 兼容处理旧版尚未结束的迁移申请；v1.1.0 客户新换绑不再等待审批 |
| `POST /web/admin/licenses/{id}/status` | 管理员 | 输入 `{ "status": "active" }`，也支持 `suspended`、`revoked` |
| `POST /web/admin/account/password` | 当前管理员 | 校验当前密码并把密码修改为新的六位数字，成功后撤销该账号全部会话 |
| `DELETE /web/admin/admins/{id}` | 所有者 | 软删除普通管理员并撤销会话；不能删除所有者或当前账号 |
| `POST /web/admin/cms/settings` | 所有者 | 修改平台名称、换绑冷却和运营公告；部署域名、服务开关拒绝网页写入 |
| `GET /web/admin/tickets/{id}` | `ticket.view` | 查看客户、授权、构建上下文、公开回复和内部备注 |
| `POST /web/admin/tickets/{id}/messages` | `ticket.manage` | 发送客户可见回复或内部备注 |
| `POST /web/admin/tickets/{id}/update` | `ticket.manage` | 更新优先级、处理状态和指派管理员 |
| `POST /web/admin/tickets/{id}/attachments?filename=...` | `ticket.manage` | 上传安全白名单附件 |
| `GET /web/admin/system/migrations` | 平台所有者 | 查看控制中心身份、接收会话、当前操作和迁移历史 |
| `POST /web/admin/system/migrations/receiver` | 平台所有者 + CSRF | 在目标服务器开启 15 分钟一次性迁移接收并返回配对码 |
| `POST /web/admin/system/migrations/receiver/close` | 平台所有者 + CSRF | 关闭当前迁移接收会话 |
| `POST /web/admin/system/migrations/source` | 平台所有者 + CSRF | 输入目标 HTTPS 地址和配对码，排队执行源服务器受控迁移 |

当前构建下载同时要求客户会话和短期 HMAC 下载票据；票据绑定会话 ID、构建任务、随机 nonce 和过期时间，成品引用不直接暴露为公共静态 URL。`Install Key` 在已完成构建详情中可再次查看；它只有首次成功安装解锁可用一次，不应把“只使用一次”误解为“只展示一次”。自助换绑后 License generation 增加，未使用 Install Receipt 和旧 Activation 立即撤销，客户在新域名重新输入原固定 Key 激活。

## 管理自动化接口

`POST /api/v1/admin/licenses` 与 `POST /api/v1/admin/licenses/{license_id}/rotate-key` 使用 `Authorization: Bearer <ADMIN_TOKEN>`，面向可信自动化调用。网页登录使用管理员用户名和密码，不使用此 Token。

签发固定 Key 示例：

```json
{
  "product_code": "appgog",
  "customer_ref": "ORDER-10001",
  "domain": "demo.example.com",
  "update_until": "2027-09-22T00:00:00.000Z",
  "max_builds_per_day": 3
}
```

`domain` 可省略；此时客户登录打包中心后必须先执行首次域名绑定，绑定完成前不能创建构建。

## 构建协议

客户页面推荐使用 `/web/customer/builds`，队列自动完成后续构建。以下是给可信集成使用的底层协议：

- `POST /api/v1/builds/authorize`：输入 `license_key`、`version`、`domain`，返回有效期约 15 分钟的一次性 `build_ticket`。
- `POST /api/v1/worker/builds/claim`：Worker Token 鉴权，输入 `build_ticket`，返回 `build_id`、`package_id`、`package_secret` 和 `install_key`。这是底层直领构建身份接口；正常网页流程由队列和内置 Worker 自动处理。

Worker 内部队列接口均使用 `Authorization: Bearer <WORKER_TOKEN>`：

| 方法和路径 | 用途 |
|---|---|
| `POST /api/v1/worker/jobs/lease` | 输入 `worker_id`，租约下一任务；无任务时返回 `{ "task": null }` |
| `POST /api/v1/worker/jobs/{id}/progress` | 输入 `worker_id`、`progress`、`message` 更新进度 |
| `POST /api/v1/worker/jobs/{id}/complete` | 输入 `worker_id`、`build_id`、`artifact_ref`、`artifact_sha256`、`install_key`、`package_proof`；服务端验证租约、整包 SHA-256、Install Key、Package Secret、签名包身份、AES-GCM 加密身份载荷、随机保护路径、Source Map 清理、逐文件摘要和 HMAC |
| `POST /api/v1/worker/jobs/{id}/fail` | 输入 `worker_id`、`code`、`message` 失败回滚 |

## 两阶段安装与激活

`GET /api/v1/public-key` 返回三类 Ed25519 公钥。旧 `public_key` 是 Activation 公钥兼容别名；新客户端使用 `public_keys`：

```json
{
  "algorithm": "Ed25519",
  "public_key": "<activation-public-key>",
  "public_keys": {
    "activation": "<activation-public-key>",
    "package": "<package-public-key>",
    "notification": "<notification-public-key>"
  }
}
```

产品服务器首次安装时生成本地 Ed25519 安装身份。调用 `POST /api/v1/installation-challenges` 提交用途、安装公钥和规范化上下文，取得一次性 Challenge；安装解锁或刷新时同时提交 `installation_public_key`、`challenge_id` 和 `challenge_signature`。Challenge 只能消费一次，Installation ID 由安装公钥指纹派生。

第一阶段调用 `POST /api/v1/install-unlocks`，只提交一次性 Install Key：

```json
{
  "install_key": "INS-XXXX-XXXX-XXXX",
  "build_id": "bld_...",
  "package_proof": "PKG_...",
  "domain": "demo.example.com",
  "backend_url": "https://panel.example.com",
  "installation_id": "installation_random_value"
}
```

成功后立即消费 Install Key，并返回 `install_receipt_id`、`install_receipt_secret`、`unlocked_at`。此时只完成安装解锁，APPGOG 正式功能仍必须保持锁定。

第二阶段调用 `POST /api/v1/activations`，只由用户输入长期固定 License Key；Install Receipt 由本地安装状态自动带上：

```json
{
  "license_key": "APPGOG-XXXX-XXXX-XXXX-XXXX",
  "install_receipt_id": "irc_...",
  "install_receipt_secret": "IRC_...",
  "build_id": "bld_...",
  "package_proof": "PKG_...",
  "domain": "demo.example.com",
  "backend_url": "https://panel.example.com",
  "installation_id": "installation_random_value"
}
```

成功后返回 `activation_id`、`activation_token`、`refresh_secret`、`expires_at`。服务端会再次核对 License、Install Receipt、Build/Package、域名、Origin、Installation ID 和 generation。不存在同时提交 Install Key 与固定 License Key 完成全部激活的兼容接口。客户可控服务器上的实际 APPGOG 服务端应在不可公开访问的目录安全保存 Install Receipt、刷新 Secret 和安装身份。

`POST /api/v1/activations/refresh`：

```json
{
  "activation_id": "act_...",
  "refresh_secret": "RFS_...",
  "domain": "demo.example.com",
  "backend_url": "https://panel.example.com",
  "installation_id": "installation_random_value"
}
```

刷新时检查授权状态、Key generation、域名、后台 Origin 和 Installation ID。旧固定 Key 轮换后不能继续打包，旧激活在下次刷新时失效。

## 客户产品受控迁机

- `POST /api/v1/product-migrations`：旧 Active 实例使用 Refresh Secret、安装公钥和一次性 Challenge Proof 申请短期 `PMG_` Grant，并指定目标安装公钥。
- `POST /api/v1/product-migrations/accept`：目标实例提交 Grant、Build/Package、域名、Origin、新安装身份和新的 Challenge Proof。

接管成功后返回新 Activation/Refresh 凭据；旧 Installation Identity 与旧 Activation 进入 Fenced。Grant 一次性使用，相同域名不能绕过安装身份验证，也不允许新旧实例长期双活。

## 控制中心迁移传输协议

控制中心迁移接口仅供两台已安装同版本 APPGOG 的服务器使用：

| 方法和路径 | 用途 |
|---|---|
| `POST /api/v1/control-migrations/handshake` | 使用一次性配对码建立迁移上传会话 |
| `PUT /api/v1/control-migrations/{id}/bundle/chunks/{index}` | 上传固定序号分块；要求 Bearer 上传凭证、`X-APPGOG-Chunk-SHA256` 和 `X-APPGOG-Total-Chunks` |
| `POST /api/v1/control-migrations/{id}/bundle/complete` | 提交总块数、整包 SHA-256 和备份恢复密钥；全部块校验成功后才排队恢复 |
| `GET /api/v1/control-migrations/{id}/status` | 使用 Bearer 上传凭证查询目标恢复状态 |

正式脚本固定使用 64 MiB 分块。目标只写入受控收件箱，同序号重传覆盖同一文件；缺块、块摘要不符或整包摘要不符都会拒绝恢复。旧整包 `PUT .../bundle` 仅保留兼容，不作为正式迁移通道。

## 版本和部署约束

网页内部协议可随页面调整；外部激活协议 v1 保持向后兼容。正式跨域部署必须使用 HTTPS，Worker Token 和管理员自动化 Token 不得发送到客户浏览器。现在的内置 Worker 与本地 ZIP 存储适合第一版；独立 Worker、对象存储和源码编译将在不改变对外激活协议的前提下接入。
