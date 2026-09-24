# APPGOG打包授权系统 v1.2.13

日期：2026-09-24

## 本次交付

v1.2.13 完成公司级重构蓝图 Phase 3，把原来集中在授权服务、Portal Service 和全库 Repository 中的多领域职责拆到固定边界，同时保持现有接口、数据库和用户数据兼容。

- `createLicenseService` 从 785 行缩为小型兼容门面，只组合 Product Catalog、Licensing、Entitlement、Packaging Authorization、Activation 和 Audit；
- Licensing 和 Entitlement 通过 Activation 生命周期 Port 请求撤销，不再直接写激活或安装凭证数据；
- 产品版本发布只依赖 Product Catalog 能力，构建队列只依赖 Build Authorization 能力，不再持有完整授权服务；
- `createPortalService` 从 247 行缩为小型兼容门面，客户概览、管理员总览和 License 永久删除拥有独立 Service 与 Repository Port；
- `createRepository` 从 948 行缩为领域 Adapter 组合器，123 个既有方法完整保留，由 Product、Entitlement、Licensing、Activation、Packaging、Audit、Identity、Operations、Support 和 Erasure 分别拥有；
- Prepared Statement 集中在纯技术目录，领域 Adapter 负责数据库方法和写所有权，兼容门面不再声明 SQL 或执行业务查询；
- 新增结构边界测试，禁止业务逻辑重新堆回三个兼容门面或向 Repository Port 暴露无关领域写接口。

## 兼容与升级

- `/api/v1`、`/web/*`、Cookie、CSRF、权限、请求与响应字段全部保持兼容；
- 数据库 Schema 没有变化，本次升级不执行破坏性迁移，不清库、不删卷、不轮换已有 Key 或生产密钥；
- 管理员、客户、授权 Key、套餐、公告、设置、上传、构建成品、工单、日志、备份和签名身份全部保留；
- 程序源码、前端、后端、Docker 和安装脚本仍按新版本完整覆盖，升级失败自动保存诊断并恢复旧健康版本。

## 验证

- 自动比较 Repository 重构前后的 123 个公开方法，确保无遗漏；
- 覆盖完整打包、Install Key、Install Receipt、固定 Key 激活、套餐能力、Ed25519 安装身份、受控产品迁机、域名换绑、Portal 和永久删除边界；
- 全量 Node 测试、Shell 语法、源码合同、制品合同和 Git 差异检查必须零失败；
- 正式 Release 仅在 Ubuntu/Docker CI 成功后创建，并从 GitHub 回下载七个附件复验 Ed25519 签名、SHA-256、版本、数量和 Latest 状态。
