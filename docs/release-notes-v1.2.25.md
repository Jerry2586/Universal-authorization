# APPGOG打包授权系统 v1.2.25

发布日期：2026-09-25

## 本次更新

- 修复 Xboard 主题管理入口 `editor.html` 未注入授权运行时，导致后台可先于激活流程打开的问题；首页、主题后台和 Blade 面板现在使用同一授权门。
- 安装域名与签名包域名不一致时，界面明确显示当前域名、打包绑定域名和换绑重建要求，不再误报为普通文件损坏。
- 客户业务 JavaScript 在 Worker 内通过 Terser 与 JavaScript Obfuscator 执行语法级压缩、按包种子十六进制标识符混淆、字符串数组编码、注释与 Source Map 清理；CSS 清理普通注释并压缩空白。无法安全解析的 JavaScript 会阻止构建，不会回退输出明文。
- 每包水印、随机保护路径、AES-256-GCM 包身份、Ed25519 签名、逐文件摘要、Package Secret HMAC 与 Xboard 服务端授权桥继续同时生效。
- 发布合同新增锁定的 pnpm 版本和 `pnpm-lock.yaml`，Docker 与 CI 使用同一依赖树构建。

## 修复对应的生产现象

- 旧包的 `editor.html` 没有运行时标签，因此打开 `https://站点/theme/APPGOG/editor.html` 时不会出现 Install Key / License Key 激活门。
- 已检查的旧客户包绑定域名为 `baidu.com`，实际安装域名为 `appgog.com`；两者不一致时必须先换绑并重新构建客户专属 ZIP，不能绕过域名授权。

## 兼容性与安全边界

- 未修改固定 License Key、一次性 Install Key、60 分钟窗口、域名换绑、Installation ID、离线授权、暂停、恢复、撤销、删除和迁移状态机。
- HTML、Blade 和浏览器静态文件无法在客户端实现不可逆保密；本版本提供可执行兼容的混淆和完整性保护，真正的授权判定与秘密继续保留在服务端。
