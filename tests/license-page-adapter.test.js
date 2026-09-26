import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
function fixture(source='const routes = {}; let currentRoute; function navigate(){currentRoute = hash;} function initShell() {}') {
 return new Map([['T/assets/js/panel.js',Buffer.from(source)],['T/assets/js/theme-boot.js',Buffer.from('appgog_boot_background')]]);
}
test('packager preserves user panel source and does not inject owner license routes',()=>{const engine=fs.readFileSync(new URL('../apps/build-worker/src/engine.js',import.meta.url),'utf8');assert.doesNotMatch(engine,/integrateLicensePage/);const files=fixture();const original=files.get('T/assets/js/panel.js');versionThemeAssets(files,'T/','build');assert.deepEqual(files.get('T/assets/js/panel.js'),original);});
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
