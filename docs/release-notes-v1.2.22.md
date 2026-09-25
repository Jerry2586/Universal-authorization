# APPGOG打包授权系统 v1.2.22

日期：2026-09-25

## 客户产品完整生命周期

- 新打包运行时改为“点击开始激活 → 服务端固定 60 分钟窗口 → 输入一次性 Install Key → 输入长期 License Key”的两阶段流程。
- 倒计时由服务端 `install_activation_windows` 状态机保存，刷新、重新登录、输错 Key 或重新请求不会延长窗口。
- `/api/v2/install-unlocks` 强制校验安装窗口；旧 `/api/v1/install-unlocks` 保持兼容，避免破坏已安装客户。
- 超时后签发固定安全清理指令。Xboard 服务端桥必须先切回原主题，再删除未激活主题；没有桥时保持锁定并提示人工处理，不执行不安全的浏览器伪删除。

## 重装、修复、离线与迁机

- 增加同服务器授权恢复：必须证明原 Ed25519 安装身份、校验官方 Build/Package 和固定 License Key，恢复后轮换 Refresh Secret。
- 增加 `offline-license-v1` 签名离线授权文件，绑定域名、后台 Origin、Installation ID、Build、Package、套餐能力和离线截止时间。
- 继续复用既有产品迁机状态机：目标服务器生成新的 Installation ID，经过候选验证后唯一 Active 切换，旧服务器进入 Fenced，并保留受控回滚窗口。
- 域名换绑继续执行“旧激活立即撤销、固定 Key 不变、为新域名重新构建并激活”的安全规则。

## 打包与界面

- 每个客户包新增 `appgog-license/xboard-bridge-contract.json` 和可上传到 Xboard 插件管理的 `appgog-license-bridge.zip`，固定自动删除、恢复、离线授权和服务器迁移的服务端桥职责。
- 已登录的 Xboard 管理员第一次打开主题时，会自动调用官方插件接口完成 upload、install、enable 与健康检查；插件未就绪时不创建 60 分钟窗口。
- Xboard 管理令牌只用于同源官方插件接口，不发送到 APPGOG 授权中心。Refresh Secret、Install Receipt Secret、窗口 Token 与 Ed25519 安装私钥由插件使用 Laravel `APP_KEY` 加密保存，普通访问者只取得裁剪状态和签名 Activation Token。
- 超时清理由插件从加密状态读取窗口凭证并再次向授权中心确认；确认后先切回原主题，再只删除登记的 APPGOG 主题。
- `build.json` 增加生命周期元数据；激活说明同步写入 60 分钟窗口和桥接边界。
- 激活页改为深色 SaaS 风格，首次只显示“开始激活”，开始后显示不可重置的倒计时和一次性 Key 表单。
- 打包中心新增“安装与迁移”独立页面，集中说明首次安装、同机恢复、换域名、服务器迁移、离线授权和超时清理。
- 保留 v1.2.21 尚未发布的运营后台顶部版本号改动，并合并到本版本。

## 数据与兼容性

- 数据库变化全部为向前兼容新增表/字段，不删除或重写管理员、License、激活、构建、工单、设置和业务数据。
- 新增回归测试覆盖窗口不可重置、过期清理、同机恢复凭证轮换、离线文件验签和跨环境复制拒绝。

本条目为源码变更记录；正式发布仍须完成全量测试、签名制品、GitHub CI、标签、Latest Release 和回下载验证。
