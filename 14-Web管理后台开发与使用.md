# Web 管理后台开发与使用说明（傻瓜版）

## 1. 这次新增了什么

现在授权服务器不再只有接口，已经加入可直接用浏览器访问的 Web 管理后台：

```text
http://服务器IP:3000/admin/
```

后台包含：

- 管理员邮箱、密码、工作区登录。
- 控制台真实数据概览。
- 产品、版本、功能管理。
- 授权策略管理。
- Key 单枚生成、批量生成、筛选、查看、暂停、恢复、续期、吊销。
- 吊销、设备解绑、封禁、解封均使用带原因输入和防误触校验的可视化确认弹窗，不再使用浏览器原生提示框。
- Key 绑定设备查看、强制解绑、封禁、解封。
- 管理员审计日志和授权事件。
- 客户端 API 目录与服务健康状态。

## 2. 安全结构

浏览器不会得到 `MANAGEMENT_GATEWAY_TOKEN`。登录成功后，服务器使用：

1. HttpOnly Cookie 保存随机会话标识。
2. Redis 保存实际管理员会话。
3. 修改操作额外验证 `X-CSRF-Token`。
4. 每次管理员 API 调用都重新检查账号、租户和权限。
5. 密码使用 Node.js 内置 `scrypt` 安全哈希。
6. 登录失败按 IP 和账号双维度限流。

原有 Bearer 管理网关认证继续保留，不影响旧的自动化调用。

## 3. Linux 一键安装

仍然执行原来的一键安装命令。安装器会自动：

1. 拉取源码。
2. 生成数据库密码和安全密钥。
3. 生成初始管理员密码。
4. 构建后端和 Web 前端。
5. 启动 PostgreSQL、Redis、授权服务器。
6. 执行数据库迁移。
7. 创建默认工作区和首个管理员。

安装完成后，终端会显示：

```text
Web 管理后台：http://服务器IP:3000/admin/
管理员邮箱：admin@example.com
工作区代码：default
初始管理员密码：自动生成的随机密码
```

## 4. 手工初始化管理员

在 `.env` 中配置：

```dotenv
ADMIN_BOOTSTRAP_TENANT_CODE=default
ADMIN_BOOTSTRAP_TENANT_NAME=默认工作区
ADMIN_BOOTSTRAP_EMAIL=admin@example.com
ADMIN_BOOTSTRAP_PASSWORD=请使用至少12位强密码
ADMIN_BOOTSTRAP_DISPLAY_NAME=系统管理员
ADMIN_BOOTSTRAP_RESET_PASSWORD=false
```

然后执行：

```bash
pnpm db:migrate
pnpm admin:bootstrap
```

管理员已存在时默认不会覆盖密码。如果确实需要重置，将下面配置临时改成：

```dotenv
ADMIN_BOOTSTRAP_RESET_PASSWORD=true
```

执行一次 `pnpm admin:bootstrap` 后，立即改回 `false`。

## 5. HTTPS 配置

直接通过 HTTP 测试时：

```dotenv
ADMIN_COOKIE_SECURE=false
```

正式部署到 HTTPS 域名后必须改为：

```dotenv
ADMIN_COOKIE_SECURE=true
```

然后重启：

```bash
docker compose up -d --build
```

## 6. 本地开发

终端一，启动后端：

```bash
pnpm dev
```

终端二，启动前端：

```bash
pnpm web:dev
```

开发页面：

```text
http://127.0.0.1:5173/admin/
```

前端生产构建：

```bash
pnpm web:build
```

构建产物位于：

```text
public/admin
```

## 7. 常用命令

```bash
# 类型检查
pnpm typecheck
pnpm --dir web typecheck

# 自动测试
pnpm test
pnpm --dir web test

# 构建全部
pnpm build:all

# 查看容器日志
cd /opt/universal-authorization
docker compose logs -f app

# 更新部署
./deploy.sh
```

## 8. 重要提醒

- Key 明文只会在生成成功时返回一次，请立即复制或下载。
- 吊销是永久操作，不能恢复。
- 不要把 `.env`、管理密码、网关 Token、Key Pepper 或签名私钥提交到 GitHub。
- 公网正式使用建议通过 Nginx/Caddy 配置 HTTPS，并只开放 80/443 端口。
