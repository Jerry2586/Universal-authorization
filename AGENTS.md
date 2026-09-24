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
