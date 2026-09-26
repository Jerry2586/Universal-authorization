import test from 'node:test';
import assert from 'node:assert/strict';
import {integrateLicensePage} from '../apps/build-worker/src/license-page-adapter.js';
function fixture(source='const routes = {}; let currentRoute; function navigate(){currentRoute = hash;} function initShell() {}') {
 return new Map([['T/assets/js/panel.js',Buffer.from(source)],['T/assets/js/theme-boot.js',Buffer.from('appgog_boot_background')]]);
}
test('APPGOG panel adapter adds authenticated route without altering existing routing boundary',()=>{
 const files=fixture('const publicRoutes=["login"];const routes = {}; let currentRoute; function navigate(){if(!loggedIn) return login();currentRoute = hash;} function initShell() {}');
 integrateLicensePage(files,'T/');const result=files.get('T/assets/js/panel.js').toString();
 assert.match(result,/license: \{ title: '授权与更新'/);assert.match(result,/if\(!loggedIn\) return login\(\)/);assert.match(result,/const publicRoutes=\["login"\]/);
 assert.match(result,/settings\?\.after\(license\)/);assert.match(result,/appgog-license-ready/);assert.match(result,/removeEventListener/);
 assert.throws(()=>integrateLicensePage(files,'T/'),error=>error.code==='SOURCE_ALREADY_PROTECTED');
});
test('unrecognized router fails build explicitly; other themes remain untouched',()=>{
 const files=fixture('new router with unsupported API');assert.throws(()=>integrateLicensePage(files,'T/'),error=>error.code==='SOURCE_PANEL_ADAPTER_UNSUPPORTED');
 const other=new Map([['T/assets/js/panel.js',Buffer.from('other theme')]]);integrateLicensePage(other,'T/');assert.equal(other.get('T/assets/js/panel.js').toString(),'other theme');
});
