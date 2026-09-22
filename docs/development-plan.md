# 开发计划与完成状态

日期：2026-09-23。

## 第一版可用闭环：已完成

- [x] 固定 License Key 签发、HMAC 摘要存储、域名绑定和每日构建额度
- [x] License 暂停、恢复、撤销、换域名和固定 Key 轮换
- [x] 一次性 Build Ticket、Build ID、Package ID、Package Secret 和 Install Key
- [x] Install Key 原子消费，不能重复激活
- [x] 域名、后台 Origin、Installation ID、Build 和 Package 绑定
- [x] Ed25519 激活凭证、本地验签、刷新 Secret 和离线有效期
- [x] 管理员账号密码登录、客户固定 Key 登录、双 Cookie 隔离和 CSRF
- [x] 多角色管理员、成员停用与会话撤销、版本公告与撤回
- [x] 双 Key 激活；服务端签名的限期离线宽限（仅已经成功激活的环境）
- [x] 历史版本重新打包与回滚意图，签名版本公告和打包站跳转地址
- [x] `/admin` 授权管理、版本上传、构建/激活/审计查看
- [x] `/build` 版本选择、构建进度、Install Key 展示和 ZIP 下载
- [x] 安全 ZIP 读取/写入，不执行客户上传代码
- [x] ZIP Slip、加密 ZIP、压缩炸弹、符号链接、可执行文件和普通 PHP 检查
- [x] Xboard `config.json` 和 HTML/Blade 入口检查
- [x] 每个包注入独立运行时、构建清单和激活说明
- [x] 独立 Worker 自动领取、构建、校验 SHA-256、完成或失败回滚
- [x] `BuildQueue`、`ArtifactStore`、`BuildEngine` 可替换接口
- [x] SQLite 队列、本地成品存储和失败额度返还
- [x] 26 个自动测试和真实浏览器/HTTP 分层闭环冒烟测试

验收链路：管理员上传主题 ZIP → 签发固定 Key → 客户登录 → 创建构建 → 下载客户专属 ZIP → 一次性 Install Key + 固定 Key 激活 → Ed25519 激活凭证 → 不同域名/后台地址环境复制校验失败。

## 接入真实 APPGOG 项目：拿到源码后做

当前系统已经能保护可安装 ZIP。以下工作只有拿到真实 APPGOG/Xboard 项目后才能精确完成：

- [ ] 确认 Vue/Xboard 版本、包管理器和生产构建命令
- [ ] 确认最终主题入口、静态资源基准路径和 Xboard 安装目录结构
- [ ] 针对真实 Blade 路由验证运行时资源 URL；必要时改为内联或使用已知公共资源前缀
- [ ] 在 APPGOG 服务端设置读取/保存接口增加授权守卫
- [ ] 将 Activation ID、Refresh Secret 和 Installation ID 存到服务器不可公开访问的位置
- [ ] 完成真实更新、重装、备份恢复和后台 URL 变化测试
- [ ] 在隔离容器中接入 Vue/npm 构建适配器，不在主 API 进程执行上传源码
- [ ] 生产构建时删除 Source Map，并按真实项目选择适度混淆策略
- [ ] 用真实服务端安装标识校验服务器环境；仅靠浏览器本地存储无法可靠防止同域名环境搬迁
- [ ] 真正自动备份/恢复 Xboard 数据与升级失败事务回滚；当前回滚仅重新构建历史版本包
- [ ] 备用授权节点与初次激活故障恢复；目前只有已有激活凭证的有限签名离线宽限

## 正式商用前加固

- [ ] HTTPS、反向代理和可信代理 IP 配置
- [ ] PostgreSQL 数据库迁移与版本化 migration
- [ ] S3 兼容对象存储与短时签名下载地址
- [ ] 独立容器 Worker、资源配额、网络隔离和沙箱逃逸测试
- [ ] Redis/专业队列、租约恢复、幂等键和死信任务
- [ ] Ed25519 私钥迁移 KMS/Vault/HSM
- [ ] 管理员 MFA、密码找回和更完整的登录限流（基础角色权限已实现）
- [ ] 数据库备份、密钥轮换、监控、告警和审计导出
- [ ] 风险 IP、频繁换绑、撞 Key 和异常构建告警
- [ ] 渗透测试及业务风控处置流程

## 已冻结的产品规则

1. 固定 Key 可重复用于合法更新和重新打包，不是一次性 Key。
2. Build Ticket、Package Secret 和 Install Key 每次打包都重新生成。
3. Install Key 只对应一个 Build，成功激活一次后永久消费。
4. 一个 License 同一时间绑定一个授权域名；换域名由卖家后台明确操作。
5. 更新或重装必须重新打包并获得新 Install Key。
6. ZIP 不设置解压密码，保证 Xboard 可以正常安装。
7. 固定 Key 不写入客户包，签名私钥不进入 Worker 或客户包。
8. 混淆、片段乱序和随机文件名只提高逆向成本，根信任仍是服务端状态和数字签名。
