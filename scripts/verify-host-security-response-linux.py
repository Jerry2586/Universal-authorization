#!/usr/bin/env python3
"""Isolated CI: real Docker containment and real Ed25519 offline source repair."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import zipfile

assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.geteuid() == 0
assert sys.argv[2:] in ([], ['--official-recovery'])
official_recovery = sys.argv[2:] == ['--official-recovery']
root = Path(sys.argv[1]).resolve()
assert str(root) == '/appgog-host-security-ci'
cli = '/usr/local/sbin/appgog-security-response'
state = Path('/var/lib/appgog-security')
source = Path(__file__).resolve().parents[1]
version = json.loads((source / 'package.json').read_text())['version']

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

control = load('linux_response_ci', Path('/usr/local/lib/appgog-security/host-security-response.py'))
repair = load('linux_repair_ci', Path('/usr/local/lib/appgog-security/host-security-repair.py'))
control.initialize()

def run(args, *, success=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=120, check=False)
    if success:
        assert result.returncode == 0, (args[0], result.stderr[-1000:])
    else:
        assert result.returncode != 0, 'Unsafe action unexpectedly succeeded'
    return result

def inspect(identifier):
    return json.loads(run(['docker', 'inspect', identifier]).stdout)[0]

# Isolated runner only: temporary test containers, never a production APPGOG image.
image = 'appgog-platform:' + version
run(['docker', 'tag', 'node:24-bookworm-slim', image])
foreign = run(['docker', 'run', '-d', '--network', 'none', '--name', 'appgog-security-foreign-ci',
    'node:24-bookworm-slim', 'node', '-e', 'setInterval(()=>{},1000)']).stdout.strip()
owned = None
try:
    owned = run(['docker', 'run', '-d', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--restart', 'unless-stopped',
        '--label', 'com.docker.compose.project=appgog', '--label', 'com.docker.compose.service=appgog',
        '--label', 'com.docker.compose.project.working_dir=' + str(root / 'releases/candidate'),
        '--label', 'com.docker.compose.project.config_files=' + str(root / 'releases/candidate/compose.yaml'),
        '--health-cmd', 'node -e "process.exit(0)"', '--health-interval', '1s', '--health-timeout', '2s',
        '--name', 'appgog-security-owned-ci', image, 'node', '-e', 'setInterval(()=>{},1000)']).stdout.strip()
    for attempt in range(30):
        if inspect(owned)['State'].get('Health', {}).get('Status') == 'healthy':
            break
        time.sleep(1)
    else:
        raise AssertionError('Test container did not become healthy')
    if official_recovery:
        # Actual production check functions, fresh official databases and real clamscan.
        control.recovery_checks()
        image_id = inspect(owned)['Image']
        run([cli, 'approve-image', image_id])
        approved_before = (state / 'approved-image.json').read_bytes()
        assert control.AGENT.approved_image_check()['state'] == 'ok'
        program_pin = control.baseline_pin(control.AGENT.BASELINE)
        host_pin = control.baseline_pin(control.AGENT.HOST_BASELINE)
        # Drift is introduced only after pre-incident approval; repair must restore the same pin.
        changed_source = root / 'current/apps/web/public/admin.html'
        changed_source.write_text(changed_source.read_text() + '\n<!-- isolated CI drift -->\n')
        assert control.AGENT.integrity_check()['state'] == 'finding'
    run([cli, 'isolate'])
    incident = json.loads((state / 'incident.json').read_text())
    assert incident['container_id'] == owned and incident['state'] == 'contained'
    assert 'Env' not in incident and 'Config' not in incident
    assert inspect(owned)['State']['Running'] is False
    assert inspect(owned)['HostConfig']['RestartPolicy']['Name'] == 'no'
    assert inspect(foreign)['State']['Running'] is True
    run([cli, 'guard'], success=False)
    result = run(['sh', str(root / 'current/scripts/docker.sh'), 'start'], success=False)
    assert '本地安全事故未解除' in result.stderr, result.stderr
    run([cli, 'isolate'])
    assert json.loads((state / 'incident.json').read_text())['created_at'] == incident['created_at']
    run([cli, 'resume', 'APPROVE-DATA-AND-RESUME'], success=False)
    run(['sh', str(root / 'current/scripts/install-host-security.sh'), 'uninstall'], success=False)
    assert inspect(owned)['State']['Running'] is False and inspect(foreign)['State']['Running'] is True

    # Separate, disposable test signing key. The installed production key is never replaced.
    # This exercises actual OpenSSL signature checks and package restoration, not mocked crypto.
    keydir = root / 'ci-test-signing'
    keydir.mkdir(mode=0o700)
    run(['/usr/bin/openssl', 'genpkey', '-algorithm', 'Ed25519', '-out', str(keydir / 'private.pem')])
    run(['/usr/bin/openssl', 'pkey', '-in', str(keydir / 'private.pem'), '-pubout',
         '-out', str(keydir / 'release-public.pem')])
    (keydir / 'private.pem').chmod(0o600)
    (keydir / 'release-public.pem').chmod(0o600)
    control.DIRECTORY = keydir
    bundle = root / 'ci-signed-source'
    bundle.mkdir(mode=0o700)
    name = 'APPGOG-Packaging-Licensing-System-' + version
    archive = bundle / (name + '.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for relative in sorted(repair.ROOT_FILES):
            z.write(source / relative, name + '/' + relative)
        for dirname in sorted(repair.DIRECTORIES):
            for path in sorted((source / dirname).rglob('*')):
                if path.is_file() and not any(part in {'__pycache__', 'node_modules', '.git', '.pnpm-store'} for part in path.relative_to(source).parts):
                    z.write(path, name + '/' + path.relative_to(source).as_posix())
    archive.chmod(0o600)
    manifest = bundle / 'release-manifest.json'
    manifest.write_text(json.dumps({'schema': 2, 'product': 'appgog', 'version': version,
        'zip_name': archive.name, 'zip_sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}))
    manifest.chmod(0o600)
    signature = bundle / 'release-manifest.json.sig'
    run(['/usr/bin/openssl', 'pkeyutl', '-sign', '-inkey', str(keydir / 'private.pem'), '-rawin',
         '-in', str(manifest), '-out', str(signature)])
    signature.chmod(0o600)
    signature_bytes = signature.read_bytes()
    signature.write_bytes(b'x' * 64)
    try:
        repair.cache(control, bundle)
        raise AssertionError('Corrupt signature accepted')
    except ValueError:
        pass
    assert not (state / 'trusted-releases').exists()
    signature.write_bytes(signature_bytes)
    assert repair.cache(control, bundle)['state'] == 'cached'
    shared = root / 'shared/.env'
    shared_before = shared.read_bytes()
    previous = (root / 'current').resolve()
    try:
        repair.repair(control, '0.0.1')
        raise AssertionError('Implicit release switch accepted')
    except ValueError:
        pass
    result = repair.repair(control, version)
    assert result['state'] == 'source_repaired' and result['service'] == 'still-contained'
    assert (root / 'current').resolve() != previous and previous.is_dir()
    assert shared.read_bytes() == shared_before
    assert control.AGENT.integrity_check()['state'] == 'ok'
    assert inspect(owned)['State']['Running'] is False and inspect(foreign)['State']['Running'] is True
    assert json.loads((state / 'incident.json').read_text())['state'] == 'source_repaired'
    run([cli, 'guard'], success=False)
    if official_recovery:
        assert (state / 'approved-image.json').read_bytes() == approved_before
        assert control.baseline_pin(control.AGENT.BASELINE) == program_pin
        assert control.baseline_pin(control.AGENT.HOST_BASELINE) == host_pin
        assert control.AGENT.approved_image_check()['state'] == 'ok'
        run([cli, 'resume', 'MISSING-DATA-REVIEW'], success=False)
        assert inspect(owned)['State']['Running'] is False
        run([cli, 'resume', 'APPROVE-DATA-AND-RESUME'])
        released = json.loads((state / 'incident.json').read_text())
        assert released['state'] == 'released' and released['container_id'] == owned
        assert released.get('data_reviewed_by_root_at') and not released.get('ci_teardown_only')
        assert inspect(owned)['Image'] == image_id and inspect(owned)['State']['Running'] is True
        assert inspect(owned)['State']['Health']['Status'] == 'healthy'
        assert inspect(owned)['HostConfig']['RestartPolicy']['Name'] == 'unless-stopped'
        assert inspect(foreign)['State']['Running'] is True
        assert (state / 'approved-image.json').read_bytes() == approved_before
        control.recovery_checks()
        assert control.AGENT.container_contract_check()['state'] == 'ok'
        run([cli, 'guard'])
        print('Official fresh database, real clamscan, pre-incident image approval, containment, signed source repair and strict resume passed (isolated control fixture, not production business).')
    else:
        # No verified clean image/data/antivirus conclusion: source repair never releases service.
        run([cli, 'resume', 'APPROVE-DATA-AND-RESUME'], success=False)
        print('Real Docker containment and actual Ed25519 source repair passed; service remained fenced.')
finally:
    # Only exact containers created by this disposable CI fixture are removed.
    for identifier in (owned, foreign):
        if identifier:
            run(['docker', 'rm', '-f', identifier])
    # Keep the real evidence; CI teardown can uninstall only after an explicit test-only release marker.
    # This marker is not a production recovery or a successful resume claim.
    if not official_recovery and (state / 'incident.json').exists():
        item = json.loads((state / 'incident.json').read_text())
        item['state'] = 'released'
        item['ci_teardown_only'] = True
        (state / 'incident.json').write_text(json.dumps(item))
        (state / 'incident.json').chmod(0o600)
