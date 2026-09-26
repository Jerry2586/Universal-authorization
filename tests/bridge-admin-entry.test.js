import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

test('Xboard后台扩展仅注入管理HTML，重复执行不重复注入且不修改客户页面',()=>{
 const result=spawnSync(process.env.APPGOG_TEST_PHP||'php',[resolve('tests/fixtures/bridge-admin-entry.php'),resolve('apps/build-worker/xboard-bridge/AppgogLicenseBridge/Middleware/AdminActivationEntry.php')],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/6 admin entry cases passed/);
});

test('HTTP维护在Octane未注册CLI命令时注册官方重载命令，失败和停用不得伪报成功',()=>{
 const result=spawnSync(process.env.APPGOG_TEST_PHP||'php',[resolve('tests/fixtures/bridge-http-reload.php'),resolve('apps/build-worker/xboard-bridge/AppgogLicenseBridge/Controllers/RuntimeMaintenanceController.php')],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/3 HTTP reload cases passed/);
});
