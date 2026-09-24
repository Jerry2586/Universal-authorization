# APPGOG打包授权系统 v1.2.12

日期：2026-09-25

## 本次交付

v1.2.12 完成公司级重构蓝图 Phase 2。原来仍堆在 `apps/license-api/src/http.js` 的公共接口、管理员/客户登录与会话、客户打包 BFF、授权管理、产品版本发布和后台总览，现已拆入固定领域路由模块；主 HTTP 文件只负责按边界编排，不再承载具体业务路由。

新增统一 HTTP 中间件：

- 每个请求都拥有 `X-Request-Id`，合法调用方 ID 会回显，缺失或非法时生成 UUID；
- 所有 JSON 错误固定返回 `code`、`message`、`request_id`，内部异常不向浏览器泄漏堆栈或本地路径；
- Cookie 会话、管理员权限、CSRF、Bearer Token、限流、CORS、请求体大小和安全响应头集中管理；
- 管理员与客户入口、Cookie 和权限继续严格隔离；
- Public、Identity、Customer、Licensing、Product、Activation、Packaging、Support、Operations、Migration 路由均不得直接访问 Repository 或自行写审计。

## 兼容与升级

- `/api/v1` 与 `/web/*` 的既有 URL、字段语义、Cookie、CSRF 和权限保持兼容；
- 数据库结构和业务数据没有变化，不执行迁移、不轮换任何 Key 或签名密钥；
- 管理员、客户、授权、公告、设置、上传、构建成品、工单、日志和备份全部保留；
- 升级仍使用 README 中长期不变的一键命令，程序文件完整覆盖，持久化数据保持不变，失败自动恢复旧健康版本。

## 验证

- 新增路由归属和统一中间件边界测试；
- 新增请求 ID 回显及错误合同真实 HTTP 回归；
- 全量 Node 测试、发布合同、制品合同和 Git 差异检查均必须通过；
- 正式 Release 仅在 Ubuntu/Docker CI 成功后创建，并从 GitHub 回下载七个附件复验 Ed25519 签名、SHA-256、版本和数量。
