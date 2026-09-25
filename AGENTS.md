# APPGOG 仓库强制开发与发布规则

本文件适用于整个仓库。任何人工开发、自动化工具或 AI 在修改代码前都必须遵守。

## 环境与安装包必须作为一个版本更新

- 每次会影响源码、页面、后端、数据库、Docker、安装器或运行环境的正式更新，必须递增 `package.json` 版本，禁止复用已经发布的版本号。
- `release-contract.json` 是运行环境的唯一发布合同。Node 版本、Node/Caddy 基础镜像、最低 Docker Compose 版本或支持架构发生变化时，必须同步更新 Dockerfile、Compose、环境示例、Linux 安装器、GitHub Actions、文档、测试和签名发布清单。
- 正式 ZIP、`.run`、SHA-256、`release-manifest.json`、Ed25519 签名、Git 标签、GitHub Release、README、部署文档和 Release Notes 必须全部对应同一个版本。
- `node scripts/verify-release-contract.js --source` 与 `--artifacts` 任一失败时禁止提交正式版本或创建 Release。

## 升级与数据保护

- 程序源码、前端、后端、Docker 配置和安装脚本按新版本完整覆盖；数据库、管理员账号和密码、授权 Key、公告、设置、签名密钥、上传、构建成品、日志与备份必须保留。
- 数据库变化只能通过向前兼容、可重复执行的迁移完成。禁止通过删除数据库、数据卷或配置解决升级问题。
- 新环境字段必须自动补齐；已有合法值不得被默认值覆盖。升级失败必须保存独立诊断日志并自动恢复原健康版本。
- 不得把 `docker compose down -v`、删除业务卷或盲目换密钥加入受支持的安装、更新或修复流程。

## 强制验证与发布顺序

1. 增加与真实旧版本/旧数据库状态一致的回归测试。
2. 运行全量测试、发布合同检查和 Shell 语法检查，必须零失败。
3. 生成正式 ZIP、`.run`、两份 SHA-256、稳定 `install.sh`、清单和签名，并本地验证签名与哈希。
4. 提交并推送 `main`，确认本地 HEAD 与 `origin/main` 一致。
5. 等待 GitHub Ubuntu/Docker CI 成功，必须覆盖真实首装、构建、升级、备份和恢复。
6. CI 成功后才能创建版本标签和 Latest Release，禁止提前打正式标签。
7. 从 GitHub Release 回下载全部附件，再次验证 Ed25519 签名、哈希、附件数量与 Latest 状态。

详细检查表见 `docs/release-policy.md`。这些规则不得为了赶版本而跳过。

## main 分支自动发布不得失效

- 任何会改变程序、页面、环境、安装器或正式行为的 main 提交，都必须由 GitHub Actions 在 `verify` 成功后自动执行签名打包、版本标签、Latest Release、七附件上传和回下载验证；禁止只推源码后等待人工补发 Release。
- 正式发布必须使用仓库 Secret `APPGOG_RELEASE_SIGNING_PRIVATE_KEY`，密钥只允许写入 Actions 临时目录并在结束时删除。Secret 缺失、标签冲突、附件不全、签名错误或 Latest 不一致时，发布必须失败并保持可见红灯。
- `package.json` 版本对应的标签如果已经存在，只允许它指向当前提交；指向其他提交时必须增加版本号，禁止覆盖标签或强推。
- `.github/workflows/release-drift.yml` 必须每日及手工检查 main、标签、签名清单、ZIP 内版本和 Latest Release；不得删除、绕过或降级为只检查 CI Artifact。
- 在线更新助手的心跳与 Release 检查结果必须分离。旧 schema、检查失败、结果过期或发布源落后时，禁止把历史 `latest_version` 显示成最新版本，也禁止执行“安全更新最新版本”。

## 强制模块边界

- 依赖方向固定为 `UI → HTTP/BFF → Application Use Case → Domain → Port → Adapter`，禁止反向依赖。
- `packages` 禁止导入 `apps`；HTTP 路由禁止直接执行 SQL；前端禁止作为授权、套餐或权限的最终判断边界。
- Identity、Licensing、Entitlement、Activation、Product、Packaging、Support、Operations、Migration、Audit 各自拥有自己的写模型。跨领域只能调用公开 Service/Port 或发布领域事件，禁止直接写入其他领域的数据表。
- 签名、加密和认证密钥必须按用途隔离，禁止自动回退到其他用途的密钥。完整约束见 `docs/refactor-blueprint.md`。
- 高风险状态变化和对应审计记录必须位于同一个数据库事务；数据库外副作用使用幂等任务或 Outbox 补偿。

## 强制服务器迁移边界

- 控制中心迁移与客户产品迁移是两种不同流程，禁止混用。
- 控制中心迁移必须保留数据库、服务域名、签名身份、加密密钥、管理员、Key、激活、构建和业务文件；不得批量修改客户授权域名、Installation ID 或重新签发 Key。
- 客户产品迁移必须生成新的目标 Installation ID，通过受控迁移凭据接管授权，并在切换后撤销或隔离旧安装；禁止把“复制旧 Installation ID”作为受支持迁移方式。
- 任意迁移时只能有一个可写 Active 实例。源实例、目标实例、所有权代次和回滚状态必须由状态机管理，禁止两边同时写入。
- SQLite 迁移允许在线预同步，但最终一致性切换必须进入短暂只读窗口。不得宣称当前架构可以实现完全零停机。
- 迁移全过程必须加密、分块校验、可恢复、可审计；失败时源实例和原始数据保持可用。详细标准见 `docs/server-migration-standard.md`。
