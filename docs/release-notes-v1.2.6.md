# APPGOG打包授权系统 v1.2.6

发布日期：2026-09-24

## 本次更新

- 在仓库根目录新增 `AGENTS.md`，把环境、安装包、数据保护、测试和正式发布顺序设为整个仓库的强制规则，后续人工开发和 AI 开发都必须先遵守。
- 新增机器可读的 `release-contract.json`，集中固定 Node 引擎、Node/Caddy 基础镜像、最低 Docker Compose 版本和 amd64/arm64 架构。
- 新增 `scripts/verify-release-contract.js`，自动核对 package、Dockerfile、Compose、环境示例、Linux 安装器、GitHub Actions、README、部署文档和 Release Notes。
- 正式 ZIP 现在必须包含仓库规则、环境合同和发布标准；签名 `release-manifest.json` 同时嵌入完整环境合同。
- 打包脚本在生成安装包前后强制校验，GitHub Actions 在测试前与打包后再次校验；任一版本、环境、文件名或 SHA-256 不匹配都会阻止发布。
- 新增发布合同自动测试，防止后续更新绕过“源码、环境和安装包必须匹配”的要求。

## 数据与升级

本版本不修改业务数据库。管理员账号和密码、授权 Key、公告、设置、签名密钥、上传源码、构建成品、日志和备份全部保持不变。服务器继续执行 README 中相同的一键命令完成升级。
