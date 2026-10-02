import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const python = process.env.APPGOG_TEST_PYTHON || 'python3';
const available = process.platform === 'linux' && spawnSync(python, ['--version']).status === 0;
const modulePath = JSON.stringify(resolve('scripts/host_posture_checks.py'));
const run = (script) => {
  const result = spawnSync(python, ['-c', `import importlib.util\ns=importlib.util.spec_from_file_location('posture', ${modulePath})\np=importlib.util.module_from_spec(s); s.loader.exec_module(p)\n${script}`],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
};

test('signed install approves program only, while root approval and upgrades preserve host trust boundaries',
  { skip: !available }, () => run(`import json, os, pathlib, tempfile, unittest.mock
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); current=root/'current'; (current/'apps').mkdir(parents=True)
 (current/'apps/code.js').write_text('clean')
 (current/'package.json').write_text('{"version":"1.2.69"}')
 shared=root/'shared'; shared.mkdir(); env=shared/'.env'
 env.write_text('APPGOG_VERSION=1.2.69\\nAPPGOG_IMAGE=appgog-platform:1.2.69\\nAUTH_DOMAIN=sq.appgog.top\\nPRIVATE_TOKEN=never-log-this\\n'); env.chmod(0o600)
 p.ROOT_UID=os.getuid(); p.PROGRAM_ROOTS=('apps',); p.PROGRAM_FILES=('package.json',)
 state=root/'state'; baseline=state/'posture.json'; audit=state/'approvals.jsonl'
 with unittest.mock.patch.object(p,'listen_ports',return_value={22,80,443}):
  manifest=p.write_posture_baseline(root,baseline)
 assert manifest['program']['version']=='1.2.69' and manifest['program']['approved'] is True
 assert manifest['config']['approved'] is None and manifest['ports']['approved'] is None
 assert p.inventory_check(root,baseline)['state']=='ok'
 assert p.config_check(root,baseline)['state']=='warning'
 with unittest.mock.patch.object(p,'listen_ports',return_value={22,80,443}):
  assert p.ports_check(baseline)['state']=='warning'
  p.approve_host_baseline(root,baseline,audit)
 assert p.config_check(root,baseline)['state']=='ok'
 with unittest.mock.patch.object(p,'listen_ports',return_value={22,80,443}): assert p.ports_check(baseline)['state']=='ok'
 assert baseline.stat().st_mode & 0o777 == 0o600 and audit.stat().st_mode & 0o777 == 0o600
 assert 'never-log-this' not in audit.read_text()
 env.write_text(env.read_text()+'INJECTED_SECRET=still-never-log-this\\n'); env.chmod(0o600)
 finding=p.config_check(root,baseline)
 assert finding['state']=='finding' and 'still-never-log-this' not in finding['detail']
 env.write_text('APPGOG_VERSION=1.2.70\\nAPPGOG_IMAGE=appgog-platform:1.2.70\\nAUTH_DOMAIN=sq.appgog.top\\nPRIVATE_TOKEN=never-log-this\\n'); env.chmod(0o600)
 (current/'package.json').write_text('{"version":"1.2.70"}'); (current/'apps/code.js').write_text('signed update')
 with unittest.mock.patch.object(p,'listen_ports',return_value={22,80,443,8080}):
  upgraded=p.write_posture_baseline(root,baseline)
 assert upgraded['program']['version']=='1.2.70'
 assert upgraded['config']['approved'] is not None and upgraded['ports']['approved']==[22,80,443]
 assert p.inventory_check(root,baseline)['state']=='ok' and p.config_check(root,baseline)['state']=='ok'
 with unittest.mock.patch.object(p,'listen_ports',return_value={22,80,443,8080}): assert p.ports_check(baseline)['state']=='warning'
 previous=baseline.with_name('posture.json.previous')
 assert previous.stat().st_mode & 0o777 == 0o600
 assert json.loads(previous.read_text())['program']['version']=='1.2.69'
`));

test('program inventory detects edits, additions, deletions, link text, link targets, escapes, and directory links',
  { skip: !available }, () => run(`import os, pathlib, tempfile, unittest.mock
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); current=root/'current'; apps=current/'apps'; apps.mkdir(parents=True)
 (apps/'code.js').write_text('clean'); (apps/'target-one.js').write_text('one'); (apps/'target-two.js').write_text('two')
 (apps/'linked.js').symlink_to('target-one.js'); (current/'package.json').write_text('{"version":"1.2.69"}')
 shared=root/'shared'; shared.mkdir(); env=shared/'.env'; env.write_text('AUTH_DOMAIN=sq.appgog.top\\n'); env.chmod(0o600)
 p.ROOT_UID=os.getuid(); p.PROGRAM_ROOTS=('apps',); p.PROGRAM_FILES=('package.json',); baseline=root/'baseline.json'
 with unittest.mock.patch.object(p,'listen_ports',return_value={22}): p.write_posture_baseline(root,baseline)
 def state(): return p.inventory_check(root,baseline)['state']
 assert state()=='ok'
 (apps/'code.js').write_text('changed'); assert state()=='finding'; (apps/'code.js').write_text('clean')
 (apps/'added.js').write_text('added'); assert state()=='finding'; (apps/'added.js').unlink()
 (apps/'code.js').unlink(); assert state()=='finding'; (apps/'code.js').write_text('clean')
 (apps/'linked.js').unlink(); (apps/'linked.js').symlink_to('./target-one.js'); assert state()=='finding'
 (apps/'linked.js').unlink(); (apps/'linked.js').symlink_to('target-one.js')
 (apps/'target-one.js').write_text('changed target'); assert state()=='finding'; (apps/'target-one.js').write_text('one')
 (apps/'linked.js').unlink(); (apps/'linked.js').symlink_to('target-two.js'); assert state()=='finding'
 outside=root/'outside.txt'; outside.write_text('outside'); (apps/'linked.js').unlink(); (apps/'linked.js').symlink_to(outside)
 assert state()=='unavailable'
 (apps/'linked.js').unlink(); (apps/'linked.js').symlink_to('target-one.js'); (apps/'folder').mkdir(); (apps/'dir-link').symlink_to('folder',target_is_directory=True)
 assert state()=='unavailable'
`));

test('private files, baselines, and approval logs reject links, broad permissions, and owner mismatch',
  { skip: !available }, () => run(`import os, pathlib, tempfile, unittest.mock
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); current=root/'current'; (current/'apps').mkdir(parents=True); (current/'apps/code.js').write_text('clean'); (current/'package.json').write_text('{"version":"1.2.69"}')
 shared=root/'shared'; shared.mkdir(); env=shared/'.env'; env.write_text('PRIVATE_TOKEN=never-print-me\\n'); env.chmod(0o600)
 p.ROOT_UID=os.getuid(); p.PROGRAM_ROOTS=('apps',); p.PROGRAM_FILES=('package.json',)
 state=root/'state'; baseline=state/'posture.json'; audit=state/'audit.jsonl'
 with unittest.mock.patch.object(p,'listen_ports',return_value={22}): p.write_posture_baseline(root,baseline)
 original=baseline.read_bytes()
 env.chmod(0o644); assert p.config_check(root,baseline)['state']=='unavailable'; env.chmod(0o600)
 real_env=shared/'real.env'; env.rename(real_env); env.symlink_to(real_env); assert p.config_check(root,baseline)['state']=='unavailable'; env.unlink(); real_env.rename(env)
 p.ROOT_UID=os.getuid()+1
 try:
  p._read_regular_file(env,p.MAX_ENV_BYTES,private=True); raise AssertionError('owner mismatch accepted')
 except OSError: pass
 p.ROOT_UID=os.getuid()
 baseline.chmod(0o644)
 with unittest.mock.patch.object(p,'listen_ports',return_value={22}):
  try: p.write_posture_baseline(root,baseline); raise AssertionError('broad baseline accepted')
  except OSError: pass
 assert baseline.read_bytes()==original; baseline.chmod(0o600)
 real_baseline=state/'real-posture.json'; baseline.rename(real_baseline); baseline.symlink_to(real_baseline)
 assert p.inventory_check(root,baseline)['state']=='unavailable'; baseline.unlink(); real_baseline.rename(baseline)
 audit.write_text('unsafe\\n'); audit.chmod(0o644)
 before=baseline.read_bytes()
 with unittest.mock.patch.object(p,'listen_ports',return_value={22}):
  try: p.approve_host_baseline(root,baseline,audit); raise AssertionError('unsafe audit accepted')
  except OSError: pass
 assert baseline.read_bytes()==before
 audit.unlink(); audit.symlink_to(state/'missing-audit')
 with unittest.mock.patch.object(p,'listen_ports',return_value={22}):
  try: p.approve_host_baseline(root,baseline,audit); raise AssertionError('audit symlink accepted')
  except OSError: pass
 assert baseline.read_bytes()==before and 'never-print-me' not in p.config_check(root,baseline)['detail']
 audit.unlink(); previous=baseline.with_name('posture.json.previous')
 previous_before=previous.read_bytes() if previous.exists() else None
 with unittest.mock.patch.object(p,'listen_ports',return_value={22}), unittest.mock.patch.object(p,'_append_approval_audit',side_effect=OSError('disk full')):
  try: p.approve_host_baseline(root,baseline,audit); raise AssertionError('audit failure accepted')
  except OSError: pass
 assert baseline.read_bytes()==before
 assert (previous.read_bytes() if previous.exists() else None)==previous_before
`));

test('container posture inspects bounded fields and rejects every unsafe runtime boundary without secrets',
  { skip: !available }, () => run(`import copy, json, pathlib, tempfile, unittest.mock
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); (root/'current').mkdir(); (root/'current/package.json').write_text('{"version":"1.2.69"}')
 base_host={'Privileged':False,'ReadonlyRootfs':True,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true']}
 base_mounts=[{'Destination':'/app/runtime/host-security','RW':False,'Type':'bind','Source':'/run/appgog-security'}]
 base_state={'Running':True,'Health':{'Status':'healthy'}}; image='appgog-platform:1.2.69'; calls=[]
 def inspect(args,timeout=5):
  calls.append(args)
  if args[1]=='ps': return 'id\\n'
  value={'{{json .HostConfig}}':host,'{{json .Mounts}}':mounts,'{{json .State}}':state,'{{json .Config.Image}}':current_image}[args[3]]
  return json.dumps(value)
 def check(mutator=None):
  global host,mounts,state,current_image
  host=copy.deepcopy(base_host); mounts=copy.deepcopy(base_mounts); state=copy.deepcopy(base_state); current_image=image
  if mutator: mutator()
  with unittest.mock.patch.object(p,'command',side_effect=inspect): return p.container_check(root)
 assert check()['state']=='ok'
 assert check(lambda: host.update(Privileged=True))['state']=='finding'
 assert check(lambda: host.update(ReadonlyRootfs=False))['state']=='finding'
 assert check(lambda: host.update(CapDrop=[]))['state']=='finding'
 assert check(lambda: host.update(SecurityOpt=[]))['state']=='finding'
 assert check(lambda: mounts.append({'Destination':'/var/run/docker.sock','Source':'/var/run/docker.sock','Type':'bind','RW':True}))['state']=='finding'
 assert check(lambda: mounts[0].update(RW=True))['state']=='finding'
 assert check(lambda: state.update(Running=False))['state']=='finding'
 assert check(lambda: state['Health'].update(Status='unhealthy'))['state']=='finding'
 def wrong_image():
  global current_image; current_image='appgog-platform:evil'
 assert check(wrong_image)['state']=='finding'
 joined=' '.join(' '.join(args) for args in calls)
 assert 'Config.Env' not in joined and 'SECRET' not in joined
`));

test('backup posture reports missing, fresh, stale, unsafe key, and future timestamps without deleting data',
  { skip: !available }, () => run(`import os, pathlib, tempfile
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); folder=root/'shared/backups'; folder.mkdir(parents=True)
 key=root/'shared/.backup-key'; key.write_text('secret'); key.chmod(0o600); p.ROOT_UID=os.getuid()
 assert p.backup_check(root)['state']=='warning'
 file=folder/'appgog-20261002.tar.gz.enc'; file.write_bytes(b'data')
 assert p.backup_check(root,now=file.stat().st_mtime+5)['state']=='ok'
 assert p.backup_check(root,now=file.stat().st_mtime+90000)['state']=='warning'
 assert p.backup_check(root,now=file.stat().st_mtime-301)['state']=='unavailable'
 key.chmod(0o777); assert p.backup_check(root)['state']=='unavailable'
 assert file.read_bytes()==b'data'
`));
