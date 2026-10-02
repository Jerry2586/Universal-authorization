"""Bounded, read-only host and container posture checks for APPGOG."""
import hashlib
import json
import os
import stat
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

PROGRAM_ROOTS = ('apps', 'packages', 'scripts')
PROGRAM_FILES = ('Dockerfile', 'compose.yaml', 'Caddyfile', 'Caddyfile.license',
                 'Caddyfile.build', 'package.json', 'release-contract.json')
EXCLUDED_DIRS = {'.git', 'node_modules', 'var', 'runtime', 'dist', 'backups', 'logs', 'shared'}
MAX_FILES = 5000
MAX_BYTES = 128 * 1024 * 1024
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_BASELINE_BYTES = 16 * 1024 * 1024
MAX_ENV_BYTES = 64 * 1024
MAX_AUDIT_BYTES = 1024 * 1024
POSTURE_BASELINE = Path('/var/lib/appgog-security/posture.json')
POSTURE_AUDIT = Path('/var/lib/appgog-security/posture-approvals.jsonl')
ROOT_UID = 0


def result(name, state, detail):
    return {'name': name, 'state': state, 'detail': detail[:180]}


def command(args, timeout=5):
    response = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                              check=False)
    if response.returncode or len(response.stdout) > 131072:
        raise OSError('command failed or response oversized')
    return response.stdout


def _now():
    return datetime.now(timezone.utc).isoformat()


def _read_regular_file(path, limit, *, private=False):
    flags = os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError('not a regular file')
        if private and (metadata.st_uid != ROOT_UID or metadata.st_mode & 0o077):
            raise OSError('private file ownership or permissions are unsafe')
        if metadata.st_size > limit:
            raise OSError('file exceeds bounded size')
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b''.join(chunks)
        if len(data) > limit:
            raise OSError('file exceeds bounded size')
        return data
    finally:
        os.close(descriptor)


def _read_json(path, limit=MAX_BASELINE_BYTES, *, private=False):
    value = json.loads(_read_regular_file(path, limit, private=private).decode('utf-8'))
    if not isinstance(value, dict):
        raise ValueError('JSON object required')
    return value


def _ensure_private_parent(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata = path.lstat()
    if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != ROOT_UID
            or metadata.st_mode & 0o077):
        raise OSError('private directory ownership or permissions are unsafe')


def _fsync_directory(path):
    flags = os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_DIRECTORY', 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _replace_private(path, data):
    _ensure_private_parent(path.parent)
    temporary = path.with_name(f'.{path.name}.{os.getpid()}.{time.time_ns()}.tmp')
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_CLOEXEC', 0)
    descriptor = os.open(temporary, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        offset = 0
        while offset < len(data):
            written = os.write(descriptor, data[offset:])
            if written <= 0:
                raise OSError('private file write failed')
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _write_baseline(target, manifest):
    old = None
    try:
        old = _read_regular_file(target, MAX_BASELINE_BYTES, private=True)
    except FileNotFoundError:
        pass
    encoded = (json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
    if len(encoded) > MAX_BASELINE_BYTES:
        raise OSError('baseline exceeds bounded size')
    if old is not None:
        _replace_private(target.with_name(target.name + '.previous'), old)
    _replace_private(target, encoded)


def _snapshot_private(path, limit):
    try:
        return _read_regular_file(path, limit, private=True)
    except FileNotFoundError:
        return None


def _restore_private(path, snapshot):
    if snapshot is None:
        try:
            path.unlink()
            _fsync_directory(path.parent)
        except FileNotFoundError:
            pass
        return
    _replace_private(path, snapshot)


def _load_baseline(path):
    value = _read_json(path, private=True)
    if value.get('schema') != 2:
        raise ValueError('unsupported baseline schema')
    return value


def _current_release(root):
    current = root / 'current'
    release = current.resolve(strict=True)
    if not release.is_dir():
        raise OSError('current release is not a directory')
    return current, release


def _inside(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _file_record(path, release, total):
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode):
        target = path.resolve(strict=True)
        if not _inside(target, release) or not target.is_file():
            raise OSError('program symlink escapes release or targets non-file')
        data = _read_regular_file(target, MAX_FILE_BYTES)
        total[0] += len(data)
        return {'type': 'symlink', 'link': os.readlink(path),
                'target': target.relative_to(release).as_posix(), 'size': len(data),
                'sha256': hashlib.sha256(data).hexdigest()}
    if not stat.S_ISREG(metadata.st_mode):
        raise OSError('unexpected program file type')
    data = _read_regular_file(path, MAX_FILE_BYTES)
    total[0] += len(data)
    return {'type': 'file', 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def program_inventory(root):
    """Inventory fixed program scope while rejecting directory links and link escapes."""
    current, release = _current_release(root)
    records = {}
    total = [0]

    def visit(path, relative):
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            target = path.resolve(strict=True)
            if target.is_dir():
                raise OSError('directory symlinks are not allowed inside release')
            records[relative] = _file_record(path, release, total)
        elif stat.S_ISDIR(metadata.st_mode):
            for child in sorted(path.iterdir(), key=lambda item: item.name):
                if child.name not in EXCLUDED_DIRS:
                    visit(child, relative + '/' + child.name)
        else:
            records[relative] = _file_record(path, release, total)
        if total[0] > MAX_BYTES or len(records) > MAX_FILES:
            raise OSError('program inventory exceeds bounded scope')

    for name in (*PROGRAM_ROOTS, *PROGRAM_FILES):
        visit(current / name, name)
    return records


def _version(root):
    value = json.loads(_read_regular_file(root / 'current/package.json', MAX_FILE_BYTES).decode('utf-8'))
    version = value.get('version') if isinstance(value, dict) else None
    if not isinstance(version, str) or not version:
        raise ValueError('missing program version')
    return version


def config_digest(root):
    """Fingerprint deployment settings without retaining or returning any values."""
    data = _read_regular_file(root / 'shared/.env', MAX_ENV_BYTES, private=True)
    entries = []
    for line in data.decode('utf-8').splitlines():
        if line.startswith(('APPGOG_VERSION=', 'APPGOG_IMAGE=')):
            continue
        entries.append(line)
    return hashlib.sha256(('\n'.join(entries) + '\n').encode('utf-8')).hexdigest()


def listen_ports():
    ports = set()
    for source in ('/proc/net/tcp', '/proc/net/tcp6'):
        for line in Path(source).read_text(encoding='utf-8').splitlines()[1:]:
            fields = line.split()
            if len(fields) > 3 and fields[3] == '0A':
                ports.add(int(fields[1].rsplit(':', 1)[1], 16))
    return ports


def _migrate(value):
    if value.get('schema') == 2:
        return value
    if value.get('schema') != 1:
        raise ValueError('unsupported baseline schema')
    digest = value.get('config_digest') if isinstance(value.get('config_digest'), str) else None
    ports = value.get('listen_ports') if isinstance(value.get('listen_ports'), list) else []
    return {'schema': 2, 'program': {},
            'config': {'sample': digest, 'current': digest, 'approved': None,
                       'sampled_at': None, 'approved_at': None, 'approved_by': None},
            'ports': {'sample': ports, 'current': ports, 'approved': None,
                      'sampled_at': None, 'approved_at': None, 'approved_by': None}}


def write_posture_baseline(root, target=POSTURE_BASELINE):
    """Approve signed program bytes only; host settings remain explicit root decisions."""
    stamp = _now()
    try:
        previous = _migrate(_read_json(target, private=True))
    except FileNotFoundError:
        previous = {'schema': 2, 'config': {}, 'ports': {}}
    digest = config_digest(root)
    ports = sorted(listen_ports())
    old_config = previous.get('config') if isinstance(previous.get('config'), dict) else {}
    old_ports = previous.get('ports') if isinstance(previous.get('ports'), dict) else {}
    manifest = {
        'schema': 2,
        'program': {'version': _version(root), 'files': program_inventory(root),
                    'approved': True, 'approved_at': stamp,
                    'approved_by': 'verified-installer', 'source': 'signed-release'},
        'config': {'sample': old_config.get('sample') or digest, 'current': digest,
                   'approved': old_config.get('approved'),
                   'sampled_at': old_config.get('sampled_at') or stamp,
                   'approved_at': old_config.get('approved_at'),
                   'approved_by': old_config.get('approved_by')},
        'ports': {'sample': old_ports.get('sample') if isinstance(old_ports.get('sample'), list) else ports,
                  'current': ports,
                  'approved': old_ports.get('approved') if isinstance(old_ports.get('approved'), list) else None,
                  'sampled_at': old_ports.get('sampled_at') or stamp,
                  'approved_at': old_ports.get('approved_at'),
                  'approved_by': old_ports.get('approved_by')},
    }
    _write_baseline(target, manifest)
    return manifest


def _append_approval_audit(path, version, port_count):
    entry = {'at': _now(), 'event': 'host-baseline-approved', 'source': 'root-console',
             'uid': os.geteuid(), 'program_version': version, 'port_count': port_count}
    encoded = (json.dumps(entry, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
    existing = _snapshot_private(path, MAX_AUDIT_BYTES)
    combined = (existing or b'') + encoded
    if len(combined) > MAX_AUDIT_BYTES:
        raise OSError('approval audit exceeds bounded size')
    _replace_private(path, combined)


def approve_host_baseline(root, target=POSTURE_BASELINE, audit=POSTURE_AUDIT):
    """Approve the current config and ports only from a root-owned local console."""
    if os.geteuid() != ROOT_UID:
        raise PermissionError('root console required')
    manifest = _load_baseline(target)
    program = manifest.get('program')
    if not isinstance(program, dict) or program.get('approved') is not True:
        raise ValueError('signed program baseline required')
    stamp = _now()
    digest = config_digest(root)
    ports = sorted(listen_ports())
    # Snapshot every mutable trust file before approval. A failed audit commit must
    # never leave the configuration or port baseline silently approved.
    baseline_before = _read_regular_file(target, MAX_BASELINE_BYTES, private=True)
    previous_path = target.with_name(target.name + '.previous')
    previous_before = _snapshot_private(previous_path, MAX_BASELINE_BYTES)
    _snapshot_private(audit, MAX_AUDIT_BYTES)
    _ensure_private_parent(audit.parent)
    config = manifest.get('config') if isinstance(manifest.get('config'), dict) else {}
    port_state = manifest.get('ports') if isinstance(manifest.get('ports'), dict) else {}
    manifest['config'] = {**config, 'current': digest, 'approved': digest,
                          'approved_at': stamp, 'approved_by': 'root-console'}
    manifest['ports'] = {**port_state, 'current': ports, 'approved': ports,
                         'approved_at': stamp, 'approved_by': 'root-console'}
    try:
        _write_baseline(target, manifest)
        _append_approval_audit(audit, program.get('version'), len(ports))
    except Exception:
        _restore_private(target, baseline_before)
        _restore_private(previous_path, previous_before)
        raise
    return manifest


def inventory_check(root, baseline=POSTURE_BASELINE):
    try:
        approved = _load_baseline(baseline)
        program = approved.get('program')
        if (not isinstance(program, dict) or program.get('approved') is not True
                or program.get('version') != _version(root) or not isinstance(program.get('files'), dict)):
            return result('程序目录完整性', 'unavailable', '当前版本没有经签名安装器批准的程序清单；不能以旧基线断言安全')
        actual = program_inventory(root)
        expected = program['files']
        changes = sorted(set(expected) ^ set(actual) | {name for name in expected.keys() & actual.keys()
                                                         if expected[name] != actual[name]})
        if changes:
            return result('程序目录完整性', 'finding',
                          f'新增、删除、修改或链接变化 {len(changes)} 个程序文件；示例：' + ', '.join(changes[:3]))
        return result('程序目录完整性', 'ok', f'本机可信基线匹配 {len(actual)} 个程序文件；宿主机失守后仍需云端独立核验')
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, UnicodeError):
        return result('程序目录完整性', 'unavailable', '程序目录或可信基线无法完整读取；未检查业务数据卷')


def config_check(root, baseline=POSTURE_BASELINE):
    try:
        approved = _load_baseline(baseline).get('config')
        if not isinstance(approved, dict):
            raise ValueError('missing configuration state')
        digest = config_digest(root)
        if approved.get('approved') is None:
            return result('业务环境配置', 'warning', '已安全采样配置指纹，等待 root 在服务器控制台明确批准；不展示任何配置原值')
        if approved.get('approved') != digest:
            return result('业务环境配置', 'finding', '部署配置或密钥文件偏离人工批准状态；不展示任何配置原值')
        return result('业务环境配置', 'ok', '部署配置指纹与 root 人工批准状态一致；未向后台公开密钥')
    except (OSError, ValueError, KeyError, TypeError, UnicodeError):
        return result('业务环境配置', 'unavailable', '配置或可信基线缺失、权限不安全；无法证明环境未被篡改')


def ports_check(baseline=POSTURE_BASELINE):
    try:
        state = _load_baseline(baseline).get('ports')
        if not isinstance(state, dict):
            raise ValueError('missing port state')
        current = listen_ports()
        expected = state.get('approved')
        if expected is None:
            return result('监听端口变化', 'warning', f'已采样当前 {len(current)} 个 TCP 监听端口，等待 root 在服务器控制台明确批准')
        if not isinstance(expected, list) or any(not isinstance(port, int) or not 0 < port < 65536 for port in expected):
            raise ValueError('invalid approved ports')
        expected_set = set(expected)
        added = sorted(current - expected_set)
        removed = sorted(expected_set - current)
        if added or removed:
            parts = []
            if added:
                parts.append('新增：' + ', '.join(map(str, added[:12])))
            if removed:
                parts.append('消失：' + ', '.join(map(str, removed[:12])))
            return result('监听端口变化', 'warning', 'TCP 监听端口偏离人工批准状态；' + '；'.join(parts))
        return result('监听端口变化', 'ok', f'当前 {len(current)} 个 TCP 监听端口与 root 人工批准状态一致')
    except (OSError, ValueError, TypeError):
        return result('监听端口变化', 'unavailable', '端口清单或可信基线不可读；无法证明端口未变化')


def container_check(root):
    """Inspect only selected APPGOG container fields and never request Config.Env."""
    try:
        ids = command(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=appgog',
                       '--filter', 'label=com.docker.compose.service=appgog', '--format', '{{.ID}}']).splitlines()
        if len(ids) != 1:
            return result('业务容器运行配置', 'finding', f'预期一个 appgog 容器，实际 {len(ids)} 个')
        container_id = ids[0]
        host = json.loads(command(['docker', 'inspect', '--format', '{{json .HostConfig}}', container_id]))
        mounts = json.loads(command(['docker', 'inspect', '--format', '{{json .Mounts}}', container_id]))
        state = json.loads(command(['docker', 'inspect', '--format', '{{json .State}}', container_id]))
        image = json.loads(command(['docker', 'inspect', '--format', '{{json .Config.Image}}', container_id]))
        options = host.get('SecurityOpt') or []
        caps = [str(value).upper() for value in (host.get('CapDrop') or [])]
        faults = []
        if host.get('Privileged') or not host.get('ReadonlyRootfs'):
            faults.append('特权运行或根目录可写')
        if 'ALL' not in caps or 'no-new-privileges:true' not in options:
            faults.append('缺少权限收敛')
        if any(m.get('Type') == 'bind' and (m.get('Source') == '/var/run/docker.sock'
               or m.get('Destination') == '/var/run/docker.sock') for m in mounts):
            faults.append('容器可访问 Docker 控制口')
        security_mount = [m for m in mounts if m.get('Destination') == '/app/runtime/host-security']
        if (len(security_mount) != 1 or security_mount[0].get('Type') != 'bind'
                or security_mount[0].get('Source') != '/run/appgog-security'
                or security_mount[0].get('RW') is not False):
            faults.append('安全代理挂载来源、类型或只读属性不符')
        if not state.get('Running') or state.get('Health', {}).get('Status') != 'healthy':
            faults.append('容器未健康运行')
        if image != 'appgog-platform:' + _version(root):
            faults.append('运行镜像标签与正式版本不符')
        if faults:
            return result('业务容器运行配置', 'finding', '；'.join(faults))
        return result('业务容器运行配置', 'ok', '容器、镜像版本、只读根目录、权限和安全代理挂载符合预期；仍需外部签名核验')
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return result('业务容器运行配置', 'unavailable', '无法取得完整 Docker 运行状态，不能断言容器安全')


def ssh_check():
    try:
        executable = next(path for path in ('/usr/sbin/sshd', '/sbin/sshd', '/usr/bin/sshd') if Path(path).is_file())
        fields = dict(line.split(None, 1) for line in command([executable, '-T', '-C',
                                                               'user=root,host=localhost,addr=127.0.0.1']).splitlines()
                      if ' ' in line)
        if not {'permitrootlogin', 'passwordauthentication', 'port'} <= fields.keys():
            raise ValueError('incomplete sshd configuration')
        risky = fields['permitrootlogin'] == 'yes' or fields['passwordauthentication'] == 'yes'
        return result('SSH 生效配置', 'warning' if risky else 'ok',
                      ('root 或密码登录已开启，建议核对来源；' if risky else '未发现 root 直接登录或密码登录；')
                      + '实际 SSH 端口 ' + fields['port'])
    except (OSError, ValueError, StopIteration, subprocess.TimeoutExpired):
        return result('SSH 生效配置', 'unavailable', '无法读取 sshd 生效配置；不能根据主配置文件推断安全')


def backup_check(root, now=None):
    try:
        directory = root / 'shared/backups'
        key = root / 'shared/.backup-key'
        _read_regular_file(key, 8192, private=True)
        files = [path for path in directory.iterdir() if path.name.startswith('appgog-')
                 and path.name.endswith('.tar.gz.enc') and path.is_file() and not path.is_symlink()]
        if not files:
            return result('本机备份', 'warning', '未找到加密完整备份；未验证异地副本')
        newest = max(path.stat().st_mtime for path in files)
        age = (now if now is not None else time.time()) - newest
        if age < -300:
            return result('本机备份', 'unavailable', '备份时间在未来，系统时钟可能异常')
        return result('本机备份', 'warning' if age > 86400 else 'ok',
                      ('最近备份超过 24 小时；' if age > 86400 else '存在 24 小时内的加密备份；')
                      + '尚未验证可解密与异地恢复')
    except OSError:
        return result('本机备份', 'unavailable', '备份目录、密钥或权限无法核实')
