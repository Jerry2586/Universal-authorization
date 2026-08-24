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

## 真正一键搭建（推荐）

Windows 只需安装并启动 Docker Desktop；Linux 测试服务器可以用远程安装器自动安装 Docker。脚本会自动完成：

1. 生成安全的 `.env` 配置
2. 生成管理令牌、Key Pepper 和数据库密码
3. 生成 Ed25519 服务端签名私钥
4. 构建授权服务器 Docker 镜像
5. 启动 PostgreSQL、Redis 和授权服务器
6. 自动执行全部数据库迁移
7. 等待健康检查通过并显示访问地址

### Windows 一键搭建

最简单的方法：直接双击源码目录里的 `一键搭建.bat`。

也可以在源码目录打开 PowerShell，执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

### Linux 服务器一键拉取并安装（主要方式）

SSH 登录 Linux 服务器后，只运行这一行：

```bash
curl -fsSL https://raw.githubusercontent.com/Jerry2586/Universal-authorization/main/install.sh | sudo bash
```

如果服务器没有 `curl`，可以使用：

```bash
wget -qO- https://raw.githubusercontent.com/Jerry2586/Universal-authorization/main/install.sh | sudo bash
```

这条命令会自动安装或检查 Git、Docker Engine 和 Docker Compose，拉取最新源码到 `/opt/universal-authorization`，生成安全配置，构建镜像、迁移数据库并启动服务。

自定义安装目录：

```bash
curl -fsSL https://raw.githubusercontent.com/Jerry2586/Universal-authorization/main/install.sh \
  | sudo bash -s -- --dir /data/universal-authorization
```

已经下载源码时，也可以在项目目录内执行：

```bash
chmod +x deploy.sh
./deploy.sh
```

搭建完成后的常用命令：

```bash
# 查看运行状态
docker compose ps

# 查看服务端实时日志
docker compose logs -f app

# 停止服务（保留数据库数据）
docker compose down

# 再次启动或升级源码后重新构建
docker compose up -d --build
```

默认访问地址：

```text
健康检查：http://127.0.0.1:3000/health
就绪检查：http://127.0.0.1:3000/ready
```

> `.env` 包含私钥和管理令牌，已被 `.gitignore` 排除。不要上传、转发或提交该文件。

完整说明请看：`09-一键部署设计与使用.md`。

> 云服务器还需要在安全组或防火墙中放行授权服务端口，默认是 TCP `3000`。不要把 PostgreSQL `5432` 和 Redis `6379` 开放到公网。

## 手动启动

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
