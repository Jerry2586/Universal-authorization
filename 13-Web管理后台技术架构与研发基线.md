# Web 管理后台技术架构与研发基线

文档编号：ARCH-WEB-001
文档版本：V1.0
编制日期：2026-08-24
当前人格：1号人格（产品经理 / 系统架构师 / 项目总控）
对应项目版本：0.8.0
UI基线：`12-Web管理后台UI设计基线.md`（已确认并冻结）
当前门禁：G4～G6设计草案已建立，G7尚未获得专用研发授权

> 本文是 Web 管理后台的技术施工图，不是正式代码。本文不会修改现有 36 个接口的业务语义，也不会让浏览器接触 `MANAGEMENT_GATEWAY_TOKEN`。

---

## 1. 一句话说明

在现有 Fastify 授权服务器中增加一个同域 Web 管理后台：管理员用账号密码登录，浏览器只保存安全 Cookie；服务端从 Redis 会话恢复管理员身份，再复用现有 PostgreSQL 角色和权限，对产品、策略、Key、设备、审计日志与授权事件进行管理。

---

# 第一部分：G4 技术架构和目录

## 2. 推荐技术栈

| 项目 | 推荐方案 | 用途 |
|---|---|---|
| 前端 | React + TypeScript | 编写登录页、后台壳、业务页面和可复用组件 |
| 前端构建 | Vite | 开发时热更新，生产时生成静态文件 |
| 页面路由 | React Router | 登录页、产品页、Key页等页面切换 |
| 服务端数据状态 | TanStack Query | 请求、缓存、刷新、错误和加载状态 |
| 本地UI状态 | React Context + 组件本地状态 | 登录用户、导航折叠、弹窗和筛选条件 |
| 表单 | React Hook Form + Zod | 表单输入、中文错误提示和前后端规则统一 |
| UI方案 | 自建轻量组件层 + CSS变量 | 精确实现 UI-01 外壳和 UI-03 Key 工作台，不绑定重量级主题 |
| 图标 | Lucide React | 保持线性、统一、可访问的后台图标 |
| 后端 | 保留 Fastify 5 + TypeScript | 不换框架，不破坏现有授权服务器 |
| 数据库 | 保留 PostgreSQL 16 | 管理员、角色、权限和业务数据继续使用现有表 |
| 会话与限流 | 保留 Redis 7 | 存储不透明会话、CSRF状态、登录失败计数和用户会话索引 |
| Cookie | `@fastify/cookie` | 解析和设置 HttpOnly 会话 Cookie |
| 静态托管 | `@fastify/static` | 由现有服务在 `/admin/` 提供前端文件 |
| 接口方式 | 同域 JSON REST API | 浏览器不跨域，不保存管理网关密钥 |
| 密码哈希 | Argon2id | 首管理员密码及后续管理员密码的安全哈希 |
| 后端验证 | 保留并扩展 Zod | 登录参数、Cookie、CSRF头和环境变量校验 |
| 前端测试 | Vitest + Testing Library | 组件、表单和页面状态测试 |
| 后端测试 | 保留 Vitest + Fastify inject | 登录、会话、权限、CSRF和兼容性测试 |
| 端到端测试 | Playwright | 模拟浏览器登录并管理 Key |
| 日志 | 保留 Fastify结构化日志 + `audit_logs` | 技术错误进日志，管理行为进审计表 |
| 部署 | Docker 多阶段构建 + 现有 Compose | 一次构建前端和后端，仍暴露同一个 3000 端口 |

## 3. 为什么推荐这套方案

### 3.1 为什么适合当前项目

1. 现有后端已经是 TypeScript，前端继续用 TypeScript，字段和错误码更容易保持一致。
2. React适合表格、抽屉、弹窗、筛选栏等后台交互。
3. TanStack Query专门处理接口数据，能统一加载、失败、重试和缓存，避免每页重复写请求逻辑。
4. 前后端同域部署，Linux服务器只需开放一个端口，Cookie和接口安全策略更简单。
5. PostgreSQL和Redis已经存在，无需增加新的基础设施。
6. 浏览器通过服务端会话访问管理员接口，绝不下发 `MANAGEMENT_GATEWAY_TOKEN`。

### 3.2 学习和维护难度

- 前端目录按“页面、组件、接口、状态、样式”分开，普通维护者可以按名称找到文件。
- 后端认证模块单独放置，不把登录代码散落到产品、Key和设备模块。
- 业务页面仍直接使用现有 `/admin/v1/*` 契约，不建立第二套重复业务接口。
- 所有新增环境变量都进入 `.env.example` 和傻瓜部署文档。

### 3.3 部署难度

生产环境仍执行一套 Docker Compose。Docker 构建阶段先编译 Web，再编译 Fastify；运行容器只保留生产依赖、后端产物和前端静态文件。用户访问：

```text
http://服务器IP:3000/admin/
```

健康检查继续使用：

```text
http://服务器IP:3000/health
http://服务器IP:3000/ready
```

### 3.4 未来扩展能力

- 可以继续增加管理员、角色、租户、在线会话和统计接口。
- 组件层可增加深色模式，但第一版不做。
- 认证模块可在后续增加 MFA、密码重置和外部身份服务。
- 前端与现有 API 契约分离，未来可独立部署到反向代理之后。

### 3.5 主要风险

| 风险 | 影响 | 处理方式 |
|---|---|---|
| Cookie认证与现有网关Token并存 | 可能破坏脚本调用 | 使用组合身份解析，保留原Token路径并增加会话路径 |
| 平台管理员没有固定租户 | 无法直接调用租户业务接口 | 第一版优先使用绑定租户的管理员；平台租户切换另立模块 |
| 邮箱可在不同租户重复 | 登录可能不明确 | 登录契约支持可选租户代码；单租户部署可由服务端固定默认租户 |
| CSRF遗漏 | 攻击者可能诱导管理员执行修改 | 所有Cookie认证的非只读请求验证CSRF Token和Origin |
| 前端表格误造总页数 | 数据显示不真实 | 没有`total`时只允许上一页/下一页 |
| Key明文泄漏 | 授权Key被复制 | 只在生成响应展示一次，不写日志和本地存储 |
| Docker镜像膨胀 | 更新和启动变慢 | 使用多阶段构建，运行镜像不保留前端开发依赖 |

## 4. 备选方案

### 4.1 备选A：服务端模板页面

- 优点：依赖少、首屏简单。
- 缺点：高密度表格、抽屉、批量交付和复杂筛选维护困难。
- 维护难度：中高，页面与后端模板耦合。
- 部署难度：低。
- 适用场景：只有少量表单和只读页面的小后台。

### 4.2 备选B：独立前端服务 + Nginx

- 优点：前端与后端可独立发布、可单独扩容。
- 缺点：增加域名、反向代理、CORS、Cookie域和部署配置。
- 维护难度：中高。
- 部署难度：中高。
- 适用场景：多团队、大流量、前后端分开发布。

### 4.3 最终推荐

采用“React静态后台 + Fastify同域托管”。它最符合当前单仓库、单服务、Linux一键安装和低维护要求。

## 5. 系统分层

```text
管理员浏览器
  ↓
页面层（登录、仪表盘、产品、策略、Key、设备、审计、事件）
  ↓
UI组件层（表格、筛选、表单、抽屉、弹窗、状态标签）
  ↓
前端状态与服务层（会话、权限菜单、Query缓存、错误映射）
  ↓
前端接口层（auth-api、products-api、keys-api 等）
  ↓ 同域 Cookie + CSRF
Fastify路由层（/admin/auth/*、/admin/v1/*、/health、/ready）
  ↓
Zod参数验证 / Cookie与CSRF验证
  ↓
身份解析与权限控制
  ↓
现有业务服务层（产品、策略、Key、设备、审计）
  ↓
Repository数据访问层
  ↓
PostgreSQL + Redis
```

## 6. 认证兼容架构

```text
A. Web后台请求
浏览器 Cookie
  → Redis读取会话
  → 获得 admin_user_id
  → PostgreSQL重新加载账号状态、租户、角色、权限
  → 生成现有 AdminPrincipal
  → 执行现有 requireManagementContext

B. 原有脚本/网关请求
Authorization: Bearer MANAGEMENT_GATEWAY_TOKEN
+ X-Admin-User-Id
  → 原有Token校验
  → PostgreSQL加载账号、角色、权限
  → 生成同样的 AdminPrincipal
  → 执行现有 requireManagementContext
```

两条入口最后得到同一种 `AdminPrincipal`，所以产品、Key、设备和审计服务无需改写权限规则。

## 7. 推荐项目目录

```text
授权服务器源码/
├─ src/                              # 现有Fastify后端
│  ├─ modules/
│  │  ├─ admin-auth/                 # 新增：登录、退出、me、会话
│  │  ├─ identity/                   # 扩展：组合身份解析
│  │  └─ ...                         # 保留现有授权业务模块
│  ├─ shared/
│  │  ├─ http/                       # 错误、Cookie、CSRF公共逻辑
│  │  └─ management/                 # 现有管理员上下文
│  ├─ app.ts
│  └─ server.ts
├─ web/                              # 新增：React管理后台源代码
│  ├─ src/
│  │  ├─ app/                        # 路由、Provider、后台壳
│  │  ├─ pages/                      # 页面
│  │  ├─ components/                 # 业务公共组件
│  │  ├─ ui/                         # 按钮、输入框、表格、弹窗等基础组件
│  │  ├─ api/                        # 接口客户端和契约类型
│  │  ├─ auth/                       # 登录状态、路由守卫、权限判断
│  │  ├─ styles/                     # UI-01与UI-03设计变量
│  │  ├─ utils/                      # 时间、错误、字段格式化
│  │  └─ main.tsx
│  ├─ public/
│  ├─ index.html
│  ├─ package.json
│  ├─ tsconfig.json
│  └─ vite.config.ts
├─ public/admin/                     # 构建产物；不手工编辑
├─ database/migrations/              # 现有表和必要新增迁移
├─ scripts/                          # 首管理员初始化和部署脚本
├─ tests/                            # 后端与集成测试
├─ web/tests/                        # 前端测试
├─ docs/或根目录编号文档             # 设计、白皮书、部署说明
├─ Dockerfile
├─ compose.yaml
├─ package.json
└─ pnpm-workspace.yaml
```

## 8. 文件职责表

| 目录或文件 | 主要职责 | 不应该放什么 | 被谁使用 |
|---|---|---|---|
| `web/src/pages` | 组合页面和触发业务操作 | 数据库SQL、网关Token | React路由 |
| `web/src/ui` | 无业务含义的基础UI组件 | 产品或Key专属规则 | 所有页面 |
| `web/src/api` | HTTP请求、类型、错误映射 | 页面排版 | 页面和Query Hooks |
| `web/src/auth` | 当前管理员、权限、登录守卫 | 产品管理逻辑 | 路由和导航 |
| `src/modules/admin-auth` | 登录、会话、退出、me | 产品/Key业务代码 | Fastify路由 |
| `src/modules/identity` | 把网关或Cookie转换为统一主体 | 页面逻辑 | 管理员接口 |
| `src/shared/http` | Cookie、CSRF、统一HTTP工具 | 独立业务规则 | 认证与路由 |
| `database/migrations` | 可追踪的数据库变化 | 临时SQL和明文密码 | 迁移程序 |
| `scripts` | 初始化、构建、部署和维护 | 长期运行的Web业务 | 管理员/运维 |
| `public/admin` | 自动生成的前端静态文件 | 手工源码 | Fastify静态托管 |
| `tests` | 后端和接口测试 | 生产密钥 | Vitest |
| `web/tests` | 组件与页面测试 | 后端数据库实现 | Vitest/Testing Library |

## 9. 运行关系

- 后端开发入口：`src/server.ts`。
- 后端组装入口：`src/app.ts`。
- 前端开发入口：`web/src/main.tsx`。
- 前端页面：`web/src/pages/`。
- 基础UI：`web/src/ui/`。
- 前端接口：`web/src/api/`。
- 后端认证接口：`src/modules/admin-auth/`。
- 现有业务接口：继续位于各个 `src/modules/*/*.routes.ts`。
- 数据库：`database/migrations/`。
- Redis：运行时会话、CSRF、限流与现有缓存。
- 配置：`.env`、`.env.example`、`src/config/env.ts`。
- 测试：`tests/`、`web/tests/`。
- 文档：根目录编号Markdown文档；后续可统一搬入`docs/`，本轮不做移动以避免破坏历史路径。

---

# 第二部分：G5 接口、数据库与调用时序草案

## 10. 新增认证接口总表

| 编号 | 方法与地址 | 用途 | 登录要求 | 权限 |
|---|---|---|---|---|
| API-AUTH-001 | `POST /admin/auth/login` | 账号密码登录并建立会话 | 否 | 无 |
| API-AUTH-002 | `POST /admin/auth/logout` | 删除当前会话 | 是 | 无业务权限 |
| API-AUTH-003 | `GET /admin/auth/me` | 恢复当前管理员、租户和权限 | 是 | 无业务权限 |
| API-AUTH-004 | `GET /admin/auth/csrf` | 获取/刷新CSRF令牌 | 是 | 无业务权限 |

现有 27 个管理员业务接口地址、字段和权限保持不变；Web 后台用 Cookie 会话进入同一权限链。

## 11. API-AUTH-001 登录契约

- 接口用途：验证管理员邮箱和密码，创建服务端会话。
- 请求地址：`/admin/auth/login`
- 请求方式：POST
- 接口版本：内部Web认证V1
- 调用页面：登录页
- 调用时机：管理员点击“登录”
- 是否需要登录：否
- 请求头：`Content-Type: application/json`；同源 `Origin`
- 请求体：`email:string`、`password:string`、`tenant_code?:string`
- 必填规则：邮箱和密码必填；多租户模式下租户代码必填。
- 参数验证：邮箱标准格式；密码只验证合理长度，不回显；租户代码仅允许配置的格式。
- 成功返回：管理员基本资料、租户资料、权限列表、CSRF令牌；同时设置HttpOnly会话Cookie。
- 失败返回：统一“账号、密码或工作区不正确”，不暴露邮箱是否存在。
- 主要错误码：`ADMIN_LOGIN_FAILED`、`ADMIN_ACCOUNT_UNAVAILABLE`、`ADMIN_LOGIN_RATE_LIMITED`、`ADMIN_MFA_NOT_SUPPORTED`。
- 超时时间：前端10秒。
- 重试规则：不自动重试。
- 重复提交：提交后按钮禁用，直到响应或超时。
- 限流：账号维度和IP维度双重限流；成功后清理短期失败计数。
- 日志：不记录密码；失败日志只记录哈希化/脱敏身份、IP、请求ID和结果。
- 安全：使用Argon2id验证；使用固定耗时策略降低账号枚举；会话ID使用安全随机数。
- 前端调用文件：计划 `web/src/api/auth-api.ts`
- 后端路由文件：计划 `src/modules/admin-auth/admin-auth.routes.ts`
- 业务服务文件：计划 `src/modules/admin-auth/admin-auth.service.ts`
- 关联数据：`tenants`、`admin_users`、`admin_user_roles`、`roles`、`role_permissions`、`permissions`、Redis会话。
- 测试：正确登录、错误密码、未知账号、停用账号、MFA账号、限流、Cookie属性、日志脱敏。

## 12. API-AUTH-002 退出契约

- 请求地址：`/admin/auth/logout`
- 请求方式：POST
- 调用时机：管理员点击顶部头像菜单中的“退出登录”。
- 登录要求：是。
- 请求头：CSRF请求头必填。
- 成功处理：删除Redis会话和用户会话索引，清除浏览器Cookie，返回成功。
- 失败处理：即使会话已不存在，也清Cookie并返回幂等成功；基础设施不可用时返回统一错误。
- 超时时间：5秒。
- 重试：可由用户再次点击，不自动重复发送。
- 审计：记录退出成功；不记录Cookie。

## 13. API-AUTH-003 当前管理员契约

- 请求地址：`/admin/auth/me`
- 请求方式：GET
- 调用时机：后台应用首次加载、刷新页面、登录后确认状态。
- 登录要求：是。
- 成功返回：`id`、`email`、`display_name`、`tenant`、`permissions`、`session_expires_at`。
- 失败：会话无效或账号停用返回401；权限变化无需重新登录即可在下一次读取时生效。
- 超时时间：8秒。
- 自动重试：网络错误最多1次；401不重试并跳转登录；403不跳转死循环。
- 安全：不返回密码哈希、网关Token、Redis键或内部密钥。

## 14. API-AUTH-004 CSRF契约

- 请求地址：`/admin/auth/csrf`
- 请求方式：GET
- 用途：登录后刷新可读CSRF令牌。
- 返回：随机CSRF令牌和过期时间。
- 使用：前端仅放在内存；对POST、PATCH、PUT、DELETE请求写入指定请求头。
- 验证：服务端将请求头令牌与Redis会话内令牌做常量时间比较，并检查`Origin`。
- 自动重试：令牌过期时允许刷新一次再重放普通表单请求；永久吊销、批量生成等危险操作不得自动重放。

## 15. 统一响应约定

优先保持现有后端的统一响应格式，不为Web前端另造一套不兼容格式。前端通过公共解析器读取：

```json
{
  "success": true,
  "message": "操作成功",
  "data": {},
  "request_id": "请求追踪编号"
}
```

失败时显示可理解的中文消息，并在详情区域保留 `request_id` 供排错。正式实现前以现有 `api-response.ts` 和错误处理器的真实字段为最终依据。

## 16. 会话数据设计

### 16.1 PostgreSQL

第一版优先复用现有表，不新增长期会话表：

- `tenants`：租户状态和租户代码。
- `admin_users`：邮箱、显示名、密码哈希、账号状态、MFA要求和最后登录时间。
- `roles`、`permissions`、`admin_user_roles`、`role_permissions`：权限来源。
- `audit_logs`：登录、退出和敏感操作审计。

必要迁移只允许增加索引或认证所需的兼容字段；不得删除和改名现有字段。

### 16.2 Redis

```text
admin-session:{session_hash}
  user_id
  csrf_hash
  created_at
  last_seen_at
  expires_at
  ip_fingerprint（可选风险字段）
  user_agent_hash（可选风险字段）

admin-user-sessions:{admin_user_id}
  当前用户的会话ID哈希集合

admin-login-ip:{ip_hash}
admin-login-account:{tenant_or_default}:{email_hash}
  登录失败计数与短期锁定信息
```

Redis中只保存会话ID的哈希，不保存明文密码、网关Token或完整Key。

## 17. Cookie基线

| 属性 | 开发环境 | 生产环境 |
|---|---|---|
| 名称 | `ua_admin_session` | `ua_admin_session` |
| HttpOnly | 是 | 是 |
| Secure | 可关闭，仅限本机HTTP | 必须开启 |
| SameSite | Lax | Lax |
| Path | `/admin` | `/admin` |
| Max-Age | 配置值 | 配置值 |

后台生产环境推荐置于HTTPS反向代理后。若直接用公网HTTP访问，生产Secure Cookie无法安全工作，部署文档必须明确提示配置HTTPS。

## 18. 关键调用时序

### 18.1 登录

```text
管理员填写邮箱/密码
  → 前端本地校验
  → 禁用登录按钮并POST /admin/auth/login
  → 后端检查Origin与限流
  → PostgreSQL查管理员和租户
  → Argon2id验证密码
  → 检查ACTIVE和mfa_required
  → Redis写入会话和CSRF状态
  → 更新last_login_at并写审计
  → 设置HttpOnly Cookie
  → 返回管理员和权限
  → 前端进入/admin/首页
```

最长等待10秒。失败后保留邮箱和租户代码、清空密码、恢复按钮，不显示“该邮箱不存在”。

### 18.2 页面刷新恢复会话

```text
浏览器打开/admin/*
  → 加载静态前端
  → GET /admin/auth/me（自动带Cookie）
  → Redis校验会话
  → PostgreSQL重新加载ACTIVE账号和最新权限
  → 成功则渲染后台壳
  → 401则清理前端状态并跳转/admin/login
```

### 18.3 调用现有管理员接口

```text
用户点击“暂停Key”
  → 前端校验原因并二次确认
  → 禁用确认按钮
  → PATCH现有/admin/v1/...接口
  → Cookie会话恢复AdminPrincipal
  → CSRF与Origin校验
  → 现有权限检查
  → 现有Key业务服务执行
  → 现有审计逻辑记录
  → 前端刷新列表和详情
```

危险操作不自动重试。最长等待15秒，超时后提示用户先刷新详情确认实际状态。

---

# 第三部分：G6 开发计划、风险和验收草案

## 19. 模块分配与顺序

| 编号 | 模块 | 范围 | 不包含 | 复杂度 | 前置依赖 | 页面/接口/数据 | 预计文件 | 小节 | 当前状态 |
|---|---|---|---|---|---|---|---:|---:|---|
| MOD-UI-001 | 管理员认证与后台壳 | 登录、Cookie会话、CSRF、退出、me、导航、路由守卫、静态托管 | MFA、找回密码、管理员管理 | 高 | UI基线、认证依赖 | 2页/4新接口/5现有表+Redis | 18～26 | 6 | 等待白皮书确认 |
| MOD-UI-002 | 仪表盘与服务状态 | 服务状态、最近事件、真实可用信息 | 伪造统计 | 中 | 001 | 1页/3接口/事件表 | 8～12 | 3 | 未开始 |
| MOD-UI-003 | 产品版本功能 | 产品CRUD、版本、功能 | 文件发布 | 高 | 001 | 2页/8接口/3表 | 12～18 | 5 | 未开始 |
| MOD-UI-004 | 授权策略 | 策略列表、创建、修改 | 删除策略 | 中 | 001、003 | 1页/3接口/1表 | 8～12 | 3 | 未开始 |
| MOD-UI-005 | Key生成与列表 | 单个/批量生成、筛选、一次性交付 | 导出历史明文 | 高 | 001、003、004 | 2页/3接口/Key表 | 12～18 | 5 | 未开始 |
| MOD-UI-006 | Key详情与生命周期 | 详情、暂停、恢复、续期、吊销 | 恢复吊销Key | 高 | 005 | 1页/5接口/Key表 | 10～15 | 4 | 未开始 |
| MOD-UI-007 | 设备管理 | Key设备、解绑、封禁、解封 | 全局设备搜索 | 高 | 006 | 1区域/4接口/设备关联表 | 9～14 | 4 | 未开始 |
| MOD-UI-008 | 审计与授权事件 | 日志和事件筛选、详情 | 导出 | 中 | 001 | 2页/2接口/2表 | 10～14 | 3 | 未开始 |
| MOD-UI-009 | 接口中心 | 36接口只读说明 | 在线调试 | 低 | 001 | 1页/0新接口/0表 | 6～9 | 2 | 未开始 |
| MOD-UI-010 | Linux部署整合 | Docker、Compose、一键更新、HTTPS指引 | 云厂商自动购证书 | 高 | 001～009 | 0页/健康接口/配置 | 8～14 | 4 | 未开始 |

## 20. 推荐开发小节

```text
S1 认证数据访问、密码与Redis会话
S2 登录/退出/me/CSRF后端接口
S3 现有管理员API的Cookie兼容与CSRF保护
S4 React工程、登录页和会话恢复
S5 UI-01后台壳、权限导航与统一状态页
S6 静态托管、Docker整合、测试和傻瓜运行说明
```

每次正式开发只创建或修改1～3个紧密相关文件；每小节结束必须静态检查、整合检查并给出人工验证方式。

## 21. P0技术依赖

1. 引入Cookie、静态托管、限流和密码哈希依赖。
2. 新增认证环境变量与安全默认值。
3. 新增首管理员初始化脚本，禁止把默认密码写死在仓库。
4. 建立Redis管理员会话和登录限流命名空间。
5. 扩展身份解析，使Cookie和原网关Token都能生成统一主体。
6. 为Web修改请求增加CSRF与Origin检查。
7. 增加前端构建工作区和生产静态资源路径。
8. Dockerfile支持前后端多阶段构建。

## 22. 验收标准

### 22.1 功能

- 未登录访问后台业务页会进入登录页。
- 正确账号密码可登录；错误密码不能登录。
- 刷新页面不会丢失有效会话。
- 退出后原Cookie不能继续访问管理员接口。
- 菜单按权限显示；无权限接口仍由后端返回403。
- 浏览器网络记录和构建产物中不存在 `MANAGEMENT_GATEWAY_TOKEN`。
- 原Bearer Token管理员接口测试继续通过。
- Key明文只在生成后一次显示。

### 22.2 安全

- Cookie为HttpOnly；生产环境Secure。
- 非只读管理请求必须通过CSRF和Origin校验。
- 登录有IP和账号双限流。
- 错误提示不泄漏账号是否存在。
- 密码、会话ID、完整Key和网关Token不进入日志。
- 账号停用或权限撤销后，下一次请求立即按数据库最新状态处理。

### 22.3 UI

- 全局符合UI-01；Key工作台内容符合UI-03。
- 1280px桌面完整可用；768px可折叠；手机端无无法关闭的弹窗。
- 页面具备加载、空、错误、401、403、断网和超时状态。
- 没有`total`时不显示伪造总页数，没有统计接口时不显示伪造统计。

### 22.4 工程

- `pnpm typecheck`、`pnpm test`、前端测试和生产构建真实执行并记录结果。
- Docker镜像能构建；`/admin/`、`/health`、`/ready`实际验证。
- `.env.example`、README和Linux一键安装文档同步更新。
- 不删除、不重命名现有公共接口和数据库核心字段。

## 23. 已知风险与处理优先级

| 编号 | 风险 | 等级 | 预防和回退 |
|---|---|---|---|
| R-001 | 身份解析改动导致原API不可用 | 高 | 先写兼容测试；保留Gateway解析器；可独立关闭Web会话入口 |
| R-002 | CSRF配置错误导致表单全失败 | 高 | 先覆盖登录/GET/POST三类测试；错误返回明确request_id |
| R-003 | Cookie在公网HTTP不工作 | 高 | 生产强制HTTPS说明；开发模式单独配置 |
| R-004 | Argon2原生依赖在Alpine构建失败 | 中 | 选支持Node 22的实现并在Docker中先做骨架验证 |
| R-005 | 平台管理员租户选择不完整 | 中 | 第一版初始化租户管理员；平台切换列入后续CR |
| R-006 | SPA刷新返回404 | 中 | `/admin/*`配置index.html回退，但不拦截`/admin/auth/*`和`/admin/v1/*` |
| R-007 | 批量Key明文被缓存 | 高 | `Cache-Control: no-store`，不持久化前端状态，离开交付页即清除 |
| R-008 | 依赖升级破坏现有项目 | 中 | 锁定版本、先做项目骨架测试、保留检查点 |

---

# 第四部分：G7 需求基线与研发门禁

## 24. 需求基线 V1.0

### 24.1 已冻结内容

1. UI使用UI-01全局外壳与UI-03 Key管理内容区。
2. 第一版必须有安全账号密码登录和Web后台。
3. 第一版连接现有管理员API，不重写授权业务逻辑。
4. 第一版包含产品、版本、功能、策略、Key、设备、审计和授权事件管理。
5. 浏览器不得获得管理网关Token。
6. 使用同域Cookie会话、CSRF、限流和审计。
7. Linux部署继续采用Docker Compose和一键安装。
8. 不伪造统计、总页数或后端不支持的操作。

### 24.2 第一版不包含

- MFA完整流程。
- 找回或重置密码页面。
- 管理员、角色、权限和租户管理页面。
- 平台管理员图形化租户切换。
- 深色主题。
- 全局设备和在线会话中心。
- 日志导出、Key明文历史查询和API在线调试。

### 24.3 变更规则

冻结后新增、删除或改变以上内容，必须建立 `CR-编号`，说明影响文件、接口、数据、测试、部署和回退方法。未批准的变更不得混入当前模块。

## 25. 当前门禁状态

| 门禁 | 状态 | 说明 |
|---|---|---|
| G3 页面地图与UI方案 | 已通过 | 用户选定UI-01 + UI-03并发送“开始制作” |
| G4 技术架构与目录 | 草案已输出，待人工确认 | 本文第2～9章 |
| G5 接口、数据库与时序 | 草案已输出，待人工确认 | 本文第10～18章 |
| G6 计划、风险、验收 | 草案已输出，待人工确认 | 本文第19～23章 |
| G7 需求冻结与研发授权 | **未通过** | 尚未收到专用口令 |
| 正式代码开发 | **禁止** | G7和模块批准均未满足 |

## 26. 正式研发的双重授权

第一道总项目研发授权必须准确发送：

```text
冻结需求，开始研发
```

第二道模块代码授权必须在阅读模块白皮书后准确发送：

```text
批准开发 MOD-UI-001
```

两道授权都满足后，才允许创建正式前端和认证代码。仅发送“开始制作”“继续”或“直接写代码”不能代替G7专用口令。

---

## 27. 当前结论

- UI基线已经冻结。
- 技术架构、认证接口、会话设计、开发计划、风险和验收标准已经形成可审查草案。
- 现有后端业务代码尚未修改。
- 当前只完成设计文档，尚未运行任何新增Web功能，也不能宣称Web后台已开发成功。
