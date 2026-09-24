# APPGOG 强制升级与发布标准

日期：2026-09-24

本标准是仓库正式版本的阻断条件，不是建议。根目录 `AGENTS.md` 约束开发流程，`release-contract.json` 保存机器可读的环境合同，`scripts/verify-release-contract.js` 和 GitHub Actions 负责自动阻断不一致版本。

## 一、同一版本必须完全匹配

以下内容必须使用同一个 `package.json` 版本：

- Git 源码、README、架构文档、部署文档和当版 Release Notes；
- Docker 镜像标签、容器内 `package.json` 与运行环境中的 `APPGOG_VERSION`；
- 正式 ZIP、版本化 `.run`、两份 SHA-256；
- `release-manifest.json`、Ed25519 签名、Git 标签和 GitHub Latest Release。

已经存在正式标签或 Release 的版本号不得重新使用。源码发生新的正式更新时必须增加版本号。

## 二、环境合同必须完全匹配

`release-contract.json` 是唯一机器可读标准，至少包含：

- Node.js 引擎与主版本；
- Node 和 Caddy 默认基础镜像；
- 最低 Docker Compose 版本；
- 支持的 CPU 架构。

修改这些值时，必须同步修改 Dockerfile、`compose.yaml`、`.env.docker.example`、`scripts/install-linux.sh`、GitHub Actions 和部署文档。签名发布清单必须嵌入同一份环境合同，正式 ZIP 内也必须包含该合同。

## 三、升级必须保留的数据

- 管理员账号、六位密码与权限；
- 授权 Key、激活、换绑和审计记录；
- 公告、运营设置和系统配置；
- SQLite 数据库、Ed25519 密钥和各类加密密钥；
- 上传源码、构建成品、日志和备份。

程序源码、页面、后端、Docker 配置和安装脚本使用新版本完整覆盖。数据库只允许通过可重复执行的向前迁移补齐结构，不允许删除卷或清空数据库重装。

## 四、每次正式发布的固定顺序

1. 修复问题并增加真实旧环境回归测试。
2. 执行全量测试、发布合同源文件检查和 Shell 语法检查。
3. 使用发布私钥生成并签名全部发布附件。
4. 本地验证签名、ZIP/RUN 哈希和包内版本/环境合同。
5. 提交并推送 `main`，等待 GitHub Ubuntu/Docker CI 完成真实首装、构建、升级和恢复。
6. CI 成功后创建版本标签和 Latest Release。
7. 从 GitHub 回下载七个附件，重新验证签名、哈希与 Latest 状态。

任意一步失败都必须停止发布。升级失败时保留数据与备份、保存独立诊断日志，并恢复原健康版本。

`node scripts/verify-release-contract.js --artifacts` 默认要求并验证 `release-manifest.json.sig`。GitHub PR/CI 由于不保存正式私钥，只能显式设置 `APPGOG_ALLOW_UNSIGNED_ARTIFACTS=1` 做非正式制品结构与 Docker 流程验证；该 CI 产物不得直接作为正式 Release。发布操作员本地不得设置此开关。
