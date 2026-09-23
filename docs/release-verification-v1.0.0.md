# APPGOG打包授权系统 v1.0.0 发布验证记录

验证日期：2026-09-23。

## 已执行验证

- `node --test`：60 项，58 通过，0 失败，2 项 Linux 专用测试跳过；
- Windows 下跳过 POSIX Shell 自动测试与自解压脚本 Linux 执行测试；另通过 Git Bash 对每个 Shell 脚本执行语法检查。新增进程退出、spawn 失败、连续健康失败及安装包校验测试通过。
- 固定 Key 正常、错误、暂停、恢复、最终撤销、轮换、跨产品拒绝和激活数量限制：自动测试通过；
- 域名规范化、首次绑定、重复绑定拒绝、受控迁移、管理员审批和 generation 失效：自动测试通过；
- 两阶段授权、Install Key 一次性事务消费、Install Receipt 环境绑定、正式激活、Token 篡改/过期/撤销与离线宽限：自动测试通过；
- 管理员/客户会话隔离、CSRF、多客户对象归属、版本期限和双 Key 一步激活禁止：自动测试通过；
- 短期下载票据的过期、篡改和跨会话复用拒绝：自动测试通过；
- ZIP 安全、构建失败回滚、签名包身份、Source Map 删除、JS/CSS 水印、随机保护路径、AES-256-GCM 包身份、逐文件 SHA-256、Package Secret HMAC、跨包替换和载荷篡改拒绝：自动测试通过；
- 独立 Worker 节点凭证、队列租约、Compose 只读根文件系统、capability 移除、禁止提权和资源上限：自动检查通过；
- Caddy 私网反代后的真实客户地址限流：自动测试通过；
- Docker 初始化身份保留、旧部署凭证导入、备份恢复输入防护、更新回滚路径和不删除数据卷：自动测试通过；
- Linux 安装器的发行版/CPU 架构/磁盘/Buildx/端口检查，以及 DNS、HTTPS、TLS 到期、签名密钥权限和最近加密备份诊断：代码和自动静态测试通过。

## 发布前本机检查

- 关键 JavaScript 文件执行 `node --check`；
- `git diff --check`；
- 重新运行 `node scripts/package-cms.js`；
- 审计 ZIP 必须包含 `Caddyfile` 与 `compose.yaml`，不得包含 `.env`、`.backup-key`、Git、`node_modules`、旧 `dist`、SQLite 数据库、PEM/Key 或已删除的 `compose.legacy.yaml`；
- 使用独立计算结果交叉验证发布 ZIP 的 SHA-256。

## 本机无法执行的真实验证

当前开发主机是 Windows，未安装 Docker。Linux Docker 运行结果以对应 GitHub Actions 为准，下列目标服务器验收不能由本机替代：

- `docker compose config --quiet` 的真实 Docker CLI 解析；
- 自解压安装文件在目标 Linux 的系统依赖补齐；
- Debian、Ubuntu、RHEL、Rocky、Alma、Fedora 实机包管理器安装；
- 公网 DNS A 记录、80/443 防火墙、Caddy ACME 证书签发与自动续期；
- 全新 VPS 一行安装、更新失败自动回滚和整机备份恢复演练；
- 单容器的资源限制与宿主机加固验证；默认 Worker 与其他进程共享文件系统；
- 真实 APPGOG/Xboard 后端设置、主题启用、Xboard 连接、受保护资源与正式更新路由的逐项守卫接入。

这些项目需要目标 Linux VPS、真实域名和真实 APPGOG/Xboard 源码。仓库已经提供安装器、Caddy 编排、诊断、服务端守卫 SDK 和接入契约，但本地静态测试不能替代外部环境验收。

## 安全声明

每包随机化、加密身份、签名清单、水印和环境绑定用于提高逆向、篡改和复制成本，不代表客户端代码绝对不可提取或不可破解。未知第三方业务资源没有被激进改写，以保持真实 Xboard 主题兼容性。

## 发布制品

主安装文件：`APPGOG-Packaging-Licensing-System-1.0.0.run`，另提供 ZIP 源码和两者 SHA-256。

最终 SHA-256 以本次收口重新生成并独立交叉验证的结果为准。每次修改源码或文档后，旧 ZIP 和旧哈希都立即失效。
