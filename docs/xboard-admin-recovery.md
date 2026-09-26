# Xboard 原生后台异常恢复

适用：APPGOG 授权桥升级/删除后原生后台返回 `Internal server error.`。平台修复版本 1.2.41，桥修复版本 1.1.1。

## 先区分日志

Redis 的 `DB saved on disk`、`Background saving terminated with success` 和 Supervisor 的 `exit status 0` 不能定位 PHP 页面异常。需要故障时刻的 Laravel 应用日志（Xboard 根目录 `storage/logs/`）与 PHP/Octane 错误输出；不要开启公开 APP_DEBUG，也不要发送 .env、数据库或完整凭证。

在已确认的 Xboard 应用目录执行只读采集：

```sh
pwd
ls -lt storage/logs
```

从列表里选取故障当日实际日志文件，读取异常及其相邻堆栈。Docker 部署先使用 `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'` 确认应用容器，再在该容器的 Xboard 工作目录读取文件；不得猜测容器名或拿 Redis 日志代替应用日志。

## 已复现的故障与修复

常驻响应回调可能比插件文件存活更久。旧回调读取已删除的 admin-entry.js 或自动加载缺失类时会抛出异常。1.1.1 将可选后台装饰与服务端授权判断分开：装饰失败保留宿主响应，授权失败仍拒绝受保护主题。

原生后台可访问时，通过官方插件管理升级授权桥 1.1.1。新增迁移会更新 `storage/app/private/appgog-host/Guard.php` 和 `admin-entry.js`，并安排工作进程重载。刷新后读取桥健康接口，必须实际返回版本 1.1.1；只看到 ZIP 版本不算完成。

原生后台已无法访问时，需要服务器维护连接：先保留故障日志和现有插件、bootstrap、私有状态备份，依据堆栈修复对应文件/权限，再通过官方升级流程执行新迁移和重载。文件来源必须为通过签名与哈希验证的正式制品。没有实际路径、进程管理方式和错误堆栈时，不提供会盲目覆盖 bootstrap 或清空状态的恢复命令。

## 验收

- 原生后台返回正常 HTML，可以登录和管理插件。
- 桥健康接口为 1.1.1；安装身份、原激活、主题设置不变。
- 点击“激活主题”先出现本地 Key 窗口，不提前切换主题；已有主题的授权按钮位于设置区。
- 插件不可用时，受保护主题配置接口继续拒绝，原生恢复后台仍可访问。
- 保留独立诊断记录；单纯推送 Git 或更新两个中心不代表客户服务器已经修好。
