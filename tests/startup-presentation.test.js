import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {initialLockMarkup, startupPresentationProfile} from '../apps/build-worker/src/startup-presentation.js';

const source = new Map(Object.entries({
  'APPGOG/assets/css/tokens.css': ':root{--bg-0:#05070d;}html[data-theme="light"]{--bg-0:#f5f6fb;}',
  'APPGOG/assets/js/theme-boot.js': 'appgog_boot_background',
  'APPGOG/assets/css/theme-editor.css': '.editor-body{background:#080d18;}html[data-studio-theme=light] .editor-body{background:#f3f5fa;}',
}).map(([path, value]) => [path, Buffer.from(value)]));
const profile = editor => startupPresentationProfile(source, 'APPGOG/', editor ? '<nav id="editorTabs"></nav>' : '<main>Home</main>');
function boot(editor, values = {}, blocked = false, systemDark = false) {
  const html = initialLockMarkup(profile(editor));
  const root = {dataset:{},style:{setProperty(k,v){this[k]=v;}},classList:{add(){throw Error('Appearance must not unlock');}}};
  const storage = {...values};
  runInNewContext(html.match(/<script data-appgog-startup-appearance>([\s\S]*)<\/script>/)[1], {
    document:{documentElement:root},localStorage:{getItem(key){if(blocked)throw Error('blocked');return storage[key]??null;}},
    matchMedia:()=>({matches:systemDark}),
  });
  assert.deepEqual(storage,values,'不写入或篡改业务/授权缓存');
  return root;
}
test('实际源码调色板区分公开首页与编辑器默认颜色',()=>{
  assert.deepEqual(profile(false),{editor:false,dark:'#05070d',light:'#f5f6fb'});
  assert.deepEqual(profile(true),{editor:true,dark:'#080d18',light:'#f3f5fa'});
  assert.equal(boot(false).style['--appgog-startup-bg'],'#05070d');
  assert.equal(boot(true).style['--appgog-startup-bg'],'#f3f5fa');
});
test('首次绘制恢复独立深浅偏好，旧的首页浅色缓存不污染编辑器',()=>{
  assert.equal(boot(false,{appgog_theme:'light'}).style['--appgog-startup-bg'],'#f5f6fb');
  const editor=boot(true,{appgog_theme:'light',appgog_studio_appearance:'dark'});
  assert.equal(editor.style['--appgog-startup-bg'],'#080d18');assert.equal(editor.dataset.studioTheme,'dark');
});
test('系统主题和禁止访客切换遵守现有外观配置',()=>{
  const values={appgog_theme:'light',appgog_public_appearance_v1:JSON.stringify({allow_user_appearance:'0',default_appearance:'system'})};
  assert.equal(boot(false,values,false,true).dataset.theme,'dark');
  assert.equal(boot(false,values,false,false).dataset.theme,'light');
});
test('存储禁用和非法缓存只退回颜色，不改变授权锁',()=>{
  assert.equal(boot(false,{},true).style['--appgog-startup-bg'],'#05070d');
  assert.equal(boot(true,{},true).style['--appgog-startup-bg'],'#f3f5fa');
  assert.equal(boot(false,{appgog_public_appearance_v1:'broken'}).dataset.theme,'dark');
});
test('未知主题不注入APPGOG偏好，外观脚本无法执行上传CSS内容',()=>{
  assert.equal(startupPresentationProfile(new Map(),'',''),null);
  assert.doesNotMatch(initialLockMarkup(),/data-appgog-startup-appearance/);
  const poisoned=new Map(source);poisoned.set('APPGOG/assets/css/tokens.css',Buffer.from(':root{--bg-0:url(javascript:bad);}'));
  assert.equal(startupPresentationProfile(poisoned,'APPGOG/','').dark,'#05070d');
});
test('初始锁保持内容隐藏且背景一致，主题加载层无文字，不添加解锁或动画',()=>{
  const html=initialLockMarkup(profile(false));
  assert.match(html,/html:not\(\.__appgog_unlocked\) body>\*:not\(#__appgog_gate\)\{visibility:hidden!important\}/);
  assert.match(html,/html\[data-theme-pending\]::after\{content:""!important;background:var\(--bg-0/);
  assert.doesNotMatch(html,/#f6f7fb|classList\.add|setTimeout|animation:|正在/);
});
