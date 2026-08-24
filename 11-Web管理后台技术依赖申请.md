# Web 管理后台《技术依赖申请》

> 申请编号：TDA-001
> 来源：2号人格 UI/UX 只读识别阶段
> 项目版本：0.8.0
> 日期：2026-08-24
> 申请对象：1号人格（后端/架构实现评估）
> 目标：让现有 API 型授权服务器具备安全、可部署、可正常登录的 Web 管理后台

---

## 1. 申请原因

现有管理员接口依赖全局 `MANAGEMENT_GATEWAY_TOKEN`、管理员 UUID 和租户 UUID 请求头。该方式适合受信任网关或内部服务，不适合直接暴露给浏览器。

如果把网关 Token 写入前端配置、LocalStorage 或 JavaScript 包，访问者可在浏览器开发者工具中取得它，从而绕过正常登录流程。因此，在制作可用的 Web 管理后台前，必须建立服务器端管理员登录会话。

---

## 2. 必须补充的技术能力（P0）

### DEP-001 管理员账号密码登录

建议接口：

```http
POST /admin/auth/login
Content-Type: application/json

{
  "email": "admin@example.com",
  "password": "用户输入密码"
}
```

建议行为：

- 从 `admin_users` 查询启用中的账号。
- 使用安全密码哈希验证，禁止明文密码。
- 登录成功写入 `HttpOnly + Secure + SameSite` Cookie。
- 更新 `last_login_at`。
- 写入登录成功/失败审计。
- 错误提示不泄露“邮箱存在但密码错误”等账号枚举信息。
- 增加 IP + 账号维度失败次数限制和冷却时间。

### DEP-002 管理员退出

建议接口：

```http
POST /admin/auth/logout
```

建议行为：撤销服务器端会话、清除 Cookie、写入审计。

### DEP-003 当前管理员资料与权限

建议接口：

```http
GET /admin/auth/me
```

建议返回：

```json
{
  "id": "管理员 UUID",
  "email": "admin@example.com",
  "display_name": "管理员",
  "tenant_id": "租户 UUID 或 null",
  "permissions": ["products.read", "licenses.write"],
  "mfa_required": false,
  "session_expires_at": "ISO-8601 时间"
}
```

用途：页面显示用户信息、控制菜单、隐藏无权按钮、处理平台管理员租户上下文。

### DEP-004 安全会话中间件

要求：

- 管理后台使用短期、可撤销的服务端会话。
- Cookie 必须 `HttpOnly`，生产环境必须 `Secure`。
- 处理会话过期、主动退出、账号停用和角色变更。
- 对修改类请求提供 CSRF 防护。
- 浏览器不得接触 `MANAGEMENT_GATEWAY_TOKEN`。
- 后端内部可将会话解析出的管理员主体继续复用现有 `requireManagementContext` 权限判断。

### DEP-005 首个租户和管理员初始化

需要提供安全的一次性初始化方式，例如部署命令：

```bash
pnpm admin:bootstrap
```

或只允许本机/一次性令牌调用的初始化流程。禁止在公开网页提供“任何人都能注册首个管理员”的入口。

至少输入：租户名称、管理员邮箱、管理员显示名和初始密码。初始化后应提示立即修改密码。

### DEP-006 Web 静态资源托管与 SPA 回退

建议方案：

- 前端构建产物输出到固定目录。
- Fastify 同域托管 `/admin/assets/*`。
- `/admin/*` 页面路由回退至 `index.html`。
- API 路由保持 `/admin/v1/*` 和 `/api/v1/*` 不变。
- `/admin/` 只提供管理后台，不改变客户端授权协议。

---

## 3. 强烈建议补充的技术能力（P1）

### DEP-007 仪表盘统计接口

建议：

```http
GET /admin/v1/dashboard/summary
```

建议返回：产品总数、各状态 Key 数、即将到期 Key 数、绑定设备数、在线会话数、24 小时激活/验证成功失败数、最近事件。

### DEP-008 列表总数

为以下列表补充 `total`：

- 产品。
- 授权策略。
- Key。
- Key 绑定设备。
- 管理员审计日志。
- 授权事件。

统一返回建议：

```json
{
  "items": [],
  "limit": 50,
  "offset": 0,
  "total": 123
}
```

### DEP-009 搜索和筛选

建议增加：

- 产品：`keyword, status`。
- Key：`keyword/display_key, generation_batch_id, expires_from, expires_to`。
- 策略：`status, license_type`。

### DEP-010 全局设备列表与在线会话

建议接口：

```http
GET /admin/v1/devices
GET /admin/v1/sessions
```

否则设备只能从某个 Key 详情进入，无法建设完整“设备中心”和“在线会话中心”。

### DEP-011 租户上下文

平台管理员需要目标租户 UUID，但当前没有租户列表 API。建议至少提供：

```http
GET /admin/v1/tenants
```

否则 UI 只能要求用户手填 UUID，体验和误操作风险都较差。

---

## 4. 后续管理能力（P2）

以下权限和数据表已存在，但没有 API，可作为后续版本：

- 租户管理：`platform.tenants.manage`。
- 管理员账号管理：`admin.users.manage`。
- 角色权限管理：`admin.roles.manage`。
- 系统设置：`settings.manage`。
- 签名密钥管理：`signing-keys.manage`。
- API 客户端管理。

在对应 API 完成前，UI 侧不得放置可点击的创建、编辑、删除按钮。

---

## 5. 推荐认证时序

```text
管理员打开 /admin/
  → 前端 GET /admin/auth/me
    → 未登录：返回 401，跳转登录页
    → 已登录：返回用户、租户、权限

管理员提交邮箱和密码
  → POST /admin/auth/login
  → 服务端验证 password_hash、账号状态和限流
  → 创建可撤销会话
  → Set-Cookie(HttpOnly, Secure, SameSite)
  → 返回管理员基础资料
  → 前端进入后台首页

前端调用 /admin/v1/*
  → 浏览器自动携带 Cookie
  → 服务端解析会话为 AdminPrincipal
  → 复用现有租户和权限判断
  → 返回业务结果

管理员退出
  → POST /admin/auth/logout
  → 服务端撤销会话并清 Cookie
  → 前端返回登录页
```

---

## 6. 安全硬性要求

1. 禁止在浏览器中保存或展示 `MANAGEMENT_GATEWAY_TOKEN`。
2. 禁止把管理员密码、Cookie、Key 明文写入日志。
3. 登录接口必须限流并防账号枚举。
4. Cookie 必须 HttpOnly；生产环境必须 Secure。
5. 修改类请求必须考虑 CSRF。
6. Key 明文只做一次性交付，不写入前端持久存储。
7. 吊销、强制解绑和封禁必须显示影响并二次确认。
8. 前端隐藏按钮不是权限控制，最终权限仍由服务端判断。
9. 平台管理员切换租户后，每个请求必须绑定明确租户上下文。
10. 登录和敏感操作必须进入审计日志。

---

## 7. 对 1 号人格的评估请求

请 1 号人格确认并形成后端模块白皮书：

- 是否采用服务端会话 + HttpOnly Cookie。
- 会话存储使用 PostgreSQL、Redis 或二者组合。
- 密码哈希算法与参数。
- 登录限流和锁定规则。
- CSRF 方案。
- 首管理员初始化方式。
- 同域静态资源托管方式。
- 是否在第一期同时实现 `dashboard/summary`、`total` 和租户列表。

在 DEP-001～DEP-006 完成前，可以进行 UI 视觉设计和静态原型，但不能宣称管理后台已经具备安全、完整的登录闭环。
