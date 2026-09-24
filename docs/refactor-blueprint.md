# APPGOG 公司级重构蓝图

日期：2026-09-24  
状态：强制执行；v1.2.10 已完成首轮边界落地  
适用范围：授权中心、客户打包中心、构建 Worker、产品 SDK、Docker 安装器、在线更新助手和服务器迁移能力。

## 1. 目标与非目标

本重构用于解决巨型前端脚本、巨型 HTTP Handler、多领域 Service、全库 Repository、跨层依赖和运维脚本职责过载。重构必须保持现有对外行为、数据库和升级语义，不以重写全部代码为目标。

必须保持：

- 长期 License Key、安装 Key、Install Receipt、Activation Token 的现有身份语义；
- Ed25519、AES-256-GCM、HMAC-SHA-256 和定时安全比较；
- 构建成品的服务端二次验证；
- SQLite 事务迁移、升级备份、健康检查和失败恢复；
- `/api/v1` 现有兼容字段、安装命令和 Docker 数据卷；
- 管理员、客户、Key、公告、工单、上传、成品、日志、备份和密钥数据。

禁止以“结构优化”为理由：

- 清空数据库或删除数据卷；
- 自动轮换现有生产密钥；
- 修改已有 Key 或要求全部客户重新激活；
- 同时替换 UI 框架、数据库和业务协议；
- 把旧功能临时删除后再补回；
- 未经真实旧版本升级测试直接发布。

## 2. 固定领域边界

| 领域 | 拥有的数据和行为 | 明确禁止 |
| --- | --- | --- |
| Identity | 管理员、客户会话、密码、角色、权限 | 直接修改授权或构建 |
| Licensing | License Key、状态、绑定域名、换绑、轮换、删除状态机 | 执行构建、管理账号密码 |
| Entitlement | 免费/付费套餐、能力和额度快照 | 生成 Key、直接改产品文件 |
| Activation | 安装解锁、Receipt、激活、刷新、撤销、Installation ID | 修改套餐和产品版本 |
| Product | 产品、版本、更新通道、发布说明和通知 | 执行 Docker 更新 |
| Packaging | 上传、构建任务、Worker 租约、成品校验和下载 | 修改管理员或工单状态 |
| Support | 工单、消息、附件、关闭/重开 | 操作授权和构建身份 |
| Operations | 公告、运营设置、备份、修复、更新编排 | 接受任意 Shell 命令 |
| Migration | 配对、快照、传输、校准、切换、回滚 | 重写授权业务内容或生成新签名身份 |
| Audit | 操作者、动作、结果、原因、请求和操作关联 ID | 修改业务状态 |

一张业务表只能由所属领域 Repository 写入。其他领域只能使用公开 Use Case、Service 或 Port。查询可以使用专门只读 Projection，但不能借只读接口执行更新。

## 3. 固定依赖方向

```text
Admin/Customer UI
  → HTTP Route / BFF
  → Application Use Case
  → Domain Service / State Machine
  → Repository or Infrastructure Port
  → SQLite / Filesystem / Docker / Network Adapter
```

禁止：

- `packages/*` 导入 `apps/*`；
- HTTP Route 直接执行 SQL；
- Domain 读取 HTTP Request、Cookie 或 DOM；
- Repository 判断用户权限；
- UI 隐藏按钮代替服务端能力校验；
- Worker 持有长期 License Key、管理员 Token 或 Ed25519 私钥；
- 运维页面传入任意命令给 root 服务执行。

第一阶段在 `apps/license-api/src/modules/*` 建立边界，稳定后才考虑迁移到顶级 `domains/*`，避免一次性改动全部 import。

## 4. 推荐目录

```text
apps/
  license-api/src/
    http/middleware/
    http/routes/admin/
    http/routes/customer/
    http/routes/worker/
    http/routes/public/
    modules/identity/
    modules/licensing/
    modules/entitlement/
    modules/activation/
    modules/product/
    modules/packaging/
    modules/support/
    modules/operations/
    modules/migration/
    modules/audit/
    bootstrap/
  build-worker/
  web/
    admin/
    customer/
    shared/
packages/
  core/
  contracts/
  ports/
  adapters/
  config/
  appgog-sdk/
scripts/
  lib/
```

## 5. API 与错误合同

- `/api/v1` 不允许原地改变已有字段语义；破坏性协议使用 `/api/v2`。
- `/web/*` 是页面 BFF，可演进但必须保持同版本前后端一致。
- 所有写操作必须支持请求关联 ID；幂等操作增加 Idempotency Key。
- 错误返回固定包含 `code`、`message`、`request_id`，不得把堆栈和内部路径返回浏览器。
- 认证、CSRF、权限和错误映射使用统一中间件，不在每条路由重复实现。
- 所有外部 URL、域名、版本、文件名和归档内容进入领域层前完成规范化与安全校验。

## 6. 数据、事务与删除

- 数据库变化只允许登记迁移；迁移必须向前兼容、可重复执行并使用真实旧数据库测试。
- 高风险业务变化和安全审计必须在同一数据库事务中提交。
- 文件、Docker 和网络调用不进入长数据库事务；使用 Outbox/补偿任务记录并重试。
- Key 永久删除必须使用 `deleting → deleted` 状态机，先冻结业务，再删除关联数据和文件。
- 文件删除失败不得恢复已经删除的业务身份，应进入可重试清理队列。
- 永久删除完成后仅保留不含 Key、域名、邮箱、IP、Installation ID 的匿名系统 Tombstone。

## 7. 密钥边界

密钥用途固定：

```text
ACTIVATION_SIGNING_KEY
PACKAGE_SIGNING_KEY
NOTIFICATION_SIGNING_KEY
LICENSE_ENCRYPTION_KEY
DELIVERY_ENCRYPTION_KEY
SESSION_SECRET
CSRF_SECRET
WORKER_AUTH_SECRET
RELEASE_PUBLIC_KEY
```

- 一把密钥只允许一个用途；缺失时拒绝生产启动，不得回退到其他密钥。
- 升级和控制中心迁移必须保留现有密钥身份。
- 私钥不得进入 Worker、客户 ZIP、浏览器、日志或诊断包。
- 产品包只携带验证所需公钥和当次构建身份。
- 完整 Key 默认不进入列表响应；单独查看必须鉴权并写审计。

## 8. 前端边界

- 管理端与客户打包端分开入口、状态和页面模块。
- API、会话、通知、弹窗、格式化和通用组件可以共享；页面不得直接操作其他页面 DOM。
- 所有请求通过统一 API Client；页面不得自行拼接认证头或解释权限。
- 保存、上传、更新和迁移操作必须有 idle/submitting/succeeded/failed 状态和可见错误。
- UI 统一使用设计 Token；业务页面不得散落新的颜色、阴影和间距体系。
- 先使用 ES Modules 渐进拆分，不在同一版本强制更换框架。

## 9. 日志与审计

运行日志、诊断日志和安全审计必须分开。统一字段：

```text
timestamp level service request_id operation_id actor_type actor_id
action result reason_code duration_ms
```

禁止记录完整 Key、密码、Cookie、Session、CSRF Token、GitHub Token、Refresh Secret、签名私钥、加密密钥和完整激活 Token。

安装、升级、迁移、恢复、构建和永久删除必须各自产生 `operation_id`，页面和命令行可以按该编号查看完整过程。

## 10. 分段研发计划

### Phase 0：基线与已知缺陷

- 固定本蓝图和服务器迁移标准；
- 修复在线更新助手状态文件为空却被 systemd 视为运行的缺陷；
- 增加版本、Shell、升级和现有行为回归测试；
- 数据库只允许向前兼容、可重复执行的新增表/列；禁止删除旧业务数据或用重建数据库解决升级问题。

### Phase 1：前端模块化

- 拆出 API Client、Session Store、Notification、Dialog；
- 按管理员和客户页面拆分 `portal.js`；
- 保持 URL、接口和视觉功能兼容；
- 增加浏览器 E2E 覆盖运营设置、工单、上传和更新。

### Phase 2：HTTP 路由与中间件

- 拆分管理员、客户、Worker、授权和公共路由；
- 统一认证、授权、CSRF、请求 ID 和错误处理；
- 路由层不再写审计或直接操作 Repository。

### Phase 3：领域 Service 与 Repository

- 按领域拆分 Portal Service 和全库 Repository；
- 修正 `packages → apps` 的反向依赖；
- 固定事务边界和数据库写所有权。

### Phase 4：授权事件、永久删除和工单状态机

- 增加统一授权事件模型；
- 实现 Key 永久删除及补偿清理；
- 完成工单双方关闭、管理员重开和附件权限。

### Phase 5：套餐和产品版本推送

- 建立免费/付费能力快照；
- 后端、构建包、SDK 和服务端 Guard 四层执行；
- 产品构建写入版本通知和兼容更新通道。

### Phase 6：服务器迁移

- 先实现控制中心迁移；
- 再接入真实产品的受控迁机；
- 产品安装身份改为本地 Ed25519 密钥对和 Challenge Proof，不能继续只信任调用方提交的 Installation ID 字符串；
- 完成配对、预同步、短暂只读、所有权切换、校准和回滚。

### Phase 7：运维脚本模块化与完整 E2E

- 保持原一键命令，内部拆分 `scripts/lib/*`；
- 覆盖首装、升级、修复、迁移、备份、恢复和失败回滚；
- 发布附件回下载后再次验证签名、哈希、版本和数量。

## 11. 每阶段完成定义

每个 Phase 必须满足：

1. 明确输入、输出、数据所有者和失败状态；
2. 增加真实旧版本/旧数据回归测试；
3. 全量测试、发布合同和 Shell 语法零失败；
4. 数据与外部 API 兼容；
5. 独立版本号、Release Notes 和升级说明；
6. Docker 首装、升级、备份与恢复通过；
7. CI 成功后才允许标签和 Latest Release；
8. 从 Release 回下载附件再次验证。

任何阶段不得为了赶进度跳过上述完成定义。
