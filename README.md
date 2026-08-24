# 通用 Key 授权服务端

当前版本：`0.8.0`

## 已完成阶段

- 第一步：需求与授权协议设计
- 第二步：基础架构与数据库设计
- 第三步：产品、授权策略与 Key 管理
- 第四步：Key 激活、设备登记绑定、设备签名和短期授权令牌
- 第五步：在线授权验证、双令牌验签、防重放和幂等令牌刷新
- 第六步：会话心跳、Redis 在线状态、主动释放和受策略限制的设备自助解绑
- 第七步：管理员设备查询、强制解绑、设备封禁与解封
- 第八步：管理员审计日志与授权事件只读查询

## 技术栈

- Node.js 22+
- TypeScript
- Fastify
- PostgreSQL 16
- Redis 7
- Ed25519
- Vitest

## 第八步新增能力

- `GET /admin/v1/audit-logs` 分页查询管理员和系统敏感操作审计
- `GET /admin/v1/license-events` 分页查询 Key、设备、激活和会话授权事件
- 两个接口统一使用 `audit.read` 权限
- 支持按主体、动作、资源、结果、请求 ID、业务 UUID 和时间范围过滤
- 所有查询强制携带当前管理上下文的租户 ID
- 查询 SQL 全部参数化，按 `occurred_at DESC, id DESC` 稳定分页
- 单页最多返回 100 条，避免无上限拉取历史
- 查询审计历史本身会写入 `audit-log.read` 或 `license-event.read` 审计
- 不接受 Key 明文作为搜索条件
- 不修改、不删除任何旧审计日志或授权事件

## 傻瓜式启动

### 第 1 步：复制配置

```powershell
Copy-Item .env.example .env
```

### 第 2 步：修改安全值

打开 `.env`，修改：

```text
MANAGEMENT_GATEWAY_TOKEN
LICENSE_KEY_PEPPER
```

两个值都要至少 32 个字符，而且不能相同。

### 第 3 步：生成开发签名私钥

```powershell
pnpm signing-key:generate
```

把输出的这一整行复制到 `.env`：

```text
LICENSE_SIGNING_PRIVATE_KEY_PEM_BASE64=很长的一串Base64
```

私钥不能发给客户端，也不能提交到代码仓库。

### 第 4 步：启动基础设施并迁移

```powershell
pnpm infra:up
pnpm db:migrate
pnpm db:status
```

### 第 5 步：启动服务

```powershell
pnpm dev
```

### 第 6 步：检查代码

```powershell
pnpm typecheck
pnpm test
pnpm build
```

## 当前公开接口

```text
GET  /health
GET  /ready
POST /api/v1/challenges
POST /api/v1/licenses/activate
POST /api/v1/licenses/verify
POST /api/v1/licenses/refresh
POST /api/v1/sessions/heartbeat
POST /api/v1/sessions/release
POST /api/v1/devices/unbind
```

验证、刷新、心跳、释放和解绑请求头：

```http
X-Product-Code
X-Client-Version
X-Timestamp
X-Client-Nonce
X-Device-Id
X-Key-Id
X-Signature
```

刷新、释放和自助解绑额外需要：

```http
Idempotency-Key
```

公开接口完整请求体和设备签名顺序请看：

```text
04-激活设备与授权令牌设计.md
05-在线验证与令牌刷新设计.md
06-会话心跳释放与设备自助解绑设计.md
```

## 当前管理接口

```text
POST  /admin/v1/products
GET   /admin/v1/products
GET   /admin/v1/products/{productId}
PATCH /admin/v1/products/{productId}

POST  /admin/v1/products/{productId}/versions
GET   /admin/v1/products/{productId}/versions
PATCH /admin/v1/products/{productId}/versions/{versionId}

POST  /admin/v1/products/{productId}/features
GET   /admin/v1/products/{productId}/features
PATCH /admin/v1/products/{productId}/features/{featureId}

POST  /admin/v1/license-policies
GET   /admin/v1/license-policies
PATCH /admin/v1/license-policies/{policyId}

POST /admin/v1/license-keys
POST /admin/v1/license-keys/batch
GET  /admin/v1/license-keys
GET  /admin/v1/license-keys/{licenseId}
POST /admin/v1/license-keys/{licenseId}/suspend
POST /admin/v1/license-keys/{licenseId}/resume
POST /admin/v1/license-keys/{licenseId}/renew
POST /admin/v1/license-keys/{licenseId}/revoke

GET  /admin/v1/license-keys/{licenseId}/devices
POST /admin/v1/devices/{deviceId}/unbind
POST /admin/v1/devices/{deviceId}/block
POST /admin/v1/devices/{deviceId}/unblock

GET  /admin/v1/audit-logs
GET  /admin/v1/license-events
```

管理请求头：

```http
Authorization: Bearer <MANAGEMENT_GATEWAY_TOKEN>
X-Admin-User-Id: <管理员 UUID>
X-Tenant-Id: <平台管理员操作目标租户时提供>
```

第七步设备接口请看：

```text
07-管理员设备查询解绑封禁与解封设计.md
```

第八步审计与授权事件查询、过滤参数、响应和架构图请看：

```text
08-管理员审计日志与授权事件查询设计.md
```

## 安全约束

- 数据库不保存完整明文 Key。
- Key 使用带服务端 Pepper 的 HMAC-SHA-256 摘要。
- Key 明文只在生成响应中返回一次。
- 设备私钥永远不上传。
- PostgreSQL 不保存服务端签名私钥。
- 服务端没有签名私钥时安全拒绝签发，不使用默认私钥。
- 客户端授权请求使用设备 Ed25519 签名；管理员设备接口使用独立的管理认证和 RBAC，二者不混用。
- 激活挑战使用 Redis 原子 `GETDEL`。
- 在线请求随机数使用 Redis 原子 `SET NX EX`。
- 激活、刷新、会话释放和设备自助解绑使用 PostgreSQL 幂等记录。
- 管理员设备状态修改通过 PostgreSQL 事务和行锁执行。
- 强制解绑和封禁会撤销有效会话并清理 Redis 在线键。
- 解封不会恢复旧绑定和旧会话。
- 授权状态以 PostgreSQL 实时结果为准，不能只信任令牌快照或 Redis 在线标记。
- 不删除设备、绑定、封禁和会话历史。
- 管理员设备操作不修改 Key 到期时间。
- 审计与授权事件接口只读历史，所有 SQL 强制租户条件并参数化。
- 读取敏感历史本身会追加读取审计，不修改或删除旧记录。
- 吊销不可恢复。
- 已应用的旧迁移文件不得修改。

## 第八步边界

当前仍然没有实现：

- 删除、修改或文件导出审计记录
- 支付和订单接口
- 代理商接口
- 管理后台页面
- 签名密钥管理接口
- 系统设置管理接口
- 第九步及以后功能

## 设计文档

- `01-需求与授权协议设计.md`
- `02-基础架构与数据库设计.md`
- `03-产品与Key管理设计.md`
- `04-激活设备与授权令牌设计.md`
- `05-在线验证与令牌刷新设计.md`
- `06-会话心跳释放与设备自助解绑设计.md`
- `07-管理员设备查询解绑封禁与解封设计.md`
- `08-管理员审计日志与授权事件查询设计.md`
