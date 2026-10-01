import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const python = process.env.APPGOG_TEST_PYTHON || 'python3';
const available = spawnSync(python, ['--version']).status === 0;

test('host security baseline detects a changed file without replacing its baseline', { skip: process.platform === 'win32' || !available }, () => {
  const source = resolve('scripts/host-security-agent.py');
  const script = `import importlib.util, pathlib, tempfile, json\n` +
    `s=importlib.util.spec_from_file_location('agent', ${JSON.stringify(source)})\n` +
    `a=importlib.util.module_from_spec(s); s.loader.exec_module(a)\n` +
    `with tempfile.TemporaryDirectory() as tmp:\n` +
    ` p=pathlib.Path(tmp); a.ROOT=p; a.BASELINE=p/'baseline.json'; a.FILES=('code.txt',)\n` +
    ` (p/'current').mkdir(); (p/'current/code.txt').write_text('original')\n` +
    ` a.write_baseline(); assert a.integrity_check()['state']=='ok'\n` +
    ` (p/'current/code.txt').write_text('tampered')\n` +
    ` assert a.integrity_check()['state']=='finding'\n` +
    ` assert a.BASELINE.exists()\n`;
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr);
});
