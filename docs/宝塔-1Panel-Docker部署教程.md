# APPGOG 授权系统部署教程

更新日期：2026-09-23。

本文适用于当前仓库的单机三服务版本，包含三种部署入口：

- 纯 Docker Compose；
- 宝塔面板；
- 1Panel。

三种方式最终运行的业务完全相同：

```text
授权管理域名 auth.example.com
  → license-center:8787

客户打包域名 build.example.com
  → build-center:8788

build-worker
  → 在服务器内部领取任务并生成 ZIP
```

建议至少准备：

- 一台 64 位 Linux 服务器，推荐 Ubuntu 22.04/24.04 或 Debian 12；
- 2 核 CPU、2 GB 内存、20 GB 可用磁盘起步；
- 两个已经解析到服务器公网 IP 的域名；
- Docker Engine 和 Docker Compose V2；
- 能申请受信任 HTTPS 证书的 80、443 端口。

示例域名：

```text
授权中心：admin.example.com
客户打包中心：build.example.com
```

请把示例域名替换成你自己的域名。

## 一、部署前必须知道的规则

### 1. 必须区分两个网站入口

- `https://admin.example.com/admin`：卖家管理后台；
- `https://build.example.com/build`：客户固定 Key 登录和打包中心；
- `https://admin.example.com`：同时也是安装后主题访问的授权 API 地址。

对应 `.env`：

```dotenv
PUBLIC_BASE_URL=https://admin.example.com
BUILD_CENTER_PUBLIC_URL=https://build.example.com/build
```

`PUBLIC_BASE_URL` 不要填写 `/admin`，`BUILD_CENTER_PUBLIC_URL` 需要保留 `/build`。

### 2. 不要公开运行数据

以下内容不能放进网站公开目录、下载目录或 Git：

- `.env`；
- SQLite 数据库；
- Ed25519 签名私钥；
- 构建成品和上传的主题包；
- Docker 数据卷备份。

### 3. 四个数据卷都要备份

当前 Compose 使用：

- `appgog-db`：授权、管理员、版本和激活记录；
- `appgog-keys`：Ed25519 签名私钥和公钥；
- `appgog-artifacts`：上传源码包和客户构建成品；
- `appgog-uploads`：上传临时文件。

数据库和签名私钥必须一起保留。丢失签名私钥后，旧激活凭证无法继续由原身份签发。

### 4. 禁止执行的数据删除命令

正常停止使用：

```bash
docker compose down
```

不要执行：

```bash
docker compose down -v
```

`-v` 会删除数据库、签名密钥和构建成品卷。

## 二、公共安装步骤

无论使用宝塔、1Panel 还是纯 Docker，都先把项目放在固定目录。

```bash
sudo mkdir -p /opt/appgog
sudo chown -R "$USER":"$USER" /opt/appgog
git clone https://github.com/Jerry2586/Universal-authorization.git /opt/appgog
cd /opt/appgog
```

如果目录已经存在并且是本项目：

```bash
cd /opt/appgog
git pull --ff-only
```

不要把项目直接放在宝塔或 1Panel 的公开静态网站目录中。推荐统一放在 `/opt/appgog`。

## 三、纯 Docker Compose 部署

### 第 1 步：安装 Docker

如果服务器已经能正常执行下面两个命令，可以跳过安装：

```bash
docker version
docker compose version
```

Ubuntu 建议使用 Docker 官方仓库安装 Docker Engine、Buildx 和 Compose 插件。安装完成后验证：

```bash
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker compose version
```

### 第 2 步：生成配置并首次启动

项目脚本会生成独立随机 Token、管理员密码和 `.env`：

```bash
cd /opt/appgog
chmod +x scripts/install-linux.sh
./scripts/install-linux.sh
```

终端会显示管理员账号和随机密码。请立即保存密码。

脚本只在 `.env` 不存在时生成配置；已经存在的 `.env` 不会被覆盖。

### 第 3 步：改成正式生产配置

编辑配置：

```bash
nano /opt/appgog/.env
```

至少修改：

```dotenv
NODE_ENV=production
LICENSE_PORT=8787
BUILD_PORT=8788
ADMIN_USERNAME=admin
ADMIN_PASSWORD=脚本生成的管理员密码
PUBLIC_BASE_URL=https://admin.example.com
BUILD_CENTER_PUBLIC_URL=https://build.example.com/build
```

以下值必须保持为脚本生成的独立随机值，不能改成示例文字，也不能让多个变量使用相同值：

```dotenv
KEY_HASH_PEPPER=...
ADMIN_TOKEN=...
WORKER_TOKEN=...
SESSION_SECRET=...
DELIVERY_ENCRYPTION_KEY=...
INTERNAL_SERVICE_TOKEN=...
```

限制 `.env` 权限：

```bash
chmod 600 /opt/appgog/.env
```

重新构建并启动：

```bash
cd /opt/appgog
docker compose up -d --build
docker compose ps
```

三个服务应当处于运行状态，授权中心和打包中心最终应显示 healthy。

### 第 4 步：检查本机服务

```bash
curl -i http://127.0.0.1:8787/health
curl -i http://127.0.0.1:8788/health
```

正常响应包含：

```json
{"ok":true}
```

### 第 5 步：配置 Nginx 双域名代理

授权中心站点：

```nginx
server {
    listen 80;
    server_name admin.example.com;

    client_max_body_size 150m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
```

客户打包站点：

```nginx
server {
    listen 80;
    server_name build.example.com;

    client_max_body_size 150m;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
```

配置完成后为两个域名申请 HTTPS 证书，并设置 HTTP 自动跳转 HTTPS。

### 第 6 步：最终验收

浏览器访问：

```text
https://admin.example.com/admin
https://build.example.com/build
```

终端检查：

```bash
curl -i https://admin.example.com/health
curl -i https://build.example.com/health
```

不要把 8787、8788 加入云服务器公网安全组。公网只开放 80、443 和你需要的 SSH/面板管理端口。

## 四、宝塔面板部署

宝塔方式仍然使用项目自带的 Docker Compose。宝塔负责文件管理、Docker 管理、Nginx 反向代理和证书。

### 第 1 步：准备环境

1. 登录宝塔面板。
2. 在软件商店安装 Docker 管理器或确认服务器 Docker 已安装。
3. 安装 Nginx。
4. 在宝塔终端执行：

```bash
docker version
docker compose version
```

两个命令都成功后继续。

### 第 2 步：拉取项目

在宝塔终端执行：

```bash
sudo mkdir -p /opt/appgog
sudo chown -R "$USER":"$USER" /opt/appgog
git clone https://github.com/Jerry2586/Universal-authorization.git /opt/appgog
cd /opt/appgog
chmod +x scripts/install-linux.sh
./scripts/install-linux.sh
```

保存脚本输出的管理员密码。

如果服务器无法访问 GitHub，可以在本地下载仓库 ZIP，通过宝塔文件管理上传到 `/opt/appgog` 并解压，然后执行安装脚本。

### 第 3 步：修改 `.env`

通过宝塔文件管理编辑 `/opt/appgog/.env`：

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://admin.example.com
BUILD_CENTER_PUBLIC_URL=https://build.example.com/build
```

其他随机密钥保持不变。保存后在终端执行：

```bash
cd /opt/appgog
chmod 600 .env
docker compose up -d --build
docker compose ps
```

### 第 4 步：创建授权中心网站

1. 宝塔左侧进入“网站”。
2. 添加站点，域名填写 `admin.example.com`。
3. 不需要 PHP 和数据库。
4. 为该站点添加反向代理：
   - 代理名称：`appgog-license`；
   - 目标 URL：`http://127.0.0.1:8787`；
   - 发送域名：`$host`。
5. 在站点配置中把上传限制调整到至少 `150m`。
6. 申请 Let's Encrypt 证书并开启强制 HTTPS。

### 第 5 步：创建客户打包网站

1. 再添加站点，域名填写 `build.example.com`。
2. 添加反向代理：
   - 代理名称：`appgog-build`；
   - 目标 URL：`http://127.0.0.1:8788`；
   - 发送域名：`$host`。
3. 上传限制调整到至少 `150m`。
4. 申请证书并开启强制 HTTPS。

### 第 6 步：宝塔防火墙

允许公网访问：

- 80；
- 443；
- 宝塔面板端口；
- SSH 端口。

不要对公网开放：

- 8787；
- 8788。

如果云厂商还有安全组，也需要在云安全组中执行相同限制。

### 第 7 步：宝塔验收

```bash
cd /opt/appgog
docker compose ps
docker compose logs --tail=100 license-center
docker compose logs --tail=100 build-center
docker compose logs --tail=100 build-worker
```

然后分别访问管理后台和打包中心。

## 五、1Panel 部署

1Panel 推荐使用“容器 → 编排 → 路径选择”导入仓库中的 `compose.yaml`。

### 第 1 步：安装 Docker

进入 1Panel 的“容器”页面。如果提示 Docker 未安装或未运行，先按面板提示安装并启动 Docker。

在服务器终端确认：

```bash
docker version
docker compose version
```

### 第 2 步：拉取项目并生成 `.env`

在 1Panel 终端执行：

```bash
sudo mkdir -p /opt/appgog
sudo chown -R "$USER":"$USER" /opt/appgog
git clone https://github.com/Jerry2586/Universal-authorization.git /opt/appgog
cd /opt/appgog
chmod +x scripts/install-linux.sh
./scripts/install-linux.sh
```

保存管理员密码，然后修改 `/opt/appgog/.env`：

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://admin.example.com
BUILD_CENTER_PUBLIC_URL=https://build.example.com/build
```

执行：

```bash
chmod 600 /opt/appgog/.env
```

### 第 3 步：在 1Panel 导入编排

1. 打开“容器”。
2. 进入“编排”。
3. 点击“创建编排”。
4. 选择“路径选择”。
5. 选择 `/opt/appgog/compose.yaml`。
6. 编排名称填写 `appgog`。
7. 创建并启动。

如果编排已经由安装脚本启动，1Panel 可能把它识别为 Local Compose；这种情况可以直接在终端继续用 `docker compose` 管理，不需要重复创建第二套容器。

检查容器状态：

```bash
cd /opt/appgog
docker compose ps
```

### 第 4 步：创建两个反向代理网站

在 1Panel 的“网站”中创建两个“反向代理”网站。

第一个网站：

```text
主域名：admin.example.com
代理地址：http://127.0.0.1:8787
```

第二个网站：

```text
主域名：build.example.com
代理地址：http://127.0.0.1:8788
```

分别为两个网站：

1. 申请 ACME/Let's Encrypt 证书；
2. 开启 HTTPS；
3. 开启 HTTP 跳转 HTTPS；
4. 将请求体大小限制设置为至少 150 MB；
5. 保留 Host、X-Real-IP、X-Forwarded-For 和 X-Forwarded-Proto 请求头。

### 第 5 步：1Panel 防火墙

只放行 80、443、SSH 和 1Panel 管理端口。不要放行 8787、8788。

## 六、首次使用流程

1. 打开 `https://admin.example.com/admin`。
2. 使用 `.env` 中的 `ADMIN_USERNAME` 和首次生成的管理员密码登录。
3. 上传一个可以直接安装到 Xboard 的主题 ZIP 并发布版本。
4. 创建客户授权，填写客户编号、域名、更新期限和构建额度。
5. 保存只显示一次的长期固定 License Key。
6. 客户访问 `https://build.example.com/build`。
7. 客户输入固定 Key，选择版本并创建构建。
8. 构建完成后保存一次性 Install Key 并下载 ZIP。
9. 安装主题，在激活页输入固定 Key、Install Key 和 Xboard 后台地址。

## 七、日常更新

更新前先备份，然后执行：

```bash
cd /opt/appgog
git pull --ff-only
docker compose up -d --build
docker compose ps
```

查看日志：

```bash
docker compose logs -f --tail=200
```

只查看一个服务：

```bash
docker compose logs -f --tail=200 license-center
docker compose logs -f --tail=200 build-center
docker compose logs -f --tail=200 build-worker
```

## 八、数据备份

先查看真实卷名：

```bash
docker volume ls | grep appgog
```

默认项目名为 `appgog`，Docker 卷通常显示为：

```text
appgog_appgog-db
appgog_appgog-keys
appgog_appgog-artifacts
appgog_appgog-uploads
```

创建备份目录：

```bash
BACKUP_DIR="/opt/appgog-backups/$(date +%Y%m%d-%H%M%S)"
sudo mkdir -p "$BACKUP_DIR"
sudo cp /opt/appgog/.env "$BACKUP_DIR/appgog.env"
```

建议在业务低峰期短暂停止服务后备份 SQLite：

```bash
cd /opt/appgog
docker compose down

docker run --rm -v appgog_appgog-db:/source:ro -v "$BACKUP_DIR":/backup alpine \
  sh -c 'cd /source && tar czf /backup/database.tar.gz .'

docker run --rm -v appgog_appgog-keys:/source:ro -v "$BACKUP_DIR":/backup alpine \
  sh -c 'cd /source && tar czf /backup/signing-keys.tar.gz .'

docker run --rm -v appgog_appgog-artifacts:/source:ro -v "$BACKUP_DIR":/backup alpine \
  sh -c 'cd /source && tar czf /backup/artifacts.tar.gz .'

docker run --rm -v appgog_appgog-uploads:/source:ro -v "$BACKUP_DIR":/backup alpine \
  sh -c 'cd /source && tar czf /backup/uploads.tar.gz .'

docker compose up -d
```

限制备份权限：

```bash
sudo chmod -R go-rwx "$BACKUP_DIR"
```

再把备份复制到另一台服务器或离线存储。只保存在原服务器上不算完整备份。

## 九、常见问题

### 1. 生产模式启动报 HTTPS 错误

检查：

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://admin.example.com
BUILD_CENTER_PUBLIC_URL=https://build.example.com/build
```

两个地址都必须是 HTTPS。

### 2. 页面显示 502 Bad Gateway

检查容器和本机端口：

```bash
cd /opt/appgog
docker compose ps
curl -i http://127.0.0.1:8787/health
curl -i http://127.0.0.1:8788/health
```

如果本机健康检查正常，问题通常在反向代理目标地址、防火墙或 Nginx 配置。

### 3. 上传主题显示 413

将宝塔、1Panel 或 Nginx 的请求体限制调整到至少：

```nginx
client_max_body_size 150m;
```

项目默认 ZIP 上限为 128 MB。

### 4. 打包中心登录后无法创建任务

查看：

```bash
docker compose logs --tail=200 build-center
docker compose logs --tail=200 license-center
```

确认三个容器使用同一个 `.env` 中的 `INTERNAL_SERVICE_TOKEN`，不要在面板中单独改成不同值。

### 5. Worker 不构建

```bash
docker compose logs --tail=200 build-worker
```

确认：

- `build-worker` 正在运行；
- `WORKER_TOKEN` 没有被单独修改；
- `appgog-artifacts` 卷可以正常挂载；
- 服务器磁盘空间充足。

### 6. 修改 `.env` 管理员密码后仍无法登录

管理员首次创建后保存在数据库中。仅修改 `.env` 不会自动修改已经存在的管理员密码。请使用后台管理员管理流程；如果是刚安装且没有业务数据，可以删除并重新初始化数据库卷，但这会永久删除全部授权数据，不应在有业务数据时操作。

### 7. 重启后数据不见了

先检查是否执行过 `docker compose down -v`，以及 Compose 项目名或数据卷名是否发生变化：

```bash
docker volume ls | grep appgog
docker compose config
```

不要直接创建一套同名但指向新空卷的 Compose。

## 十、正式上线检查清单

- [ ] 两个域名均解析到当前服务器；
- [ ] 两个域名均启用受信任 HTTPS 证书；
- [ ] `.env` 中 `NODE_ENV=production`；
- [ ] `PUBLIC_BASE_URL` 是授权中心 HTTPS 根地址；
- [ ] `BUILD_CENTER_PUBLIC_URL` 是打包中心 HTTPS `/build` 地址；
- [ ] 所有 Token 均为独立随机值且长度至少 32 字符；
- [ ] 管理员密码已单独保存；
- [ ] 公网没有开放 8787、8788；
- [ ] `.env` 权限为 600；
- [ ] 四个 Docker 数据卷已设置定期备份；
- [ ] 备份已复制到另一台设备或离线存储；
- [ ] 管理后台和客户打包中心均通过真实域名测试；
- [ ] 使用测试授权完成过上传、打包、下载和激活闭环。
