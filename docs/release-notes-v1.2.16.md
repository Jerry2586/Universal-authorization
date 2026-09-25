# APPGOG打包授权系统 v1.2.16

日期：2026-09-25

## 本次交付

v1.2.16 完成公司级重构蓝图 Phase 6，把控制中心迁移与客户产品迁机固定为两套独立、可审计且始终只有一个 Active 实例的协议。

- 客户产品迁机新增 `issued → prepared → completed → rolled_back` 状态机；目标服务器先以新 Ed25519 Installation Identity 和一次性 `migration_prepare` Challenge 创建 Candidate Activation；
- Candidate 不能刷新授权；只有 `migration_commit` Challenge 通过后，才在同一数据库事务中 Fenced 旧 Activation/Identity 并激活目标；
- 有限窗口内回滚要求旧服务器原 Refresh Secret、原安装私钥和新的 `migration_rollback` Challenge，先 Fenced 目标再恢复源 Active；
- 旧 `/api/v1/product-migrations/accept` 保留兼容，新接口增加 `/prepare`、`/commit` 和 `/rollback`；
- 控制中心切换后的人工回滚改为两阶段：当前 Active 目标先停止写入、进入 `rollback_exporting` 并导出最终加密快照、独立密钥和 SHA-256 manifest；
- 旧源只从固定 `rollback-inbox/<migration-id>` 读取三份文件，核对原部署身份、目标 generation、文件名、路径和哈希后恢复，并使用 `target generation + 1` 重新取得所有权；
- 回滚导入失败会恢复旧源导入前的 Fenced 快照并保持停止，不能直接删除 `source-fenced.json`，也不支持两台服务器同时写入；
- 修复 `APPGOG_RESTORE_NO_START=true` 在完整恢复分支未生效的问题，迁移可严格执行“恢复数据 → 更新所有权 → 健康启动”的顺序。

## 兼容与数据保护

- 数据库只向 `product_migration_grants` 追加候选、提交和回滚字段，旧迁机记录原样保留；
- 固定 License Key、套餐、绑定域名、Build、Package、Install Receipt、现有 Activation 签名和三类生产签名密钥保持不变；
- 控制中心迁移继续保留数据库、管理员、公告、设置、Key、上传、成品、工单、日志、备份、Caddy 状态和全部加密/签名身份；
- 源码、前端、后端、Docker 和安装器按 v1.2.16 完整覆盖，禁止清库、删卷或重新生成密钥解决升级；
- SQLite 最终切换仍需要短暂只读窗口，本版本不宣称完全零停机。

## 验证

- 回归覆盖 Candidate 不可刷新、提交后唯一 Active、窗口内回滚、窗口过期和 Challenge 重放拒绝；
- 回归覆盖控制中心回滚导出后目标 Fenced、导出取消恢复目标 Active、非 Fenced 快照拒绝和所有权代次必须递增；
- 回归覆盖旧产品迁机表向前增列且保留原记录；
- Linux 管理脚本检查固定 rollback inbox、SHA-256、禁止直接删除 fence、禁止 `down -v`，并验证恢复阶段可保持容器停止。
