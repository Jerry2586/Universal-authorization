# APPGOG打包授权系统 v1.2.15

日期：2026-09-25

## 本次交付

v1.2.15 完成公司级重构蓝图 Phase 5，把免费版、付费版、历史兼容版的能力与额度固定为可审计、不可漂移的 License 快照，并补齐产品版本推送的签名执行边界。

- 新授权签发时保存套餐能力和实际构建/激活额度快照；以后修改套餐模板不会静默改变既有客户权益；
- 老数据库只新增 `entitlement_capabilities_json` 与 `entitlement_limits_json`，按原套餐回填能力并按原 License 字段保留实际额度；
- 套餐切换在同一事务中更新快照与额度、增加 License generation、撤销旧激活并写授权事件和安全审计；
- Activation Token 新增签名额度快照，能力继续使用独立 Activation 签名保护；
- 客户安装包运行时新增 `APPGOGLicense.hasCapability()` 与 `requireCapability()`，无权操作统一抛出 `APPGOG_CAPABILITY_DENIED`；
- 版本检查要求签名激活包含 `updates:read`，并校验 Notification Token 绑定的版本、名称、说明、发布时间、通道、发布类型和打包中心地址；
- SDK 提供相同的能力查询与强制 Guard，旧版未携带 capabilities 的历史兼容激活保持原有能力，明确空能力数组仍全部拒绝；
- 管理员切换套餐时可预览目标能力、每日构建额度和激活环境额度。

## 兼容与升级

- `/api/v1`、既有 `/web/*` 请求字段、固定 License Key、Install Receipt 和激活环境绑定语义保持兼容；
- 数据库迁移向前兼容且可重复执行，不清库、不删卷、不改变已有管理员、Key、域名、构建、工单、公告、上传、成品、日志、备份和生产密钥；
- 源码、前端、后端、Docker 和安装器按 v1.2.15 完整覆盖，升级失败继续保留独立诊断并恢复旧健康版本；
- 真实 APPGOG/Xboard 产品服务端仍需在取得其源码后，把 SDK Guard 接入设置保存、主题启用和 Xboard 连接等实际关键路由。

## 验证

- 回归覆盖套餐模板修改不影响已签发免费版快照；
- 回归覆盖套餐切换立即更新额度、撤销旧激活并阻止旧 Refresh；
- 回归覆盖浏览器能力查询、无权能力拒绝以及无 `updates:read` 时零版本请求；
- 回归覆盖 SDK 能力 API 与旧 Token 兼容语义；
- 回归覆盖真实旧授权数据库升级、能力回填和原额度保留。
