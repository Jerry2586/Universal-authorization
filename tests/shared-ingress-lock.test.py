#!/usr/bin/env python3
"""Actual inherited flock/exclusion boundaries on a disposable Linux runner."""
import fcntl
import os
from pathlib import Path
import subprocess
import time

assert os.geteuid() == 0 and os.environ.get('GITHUB_ACTIONS') == 'true'
lock = Path('/run/lock/appgog-ingress.lock')
assert not lock.exists() and not lock.is_symlink(), 'Refuse existing ingress lock'
helper = str(Path(__file__).resolve().parents[1] / 'scripts/lib/shared-ingress.sh')
def invoke(body, env=None):
    return subprocess.run(['sh', '-c', '. "$1"; '+body, '_', helper], env=env, capture_output=True, text=True, timeout=10)
try:
    parent = subprocess.Popen(['sh','-c', '. "$1"; appgog_ingress_lock || exit; sh -c \' . "$1"; appgog_ingress_lock && appgog_ingress_unlock\' _ "$1" || exit; echo READY; read ignored; appgog_ingress_unlock', '_', helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert parent.stdout.readline().strip() == 'READY'
    assert invoke('appgog_ingress_lock').returncode != 0, 'Independent process acquired held lock'
    parent.communicate('\n', timeout=10)
    assert parent.returncode == 0
    assert invoke('appgog_ingress_lock && appgog_ingress_unlock').returncode == 0
    env = dict(os.environ, APPGOG_INGRESS_LOCKED='8')
    assert invoke('appgog_ingress_lock', env).returncode != 0, 'Spoofed inherited FD accepted'
    env['APPGOG_INGRESS_LOCKED'] = 'bad'
    assert invoke('appgog_ingress_lock', env).returncode != 0
    lock.chmod(0o666)
    assert invoke('appgog_ingress_lock').returncode != 0, 'Writable lock admitted'
    lock.chmod(0o600)
    linked = Path('/run/lock/appgog-ingress-test-linked')
    assert not linked.exists()
    os.link(lock, linked)
    try: assert invoke('appgog_ingress_lock').returncode != 0, 'Hard linked lock admitted'
    finally: linked.unlink()
    lock.unlink()
    lock.symlink_to('/dev/null')
    assert invoke('appgog_ingress_lock').returncode != 0, 'Symlink lock admitted'
    lock.unlink()
    assert invoke('appgog_ingress_lock && appgog_ingress_unlock').returncode == 0
finally:
    if lock.exists() or lock.is_symlink(): lock.unlink()
print('Shared ingress nested FD, exclusion, release and invalid lock boundaries passed')
