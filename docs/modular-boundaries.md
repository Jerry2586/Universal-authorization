# 分层部署与未来基础设施边界

日期：2026-09-22。当前第一版已经拆为授权中心、客户打包中心和构建 Worker 三个进程，共用一个 SQLite 数据库和本地成品目录。访问边界已经固定，后续可以逐项替换基础设施。

## 当前部署

```text
admin.example.com → license-center
  /admin            授权中心 CMS
  /web/*            页面 BFF：服务端会话 + CSRF
  /api/v1/*         激活和自动化协议
  /api/v1/worker/*  Worker 内部协议：独立 Worker Token

build.example.com → build-center
  /build            客户打包中心
  /web/customer/*   受限代理，必须携带 INTERNAL_SERVICE_TOKEN

build-worker
  /api/v1/worker/*  租约、进度、完成与失败上报
```

```text
管理页面 → 授权中心 HTTP/BFF → PortalService → LicenseService → SQLite
客户页面 → 打包中心受限代理 ────────┘
                               │
                               ├─ BuildQueue → SQLiteBuildQueue
                               ├─ ArtifactStore → LocalArtifactStore
                               └─ BuildEngine → HardenedThemeBuildEngine
                                                    │
独立 Worker ← 内部 API 定时租约队列 ←───────────────┘

APPGOG 主题 → Activation API → Ed25519 凭证 → 本地验签 SDK
```

网页不直接访问数据库，客户主题不访问管理接口。Worker 不持有 Ed25519 私钥；它只领取每次构建需要的短期身份。数据库表不是跨服务契约，跨边界使用稳定 JSON 和不透明 ID。

## 已实现的替换边界

| 契约 | 当前实现 | 将来替换 |
|---|---|---|
| `BuildQueue` | SQLite 租约队列 | Redis Streams、RabbitMQ 或云队列 |
| `ArtifactStore` | 本地目录 | S3 兼容对象存储 |
| `BuildEngine` | 安全检查并重打包可安装 Xboard ZIP | 隔离容器中的 Vue 源码编译 + 重打包 |
| Worker | 独立 Node.js 进程 | 独立机器/隔离容器 Worker |
| 授权数据库 | SQLite | PostgreSQL |
| 激活签名 | 本地 Ed25519 PEM | KMS/HSM 或独立签名服务 |
| 页面会话 | SQLite + HttpOnly Cookie | Redis/独立会话服务 |

`packages/contracts` 保存跨模块返回模型，`packages/ports` 定义适配器能力，`packages/adapters` 保存本地实现。以后拆成 `build.example.com`、`admin.example.com` 和 `api.example.com` 时，不修改 License、Build、Package、Activation 的身份和状态语义。

## 当前构建边界

`HardenedThemeBuildEngine` 接收一个已经可安装的 Xboard 主题 ZIP，并完成：

1. 安全解析和结构验证。
2. 注入每包独立的激活运行时、Package Secret、Build/Package 身份和公钥。
3. 写入 `appgog-license/build.json` 与 `APPGOG-ACTIVATION.txt`。
4. 生成普通可安装 ZIP 和 SHA-256。
5. Portal 再读取真实成品，校验哈希和结构后才标记成功。

它不会执行 ZIP 中的脚本、PHP、npm 生命周期或任意源码构建命令。真实 Vue 源码编译将作为新的 `BuildEngine` 适配器运行在隔离容器中。

## 演进规则

1. `/api/v1` 已有字段不能原地改变语义；兼容新增字段可以进入 v1，破坏性变更使用 `/api/v2`。
2. `/web/*` 是网页内部协议，可随页面迭代，不提供给客户主题调用。
3. 队列消息只传任务身份和版本，不传长期 License Key 或签名私钥。
4. Worker 只通过内部协议租约任务、上报进度、完成或失败。
5. 上线前建立显式数据库 migration；当前自动建表只适合第一版和全新环境。
6. 任何 Worker 的完成结果都必须验证租约、Build 归属、版本、域名、文件哈希和 ZIP 结构。
7. Artifact Ref 保持不透明，使本地文件存储迁移到对象存储时不改变业务层。

## 推荐拆分顺序

1. 拿到真实 APPGOG 源码后，把源码编译步骤放进隔离构建容器。
2. 将 ArtifactStore 换成对象存储，并使用短时签名下载地址。
3. 将 BuildQueue 换成专业队列，同时保留数据库任务状态用于审计。
4. 将授权数据库迁移 PostgreSQL，建立备份和 migration。
5. 将激活 API 从授权中心进程进一步拆出，不改变客户已有 Key 与激活协议。

## 仍需注意

- 当前的浏览器激活门适合第一版防复制，但真实 APPGOG 的关键设置 API 仍应增加服务端授权守卫。
- `dashboard.blade.php` 的相对静态资源 URL 需要在真实 Xboard 路由上验收；如果路由解析不同，应改为内联运行时或主题的固定资源前缀。
- SQLite、共享本机成品卷和独立 Worker 适合单机、小规模部署；正式多机商用需完成上面的基础设施迁移。
- 混淆和随机布局不能代替 Ed25519 签名、服务端状态、域名绑定和审计。
