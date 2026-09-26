import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';

test('native recovery login survives stale response handler after plugin files disappear',()=>{
 const root=mkdtempSync(join(tmpdir(),'appgog-admin-uninstall-'));
 try {
  for(const dir of ['Middleware','assets'])mkdirSync(join(root,dir));
  for(const name of ['Middleware/AdminActivationEntry.php','assets/admin-entry.js'])copyFileSync(resolve('apps/build-worker/xboard-bridge/AppgogLicenseBridge',name),join(root,name));
  const result=spawnSync(process.env.APPGOG_TEST_PHP||'php',[resolve('tests/fixtures/bridge-admin-uninstall.php'),root],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/native admin survives/);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('stale request-handled callback preserves response when plugin class/autoloader is removed',()=>{
 const result=spawnSync(process.env.APPGOG_TEST_PHP||'php',[resolve('tests/fixtures/bridge-provider-uninstall.php'),resolve('apps/build-worker/xboard-bridge/AppgogLicenseBridge/Providers/PluginServiceProvider.php')],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/stale provider survives/);
});
