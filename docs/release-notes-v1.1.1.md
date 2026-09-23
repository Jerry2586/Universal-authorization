# APPGOG打包授权系统 v1.1.1

发布日期：2026-09-23。

## 一条固定命令完成首装和升级

- 新增可通过管道执行的稳定引导入口 `install-docker.sh`，不再要求先把版本化 `.run` 上传到 `/root`。
- 唯一推荐命令先识别 `apt`、`dnf` 或 `yum` 并补齐 `curl` 与 CA，随后识别发行版和 CPU，补齐其余工具、Docker、Compose 和 Buildx。
- 引导器自动获取最新正式 Release，先验证 Ed25519 清单签名，再校验 `.run` SHA-256；签名或哈希不一致时不会执行安装包。
- 首次执行提示输入授权中心和打包中心域名并完成部署；发布新版本后逐字重跑同一句命令自动升级。
- 相同版本重跑安全退出；默认拒绝降级；升级保留 `.env`、runtime、数据库、业务签名密钥、管理员身份和备份。
- GitHub 下载失败时自动尝试自有国内源、GitHub Release 和签名保护的备用代理源。
- 打包流程新增稳定附件 `install.sh`，GitHub Actions 同步保存该附件。
- 升级时同步 `.env` 中的 `APPGOG_VERSION`，避免运行代码和显示版本不一致。

## 教程调整

- README 和部署文档统一为一个长期不变的标准命令。
- 版本化 `.run` 只保留为离线安装和指定版本归档方式。
- `appgog update` 明确为“使用服务器已有代码重建”，跨版本升级使用固定在线命令。
- 补充国内源、GitHub 代理、签名校验、禁止降级、同版本幂等及真实 VPS 验收说明。

## 验证

- Node 自动测试：66 项，64 通过，0 失败；2 项 POSIX 执行测试在 Windows 环境按设计跳过。
- `install-docker.sh`、主安装器、Docker 管理脚本和交互菜单均通过 POSIX Shell 语法检查。
- 正式 ZIP、`.run`、稳定 `install.sh`、发布清单和 Ed25519 签名已完成独立哈希、签名和内嵌 ZIP 一致性校验。
- Linux GitHub Actions 继续执行真实 Docker 首装、更新和完整恢复验证。
