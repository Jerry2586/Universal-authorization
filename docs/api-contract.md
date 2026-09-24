# API 契约 v1

所有 JSON 错误使用统一格式：

```json
{ "error": { "code": "DOMAIN_MISMATCH", "message": "当前域名与打包授权域名不一致" } }
```

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
| `POST /web/customer/tickets/{id}/attachments?filename=...` | 所属客户 + CSRF | 上传 PNG/JPEG/WebP/TXT/LOG/PDF，单文件不超过 10 MB |
| `GET /web/admin/overview` | 管理员 | 统计、授权、版本、构建、工单、激活与审计 |
| `POST /web/admin/licenses` | 管理员 | 签发长期固定 Key；明文 Key 只在本次响应中显示 |
| `POST /web/admin/versions` | 管理员 | 登记尚未发布的草稿版本 |
| `POST /web/admin/versions/upload?product_code=appgog&version=1.0.0&display_name=APPGOG` | 管理员 | 请求体为 ZIP 原始字节，`Content-Type: application/zip`；检查并发布可安装主题版本 |
| `POST /web/admin/licenses/{id}/rotate-key` | 管理员 | 轮换固定 Key，返回只显示一次的新 Key |
| `POST /web/admin/licenses/{id}/domain` | 管理员 | 输入 `{ "domain": "new.example.com" }` 换绑域名 |
| `POST /web/admin/domain-migrations/{id}/review` | 授权管理员 | 兼容处理旧版尚未结束的迁移申请；v1.1.0 客户新换绑不再等待审批 |
| `POST /web/admin/licenses/{id}/status` | 管理员 | 输入 `{ "status": "active" }`，也支持 `suspended`、`revoked` |
| `POST /web/admin/account/password` | 当前管理员 | 校验当前密码并把密码修改为新的六位数字，成功后撤销该账号全部会话 |
| `DELETE /web/admin/admins/{id}` | 所有者 | 软删除普通管理员并撤销会话；不能删除所有者或当前账号 |
| `POST /web/admin/cms/settings` | 所有者 | 修改平台名称、换绑冷却和运营公告；部署域名、服务开关拒绝网页写入 |
| `GET /web/admin/tickets/{id}` | `ticket.view` | 查看客户、授权、构建上下文、公开回复和内部备注 |
| `POST /web/admin/tickets/{id}/messages` | `ticket.manage` | 发送客户可见回复或内部备注 |
| `POST /web/admin/tickets/{id}/update` | `ticket.manage` | 更新优先级、处理状态和指派管理员 |
| `POST /web/admin/tickets/{id}/attachments?filename=...` | `ticket.manage` | 上传安全白名单附件 |

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

`GET /api/v1/public-key` 返回 Ed25519 公钥。安装后的主题使用公钥本地验签。

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

## 版本和部署约束

网页内部协议可随页面调整；外部激活协议 v1 保持向后兼容。正式跨域部署必须使用 HTTPS，Worker Token 和管理员自动化 Token 不得发送到客户浏览器。现在的内置 Worker 与本地 ZIP 存储适合第一版；独立 Worker、对象存储和源码编译将在不改变对外激活协议的前提下接入。
