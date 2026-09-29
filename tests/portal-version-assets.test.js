import test from 'node:test';
import assert from 'node:assert/strict';
import {PACKAGE_VERSION,renderVersionedHtml,portalAssetPath} from '../packages/core/src/version.js';

test('门户HTML版本标记和JS/CSS资源同版本，模块相对导入继承命名空间',()=>{
 const html=renderVersionedHtml('<head><script src="/assets/admin-portal.js" type="module"></script><link href="/assets/site.css"></head>').toString();
 assert.ok(html.includes('content="'+PACKAGE_VERSION+'"'));
 assert.ok(html.includes('/assets/v/'+PACKAGE_VERSION+'/admin-portal.js'));
 assert.ok(html.includes('/assets/v/'+PACKAGE_VERSION+'/site.css'));
 const imported=new URL('./portal/admin-page.js','https://fixture.test/assets/v/'+PACKAGE_VERSION+'/admin-portal.js');
 assert.equal(portalAssetPath(imported.pathname),'/assets/portal/admin-page.js');
 assert.equal(portalAssetPath('/web/admin/plans'),'/web/admin/plans');
 assert.equal(portalAssetPath('/assets/v/bad/portal/admin-page.js'),'/assets/v/bad/portal/admin-page.js');
});
