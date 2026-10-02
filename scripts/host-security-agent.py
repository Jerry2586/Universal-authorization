#!/usr/bin/env python3
"""Fixed-scope, read-only Linux posture checks exposed on a local Unix socket."""
import hashlib
import ipaddress
import json
import math
import os
import posixpath
import re
import tempfile
import socketserver
import stat
import subprocess
import sys
import threading
import time
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path

SOCKET = os.environ.get('APPGOG_HOST_SCAN_SOCKET', '/run/appgog-security/scan.sock')
ROOT = Path(os.environ.get('APPGOG_INSTALL_ROOT', '/opt/appgog')).resolve()
STATE_DIR = Path('/var/lib/appgog-security')
BASELINE = STATE_DIR / 'baseline.json'
HOST_BASELINE = STATE_DIR / 'host-baseline.json'
HISTORY_FILE = STATE_DIR / 'events.json'
PROGRAM_DIRS = ('apps', 'packages', 'scripts')
PROGRAM_ROOT_FILES = ('package.json', 'pnpm-lock.yaml', 'release-contract.json', 'Dockerfile',
                      'compose.yaml', 'compose.license.yaml', 'compose.build.yaml',
                      'Caddyfile', 'Caddyfile.license', 'Caddyfile.build',
                      '.env.example', '.env.docker.example', '.dockerignore', 'install-docker.sh')
IGNORED_DIRS = {'node_modules', '.git', '__pycache__'}
MAX_INVENTORY_FILES = 4096
MAX_INVENTORY_BYTES = 128 * 1024 * 1024
MAX_FILE_BYTES = 8 * 1024 * 1024
HOST_FILES = ('/etc/passwd', '/etc/group', '/etc/ssh/sshd_config', '/etc/sudoers',
              '/etc/sysctl.conf', '/etc/ufw/ufw.conf',
              '/etc/crontab', '/etc/docker/daemon.json', '/etc/login.defs')
HOST_DIRS = ('/etc/ssh/sshd_config.d', '/etc/sudoers.d', '/etc/cron.d',
             '/etc/sysctl.d', '/etc/ufw', '/etc/firewalld', '/etc/iptables',
             '/etc/systemd/system', '/var/spool/cron')
MAX_HISTORY = 64
MAX_RESPONSE_BYTES = 32768
MAX_RESPONSE_HISTORY = 8
EVENTS = []
PREVIOUS = {}
HISTORY_VALID = True
SCANNER = Path('/usr/bin/clamscan')
CLAM_DATABASE = Path('/var/lib/clamav')
FILES = ('compose.yaml', 'compose.license.yaml', 'compose.build.yaml', 'Dockerfile', 'scripts/install-linux.sh',
         'scripts/host-security-agent.py', 'apps/license-api/src/modules/operations/http-routes.js',
         'apps/web/public/admin.html')
LOCK = threading.Lock()
STATE = {'state': 'idle', 'checked_at': None, 'checks': []}
LAST_START = None
SCAN_INTERVAL_SECONDS = 300
CHECK_STATES = {'ok', 'warning', 'finding', 'unavailable'}
SEVERITIES = {'info', 'low', 'medium', 'high', 'critical', 'unknown'}
DANGEROUS_PUBLIC_PORTS = {21, 23, 2375}
MAX_LISTENERS = 64


def bounded_text(value, limit):
    return str(value if value is not None else '')[:limit]


def bounded_evidence(value, depth=0):
    """Create a deterministic, size-limited evidence shape without reading secrets."""
    if depth >= 4:
        return '<truncated>'
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda item: str(item[0]))[:32]
        return {bounded_text(key, 48): bounded_evidence(item, depth + 1) for key, item in items}
    if isinstance(value, (list, tuple, set)):
        ordered = sorted(value, key=str) if isinstance(value, set) else list(value)
        return [bounded_evidence(item, depth + 1) for item in ordered[:32]]
    if isinstance(value, str):
        return value[:160]
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return bounded_text(value, 160)


def check(name, state, detail, *, check_id=None, category='host', severity=None,
          scope='fixed', evidence=None, checked_at=None):
    safe_state = state if state in CHECK_STATES else 'unavailable'
    safe_detail = bounded_text(detail, 180)
    safe_scope = bounded_text(scope, 120)
    safe_severity = severity if severity in SEVERITIES else {
        'ok': 'info', 'warning': 'medium', 'finding': 'high', 'unavailable': 'unknown',
    }[safe_state]
    safe_id = bounded_text(check_id or 'host.' + hashlib.sha256(
        bounded_text(name, 60).encode('utf-8')).hexdigest()[:16], 80)
    evidence_shape = bounded_evidence(evidence if evidence is not None else {
        'state': safe_state, 'detail': safe_detail, 'scope': safe_scope,
    })
    canonical = json.dumps(evidence_shape, ensure_ascii=True, sort_keys=True,
                           separators=(',', ':'), allow_nan=False).encode('utf-8')
    return {
        'name': bounded_text(name, 60),
        'state': safe_state,
        'detail': safe_detail,
        'id': safe_id,
        'category': bounded_text(category, 32),
        'severity': safe_severity,
        'checked_at': bounded_text(checked_at or datetime.now(timezone.utc).isoformat(), 40),
        'scope': safe_scope,
        'evidence_digest': hashlib.sha256(canonical).hexdigest(),
    }


def read_regular(path, limit=MAX_FILE_BYTES):
    """No-follow descriptor reads, including ancestors, with size/race limits."""
    target = Path(path).absolute()
    parent_fd = None
    fd = None
    try:
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
        if os.name == 'posix':
            directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            parent_fd = os.open(target.anchor, directory_flags)
            for part in target.parts[1:-1]:
                next_fd = os.open(part, directory_flags, dir_fd=parent_fd)
                os.close(parent_fd)
                parent_fd = next_fd
            fd = os.open(target.name, flags, dir_fd=parent_fd)
        else:
            # Windows is used only for deterministic development tests.
            if target.is_symlink():
                raise OSError('symlink')
            fd = os.open(str(target), flags)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise OSError('not a bounded regular file')
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, min(65536, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > limit:
                raise OSError('file limit exceeded')
        after = os.fstat(fd)
        named = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False) if parent_fd is not None else target.lstat()
        if file_identity(before) != file_identity(after) or file_identity(after) != file_identity(named):
            raise OSError('file changed during read')
        return b''.join(chunks)
    finally:
        if fd is not None:
            os.close(fd)
        if parent_fd is not None:
            os.close(parent_fd)


def read_state(path, limit=1024 * 1024):
    metadata = Path(path).lstat()
    if os.name == 'posix' and (metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077):
        raise OSError('untrusted state file permissions')
    return read_regular(path, limit)


def file_digest(path):
    return hashlib.sha256(read_regular(path)).hexdigest()


def private_directory(folder):
    folder = Path(folder).absolute()
    # Reject symlink ancestors before creating or writing root-owned evidence.
    for item in reversed((folder, *folder.parents)):
        if item.exists() or item.is_symlink():
            metadata = item.lstat()
            if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                raise OSError('unsafe state directory')
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata = folder.lstat()
    if os.name == 'posix' and (metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077):
        raise OSError('state directory must be private and owned by the agent')


def atomic_json(target, value):
    target = Path(target)
    private_directory(target.parent)
    if target.is_symlink():
        raise OSError('state symlink')
    fd, name = tempfile.mkstemp(prefix='.' + target.name + '-', dir=str(target.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, 0o600)
        os.replace(name, target)
        if os.name == 'posix':
            directory = os.open(str(target.parent), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def release_root():
    candidate = ROOT / 'current'
    if not candidate.exists() and not candidate.is_symlink():
        return ROOT  # Supported direct Docker source layout.
    resolved = candidate.resolve(strict=True)
    try:
        resolved.relative_to(ROOT)
        if candidate.is_symlink():
            resolved.relative_to(ROOT / 'releases')
    except ValueError as error:
        raise OSError('release escapes installation') from error
    if not resolved.is_dir() or resolved == ROOT:
        raise OSError('invalid release directory')
    return resolved


def bounded_tree(folder, *, allow_links=False):
    """Bounded enumeration; do not follow any directory or file symlink."""
    pending, seen = [Path(folder)], 0
    started = time.monotonic()
    while pending:
        current = pending.pop()
        before = current.lstat()
        if not stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode):
            raise OSError('unsafe inventory directory')
        with os.scandir(current) as entries:
            for entry in entries:
                seen += 1
                if seen > MAX_INVENTORY_FILES or time.monotonic() - started > 15:
                    raise OSError('inventory count or time limit')
                item = Path(entry.path)
                # Windows DirEntry.stat may omit file identity; production uses
                # descriptor-independent POSIX metadata including inode/ctime.
                metadata = entry.stat(follow_symlinks=False) if os.name == 'posix' else item.lstat()
                if stat.S_ISDIR(metadata.st_mode):
                    if entry.name not in IGNORED_DIRS:
                        pending.append(item)
                elif stat.S_ISREG(metadata.st_mode) or (allow_links and stat.S_ISLNK(metadata.st_mode)):
                    yield item, metadata
                else:
                    raise OSError('unsupported inventory entry')
        if file_identity(before) != file_identity(current.lstat()):
            raise OSError('directory changed during inventory')


def program_snapshot():
    root = release_root()
    result, total = {}, 0
    for name in PROGRAM_ROOT_FILES:
        payload = read_regular(root / name)
        result[name] = hashlib.sha256(payload).hexdigest()
        total += len(payload)
    for name in PROGRAM_DIRS:
        for target, metadata in bounded_tree(root / name):
            key = target.relative_to(root).as_posix()
            payload = read_regular(target)
            total += len(payload)
            if len(result) >= MAX_INVENTORY_FILES or total > MAX_INVENTORY_BYTES:
                raise OSError('program inventory limit')
            result[key] = hashlib.sha256(payload).hexdigest()
    if total > MAX_INVENTORY_BYTES:
        raise OSError('program byte limit')
    if release_root() != root:
        raise OSError('active release changed during inventory')
    return result


def write_baseline():
    files = program_snapshot()
    version = installed_version()
    if file_digest(release_root() / 'package.json') != files['package.json']:
        raise OSError('version changed during approval')
    atomic_json(BASELINE, {'schema': 2, 'version': version, 'files': files,
                           'approved_at': datetime.now(timezone.utc).isoformat()})


def installed_version():
    package = json.loads(read_regular(release_root() / 'package.json', 65536))
    version = package.get('version')
    if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', version):
        raise ValueError('invalid package version')
    return version


def integrity_check():
    try:
        baseline = json.loads(read_state(BASELINE))
        if not isinstance(baseline, dict):
            raise ValueError('invalid baseline')
        if baseline.get('schema') != 2:
            # Preserve old evidence; never silently approve expanded coverage.
            if set(baseline) != set(FILES):
                raise ValueError('invalid legacy baseline')
            changed = [name for name in FILES if file_digest(release_root() / name) != baseline[name]]
            return check('程序文件完整性', 'finding' if changed else 'warning',
                         '旧基线文件变化：' + ', '.join(changed[:5]) if changed else '旧版仅覆盖少量文件；请在可信版本核验后由 root 批准扩展基线',
                         check_id='integrity.program', scope='legacy fixed inventory', evidence={'changed': changed})
        expected = baseline.get('files')
        if not isinstance(expected, dict) or not expected or len(expected) > MAX_INVENTORY_FILES:
            raise ValueError('invalid inventory')
        if any(not isinstance(key, str) or not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for key, value in expected.items()):
            raise ValueError('invalid file digest')
        current = program_snapshot()
        changed = sorted(key for key in set(expected) | set(current) if expected.get(key) != current.get(key))
        version_drift = baseline.get('version') != installed_version()
        return check('程序文件完整性', 'finding' if changed or version_drift else 'ok',
                     f'程序清单 {len(current)} 个；新增/删除/修改 {len(changed)} 个；' + ('版本与批准基线不符；' if version_drift else '') +
                     (', '.join(changed[:4]) if changed else '与本机批准基线一致；仍需独立可信核验'),
                     check_id='integrity.program', scope='apps/packages/scripts and release contracts; excludes data/node_modules',
                     evidence={'count': len(current), 'changed': changed, 'version_drift': version_drift})
    except (OSError, ValueError, TypeError):
        return check('程序文件完整性', 'unavailable', '基线缺失、清单超限、符号链接、文件不可读或扫描期间变化',
                     check_id='integrity.program', scope='bounded program inventory')


def host_snapshot():
    result, total = {}, 0
    def record(target, metadata):
        nonlocal total
        if stat.S_ISLNK(metadata.st_mode):
            # systemd enablement links are evidence, not executable scan targets.
            data = os.readlink(target).encode('utf-8')
        else:
            data = read_regular(target, 1024 * 1024)
        total += len(data)
        if total > 16 * 1024 * 1024 or len(result) >= 2048:
            raise OSError('host inventory limit')
        if file_identity(metadata) != file_identity(target.lstat()):
            raise OSError('host configuration changed during read')
        result[str(target)] = {'digest': hashlib.sha256(data).hexdigest(),
                              'mode': stat.S_IMODE(metadata.st_mode), 'uid': getattr(metadata, 'st_uid', 0),
                              'gid': getattr(metadata, 'st_gid', 0), 'link': stat.S_ISLNK(metadata.st_mode)}
    for name in HOST_FILES:
        target = Path(name)
        try:
            metadata = target.lstat()
        except FileNotFoundError:
            result[name] = {'missing': True}
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError('unsafe host file')
        record(target, metadata)
    for name in HOST_DIRS:
        target = Path(name)
        if not target.exists() and not target.is_symlink():
            result[name + '/'] = {'missing': True}
            continue
        metadata = target.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise OSError('unsafe host configuration directory')
        result[name + '/'] = {'mode': stat.S_IMODE(metadata.st_mode), 'uid': getattr(metadata, 'st_uid', 0), 'gid': getattr(metadata, 'st_gid', 0)}
        for item, item_meta in bounded_tree(target, allow_links=True):
            record(item, item_meta)
    # Hash application settings locally; never return their contents or individual hashes.
    shared = ROOT / 'shared'
    settings = shared / '.env' if shared.is_dir() else ROOT / '.env'
    try:
        metadata = settings.lstat()
    except FileNotFoundError:
        result['appgog.environment'] = {'missing': True}
    else:
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError('unsafe application settings')
        record(settings, metadata)
    return result


def write_host_baseline():
    atomic_json(HOST_BASELINE, {'schema': 1, 'files': host_snapshot(),
                              'approved_at': datetime.now(timezone.utc).isoformat()})


def host_configuration_check():
    try:
        baseline = json.loads(read_state(HOST_BASELINE))
        if not isinstance(baseline, dict) or baseline.get('schema') != 1 or not isinstance(baseline.get('files'), dict):
            raise ValueError('invalid host baseline')
        expected = baseline['files']
        if not expected or len(expected) > 4096 or any(not isinstance(name, str) or not isinstance(value, dict) for name, value in expected.items()):
            raise ValueError('invalid host baseline inventory')
        for value in expected.values():
            if value == {'missing': True}:
                continue
            if any(type(value.get(key)) is not int or value[key] < 0 for key in ('mode', 'uid', 'gid')):
                raise ValueError('invalid host metadata')
            if 'digest' in value and (not isinstance(value['digest'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['digest'])):
                raise ValueError('invalid host digest')
        current = host_snapshot()
        changed = sorted(name for name in set(current) | set(expected) if current.get(name) != expected.get(name))
        return check('账户、SSH、Docker 与持久化配置', 'finding' if changed else 'ok',
                     f'固定配置清单 {len(current)} 项；差异 {len(changed)} 项；' + (', '.join(changed[:4]) if changed else '与本机批准基线一致'),
                     check_id='host.configuration', scope='passwd/group/sshd/sudo/cron/systemd/docker; no shadow or private keys',
                     evidence={'count': len(current), 'changed': changed})
    except (OSError, ValueError, TypeError):
        return check('账户、SSH、Docker 与持久化配置', 'unavailable', '主机配置基线缺失、读取失败、超限或扫描期间变化',
                     check_id='host.configuration', scope='fixed host configuration inventory')


def history_item(item):
    if not isinstance(item, dict) or item.get('state') not in CHECK_STATES:
        raise ValueError('invalid history state')
    if not isinstance(item.get('id'), str) or not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,79}', item['id']):
        raise ValueError('invalid history id')
    if not isinstance(item.get('evidence_digest'), str) or not re.fullmatch(r'[a-f0-9]{64}', item['evidence_digest']):
        raise ValueError('invalid history digest')
    if item.get('previous_state') is not None and item['previous_state'] not in CHECK_STATES:
        raise ValueError('invalid previous state')
    result = {key: bounded_text(item.get(key), limit) for key, limit in
              [('name', 60), ('detail', 180), ('id', 80), ('category', 32), ('severity', 16),
               ('checked_at', 40), ('scope', 120), ('evidence_digest', 64)]}
    if result['category'] not in {'host', 'container', 'permissions', 'ssh', 'network'} or result['severity'] not in SEVERITIES:
        raise ValueError('invalid history classification')
    observed = datetime.fromisoformat(result['checked_at'].replace('Z', '+00:00'))
    if observed.tzinfo is None:
        raise ValueError('invalid history timestamp')
    result.update(state=item['state'], previous_state=item.get('previous_state'))
    return result


def save_history(checks):
    global EVENTS, PREVIOUS
    if not HISTORY_VALID:
        raise OSError('preserve unreadable history for operator inspection')
    events = list(EVENTS)
    previous = {}
    for item in checks:
        key = item['id']
        marker = {'state': item['state'], 'digest': item['evidence_digest']}
        old = PREVIOUS.get(key)
        if old != marker and (old is not None or item['state'] != 'ok'):
            events.append(history_item({**item, 'previous_state': old['state'] if old else None}))
        previous[key] = marker
    events = events[-MAX_HISTORY:]
    atomic_json(HISTORY_FILE, {'schema': 1, 'events': events, 'previous': previous})
    EVENTS, PREVIOUS = events, previous
    return events[-MAX_RESPONSE_HISTORY:]


def load_history():
    global EVENTS, PREVIOUS
    try:
        state = json.loads(read_state(HISTORY_FILE, 131072))
        if not isinstance(state, dict) or state.get('schema') != 1 or not isinstance(state.get('events'), list) or not isinstance(state.get('previous'), dict):
            raise ValueError('invalid history')
        if len(state['events']) > MAX_HISTORY:
            raise ValueError('history count limit')
        events = [history_item(item) for item in state['events']]
        previous = state['previous']
        if len(previous) > 20:
            raise ValueError('previous count limit')
        for key, value in previous.items():
            if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,79}', key) or not isinstance(value, dict) or value.get('state') not in CHECK_STATES:
                raise ValueError('invalid previous state')
            if not isinstance(value.get('digest'), str) or not re.fullmatch(r'[a-f0-9]{64}', value['digest']):
                raise ValueError('invalid previous digest')
        EVENTS, PREVIOUS = events, previous
        return True
    except FileNotFoundError:
        EVENTS, PREVIOUS = [], {}
        return True
    except (OSError, ValueError, TypeError, AttributeError):
        EVENTS, PREVIOUS = [], {}
        return False


def file_identity(metadata):
    identity = (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns)
    # Windows descriptor and named stats expose different ctime semantics.
    # Linux production retains ctime to detect same-size/mtime tampering.
    return identity + ((metadata.st_ctime_ns,) if os.name == 'posix' else ())


def daily_database_identity():
    """Read the embedded CVD/CLD build time; touching mtime cannot renew trust."""
    candidates = [CLAM_DATABASE / name for name in ('daily.cvd', 'daily.cld')]
    records = {}
    for path in candidates:
        try:
            before = path.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(before.st_mode):
            raise OSError('invalid daily database')
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        try:
            opened = os.fstat(descriptor)
            if file_identity(before) != file_identity(opened):
                raise OSError('database changed while opening')
            header = os.read(descriptor, 512).decode('ascii').strip(' \x00\r\n')
            fields = header.split(':')
            if len(fields) != 9 or fields[0] != 'ClamAV-VDB' or not fields[8].isdigit():
                raise ValueError('invalid daily database header')
            built_at = int(fields[8])
            if built_at < time.time() - 7 * 86400 or built_at > time.time() + 120:
                raise ValueError('stale or future daily database')
            if file_identity(opened) != file_identity(os.fstat(descriptor)):
                raise OSError('database changed while reading')
            records[str(path)] = file_identity(opened)
        finally:
            os.close(descriptor)
    if not records:
        raise OSError('missing daily database')
    return records


def validate_zip_budget(path):
    """Reject known ZIP coverage gaps before trusting an engine clean exit."""
    with Path(path).open('rb') as source:
        magic = source.read(4)
    if magic not in (b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08'):
        return
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if (len(entries) > 100 or any(item.file_size >= MAX_FILE_BYTES or item.flag_bits & 1 for item in entries)
                    or sum(item.file_size for item in entries) >= 16 * 1024 * 1024):
                raise OSError('ZIP scan coverage limit or encryption')
    except (zipfile.BadZipFile, ValueError, NotImplementedError) as error:
        raise OSError('invalid ZIP scan target') from error


def malware_scan():
    """Bounded program scan only; missing coverage or stale DB never means clean."""
    scanner = SCANNER
    if not scanner.is_file() or not os.access(scanner, os.X_OK):
        return check('病毒特征查杀', 'unavailable', '未安装 ClamAV；请从 Linux 安全菜单安装引擎与特征库；不含业务数据与整个宿主机',
                     check_id='malware.program', scope='bounded program inventory')
    try:
        inventory = program_snapshot()
        root = release_root()
        selected = [str(root / name) for name in sorted(inventory)]
        if not selected or sum(len(name.encode('utf-8')) + 1 for name in selected) > 131072 or any('\n' in name or '\r' in name for name in selected):
            raise OSError('scan input limit')
        recorded = {name: file_identity(Path(name).lstat()) for name in selected}
        if any(not stat.S_ISREG(Path(name).lstat().st_mode) or Path(name).lstat().st_size >= MAX_FILE_BYTES for name in selected):
            raise OSError('unsupported scan target')
        for name in selected:
            validate_zip_budget(name)
        # clamscan validates the database content/signature; header age is an
        # additional freshness bound compatible with distribution ClamAV 1.0.
        database_identity = daily_database_identity()
        result = subprocess.run([
            str(scanner), '--no-summary', '--infected', '--max-filesize=8M',
            '--max-scansize=16M', '--max-files=100', '--max-recursion=8',
            '--alert-exceeds-max=yes', '--database=' + str(CLAM_DATABASE), '--follow-file-symlinks=0', '--follow-dir-symlinks=0', *selected,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45, check=False)
        stable = all(file_identity(Path(name).lstat()) == recorded[name] for name in selected)
        # Re-enumeration detects added/deleted files while the engine was scanning.
        stable = stable and program_snapshot() == inventory and daily_database_identity() == database_identity
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return check('病毒特征查杀', 'unavailable', '清单不完整/超限、特征库缺失/过期、引擎失败或超过 45 秒；结果未知',
                     check_id='malware.program', scope='bounded program inventory')
    scope = f'程序清单 {len(selected)} 个文件；不包含业务数据、依赖目录和宿主机其他目录'
    if not stable:
        return check('病毒特征查杀', 'unavailable', '扫描期间文件或目录发生变化；结果不可采信',
                     check_id='malware.program', scope=scope)
    if result.returncode == 1:
        return check('病毒特征查杀', 'finding', 'ClamAV 报告疑似恶意特征或扫描限制；需人工复核，不自动删除',
                     check_id='malware.program', scope=scope)
    if result.returncode != 0:
        return check('病毒特征查杀', 'unavailable', 'ClamAV 扫描失败或特征库不可用', check_id='malware.program', scope=scope)
    return check('病毒特征查杀', 'ok', '本次程序清单未发现已知特征；此结论不能证明整机未入侵',
                 check_id='malware.program', scope=scope)


def expected_platform_image():
    try:
        package = json.loads(read_regular(release_root() / 'package.json', 65536))
        version = package.get('version')
        if isinstance(version, str) and version and len(version) <= 40:
            return 'appgog-platform:' + version
    except (OSError, ValueError, TypeError):
        pass
    return None


def container_contract_check():
    """Inspect only the one Compose-labelled APPGOG service; never mutate Docker state."""
    ps_command = [
        'docker', 'ps',
        '--filter', 'label=com.docker.compose.project=appgog',
        '--filter', 'label=com.docker.compose.service=appgog',
        '--format', '{{.ID}}',
    ]
    try:
        listed = subprocess.run(ps_command, capture_output=True, text=True, timeout=5, check=False)
        if listed.returncode != 0:
            raise OSError('docker ps failed')
        identifiers = [line.strip() for line in listed.stdout.splitlines() if line.strip()]
        if len(identifiers) != 1:
            return check('APPGOG 容器合同', 'finding' if identifiers else 'unavailable',
                         f'预期一个 APPGOG 主容器，实际发现 {len(identifiers)} 个',
                         check_id='container.contract', category='container', severity='high',
                         scope='compose project appgog / service appgog',
                         evidence={'container_count': len(identifiers)})
        inspected = subprocess.run(['docker', 'inspect', identifiers[0]], capture_output=True,
                                   text=True, timeout=5, check=False)
        if inspected.returncode != 0:
            raise OSError('docker inspect failed')
        payload = json.loads(inspected.stdout)
        if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
            raise ValueError('invalid inspect response')
        container = payload[0]
    except (OSError, ValueError, TypeError, json.JSONDecodeError, subprocess.TimeoutExpired):
        return check('APPGOG 容器合同', 'unavailable', 'Docker 不可用、响应异常或检查超时',
                     check_id='container.contract', category='container', severity='unknown',
                     scope='compose project appgog / service appgog', evidence={'inspect': 'unavailable'})

    config = container.get('Config') if isinstance(container.get('Config'), dict) else {}
    state = container.get('State') if isinstance(container.get('State'), dict) else {}
    host = container.get('HostConfig') if isinstance(container.get('HostConfig'), dict) else {}
    mounts = container.get('Mounts') if isinstance(container.get('Mounts'), list) else []
    issues = []
    image = bounded_text(config.get('Image'), 100)
    expected_image = expected_platform_image()
    if expected_image:
        if image != expected_image:
            issues.append('image-mismatch')
    elif not image.startswith('appgog-platform:') or len(image.split(':', 1)[1]) > 40:
        issues.append('image-invalid')
    user = bounded_text(config.get('User'), 40).strip().lower()
    if not user or user.split(':', 1)[0] in {'0', 'root'}:
        issues.append('root-user')
    if state.get('Status') != 'running':
        issues.append('not-running')
    health = state.get('Health') if isinstance(state.get('Health'), dict) else {}
    if health.get('Status') != 'healthy':
        issues.append('not-healthy')
    if host.get('Privileged') is not False:
        issues.append('privileged')
    if host.get('ReadonlyRootfs') is not True:
        issues.append('writable-rootfs')
    if host.get('CapAdd') not in (None, []):
        issues.append('added-capabilities')

    allowed_binds = {
        '/app/var/update-control': (os.path.normpath(str(ROOT / 'shared' / 'update-control')), False),
        '/app/runtime/security': (os.path.normpath(str(ROOT / 'shared' / 'security')), True),
        '/app/runtime/host-security': ('/run/appgog-security', True),
    }
    bind_evidence = []
    for mount in mounts:
        if not isinstance(mount, dict) or mount.get('Type') != 'bind':
            continue
        # Docker inspect always reports Linux container paths, even when the
        # contract test is executed from a non-Linux development workstation.
        source = posixpath.normpath(bounded_text(mount.get('Source'), 160))
        destination = posixpath.normpath(bounded_text(mount.get('Destination'), 160))
        read_only = mount.get('RW') is False
        if len(bind_evidence) < 64:
            bind_evidence.append({'destination': destination, 'read_only': read_only})
        if source.endswith('/docker.sock') or destination.endswith('/docker.sock'):
            issues.append('docker-socket')
            continue
        contract = allowed_binds.get(destination)
        if contract is None:
            issues.append('unexpected-bind')
            continue
        expected_source, must_be_read_only = contract
        if source != expected_source:
            issues.append('bind-source-drift')
        if must_be_read_only and not read_only:
            issues.append('writable-sensitive-bind')

    unique_issues = sorted(set(issues))
    return check('APPGOG 容器合同', 'finding' if unique_issues else 'ok',
                 '容器偏离加固合同：' + ', '.join(unique_issues)
                 if unique_issues else '唯一 APPGOG 主容器运行健康，镜像、用户、权限和挂载符合固定合同',
                 check_id='container.contract', category='container',
                 severity='critical' if any(item in unique_issues for item in ('privileged', 'docker-socket'))
                 else ('high' if unique_issues else 'info'),
                 scope='compose project appgog / service appgog',
                 evidence={'image': image, 'expected_image': expected_image or 'appgog-platform:<version>',
                           'user': user, 'status': state.get('Status'), 'health': health.get('Status'),
                           'issues': unique_issues, 'binds': bind_evidence})


def evaluate_permission(path, *, name, check_id, metadata=None, max_mode=0o600,
                        expected_uid=0, expected_gid=0, expect_directory=False, required=True):
    """Evaluate metadata only. Secret contents are never opened, returned or hashed."""
    target = Path(path)
    try:
        item = metadata if metadata is not None else target.lstat()
    except OSError:
        return check(name, 'unavailable' if required else 'ok',
                     '路径缺失或元数据不可读' if required else '未配置该可选路径',
                     check_id=check_id, category='permissions', severity='unknown' if required else 'info',
                     scope=bounded_text(target, 120), evidence={'present': False})
    mode = stat.S_IMODE(item.st_mode)
    wrong_type = not (stat.S_ISDIR(item.st_mode) if expect_directory else stat.S_ISREG(item.st_mode))
    wrong_owner = expected_uid is not None and getattr(item, 'st_uid', expected_uid) != expected_uid
    wrong_group = expected_gid is not None and getattr(item, 'st_gid', expected_gid) != expected_gid
    too_wide = bool(mode & ~max_mode)
    unsafe = stat.S_ISLNK(item.st_mode) or wrong_type or wrong_owner or wrong_group or too_wide
    reasons = []
    if stat.S_ISLNK(item.st_mode):
        reasons.append('符号链接')
    if wrong_type:
        reasons.append('类型异常')
    if wrong_owner or wrong_group:
        reasons.append('所有者异常')
    if too_wide:
        reasons.append('权限过宽')
    return check(name, 'finding' if unsafe else 'ok',
                 '元数据风险：' + '、'.join(reasons) if unsafe else f'所有者和权限符合不宽于 {max_mode:04o} 的固定合同',
                 check_id=check_id, category='permissions', severity='high' if unsafe else 'info',
                 scope=bounded_text(target, 120),
                 evidence={'present': True, 'mode': f'{mode:04o}',
                           'uid': getattr(item, 'st_uid', None), 'gid': getattr(item, 'st_gid', None),
                           'kind': 'directory' if stat.S_ISDIR(item.st_mode) else
                           ('file' if stat.S_ISREG(item.st_mode) else 'other')})


def optional_metadata(path):
    try:
        return Path(path).lstat()
    except OSError:
        return None


def secret_permissions_check():
    """Check a fixed credential inventory through lstat only; never read credential bytes."""
    results = [
        evaluate_permission(ROOT / 'shared' / '.env', name='环境配置权限',
                            check_id='permissions.shared-env'),
        evaluate_permission(ROOT / 'shared' / '.backup-key', name='备份密钥权限',
                            check_id='permissions.backup-key'),
    ]
    security_root = ROOT / 'shared' / 'security'
    security_metadata = optional_metadata(security_root)
    if security_metadata is not None:
        results.append(evaluate_permission(security_root, name='云端凭据目录权限',
                                           check_id='permissions.cloud-directory',
                                           metadata=security_metadata, max_mode=0o700,
                                           expected_uid=None, expected_gid=None, expect_directory=True))
        for filename, max_mode in (('ca.crt', 0o644), ('license.crt', 0o644),
                                   ('license.key', 0o600), ('build.crt', 0o644),
                                   ('build.key', 0o600)):
            target = security_root / filename
            metadata = optional_metadata(target)
            if metadata is not None:
                results.append(evaluate_permission(target, name=f'云端凭据 {filename}',
                                                   check_id='permissions.cloud-' + filename.replace('.', '-'),
                                                   metadata=metadata, max_mode=max_mode,
                                                   expected_uid=None, expected_gid=None))
    system_security = Path('/etc/appgog-security')
    system_metadata = optional_metadata(system_security)
    if system_metadata is not None:
        results.append(evaluate_permission(system_security, name='安全服务配置目录权限',
                                           check_id='permissions.security-directory',
                                           metadata=system_metadata, max_mode=0o700,
                                           expect_directory=True))
        for filename, max_mode in (('config.json', 0o600), ('ca.crt', 0o644),
                                   ('server.crt', 0o644), ('server.key', 0o600)):
            target = system_security / filename
            metadata = optional_metadata(target)
            if metadata is not None:
                results.append(evaluate_permission(target, name=f'安全服务 {filename}',
                                                   check_id='permissions.security-' + filename.replace('.', '-'),
                                                   metadata=metadata, max_mode=max_mode))
    findings = [item for item in results if item['state'] == 'finding']
    unavailable = [item for item in results if item['state'] == 'unavailable']
    state_value = 'finding' if findings else ('unavailable' if unavailable else 'ok')
    affected = findings or unavailable
    detail = ('存在不安全的所有者、文件类型或权限：' + ', '.join(item['name'] for item in affected[:6])) \
        if affected else f'固定凭据清单共 {len(results)} 项，均通过仅元数据权限检查'
    return check('敏感配置与密钥权限', state_value, detail,
                 check_id='permissions.secret-inventory', category='permissions',
                 severity='high' if findings else ('unknown' if unavailable else 'info'),
                 scope='固定凭据路径，仅 lstat 元数据',
                 evidence={'checked': len(results),
                           'states': {item['id']: item['state'] for item in results[:24]}})


def sshd_effective_check():
    command = ['sshd', '-T', '-C', 'user=root,host=localhost,addr=127.0.0.1']
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5, check=False)
        if result.returncode != 0:
            raise OSError('sshd effective configuration failed')
    except (OSError, subprocess.TimeoutExpired):
        return check('SSH 生效配置', 'unavailable', '无法执行固定上下文的 sshd -T 检查',
                     check_id='ssh.effective', category='ssh', severity='unknown',
                     scope='root@localhost effective sshd configuration', evidence={'command': 'sshd -T'})
    values = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.strip().partition(' ')
        if separator and key in {'permitrootlogin', 'passwordauthentication', 'permitemptypasswords', 'port'}:
            values[key] = value.strip().lower()[:40]
    required = {'permitrootlogin', 'passwordauthentication', 'permitemptypasswords', 'port'}
    if not required.issubset(values):
        return check('SSH 生效配置', 'unavailable', 'sshd -T 输出缺少必要安全字段',
                     check_id='ssh.effective', category='ssh', severity='unknown',
                     scope='root@localhost effective sshd configuration',
                     evidence={'present_fields': sorted(values)})
    risky = (values['permitrootlogin'] == 'yes' or values['passwordauthentication'] == 'yes'
             or values['permitemptypasswords'] == 'yes')
    return check('SSH 生效配置', 'finding' if risky else 'ok',
                 '生效配置允许 root、密码或空密码登录' if risky
                 else f"生效配置已关闭密码/空密码直登，SSH 端口 {values['port']}",
                 check_id='ssh.effective', category='ssh', severity='high' if risky else 'info',
                 scope='root@localhost effective sshd configuration', evidence=values)


def proc_address(address, ipv6=False):
    raw = bytes.fromhex(address)
    if ipv6:
        network = b''.join(raw[offset:offset + 4][::-1] for offset in range(0, 16, 4))
    else:
        network = raw[::-1]
    return ipaddress.ip_address(network)


def listener_posture_from_text(ipv4_text, ipv6_text=''):
    listeners = []
    total = 0
    malformed = 0
    dangerous_ports = set()
    public_port_set = set()
    for family, text in ((4, ipv4_text), (6, ipv6_text)):
        for line in str(text).splitlines()[1:]:
            cells = line.split()
            if len(cells) <= 3 or cells[3] != '0A':
                continue
            try:
                address_hex, port_hex = cells[1].rsplit(':', 1)
                address = proc_address(address_hex, ipv6=family == 6)
                port = int(port_hex, 16)
                mapped = getattr(address, 'ipv4_mapped', None)
                loopback = address.is_loopback or (mapped is not None and mapped.is_loopback)
                exposure = 'loopback' if loopback else ('wildcard' if address.is_unspecified else 'public')
            except (ValueError, IndexError):
                malformed += 1
                continue
            total += 1
            if exposure != 'loopback':
                public_port_set.add(port)
                if port in DANGEROUS_PUBLIC_PORTS:
                    dangerous_ports.add(port)
            if len(listeners) < MAX_LISTENERS:
                listeners.append({'family': family, 'address': str(address),
                                  'port': port, 'exposure': exposure})
    dangerous = sorted(dangerous_ports)
    public_ports = sorted(public_port_set)
    if dangerous:
        state_value, severity = 'finding', 'critical' if 2375 in dangerous else 'high'
        summary = '危险端口暴露在公网或通配地址：' + ', '.join(map(str, dangerous))
    elif public_ports:
        state_value, severity = 'warning', 'medium'
        summary = '公网或通配地址 TCP 监听端口：' + ', '.join(map(str, public_ports[:20]))
    elif malformed:
        state_value, severity = 'unavailable', 'unknown'
        summary = 'TCP 监听数据格式异常，无法形成可信结论'
    else:
        state_value, severity = 'ok', 'info'
        loopback_ports = sorted({item['port'] for item in listeners})
        summary = '仅发现本机回环 TCP 监听：' + ', '.join(map(str, loopback_ports[:20])) \
            if loopback_ports else '未发现 TCP 监听端口'
    if total > MAX_LISTENERS:
        summary += f'；证据仅保留前 {MAX_LISTENERS}/{total} 项'
    return check('TCP 监听端口姿态', state_value, summary,
                 check_id='network.listeners', category='network', severity=severity,
                 scope='/proc/net/tcp and /proc/net/tcp6 fixed snapshot',
                 evidence={'listeners': listeners, 'total': total, 'malformed': malformed,
                           'dangerous_public_ports': dangerous})


def listener_posture_check():
    texts = {}
    missing = []
    for label, path in (('ipv4', Path('/proc/net/tcp')), ('ipv6', Path('/proc/net/tcp6'))):
        try:
            texts[label] = path.read_text(encoding='ascii')
        except OSError:
            texts[label] = ''
            missing.append(label)
    if len(missing) == 2:
        return check('TCP 监听端口姿态', 'unavailable', '无法读取固定的 /proc TCP 监听快照',
                     check_id='network.listeners', category='network', severity='unknown',
                     scope='/proc/net/tcp and /proc/net/tcp6 fixed snapshot',
                     evidence={'missing': missing})
    result = listener_posture_from_text(texts['ipv4'], texts['ipv6'])
    if missing and result['state'] != 'finding':
        return check('TCP 监听端口姿态', 'unavailable', '仅取得部分 TCP 监听快照，不能证明未暴露危险端口',
                     check_id='network.listeners', category='network', severity='unknown',
                     scope='/proc/net/tcp and /proc/net/tcp6 fixed snapshot',
                     evidence={'missing': missing, 'partial_state': result['state'],
                               'partial_digest': result['evidence_digest']})
    return result


def containment_check():
    path = STATE_DIR / 'incident.json'
    if not path.exists() and not path.is_symlink():
        return check('本地事故隔离', 'ok', '没有活动隔离记录；这不代表整台主机无入侵',
                     check_id='response.containment', category='host', scope='independent local response')
    try:
        item = json.loads(read_state(path, 32768))
        if item.get('schema') != 1 or item.get('root') != str(ROOT) or item.get('state') not in {
            'isolating', 'contained', 'containment_failed', 'source_repaired', 'recovering', 'released'
        }:
            raise ValueError('invalid incident')
        active = item['state'] != 'released'
        return check('本地事故隔离', 'finding' if active else 'ok',
                     '隔离状态：' + item['state'] + ('；仅允许 root 经独立核验恢复' if active else '；已留存恢复记录'),
                     check_id='response.containment', category='host', severity='critical' if active else 'info',
                     scope='independent local response', evidence={'state': item['state'], 'updated_at': item.get('updated_at')})
    except (OSError, ValueError, TypeError):
        return check('本地事故隔离', 'unavailable', '独立隔离记录异常，普通恢复应保持禁止',
                     check_id='response.containment', category='host', scope='independent local response')


def scan():
    results = [integrity_check(), host_configuration_check(), container_contract_check(), containment_check()]
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
    results.append(sshd_effective_check())
    results.append(secret_permissions_check())
    for label, path in [('安装目录权限', ROOT), ('定时任务权限', Path('/etc/cron.d'))]:
        try:
            mode = path.stat().st_mode
            results.append(check(label, 'finding' if mode & stat.S_IWOTH else 'ok', '目录允许所有用户写入' if mode & stat.S_IWOTH else '目录未开放全员写权限'))
        except OSError:
            results.append(check(label, 'unavailable', '无法读取路径或权限'))
    results.append(listener_posture_check())
    results.append(malware_scan())
    return results


def run_scan():
    global STATE
    try:
        checks = scan()
        history_state = 'ok'
        try:
            history = save_history(checks)
        except (OSError, ValueError, TypeError):
            history, history_state = [], 'unavailable'
            checks.append(check('本地告警历史', 'unavailable', '历史读取或保存失败；请由 root 检查状态目录，原有证据保留', check_id='host.history'))
        with LOCK:
            STATE = {'state': 'finished', 'checked_at': datetime.now(timezone.utc).isoformat(),
                     'checks': checks, 'history': history, 'history_state': history_state}
    except Exception:
        with LOCK:
            STATE = {'state': 'failed', 'checked_at': datetime.now(timezone.utc).isoformat(), 'checks': []}


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(*args, **kwargs)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, code, data):
        data = dict(data)
        if 'history' in data:
            data['history'] = list(data['history'])
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        while len(body) > MAX_RESPONSE_BYTES and data.get('history'):
            data['history'].pop(0)
            data['history_state'] = 'truncated'
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        if len(body) > MAX_RESPONSE_BYTES:
            code, body = 503, b'{"state":"unavailable"}'
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def empty_request(self):
        lengths = self.headers.get_all('Content-Length', [])
        return len(lengths) <= 1 and (not lengths or lengths[0] == '0') and not self.headers.get_all('Transfer-Encoding')

    def do_GET(self):
        if not self.empty_request():
            return self.reply(400, {'error': 'invalid body'})
        if self.path != '/status':
            return self.reply(404, {'error': 'unknown action'})
        with LOCK:
            report = dict(STATE)
        self.reply(200, report)

    def do_POST(self):
        if self.path != '/scan' or not self.empty_request():
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
    global HISTORY_VALID
    if os.geteuid() != 0:
        raise RuntimeError('host agent requires root')
    folder.mkdir(mode=0o750, parents=True, exist_ok=True)
    metadata = folder.lstat()
    if folder.is_symlink() or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) & 0o027:
        raise RuntimeError('unsafe socket directory')
    gid = int(os.environ.get('APPGOG_HOST_SECURITY_GID', '65532'))
    if gid <= 0 or gid > 2147483647 or metadata.st_gid != gid:
        raise RuntimeError('invalid socket group')
    HISTORY_VALID = load_history()
    if Path(SOCKET).exists():
        if not stat.S_ISSOCK(Path(SOCKET).lstat().st_mode):
            raise RuntimeError('socket path occupied')
        Path(SOCKET).unlink()
    with UnixHTTPServer(SOCKET, Handler) as server:
        os.chown(SOCKET, 0, gid)
        os.chmod(SOCKET, 0o660)
        threading.Thread(target=periodic_scans, args=(threading.Event(),), daemon=True).start()
        server.serve_forever()


if __name__ == '__main__':
    if sys.argv[1:] == ['--write-baseline'] and os.geteuid() == 0:
        write_baseline()
    elif sys.argv[1:] == ['--write-host-baseline'] and os.geteuid() == 0:
        write_host_baseline()
    elif sys.argv[1:] == ['--approve-host-baseline', 'APPROVE-HOST'] and os.geteuid() == 0:
        write_host_baseline()
    elif len(sys.argv) == 3 and sys.argv[1] == '--approve-baseline' and os.geteuid() == 0:
        if sys.argv[2] != installed_version():
            raise SystemExit('version confirmation mismatch')
        write_baseline()
    elif sys.argv[1:]:
        raise SystemExit('invalid action')
    else:
        main()
