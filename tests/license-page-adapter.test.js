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
import {versionThemeAssets} from '../apps/build-worker/src/license-page-adapter.js';
test('real legacy asset versions change together for static and dynamic theme entry points',()=>{
 const files=fixture();files.set('T/assets/js/root-entry.js',Buffer.from("const version = '11910';const load=name=>base+name+'?v='+version;"));
 const old='<script src="/theme/{{$theme}}/assets/js/root-entry.js?v=11910"></script><link href="assets/css/base.css?v=11910&mode=dark"><script src="https://cdn.example/assets/js/sdk.js?v=11910"></script>';
 for(const name of ['dashboard.blade.php','index.html','editor.html'])files.set('T/'+name,Buffer.from(old));
 versionThemeAssets(files,'T/','build-one');const revision=files.get('T/assets/js/root-entry.js').toString().match(/version = '([^']+)'/)[1];
 assert.notEqual(revision,'11910');for(const name of ['dashboard.blade.php','index.html','editor.html']){const output=files.get('T/'+name).toString();assert.ok(output.includes('root-entry.js?v='+revision));assert.ok(output.includes('base.css?v='+revision+'&mode=dark'));assert.ok(output.includes('https://cdn.example/assets/js/sdk.js?v=11910'));}
 const previous=files.get('T/index.html').toString();versionThemeAssets(files,'T/','build-one');assert.equal(files.get('T/index.html').toString(),previous);versionThemeAssets(files,'T/','build-two');assert.notEqual(files.get('T/index.html').toString(),previous);
});
test('unknown dynamic loader fails rather than producing a partially refreshed theme',()=>{const files=fixture();files.set('T/assets/js/root-entry.js',Buffer.from('new unsupported loader'));assert.throws(()=>versionThemeAssets(files,'T/','build'),error=>error.code==='SOURCE_ASSET_LOADER_UNSUPPORTED');});
