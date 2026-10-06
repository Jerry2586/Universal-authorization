#!/usr/bin/env sh
# Shared with the optional security domain adapter. FD 8 survives nested sh calls.
appgog_ingress_lock() {
  [ "$(id -u)" = 0 ] || { echo '共享入口操作需要 root，请使用 sudo。' >&2; return 1; }
  command -v flock >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 || {
    echo '共享入口互斥需要 flock 和 Python3，请运行一键安装器补齐环境。' >&2; return 1;
  }
  python3 -I - "${APPGOG_INGRESS_LOCKED:-}" <<'PY'
import os, stat, sys
path = '/run/lock/appgog-ingress.lock'
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022:
        raise ValueError('入口锁不是 root 控制的普通文件')
    if sys.argv[1] == '8':
        held = os.fstat(8)
        if (held.st_dev, held.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError('继承的入口锁不匹配')
    elif sys.argv[1]:
        raise ValueError('入口锁标记无效')
finally:
    os.close(fd)
PY
  [ "$?" = 0 ] || { echo '共享入口锁校验失败。' >&2; return 1; }
  if [ "${APPGOG_INGRESS_LOCKED:-}" != 8 ]; then
    exec 8<>/run/lock/appgog-ingress.lock
  fi
  # Also checks that an inherited FD is actually flockable; never trust a marker alone.
  flock -n -x 8 || { echo 'APPGOG 或安全域名任务正在修改共享入口，请稍后重试。' >&2; return 1; }
  APPGOG_INGRESS_LOCKED=8
  export APPGOG_INGRESS_LOCKED
}
appgog_ingress_unlock() {
  unset APPGOG_INGRESS_LOCKED
  exec 8>&-
}
