#!/usr/bin/env sh
# Fixed local agent lifecycle. Never accepts remote commands or arbitrary scan targets.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
INSTALL_ROOT=${APPGOG_INSTALL_ROOT:-$SOURCE_DIR}
ENV_FILE=${APPGOG_HOST_ENV_FILE:-$SOURCE_DIR/.env}
AGENT_DIR=/usr/local/lib/appgog-security
AGENT_FILE=$AGENT_DIR/host-security-agent.py
UNIT=/etc/systemd/system/appgog-host-security.service
TMPFILES=/etc/tmpfiles.d/appgog-host-security.conf
STATE_DIR=/var/lib/appgog-security
RUNTIME_DIR=/run/appgog-security
GROUP=appgog-security
ACTION=${1:-install}
fail() { echo "本地安全代理：$*" >&2; exit 1; }
[ "$#" -le 1 ] || fail '只接受固定动作'
case "$ACTION" in prepare|install|uninstall|engine) ;; *) fail '用法：install-host-security.sh prepare|install|uninstall|engine' ;; esac
[ "$(id -u)" -eq 0 ] || fail '需要 root 或 sudo'
case "$INSTALL_ROOT" in /*) ;; *) fail '安装目录必须是绝对路径' ;; esac
printf '%s' "$INSTALL_ROOT" | LC_ALL=C grep -Eq '^/[A-Za-z0-9_./-]+$' || fail '安装目录含不支持的字符'
INSTALL_ROOT=$(CDPATH= cd -- "$INSTALL_ROOT" && pwd -P) || fail '安装目录不存在'
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || fail '需要运行中的 systemd；本机检测不可用'

safe_parents() {
  parent=$(dirname -- "$1")
  while :; do
    [ ! -L "$parent" ] && [ -d "$parent" ] && [ "$(stat -c %u "$parent")" = 0 ] || fail "不可信父目录：$parent"
    [ $(( $(stat -c %a "$parent") % 100 / 10 / 2 % 2 )) -eq 0 ] && [ $(( $(stat -c %a "$parent") % 10 / 2 % 2 )) -eq 0 ] || fail "父目录可被其他用户写入：$parent"
    [ "$parent" != / ] || break
    parent=$(dirname -- "$parent")
  done
}
safe_file() {
  [ ! -L "$1" ] && [ -f "$1" ] && [ "$(stat -c %u "$1")" = 0 ] || fail "不可信文件：$1"
  file_mode=$(stat -c %a "$1")
  case "$file_mode" in 600|644|700|755) ;; *) fail "不安全文件权限：$1" ;; esac
}
safe_directory() {
  target=$1; mode=$2; owner_group=$3
  safe_parents "$target"
  [ ! -L "$target" ] || fail "拒绝符号链接目录：$target"
  [ ! -e "$target" ] || { [ -d "$target" ] && [ "$(stat -c %u "$target")" = 0 ]; } || fail "目录类型或所有者异常：$target"
  install -d -o root -g "$owner_group" -m "$mode" "$target"
}
owned_unit() {
  safe_file "$UNIT"
  grep -Fxq '# APPGOG-HOST-SECURITY-MANAGED' "$UNIT" &&
    grep -Fxq "Environment=APPGOG_INSTALL_ROOT=$INSTALL_ROOT" "$UNIT"
}
validate_unit() {
  if [ -e "$UNIT" ] || [ -L "$UNIT" ]; then
    safe_file "$UNIT"
    if ! grep -Fxq '# APPGOG-HOST-SECURITY-MANAGED' "$UNIT"; then
      grep -Fxq "Environment=APPGOG_INSTALL_ROOT=$INSTALL_ROOT" "$UNIT" &&
        grep -Fxq "ExecStart=$(command -v python3) $AGENT_FILE" "$UNIT" || fail '旧服务归属不符'
    else owned_unit || fail '服务属于不同安装目录'; fi
  fi
  if [ -e "$TMPFILES" ] || [ -L "$TMPFILES" ]; then
    safe_file "$TMPFILES"
    grep -Eq '^d /run/appgog-security 0(700 root root|750 root appgog-security) -$' "$TMPFILES" || fail 'tmpfiles 归属不符'
  fi
}
safe_parents "$UNIT"
safe_parents "$TMPFILES"
validate_unit

if [ "$ACTION" = uninstall ]; then
  # Validate all removable artifacts before touching the running service.
  if [ -e "$AGENT_DIR" ] || [ -L "$AGENT_DIR" ]; then
    safe_parents "$AGENT_DIR"
    [ ! -L "$AGENT_DIR" ] && [ -d "$AGENT_DIR" ] && [ "$(stat -c %u "$AGENT_DIR")" = 0 ] || fail '代理目录归属异常'
    [ ! -e "$AGENT_FILE" ] || safe_file "$AGENT_FILE"
  fi
  [ ! -L "$RUNTIME_DIR" ] || fail '运行目录异常'
  if [ -e "$UNIT" ] || systemctl is-active --quiet appgog-host-security.service; then
    systemctl stop appgog-host-security.service
    systemctl is-active --quiet appgog-host-security.service && fail '代理仍在运行，停止卸载'
    systemctl disable appgog-host-security.service || true
  fi
  rm -f "$UNIT" "$TMPFILES" "$AGENT_FILE"
  if [ -S "$RUNTIME_DIR/scan.sock" ]; then rm -f "$RUNTIME_DIR/scan.sock"; fi
  systemctl daemon-reload
  echo '本地安全服务已停止；基线、告警、专用组和 GID 配置保留，便于重装沿用权限'
  exit 0
fi

if [ "$ACTION" = engine ]; then
  updater_active=''
  for candidate in clamav-freshclam.service freshclam.service clamav-freshclam-once.service; do
    if systemctl is-active --quiet "$candidate"; then updater_active="$updater_active $candidate"; fi
  done
  restore_updaters() { for service in $updater_active; do systemctl start "$service" || echo "特征库服务恢复失败：$service" >&2; done; }
  trap restore_updaters 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y clamav clamav-freshclam
  elif command -v dnf >/dev/null 2>&1; then dnf install -y clamav clamav-update
  elif command -v yum >/dev/null 2>&1; then yum install -y clamav clamav-update
  else fail '没有受支持的包管理器'; fi
  command -v clamscan >/dev/null 2>&1 && command -v freshclam >/dev/null 2>&1 || fail '发行版仓库未提供 ClamAV；不自动添加第三方软件源'
  for candidate in clamav-freshclam.service freshclam.service clamav-freshclam-once.service; do
    if systemctl is-active --quiet "$candidate"; then
      case " $updater_active " in *" $candidate "*) ;; *) updater_active="$updater_active $candidate" ;; esac
      systemctl stop "$candidate"
    fi
  done
  timeout 180 freshclam || fail '特征库下载失败；查杀结果仍为未知'
  scheduled=false
  for candidate in clamav-freshclam.service freshclam.service clamav-freshclam-once.timer freshclam.timer; do
    if [ "$(systemctl show -p LoadState --value "$candidate" 2>/dev/null)" = loaded ]; then
      systemctl enable --now "$candidate" && scheduled=true && break
    fi
  done
  [ "$scheduled" = true ] || fail '特征库已下载，但自动更新服务不可用；请配置发行版更新服务'
  echo 'ClamAV 引擎、特征库和自动更新已就绪；请重新执行本地检查'
  exit 0
fi

getent group "$GROUP" >/dev/null 2>&1 || groupadd --system "$GROUP"
group_row=$(getent group "$GROUP")
GROUP_ID=$(printf '%s\n' "$group_row" | cut -d: -f3)
printf '%s' "$GROUP_ID" | LC_ALL=C grep -Eq '^[1-9][0-9]{0,9}$' && [ "$GROUP_ID" -le 2147483647 ] || fail '专用组 GID 无效'
[ -z "$(printf '%s\n' "$group_row" | cut -d: -f4)" ] || fail '专用安全组含宿主用户，请先复核成员'
getent passwd | awk -F: -v gid="$GROUP_ID" '$4 == gid { found=1 } END { exit found ? 1 : 0 }' || fail '专用安全组被宿主用户作为主组使用'
[ -f "$ENV_FILE" ] || fail '配置文件不存在'
[ ! -L "$ENV_FILE" ] || fail '拒绝符号链接配置文件'
ENV_FILE=$(readlink -f -- "$ENV_FILE") || fail '无法解析配置文件'
case "$ENV_FILE" in "$INSTALL_ROOT/"*) ;; *) fail '配置文件超出安装目录' ;; esac
safe_parents "$ENV_FILE"
[ ! -L "$ENV_FILE" ] && [ -f "$ENV_FILE" ] && [ "$(stat -c %u "$ENV_FILE")" = 0 ] || fail '配置文件所有者异常'
chmod 600 "$ENV_FILE"
existing_gid=$(sed -n 's/^APPGOG_HOST_SECURITY_GID=//p' "$ENV_FILE" | tail -n 1)
[ -z "$existing_gid" ] || [ "$existing_gid" = "$GROUP_ID" ] || fail '现有安全组配置与本机不符'
if [ -z "$existing_gid" ]; then printf '\nAPPGOG_HOST_SECURITY_GID=%s\n' "$GROUP_ID" >> "$ENV_FILE"; fi
safe_directory "$RUNTIME_DIR" 0750 "$GROUP"
[ "$ACTION" != prepare ] || exit 0

if ! command -v python3 >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3
  elif command -v dnf >/dev/null 2>&1; then dnf install -y python3
  elif command -v yum >/dev/null 2>&1; then yum install -y python3
  else fail '无法安装 Python3'; fi
fi
# Complete the engine on first installation; unavailable package repositories
# must leave the business running with an explicit unavailable scan result.
if ! command -v clamscan >/dev/null 2>&1 || { [ ! -f /var/lib/clamav/daily.cvd ] && [ ! -f /var/lib/clamav/daily.cld ]; }; then
  sh "$SOURCE_DIR/scripts/install-host-security.sh" engine || echo '病毒引擎或特征库未就绪：文件/配置检测继续，病毒检查显示不可用；可从菜单重试安装' >&2
fi
safe_directory "$AGENT_DIR" 0700 root
safe_directory "$STATE_DIR" 0700 root
safe_parents "$SOURCE_DIR/scripts/host-security-agent.py"
safe_file "$SOURCE_DIR/scripts/host-security-agent.py"
# Restore the previous executable/unit/updater definition if activation fails.
for file in "$AGENT_FILE" "$UNIT" "$TMPFILES"; do
  if [ -e "$file" ] || [ -L "$file" ]; then safe_file "$file"; fi
done
transaction=$(mktemp -d "$AGENT_DIR/.install.XXXXXX")
old_active=false; old_enabled=false; committed=false
systemctl is-active --quiet appgog-host-security.service && old_active=true
systemctl is-enabled --quiet appgog-host-security.service && old_enabled=true
for file in "$AGENT_FILE" "$UNIT" "$TMPFILES"; do
  if [ -e "$file" ] || [ -L "$file" ]; then
    cp -p "$file" "$transaction/$(basename "$file").old" || { rm -f "$transaction/"*.old; rmdir "$transaction"; fail '原代理备份失败'; }
  fi
done
cleanup() {
  result=$?
  trap - 0 INT TERM
  if [ "$committed" != true ]; then
    systemctl stop appgog-host-security.service || true
    for file in "$AGENT_FILE" "$UNIT" "$TMPFILES"; do
      backup="$transaction/$(basename "$file").old"
      if [ -f "$backup" ]; then
        cp -p "$backup" "$file" || echo "原文件恢复失败：$file" >&2
      else rm -f "$file" || echo "新文件清理失败：$file" >&2; fi
    done
    systemctl daemon-reload || true
    if [ "$old_enabled" = true ]; then systemctl enable appgog-host-security.service >/dev/null || true
    else systemctl disable appgog-host-security.service >/dev/null 2>&1 || true; fi
    if [ "$old_active" = true ]; then systemctl restart appgog-host-security.service || echo '旧代理恢复失败，请查看 journalctl' >&2; fi
    echo '本地安全代理激活失败，已尝试恢复原服务；保留环境补齐、安全组、GID 配置与基线' >&2
  fi
  rm -f "$transaction/host-security-agent.py.old" "$transaction/appgog-host-security.service.old" "$transaction/appgog-host-security.conf.old" "$transaction/agent.new" "$transaction/unit.new"
  rmdir "$transaction" || true
  exit "$result"
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM
agent_temp=$transaction/agent.new
install -o root -g root -m 0700 "$SOURCE_DIR/scripts/host-security-agent.py" "$agent_temp"
python_bin=/usr/bin/python3
[ -x "$python_bin" ] || fail '缺少系统 Python3'
safe_parents "$(readlink -f "$python_bin")"
safe_file "$(readlink -f "$python_bin")"
"$python_bin" -I -c 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())' "$agent_temp"
mv -f "$agent_temp" "$AGENT_FILE"
unit_temp=$transaction/unit.new
cat > "$unit_temp" <<EOF
# APPGOG-HOST-SECURITY-MANAGED
[Unit]
Description=APPGOG local host security inspection
After=local-fs.target docker.service

[Service]
Type=simple
ExecStart=$python_bin -I $AGENT_FILE
Environment=APPGOG_INSTALL_ROOT=$INSTALL_ROOT
Environment=APPGOG_HOST_SCAN_SOCKET=$RUNTIME_DIR/scan.sock
Environment=APPGOG_HOST_SECURITY_GID=$GROUP_ID
Environment=PYTHONDONTWRITEBYTECODE=1
User=root
ReadWritePaths=$RUNTIME_DIR $STATE_DIR
CPUQuota=80%
MemoryMax=2G
TasksMax=32
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$unit_temp"
mv -f "$unit_temp" "$UNIT"
printf 'd %s 0750 root %s -\n' "$RUNTIME_DIR" "$GROUP" > "$TMPFILES"
chmod 644 "$TMPFILES"
systemctl daemon-reload
systemctl enable appgog-host-security.service >/dev/null
if [ ! -e "$STATE_DIR/baseline.json" ] && [ ! -L "$STATE_DIR/baseline.json" ]; then
  APPGOG_INSTALL_ROOT="$INSTALL_ROOT" "$python_bin" -I "$AGENT_FILE" --write-baseline || echo '首次程序基线失败；检查结果为不可用' >&2
else echo '保留程序基线；升级差异须在可信版本核验后由 root 批准'; fi
if [ ! -e "$STATE_DIR/host-baseline.json" ] && [ ! -L "$STATE_DIR/host-baseline.json" ]; then
  APPGOG_INSTALL_ROOT="$INSTALL_ROOT" "$python_bin" -I "$AGENT_FILE" --write-host-baseline || echo '首次主机配置基线失败；检查结果为不可用' >&2
else echo '保留主机基线；不自动批准新增账户、端口或持久化配置'; fi
systemctl restart appgog-host-security.service
systemctl is-active --quiet appgog-host-security.service || fail '服务未启动'
attempt=0
while [ "$attempt" -lt 10 ]; do
  if [ -S "$RUNTIME_DIR/scan.sock" ] && [ "$(stat -c '%u:%g:%a' "$RUNTIME_DIR/scan.sock")" = "0:$GROUP_ID:660" ]; then
    committed=true
    echo '本地代理已启动；扫描结论请查看后台或 appgog security-local status'
    exit 0
  fi
  attempt=$((attempt + 1)); sleep 1
done
fail '代理 socket 未就绪或权限不符'
