# 通用 Key 授权服务端——第三步：产品与 Key 管理

> 文档版本：V1.0  
> 编制日期：2026-08-24  
> 本阶段只做：产品、版本、功能、授权策略、Key 生成与 Key 生命周期管理。  
> 本阶段不做：设备激活、设备绑定、客户端签名验证、授权令牌、刷新、心跳、支付、代理和管理后台页面。

---

## 1. 用一句话理解第三步

第三步就是先把“卖什么授权、授权能用多久、能用几台设备、开放哪些功能、生成哪些 Key”管理起来。

完成第三步后，管理员可以通过管理 API：

1. 创建产品。
2. 给产品登记版本。
3. 给产品定义功能，例如 `export.pdf`。
4. 创建授权策略，例如“30 天、1 台设备、1 个并发”。
5. 单个或批量生成 Key。
6. 查询 Key，但数据库和查询接口都看不到完整明文 Key。
7. 冻结、解冻、续期和永久吊销 Key。
8. 自动检查管理员权限和租户边界。
9. 自动保存敏感操作审计记录。

---

## 2. 最简单的使用顺序

```text
第一步：创建产品
  ↓
第二步：添加产品版本
  ↓
第三步：定义产品功能
  ↓
第四步：创建授权策略
  ↓
第五步：生成 Key，并立即安全保存返回的明文
  ↓
第六步：以后只能看到掩码 Key，不能从数据库找回明文
```

例如：

```text
产品：桌面设计软件
产品代码：designer-pro
功能：export.pdf、export.excel
策略：30 天授权、最多 1 台设备、最多 1 个在线会话
生成数量：100
```

服务端会一次性返回 100 个明文 Key。返回结束后，数据库只保存不可逆摘要和展示片段。

---

## 3. 管理 API 安全方式

管理 API 与客户端授权 API 完全分开：

```text
管理 API：/admin/v1/*
客户端 API：/api/v1/*
```

第三步不开发用户名密码登录页面。当前采用“可信管理网关”模式：

```http
Authorization: Bearer <MANAGEMENT_GATEWAY_TOKEN>
X-Admin-User-Id: <管理员 UUID>
X-Tenant-Id: <目标租户 UUID，仅平台管理员必须提供>
```

安全规则：

1. `MANAGEMENT_GATEWAY_TOKEN` 至少 32 个字符，通过环境变量提供。
2. Token 不正确时统一返回 `ADMIN_UNAUTHORIZED`。
3. 服务端会从 PostgreSQL 重新读取管理员状态、角色和权限，不能只相信请求头。
4. 租户管理员只能访问自己的租户。
5. 平台管理员跨租户操作时必须明确提供 `X-Tenant-Id`。
6. 正式部署时管理 API 必须放在 HTTPS 和可信网关后面。
7. 后续可以把当前解析器替换成真正的管理员登录、SSO 或 OAuth，不影响产品和 Key 业务代码。

---

## 4. 权限对应关系

| 操作 | 必须权限 |
|---|---|
| 查看产品、版本、功能 | `products.read` |
| 创建或修改产品、版本、功能 | `products.write` |
| 查看授权策略和 Key | `licenses.read` |
| 创建或修改授权策略 | `licenses.write` |
| 生成单个 Key | `licenses.write` |
| 批量生成并交付明文 Key | `licenses.write` + `licenses.export` |
| 冻结、解冻、续期、吊销 | `licenses.write` |

即使数据库误把平台权限分配给租户角色，代码仍然会再次检查租户边界。

---

## 5. 数据结构补充

第三步新增迁移：

```text
database/migrations/0002_management_stage.sql
```

在 `license_keys` 增加：

| 字段 | 作用 |
|---|---|
| `generation_batch_id` | 标记同一批生成的 Key |
| `offline_grace_seconds` | 该 Key 的离线宽限时间快照 |
| `allow_self_unbind` | 是否允许用户自助解绑 |
| `unbind_cooldown_seconds` | 自助解绑冷却时间 |
| `suspended_from_status` | 记录冻结前状态，保证正确解冻 |

为什么要保存策略快照：策略以后可能修改，但已经发出去的 Key 不应该偷偷改变设备数、并发数或离线时间。

---

## 6. 产品管理 API

### 6.1 创建产品

```http
POST /admin/v1/products
```

```json
{
  "code": "designer-pro",
  "name": "桌面设计软件",
  "description": "示例产品",
  "minimum_client_version": "1.0.0",
  "recommended_client_version": "1.5.0",
  "force_update_version": null,
  "settings": {}
}
```

规则：

- 产品代码只能使用小写字母、数字和中划线。
- 同一租户不能创建重复产品代码。
- 产品停用后，后续客户端激活阶段必须拒绝新激活。

### 6.2 查询产品

```http
GET /admin/v1/products?limit=50&offset=0
GET /admin/v1/products/{productId}
```

### 6.3 修改产品

```http
PATCH /admin/v1/products/{productId}
```

只传需要修改的字段。

---

## 7. 版本管理 API

```http
POST  /admin/v1/products/{productId}/versions
GET   /admin/v1/products/{productId}/versions
PATCH /admin/v1/products/{productId}/versions/{versionId}
```

示例：

```json
{
  "version": "1.5.0",
  "status": "ACTIVE",
  "force_update": false,
  "release_notes": "修复问题",
  "released_at": "2026-08-24T00:00:00.000Z"
}
```

版本状态：

- `ACTIVE`：允许使用。
- `BLOCKED`：禁止使用。
- `DEPRECATED`：已过时，但是否强制禁止由后续客户端验证阶段决定。

---

## 8. 功能定义 API

```http
POST  /admin/v1/products/{productId}/features
GET   /admin/v1/products/{productId}/features
PATCH /admin/v1/products/{productId}/features/{featureId}
```

示例：

```json
{
  "code": "export.pdf",
  "name": "导出 PDF",
  "description": "允许导出 PDF 文件",
  "status": "ACTIVE"
}
```

功能代码只表示“这个产品有哪些功能”。具体某个 Key 能不能用，由生成 Key 时的功能授权决定。

---

## 9. 授权策略 API

```http
POST  /admin/v1/license-policies
GET   /admin/v1/license-policies?product_id={productId}
PATCH /admin/v1/license-policies/{policyId}
```

30 天授权示例：

```json
{
  "product_id": "产品 UUID",
  "code": "standard-30d",
  "name": "标准版 30 天",
  "license_type": "DURATION",
  "duration_seconds": 2592000,
  "max_devices": 1,
  "max_concurrent_sessions": 1,
  "offline_grace_seconds": 86400,
  "allow_self_unbind": false,
  "unbind_cooldown_seconds": 604800,
  "rules": {},
  "status": "ACTIVE"
}
```

固定到期授权示例：

```json
{
  "product_id": "产品 UUID",
  "code": "year-2027",
  "name": "2027 年度授权",
  "license_type": "FIXED_EXPIRY",
  "duration_seconds": null,
  "max_devices": 2,
  "max_concurrent_sessions": 1,
  "offline_grace_seconds": 86400,
  "allow_self_unbind": false,
  "unbind_cooldown_seconds": 604800,
  "rules": {
    "fixed_expires_at": "2027-12-31T23:59:59.000Z"
  },
  "status": "ACTIVE"
}
```

校验规则：

- `TRIAL`、`DURATION` 必须提供大于 0 的 `duration_seconds`。
- `FIXED_EXPIRY` 必须在 `rules.fixed_expires_at` 提供未来 UTC 时间。
- `PERPETUAL` 不允许提供时长和固定到期时间。
- 设备数和并发数最小为 1。

---

## 10. Key 生成 API

### 10.1 生成一个 Key

```http
POST /admin/v1/license-keys
```

```json
{
  "product_id": "产品 UUID",
  "policy_id": "策略 UUID",
  "max_devices": 1,
  "max_concurrent_sessions": 1,
  "metadata": {
    "customer_no": "C10001"
  },
  "features": [
    {
      "code": "export.pdf",
      "allowed": true,
      "limits": {},
      "expires_at": null
    }
  ]
}
```

返回中包含一次性明文：

```json
{
  "plain_key": "ULK1-XXXX-XXXX-XXXX-XXXX-XXXX",
  "license": {
    "id": "Key UUID",
    "display_key": "ULK1-XXXX-...-XXXX"
  }
}
```

### 10.2 批量生成 Key

```http
POST /admin/v1/license-keys/batch
```

```json
{
  "product_id": "产品 UUID",
  "policy_id": "策略 UUID",
  "count": 100,
  "metadata": {
    "order_no": "ORDER-2026-001"
  },
  "features": []
}
```

规则：

- 每批最少 1 个，最多 500 个。
- 批量接口额外要求 `licenses.export` 权限。
- 明文 Key 只在本次响应返回一次。
- 服务端日志、审计日志和数据库都不能保存明文 Key。
- 如果明文丢失，不能恢复，只能吊销旧 Key 后重新生成。

Key 格式：

```text
ULK1-XXXX-XXXX-XXXX-XXXX-XXXX
```

随机部分约 100 位熵。数据库保存 HMAC-SHA-256 摘要，摘要密钥由 `LICENSE_KEY_PEPPER` 环境变量提供。

---

## 11. Key 查询和状态管理

### 11.1 查询

```http
GET /admin/v1/license-keys?product_id={productId}&status=ACTIVE&limit=50&offset=0
GET /admin/v1/license-keys/{licenseId}
```

查询只返回：

```text
ULK1-ABCD-...-WXYZ
```

不会返回完整 Key，也不会返回 Key 摘要。

### 11.2 冻结

```http
POST /admin/v1/license-keys/{licenseId}/suspend
```

只允许 `ACTIVE -> SUSPENDED`。

### 11.3 解冻

```http
POST /admin/v1/license-keys/{licenseId}/resume
```

只允许 `SUSPENDED -> ACTIVE`。如果已经到期，则转为 `EXPIRED`，不能恢复成有效授权。

### 11.4 续期

```http
POST /admin/v1/license-keys/{licenseId}/renew
```

时长授权：

```json
{
  "extend_seconds": 2592000
}
```

固定到期授权：

```json
{
  "expires_at": "2027-12-31T23:59:59.000Z"
}
```

规则：

- `ACTIVE` 和 `EXPIRED` 可以续期。
- `CREATED`、`SUSPENDED`、`DISABLED`、`REVOKED` 不能续期。
- `PERPETUAL` 不需要续期。
- `EXPIRED` 续期成功后恢复为 `ACTIVE`。

### 11.5 永久吊销

```http
POST /admin/v1/license-keys/{licenseId}/revoke
```

```json
{
  "reason": "Key 泄露"
}
```

吊销不可恢复。任何“恢复已吊销 Key”的接口都不会提供。

---

## 12. 审计记录

以下操作必须写入 `audit_logs`：

- 创建或修改产品。
- 创建或修改版本。
- 创建或修改功能定义。
- 创建或修改授权策略。
- 单个或批量生成 Key。
- 冻结、解冻、续期和吊销 Key。

审计记录包含管理员、租户、请求 ID、IP、User-Agent、资源、操作结果和修改前后摘要。

特别说明：Key 生成审计只记录批次号、数量和掩码，不记录完整明文。

---

## 13. 环境变量

在 `.env` 中增加：

```text
# 至少 32 个字符，仅可信管理网关知道
MANAGEMENT_GATEWAY_TOKEN=replace-with-a-long-random-secret

# 至少 32 个字符，生成后必须安全备份，不能随意更换
LICENSE_KEY_PEPPER=replace-with-another-long-random-secret
```

`LICENSE_KEY_PEPPER` 如果被更换，旧 Key 在后续激活阶段将无法得到相同摘要，因此正式环境必须由秘密管理系统保存。

---

## 14. 启动方法

```powershell
Copy-Item .env.example .env
# 修改 .env 中的密码、MANAGEMENT_GATEWAY_TOKEN 和 LICENSE_KEY_PEPPER
pnpm infra:up
pnpm db:migrate
pnpm dev
```

检查：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

---

## 15. 第三步验收清单

- [x] 产品创建、查询和修改。
- [x] 产品版本创建、查询和修改。
- [x] 功能定义创建、查询和修改。
- [x] 授权策略创建、查询和修改。
- [x] 单个 Key 生成。
- [x] 最多 500 个 Key 批量生成。
- [x] Key 使用 HMAC-SHA-256 保存摘要。
- [x] 明文 Key 只在生成响应中返回一次。
- [x] Key 列表和详情不返回摘要与明文。
- [x] Key 冻结、解冻、续期和永久吊销。
- [x] 设备数、并发数和离线规则快照。
- [x] 功能模块授权。
- [x] RBAC 权限和租户边界检查。
- [x] PostgreSQL Repository。
- [x] 敏感写操作审计落库。
- [x] 自动化测试。

---

## 16. 第三步绝对不进入的范围

当前代码仍然不会：

- 使用 Key 激活设备。
- 保存设备绑定。
- 验证设备签名。
- 签发授权令牌。
- 刷新令牌。
- 接收心跳。
- 控制在线并发集合。
- 开发网页管理后台。
- 接入支付或代理系统。

必须收到第四步命令后，才能开发客户端激活和授权验证。

