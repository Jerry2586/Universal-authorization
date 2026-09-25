# APPGOG 服务器迁移标准

日期：2026-09-25
状态：v1.2.16 已完成控制中心安全回滚交接与客户产品迁机状态机

## 1. 必须区分的两类迁移

### A. 控制中心迁移

迁移对象是 APPGOG 授权中心、打包中心和 Worker 所在服务器。目标是把控制平面整体搬到新服务器，同时保持原来的授权 API 域名、数据库、Key、签名身份和业务数据。

控制中心迁移后：

- 客户 License Key 不变；
- 客户绑定业务域名不变；
- 客户 Installation ID 不变；
- 已签发 Activation Token 的验证公钥不变；
- 原授权 API 域名通过 DNS 指向新服务器；
- 不批量重新激活客户产品。

### B. 客户产品迁移

迁移对象是某个客户已经激活的产品，从旧业务服务器搬到新业务服务器。业务域名可以保持不变，但目标服务器必须得到新的 Installation ID，并通过受控迁移接管授权。

控制中心迁移允许继承控制中心身份；客户产品迁移禁止简单复制旧 Installation ID。两种流程不得共用同一个“自动校准”接口。

## 2. 当前实现的真实边界

当前激活令牌已经绑定：

```text
License generation
Build ID
Package ID
客户业务域名
客户后台 Origin
Installation ID
有效期和 Ed25519 签名
```

v1.2.10 的 SDK 已提供产品服务器安装身份模块：产品服务端在持久目录生成 Ed25519 密钥对，Installation ID 由安装公钥指纹派生。安装解锁、刷新和产品迁机使用短期一次性 Challenge Proof；只复制数据库、Installation ID 或浏览器状态不能取得新凭证。

真实产品接入仍必须把私钥放在 Web 根目录之外，并由服务端调用 SDK。浏览器 Local Storage、可公开配置文件、IP、MAC 或用户任意提交值都不能作为可信安装身份。仓库提供可信身份协议和 SDK，不承诺自动读取所有云厂商的硬件属性。

## 3. 产品服务器身份标准

产品授权必须以“服务器持有的安装身份密钥”为主绑定，以业务域名和后台 Origin 为环境约束。公网 IP、MAC、CPU 序列号和云厂商实例 ID 只能作为风险信号，不能单独作为授权根身份，因为它们会在换 IP、重装、云平台迁移、网卡变化或灾备恢复时产生误伤。

首次安装固定执行：

1. 产品服务端在目标服务器本地生成独立 Ed25519 安装身份密钥对；
2. 私钥写入 Web 根目录之外、仅 root/产品服务账号可读的持久目录，权限不高于 `0600`；
3. 私钥不进入安装包、数据库导出、页面、日志或普通诊断包；
4. `Installation ID` 由安装公钥 SPKI 的 SHA-256 指纹稳定生成；
5. 控制中心签发短期一次性 Challenge；
6. 产品服务器用安装私钥签署包含 Challenge、License、Build、Package、域名和 Origin 的规范化载荷；
7. 控制中心验证签名后才签发 Install Receipt 或 Activation Token；
8. Activation Token 同时包含安装公钥指纹，刷新时继续要求新的 Challenge Proof。

因此：

- 同一个域名复制到另一台服务器，没有原安装私钥也不能冒充原实例；
- 只复制数据库但未受控迁移安装身份，授权刷新必须失败；
- 控制中心迁移必须原样继承控制中心自己的签名身份，不影响客户安装身份；
- 客户产品迁机由目标服务器生成新密钥对，通过迁机 Grant 完成新旧公钥指纹交接；
- 不允许长期复制旧服务器安装私钥到新服务器后让两边同时运行。

## 4. 控制中心迁移状态机

```text
waiting_pair → paired → uploading → import_queued
             → target_preflight → restoring → target_active
             → source_fenced → completed
```

失败分支：

```text
任意上传前状态 → cancelled / expired
源端失败 → source_active → rolled_back
目标恢复失败 → rollback_required → target_restored → failed
切换后回滚 → rollback_exporting → source_importing → rolled_back
```

规则：

- 任意时间只能有一个写入 Active 实例；
- 目标通过健康检查和一致性校验前不得 Active；
- 目标 Active 后源服务器必须 Fenced；
- Fenced 状态不能通过普通 restart 绕过；
- 所有权由签名的 `ownership_generation` 控制；
- SQLite 最终切换必须进入短暂只读窗口；
- 失败时不删除源数据和源备份。

## 5. 控制中心迁移数据范围

必须迁移：

- SQLite 数据库和 Schema 版本；
- 管理员、客户会话策略和密码哈希；
- License Key 密文/摘要、状态、套餐和域名；
- Build Ticket、Build、Install Key、Receipt、Activation 和事件；
- 上传、构建成品、工单附件和产品版本；
- 公告、运营设置、主题和节点配置；
- 激活、Package、通知签名密钥及加密密钥；
- 审计、必要日志、备份元数据和更新控制状态。

不迁移旧容器、旧 Node Modules、旧系统包和临时构建缓存。目标服务器从同版本签名 Release 安装干净程序，只导入持久数据。

## 6. 控制中心迁移流程

1. 新服务器用正式一键命令安装与源服务器完全相同的版本，暂时可使用可访问的目标 HTTPS 域名。
2. 目标管理员在“系统迁移”页面开启接收，获得 15 分钟有效的一次性配对码。
3. 源管理员在“系统迁移”页面输入目标 HTTPS 地址和配对码。
4. 双方核对版本、时间、磁盘、Docker、Compose 和部署身份；握手成功后配对码立即失效。
5. 源停止写入并创建最终一致性加密备份；失败立即恢复源服务。
6. 备份按 64 MiB 分块上传；每块 SHA-256 校验，同序号失败块可以重传。
7. 目标确认所有块齐全，再校验整包 SHA-256；校验前不得创建恢复请求。
8. 目标先创建迁移前回滚备份，再恢复数据库、密钥、上传、成品、附件和 Caddy 状态。
9. 目标修复权限、执行幂等数据库迁移并通过容器健康检查后取得新所有权 generation。
10. 目标恢复失败时自动恢复迁移前状态；源服务器继续或恢复 Active。
11. 目标成功后源进入数据库与文件双重 Fenced，普通 restart 不能恢复写入。
12. 用户把原授权域名和打包域名 DNS 指向目标 IP，确认 HTTPS、授权 API、管理后台和打包中心后完成迁移。

迁移模块只能检查 DNS；除非用户显式配置受支持的 DNS Provider Token，否则不能假设可以自动修改所有 DNS 服务商。

## 7. 客户产品受控迁机

客户产品迁移固定流程：

```text
旧产品实例申请迁移
  → 控制中心验证 License、套餐、冷却和旧实例状态
  → 生成短期一次性 Product Migration Grant
  → 新服务器安装同一或兼容版本
  → 新服务器生成新的 Installation ID
  → 新实例提交 Grant、Build/Package、域名、Origin 和新 Installation ID
  → 控制中心签发不可刷新的候选激活
  → 数据校验和业务健康检查
  → 提交所有权切换：新实例 Active，旧实例 Fenced
  → 切换业务域名/DNS
  → 有限窗口内可由旧实例凭原 Refresh Secret 和新 Challenge Proof 回滚
```

自动校准的含义是：

- 保留原 License Key、套餐、绑定业务域名和更新权益；
- 把激活所有权从旧 Installation ID 转给新 Installation ID；
- 把服务器身份从旧安装公钥指纹转给新安装公钥指纹；
- 生成新的 Activation/Refresh 凭据；
- 撤销旧实例继续刷新的能力；
- 保留可审计的迁移记录和有限回滚窗口。

自动校准绝不等于：

- 新服务器只输入 License Key 就无条件顶掉旧服务器；
- 复制旧 Installation ID；
- 两台服务器长期同时激活；
- 仅凭相同域名认定为同一服务器；
- 绕过 Install Receipt、Build 和 Package 校验。

## 8. 迁移安全协议

- 配对码最长有效 15 分钟，只能使用一次，只保存摘要；
- 正式环境强制使用 HTTPS，并依赖目标站点的受信任证书完成传输身份校验；
- 每个任务拥有 `migration_id`、源/目标实例 ID 和所有权代次；
- 每个 64 MiB 数据块独立 SHA-256 校验，完整快照再做整包 SHA-256 校验；
- 目标恢复前再次验证哈希、源/目标版本、会话和固定收件箱路径；
- 迁移接口只允许固定动作，不接受任意路径、SQL 或 Shell；
- 迁移包使用现有 AES-256/PBKDF2 完整备份加密；恢复密钥仅在一次性 HTTPS 上传会话中传递，不写普通日志；
- 每一步写结构化迁移日志和安全审计。

## 9. 一致性与零损伤标准

“用户数据 0 损伤”定义为迁移完成后以下内容一致：

- 管理员、客户、授权、套餐、域名、安装、激活、构建、工单和设置记录；
- 数据库外键与业务状态；
- 上传、构建成品和附件哈希；
- 签名公钥指纹、加密密钥身份和 License generation；
- 活动构建不存在半完成或重复消费；
- 新旧两台服务器不会同时接受写入。

当前 SQLite 方案可以做到数据零损伤，但最终切换需要短暂只读，不能承诺完全零停机。完全零停机属于后续 PostgreSQL 复制架构范围。

## 10. 回滚

- 切换前失败：目标清理未激活快照，源继续 Active。
- 切换期间失败：目标保持不可写，源退出只读并恢复 Active。
- 切换后回滚：先冻结目标，回传目标产生的最终增量，校验后提升源所有权代次，再把目标 Fenced。
- 当前实现以目标的最终加密完整快照承载全部增量。目标执行 `migration-rollback-export` 后数据库和服务保持 Fenced/停止；旧源只接受固定 `rollback-inbox/<migration-id>` 中的备份、独立密钥和 manifest。
- 旧源导入必须核对 `source_deployment_id`、目标 generation、SHA-256 和文件路径，成功后使用 `target generation + 1` 恢复 Active；失败恢复导入前旧源快照并保持 Fenced/停止。
- 不允许通过同时启动两台服务器“观察哪台可用”。
- 回滚日志必须注明差异、所有权代次、数据哈希和 DNS 待处理状态。

## 11. 当前模块划分

```text
apps/license-api/src/modules/migration/
  repository.js       数据库状态、控制中心身份与所有权 generation
  control.js          配对、分块接收、哈希校验和固定恢复请求
  http-routes.js      独立 HTTP 边界
scripts/migration.sh  宿主机预检、备份、传输、恢复、Fenced 和回滚
scripts/docker/migration-state.js
                      受控数据库状态切换
apps/web/public/assets/portal/migrations.js
                      管理后台系统迁移界面
```

迁移模块负责搬运和校验，不直接重写授权业务内容；授权变化必须调用 Licensing/Activation 公开 Use Case。

## 12. 发布必须保持的测试

- 控制中心迁移保留 Key、密钥和激活；
- 迁移后旧 Activation Token 仍能由相同公钥验证；
- 产品迁机必须产生新 Installation ID；
- 激活和刷新必须验证目标服务器对一次性 Challenge 的签名；
- 相同域名但不同安装公钥不能冒充原服务器；
- 复制数据库但没有安装私钥的实例不能刷新授权；
- 旧产品实例在切换后无法刷新；
- 两个 Active 所有权被拒绝；
- 分块摘要、缺块拒绝、整包摘要和重复序号重传；
- SQLite 快照与迁移期间写入一致性；
- 文件哈希差异阻止切换；
- 目标健康检查失败自动回滚；
- DNS 未切换只显示待处理，不篡改授权数据；
- 日志和迁移包不泄漏密钥。
