import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeZip } from '../packages/core/src/zip.js';

const output = resolve(process.argv[2] ?? './var/demo/APPGOG-demo-theme.zip');
mkdirSync(dirname(output), { recursive: true });
const zip = writeZip(new Map([
  ['APPGOG/config.json', Buffer.from(JSON.stringify({ name: 'APPGOG Demo', version: '1.0.0' }, null, 2))],
  ['APPGOG/index.html', Buffer.from(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>APPGOG Demo</title><style>body{font-family:system-ui;background:#f4f7fb;color:#172033;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#fff;padding:40px;border-radius:18px;box-shadow:0 20px 60px #20345c1a}</style></head><body><div class="card"><h1>APPGOG Demo Theme</h1><p>这是用于验证授权打包链路的演示主题。</p></div></body></html>`, 'utf8')],
  ['APPGOG/dashboard.blade.php', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>APPGOG Dashboard</title></head><body><h1>APPGOG Dashboard Demo</h1></body></html>', 'utf8')],
]));
writeFileSync(output, zip);
console.log(output);
