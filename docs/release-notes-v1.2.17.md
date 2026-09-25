# APPGOG打包授权系统 v1.2.17

日期：2026-09-25

## 本次交付

v1.2.17 完成公司级重构蓝图 Phase 7，固定运维脚本边界、真实失败回滚测试和正式 Release 发布后复验流程。

- 管理菜单中的控制中心安全回滚请求拆入 `scripts/lib/manager-migration.sh`，菜单和命令行入口、固定 rollback inbox 与迁移状态机保持不变；
- Linux 安装器中的签名 Release 下载拆入 `scripts/lib/release-install.sh`，继续支持国内源、GitHub 和离线 `.run`，任何来源都必须通过 Ed25519 与 SHA-256；
- 新增 `scripts/verify-published-release.js`，从 GitHub Release API 返回的下载地址获取固定七附件，拒绝草稿、预发布、附件缺失、多余附件和非 Latest 标签；
- GitHub 回下载内容复用本地发布合同，验证清单 Ed25519 签名、ZIP/RUN 哈希、两份 `.sha256`、稳定 `install.sh`、包内 `package.json` 与 `release-contract.json`；
- Docker E2E 新增损坏候选镜像：两次启动均失败时必须保存独立诊断、恢复旧健康镜像并保留业务数据；
- Docker E2E 新增无缓存源码修复，修复后继续验证数据库、Key、激活、构建和业务文件没有丢失。

## 兼容与数据保护

- 现有数据库结构和 v1.2.16 迁移标识不改名、不重跑、不清库；
- 管理员、六位密码、授权 Key、激活、域名、公告、设置、工单、上传、构建成品、日志、备份和全部生产密钥继续保留；
- 源码、页面、后端、Docker 配置和安装器按 v1.2.17 完整覆盖，禁止 `docker compose down -v`、删除业务卷或重新生成合法密钥；
- 控制中心迁移与客户产品迁机仍使用 v1.2.16 已固定的两套独立状态机，任意时刻只能有一个可写 Active 实例。

## 验证

- 发布回下载测试覆盖七附件成功、附件缺失/多余、Latest 不匹配、签名篡改和 ZIP 哈希篡改；
- Docker CI 覆盖首装、真实构建、普通升级、候选失败回滚、源码修复、加密备份、空部署恢复和域名重载；
- 正式发布仍必须依次通过源文件合同、全量测试、Shell 语法、本地签名制品、`main` CI、标签/Latest Release 和 GitHub 回下载复验。
