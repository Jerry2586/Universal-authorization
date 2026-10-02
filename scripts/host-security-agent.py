#!/usr/bin/env python3
"""Fixed-scope, read-only Linux posture checks exposed on a local Unix socket."""
import hashlib
import json
import os
import socketserver
import stat
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path

# Installed as a root-owned module; the web container receives only the fixed scan socket.
sys.path.insert(0, str(Path(__file__).parent))
from host_posture_checks import (approve_host_baseline, backup_check, config_check,
                                 container_check, inventory_check, ports_check,
                                 ssh_check, write_posture_baseline)

SOCKET = os.environ.get('APPGOG_HOST_SCAN_SOCKET', '/run/appgog-security/scan.sock')
ROOT = Path(os.environ.get('APPGOG_INSTALL_ROOT', '/opt/appgog')).resolve()
BASELINE = Path('/var/lib/appgog-security/baseline.json')
SCANNER = Path('/usr/bin/clamscan')
FILES = ('compose.yaml', 'Dockerfile', 'scripts/install-linux.sh',
         'scripts/host-security-agent.py', 'apps/license-api/src/modules/operations/http-routes.js',
         'apps/web/public/admin.html')
LOCK = threading.Lock()
STATE = {'state': 'idle', 'checked_at': None, 'checks': []}
LAST_START = None
SCAN_INTERVAL_SECONDS = 300


def check(name, state, detail):
    return {'name': name, 'state': state, 'detail': detail[:180]}


def file_digest(path):
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 8 * 1024 * 1024:
        raise OSError('missing or oversized file')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_baseline():
    files = {name: file_digest(ROOT / 'current' / name) for name in FILES}
    BASELINE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = BASELINE.with_suffix('.tmp')
    temporary.write_text(json.dumps(files, sort_keys=True), encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(BASELINE)


def integrity_check():
    try:
        baseline = json.loads(BASELINE.read_text(encoding='utf-8'))
        if set(baseline) != set(FILES):
            raise ValueError('baseline missing entries')
        changed = [name for name in FILES if file_digest(ROOT / 'current' / name) != baseline[name]]
        return check('核心文件完整性', 'finding' if changed else 'ok',
                     '安装基线与当前文件不一致：' + ', '.join(changed) if changed else '固定文件与本机安装基线一致；仍需独立可信核验')
    except (OSError, ValueError, TypeError):
        return check('核心文件完整性', 'unavailable', '安装基线缺失或文件不可读')


def file_identity(metadata):
    return (metadata.st_dev, metadata.st_ino, metadata.st_size,
            metadata.st_mtime_ns, metadata.st_ctime_ns)


def malware_scan():
    """Scan only the release inventory; incomplete coverage is never called clean."""
    scanner = SCANNER
    if not scanner.is_file() or not os.access(scanner, os.X_OK):
        return check('病毒特征查杀', 'unavailable', '未安装 ClamAV；仅支持固定清单中的程序文件，未检查业务数据与整个宿主机')
    selected = []
    recorded = {}
    skipped = 0
    for name in FILES:
        path = ROOT / 'current' / name
        try:
            metadata = path.lstat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size >= 8 * 1024 * 1024:
                skipped += 1
            else:
                selected.append(str(path))
                recorded[str(path)] = file_identity(metadata)
        except OSError:
            skipped += 1
    if not selected:
        return check('病毒特征查杀', 'unavailable', '固定程序清单均不可扫描；未检查业务数据与整个宿主机')
    try:
        result = subprocess.run([
            str(scanner), '--no-summary', '--infected', '--max-filesize=8M',
            '--max-scansize=16M', '--max-files=100', '--max-recursion=8',
            '--alert-exceeds-max=yes',
            '--follow-file-symlinks=0', '--follow-dir-symlinks=0', *selected,
        ], capture_output=True, text=True, timeout=45, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return check('病毒特征查杀', 'unavailable', 'ClamAV 启动失败或超过 45 秒；扫描结果未知')
    scope = f'固定程序文件 {len(selected)}/{len(FILES)} 个，跳过 {skipped} 个；不包含业务数据与宿主机其他目录'
    try:
        stable = all(file_identity(Path(path).lstat()) == recorded[path]
                     for path in selected)
    except OSError:
        stable = False
    if not stable:
        return check('病毒特征查杀', 'unavailable', '扫描期间文件发生变化，结果不可采信；' + scope)
    if result.returncode == 1:
        return check('病毒特征查杀', 'finding', 'ClamAV 报告疑似恶意特征或扫描限制；' + scope + '，需人工复核原始证据')
    if result.returncode != 0:
        return check('病毒特征查杀', 'unavailable', 'ClamAV 扫描失败或特征库不可用；' + scope)
    if skipped:
        return check('病毒特征查杀', 'unavailable', '部分清单未扫描；' + scope)
    return check('病毒特征查杀', 'ok', 'ClamAV 在本次固定程序清单中未发现已知特征；' + scope)


def scan():
    results = [integrity_check(), inventory_check(ROOT), config_check(ROOT),
               container_check(ROOT), ports_check(), ssh_check(), backup_check(ROOT)]
    try:
        info = Path('/etc/os-release').read_text(encoding='utf-8')
        distro = next((line[8:].strip('"') for line in info.splitlines() if line.startswith('PRETTY_NAME=')), 'Linux')
        results.append(check('Linux 系统', 'ok', distro[:80] + ' · ' + os.uname().release[:70]))
    except OSError:
        results.append(check('Linux 系统', 'unavailable', '无法读取系统版本'))
    try:
        output = subprocess.run(['systemctl', 'is-system-running'], capture_output=True, text=True, timeout=4, check=False)
        value = output.stdout.strip()
        results.append(check('systemd 状态', 'ok' if value == 'running' else 'warning', value or 'systemd 状态不可用'))
    except (OSError, subprocess.TimeoutExpired):
        results.append(check('systemd 状态', 'unavailable', '无法核对服务管理器'))
    try:
        ssh = Path('/etc/ssh/sshd_config').read_text(encoding='utf-8')
        rules = [line.split('#', 1)[0].strip().lower() for line in ssh.splitlines()]
        risky = 'permitrootlogin yes' in rules or 'passwordauthentication yes' in rules
        results.append(check('SSH 基础配置', 'warning' if risky else 'ok', '检测到允许 root 或密码登录的显式配置' if risky else '未发现显式允许 root/密码登录；仍需核对 include 和生效配置'))
    except OSError:
        results.append(check('SSH 基础配置', 'unavailable', '无法读取主配置；未核对 include 和生效配置'))
    for label, path in [('安装目录权限', ROOT), ('定时任务权限', Path('/etc/cron.d'))]:
        try:
            mode = path.stat().st_mode
            results.append(check(label, 'finding' if mode & stat.S_IWOTH else 'ok', '目录允许所有用户写入' if mode & stat.S_IWOTH else '目录未开放全员写权限'))
        except OSError:
            results.append(check(label, 'unavailable', '无法读取路径或权限'))
    try:
        ports = set()
        for path in ('/proc/net/tcp', '/proc/net/tcp6'):
            for line in Path(path).read_text().splitlines()[1:]:
                cells = line.split()
                if len(cells) > 3 and cells[3] == '0A':
                    ports.add(int(cells[1].rsplit(':', 1)[1], 16))
        results.append(check('监听端口', 'warning' if ports & {21, 23, 2375} else 'ok', 'TCP 监听端口：' + ', '.join(map(str, sorted(ports)[:30]))))
    except (OSError, ValueError, IndexError):
        results.append(check('监听端口', 'unavailable', '无法读取 TCP 监听信息'))
    results.append(malware_scan())
    return results


def run_scan():
    global STATE
    try:
        checks = scan()
        with LOCK:
            STATE = {'state': 'finished', 'checked_at': datetime.now(timezone.utc).isoformat(), 'checks': checks}
    except Exception:
        with LOCK:
            STATE = {'state': 'failed', 'checked_at': datetime.now(timezone.utc).isoformat(), 'checks': []}


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != '/status':
            return self.reply(404, {'error': 'unknown action'})
        with LOCK:
            self.reply(200, dict(STATE))

    def do_POST(self):
        if self.path != '/scan' or self.headers.get('Content-Length', '0') != '0':
            return self.reply(400, {'error': 'invalid action'})
        code = start_scan()
        self.reply(code, {'state': 'running' if code in (202, 409) else 'unavailable'})


def start_scan():
    """Share one scan lock and cooldown between scheduled and manual requests."""
    global LAST_START
    with LOCK:
        if STATE['state'] == 'running':
            return 409
        now = time.monotonic()
        if LAST_START is not None and now - LAST_START < 60:
            return 429
        LAST_START = now
        STATE.update(state='running', checks=[])
        threading.Thread(target=run_scan, daemon=True).start()
        return 202


def periodic_scans(stop_event, interval=SCAN_INTERVAL_SECONDS):
    start_scan()  # No clean result is reported before the first completed check.
    while not stop_event.wait(interval):
        start_scan()


def main():
    folder = Path(SOCKET).parent
    folder.mkdir(mode=0o755, parents=True, exist_ok=True)
    if Path(SOCKET).exists():
        if not stat.S_ISSOCK(Path(SOCKET).lstat().st_mode):
            raise RuntimeError('socket path occupied')
        Path(SOCKET).unlink()
    with UnixHTTPServer(SOCKET, Handler) as server:
        os.chown(SOCKET, 1000, 1000)  # Dockerfile USER node (UID/GID 1000).
        os.chmod(SOCKET, 0o600)
        threading.Thread(target=periodic_scans, args=(threading.Event(),), daemon=True).start()
        server.serve_forever()


if __name__ == '__main__':
    action = sys.argv[1:]
    if action in (['--write-baseline'], ['--write-posture-baseline'], ['--approve-host-baseline']):
        if os.geteuid() != 0:
            raise SystemExit('root required')
        if action == ['--write-baseline']:
            write_baseline()
        elif action == ['--write-posture-baseline']:
            write_posture_baseline(ROOT)
        else:
            approve_host_baseline(ROOT)
    elif action:
        raise SystemExit('invalid action')
    else:
        main()
