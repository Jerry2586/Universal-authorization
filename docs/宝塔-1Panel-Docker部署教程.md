# APPGOG Docker 一体部署教程

默认安装是一套代码、一份 Compose、两个域名。Docker 内包含 Node.js 24、SQLite、授权中心、打包中心和构建 Worker，不需要在宿主机安装 Node.js、npm、MySQL 或手工生成业务密钥。SQLite 数据库首次启动自动创建；这不是演示模式。

## 最快方式：Linux 一行安装

全新服务器可以跳过手工安装 Docker、上传源码和复制 `.env` 的步骤，直接执行：

```sh
curl -fsSL https://raw.githubusercontent.com/Jerry2586/Universal-authorization/main/scripts/install-linux.sh | sudo sh -s -- \
  --auth-domain sq.example.com \
  --build-domain db.example.com
```

脚本支持 Debian、Ubuntu、CentOS、RHEL、Rocky Linux、AlmaLinux 和 Fedora。它会安装 Docker Engine 与 Compose v2、下载代码到 `/opt/appgog/APPGOG-CMS`、启动服务，并安装全局管理命令。执行 `appgog` 即可打开专业管理菜单；执行 `appgog help` 查看所有非交互命令。

为了不破坏面板和已有网站，脚本不会接管 80/443、不会修改 DNS 或自动写入 Nginx/OpenResty。安装完成后继续阅读本文第 4 节，为两个域名配置 HTTPS 反向代理。

## 1. 准备服务器和项目

在宝塔 / aaPanel / 1Panel 安装 Docker，确保终端能执行以下两条命令。需要 Docker Compose v2.24.0 或更新版本（支持可选 env_file）。

```sh
docker --version
docker compose version
```

把 CMS ZIP 解压到 /opt/appgog/APPGOG-CMS，确认该目录里能看到 compose.yaml、Dockerfile、scripts。不要放在公开网站根目录。也可以将已授权访问的私有 Git 仓库克隆到这个目录；GitHub 登录是源码下载权限，与系统后台账号无关。

下面所有命令均在该目录执行：

```sh
cd /opt/appgog/APPGOG-CMS
```

## 2. 只填写两个域名

**全新安装**时复制配置：

```sh
cp .env.docker.example .env
```

用面板文件编辑器打开 .env，把内容改成自己的两个真实域名。例如：

```dotenv
AUTH_DOMAIN=sq.appgog.top
BUILD_DOMAIN=db.appgog.top
```

不用填写管理员密码、数据库密码、内部 Token 或签名密钥；首次初始化自动生成并保存。域名不要带 /admin、/build 等路径。两个域名的 DNS A 记录指向本服务器 IPv4 地址；有 AAAA 记录时 IPv6 也必须正确。

**已有安装不要执行 cp 覆盖原 .env**，先看本文的“旧部署升级”。

## 3. 一条命令启动

```sh
sh scripts/docker.sh install
```

脚本构建镜像、运行一次性初始化、启动服务并等待健康检查。首次需要联网下载 Node 基础镜像；构建失败时检查服务器访问镜像仓库的网络。

```sh
sh scripts/docker.sh status
sh scripts/docker.sh credentials
```

credentials 显示初始管理员账号和随机密码，默认账号 admin。请私密保存，登录后在后台修改密码；修改后该文件仍是初始记录，不是重置密码功能。

正常状态：initialize 为 Exited (0)，license-center 和 build-center 为 healthy，build-worker 为运行中。initialize 是一次性任务，正常退出不表示故障。Worker 是否真正能打包，还可以通过上传主题并创建任务检查。

## 4. 面板绑定两个域名与 HTTPS

在宝塔 / aaPanel 中创建两个反向代理站点，或在已有两个空白站点中添加反代：

| 站点域名 | 反向代理目标 | 最终入口 |
| --- | --- | --- |
| 授权域名，例如 sq.appgog.top | http://127.0.0.1:8787 | https://sq.appgog.top/admin |
| 打包域名，例如 db.appgog.top | http://127.0.0.1:8788 | https://db.appgog.top/build |

对整个站点 / 反代，代理目标不用追加 /admin 或 /build。两个站点分别申请并启用 SSL 证书，启用 HTTPS。保留真实 Host、X-Forwarded-For 和 X-Forwarded-Proto，请勿缓存后台/API 响应。

Nginx 站点配置建议：

```nginx
client_max_body_size 140m;
# 以下指令放进面板现有的 location / 中，不要重复创建 location /
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 300s;
```

应用默认接收最多 128 MiB 的主题 ZIP。DNS、证书和反代只需首次配置一次；日常代码更新不需要重配。

**1Panel**：同样创建两个反向代理网站并申请证书。如果 OpenResty 使用 host 网络模式，直接使用上表的 127.0.0.1。若它运行在独立 Docker bridge 网络里，127.0.0.1 指向 OpenResty 自己，此时应把它接入本项目网络，再用服务名反代：

```sh
# 先在 1Panel 容器列表确认 OpenResty 的真实容器名称
# 将下方 OPENRESTY_CONTAINER 替换为这个名称
docker network connect appgog_default OPENRESTY_CONTAINER
```

对应目标改为 http://license-center:8787 和 http://build-center:8788。将此网络设置同时保存在 OpenResty 的编排配置中，避免它重建后丢失。使用自定义 APPGOG_PROJECT 时网络前缀跟随项目名改变。默认业务端口仅绑定宿主机回环地址，不需要对公网开放 8787/8788。

纯 Linux 服务器也使用相同的 Compose；自行用已有 Nginx / Caddy 配置这两个反代和证书。该安装包不接管面板占用的 80/443，也不自动修改 DNS。

## 5. 日常使用

管理员登录授权域名 /admin，上传真实主题版本、管理用户与授权。客户只在打包域名 /build 输入固定授权 Key，选择版本和绑定域名后打包。首次部署不会自动创建演示客户或演示 Key。

使用一键安装器后，日常管理直接运行：

```sh
appgog
```

菜单包含状态、启动、停止、重启、日志、域名配置保存、初始凭证、更新、备份、恢复和诊断。域名修改时会先备份原 `.env`，更新前会创建完整业务备份。也可直接执行 `appgog status`、`appgog logs build-worker`、`appgog backup` 或 `appgog doctor`。

## 6. 以后覆盖更新

先把新版本代码覆盖到**原项目目录**，保留 .env 和 backups 文件夹，然后执行：

```sh
sh scripts/docker.sh update
```

使用 Git 管理源码时可以先 git pull --ff-only，再执行同一条更新命令。代码构建成功后，脚本短暂停止业务写入并生成完整备份，再重建容器、检查健康。构建失败不会先停止原服务。

数据和密钥在持久化卷中，覆盖源码或重建容器不会主动清空它们。保持项目名 appgog；不要换成另一个 Compose 项目，也不要删除数据卷或执行 docker compose down -v。仅执行 docker compose restart 不会更新镜像或重新加载初始化配置，请使用上述脚本。

当前交付使用**源码构建镜像**，不是已发布到镜像仓库的自动拉取版本，因此不能只执行 docker compose pull 就期待拿到新代码。升级有短暂停机，不宣称零停机。

更换域名时修改 .env，并配置对应 DNS、证书、反代，再执行 update。已有客户安装包包含原授权服务地址：有在用客户时应保留旧域名转发服务，或另行安排客户端迁移，单改平台配置不会改写已发出的安装包。

## 7. 完整备份

```sh
sh scripts/docker.sh backup
```

文件生成在 backups/appgog-时间-进程号.tar.gz，包含数据库（含 WAL）、签名公私钥、内部凭证、初始账号记录、主题源码、构建成品和上传文件。备份期间短暂停止写入，结束后恢复原来正在运行的服务。

**备份包含私钥和凭证，文件没有额外加密，请只存放到你控制的私密存储中。** 同时保存本次代码版本/ZIP 和 .env，便于按同一版本恢复。不要只备份 SQLite，否则会丢失签名身份和解密资料。

## 8. 换服务器迁移 / 从备份恢复

新服务器安装 Docker、上传同一版本代码和备份。复制 .env.docker.example 为 .env，填两个域名。**先恢复，不要先执行 install**：

```sh
cd /opt/appgog/APPGOG-CMS
sh scripts/docker.sh restore /绝对路径/appgog-备份.tar.gz
```

脚本只向空的数据卷恢复；已有运行中服务或非空目标目录时拒绝覆盖。恢复完自动启动并使用新 .env 的域名。随后切换 DNS，配置反代和证书。迁移时优先保留原域名，以便已安装的客户主题继续找到授权中心。切流前停止旧服务器写入，避免两边数据各自变化。

恢复备份会将业务恢复到备份时刻。代码回滚不等于数据库回滚；不保证旧代码兼容升级后的数据库结构。需要回退时在新空项目恢复升级前备份并使用对应代码版本，验证后再切换反代。

## 9. 已有旧 Docker 部署升级

新 compose.yaml 保留 appgog-db、appgog-keys、appgog-artifacts、appgog-uploads 四个逻辑卷名，并增加三个服务配置卷。升级前保存原 .env、原 compose.production.yaml（若有）、原代码版本，以及旧数据库/密钥/文件卷的完整备份。

确认旧 Compose 项目名是 appgog，且挂载的是这四个卷；原先用 appgog-data 单卷或自定义卷路径的安装需要先安排数据搬迁，不能直接套用。不要删除旧卷来消除初始化错误。

保留旧 .env 的所有原始秘密值与管理员配置；可以追加 AUTH_DOMAIN、BUILD_DOMAIN，也可继续使用原 PUBLIC_BASE_URL、BUILD_CENTER_PUBLIC_URL。首次启动会校验原签名密钥，并将原凭证导入新配置卷。发现旧数据但缺少原凭证时主动停止，不会生成新密钥破坏原授权。

在原项目目录执行 sh scripts/docker.sh install 完成首次转换；之后统一用 update。保留的 compose.legacy.yaml 仅供旧版手工部署参考，不与新版同时启动。使用过独立节点、外部数据库或自定义挂载的安装应单独核对后迁移。

## 10. 排查故障

```sh
sh scripts/docker.sh status
docker compose logs --tail=100 initialize
docker compose logs --tail=100 license-center build-center build-worker
```

- 初始化退出非零：检查域名是否仍是示例、原密钥是否缺失、旧 .env 是否完整；不要删除数据重试。
- 502：先看服务健康，再核对反代目标与 OpenResty 网络模式。
- 登录失败：新安装用 credentials 查看初始密码；改过密码用新密码。
- 上传 413：检查面板站点 client_max_body_size 和应用上传限制。
- 任务一直排队：检查 build-worker 的运行状态和错误日志。
- 宿主机磁盘满：清理无用的旧备份/镜像并扩容，保留正在使用的数据卷。

高级容量或有效期设置可在 .env 添加 MAX_SOURCE_UPLOAD_BYTES、OFFLINE_GRACE_SECONDS、ACTIVATION_TOKEN_TTL_SECONDS、BUILD_TICKET_TTL_SECONDS、WEB_SESSION_TTL_SECONDS，必须为正整数。显式设置后会保存在配置卷中；之后删掉 .env 对应行会继续沿用已保存值，要恢复默认请填写所需默认值再 update。密钥以首次初始化保存的身份为准，不支持靠修改 .env 静默轮换。
