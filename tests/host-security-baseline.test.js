import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const python = process.env.APPGOG_TEST_PYTHON || 'python3';
const available = spawnSync(python, ['--version']).status === 0;
const linuxOnly = { skip: process.platform !== 'linux' || !available };

function runPython(script) {
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function importAgent() {
  return `import importlib.util\ns=importlib.util.spec_from_file_location('agent', ${JSON.stringify(resolve('scripts/host-security-agent.py'))})\na=importlib.util.module_from_spec(s); s.loader.exec_module(a)\n`;
}

test('host security baseline detects a changed file without replacing its baseline', linuxOnly, () => {
  runPython(importAgent() + `import pathlib, tempfile\n` +
    `with tempfile.TemporaryDirectory() as tmp:\n` +
    ` p=pathlib.Path(tmp); a.ROOT=p; a.BASELINE=p/'baseline.json'; a.FILES=('code.txt',)\n` +
    ` (p/'current').mkdir(); (p/'current/code.txt').write_text('original')\n` +
    ` a.write_baseline(); assert a.integrity_check()['state']=='ok'\n` +
    ` (p/'current/code.txt').write_text('tampered')\n` +
    ` assert a.integrity_check()['state']=='finding'\n` +
    ` assert a.BASELINE.exists()\n`);
});

test('Linux agent Unix socket allows one bounded scan, reports status and enforces cooldown', linuxOnly, () => {
  runPython(importAgent() + `import http.client, pathlib, socket, tempfile, threading, time\n` +
    `with tempfile.TemporaryDirectory() as tmp:\n` +
    ` path=str(pathlib.Path(tmp)/'agent.sock')\n` +
    ` original=a.scan\n` +
    ` def fixed_scan():\n` +
    `  time.sleep(0.25)\n` +
    `  return [a.check('fixed', 'ok', 'passed')]\n` +
    ` a.scan=fixed_scan\n` +
    ` class LocalConnection(http.client.HTTPConnection):\n` +
    `  def connect(self):\n` +
    `   self.sock=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n` +
    `   self.sock.connect(path)\n` +
    ` def call(method, route, body=None):\n` +
    `  conn=LocalConnection('localhost', timeout=3)\n` +
    `  conn.request(method, route, body=body, headers={'Content-Length':str(len(body or b''))} if method=='POST' else {})\n` +
    `  response=conn.getresponse(); data=response.read(); conn.close()\n` +
    `  return response.status, __import__('json').loads(data)\n` +
    ` with a.UnixHTTPServer(path, a.Handler) as server:\n` +
    `  thread=threading.Thread(target=server.serve_forever, daemon=True); thread.start()\n` +
    `  assert call('GET','/status')[1]['state']=='idle'\n` +
    `  assert call('POST','/scan',b'payload')[0]==400\n` +
    `  assert call('POST','/scan',b'')[0]==202\n` +
    `  assert call('POST','/scan',b'')[0]==409\n` +
    `  time.sleep(0.45)\n` +
    `  status, report=call('GET','/status')\n` +
    `  assert status==200 and report['state']=='finished' and report['checks'][0]['name']=='fixed'\n` +
    `  assert call('POST','/scan',b'')[0]==429\n` +
    `  server.shutdown(); thread.join(timeout=2)\n`);
});

test('first scan is allowed when host monotonic uptime is below cooldown', linuxOnly, () => {
  runPython(importAgent() + `from unittest.mock import patch
` +
    `a.scan=lambda: [a.check('fixed','ok','done')]
` +
    `with patch.object(a.time, 'monotonic', return_value=10.0):
` +
    ` assert a.start_scan()==202
` +
    ` assert a.start_scan() in (409,429)
`);
});

test('periodic scan starts at boot and respects manual scan lock', linuxOnly, () => {
  runPython(importAgent() + `import threading, time
` +
    `started=threading.Event()
` +
    `release=threading.Event()
` +
    `counter=[]
` +
    `def fixed():
` +
    ` counter.append(1)
` +
    ` started.set()
` +
    ` assert release.wait(2)
` +
    ` return [a.check('fixed','ok','done')]
` +
    `a.scan=fixed
` +
    `stop=threading.Event()
` +
    `thread=threading.Thread(target=a.periodic_scans,args=(stop,0.08),daemon=True)
` +
    `try:
` +
    ` thread.start()
` +
    ` assert started.wait(2) and a.STATE['state']=='running'
` +
    ` assert a.start_scan()==409
` +
    ` release.set()
` +
    ` deadline=time.monotonic()+2
` +
    ` while a.STATE['state']=='running' and time.monotonic()<deadline:
` +
    `  time.sleep(0.01)
` +
    ` assert a.STATE['state']=='finished' and len(counter)==1 and a.start_scan()==429
` +
    `finally:
` +
    ` release.set(); stop.set(); thread.join(timeout=2)
` +
    `assert not thread.is_alive()
`);
});
