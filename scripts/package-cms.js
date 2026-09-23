import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { writeZip } from '../packages/core/src/zip.js';

const root = resolve(process.cwd());
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outputDirectory = join(root, 'dist');
const output = join(outputDirectory, `APPGOG-CMS-${manifest.version}.zip`);
const files = new Map();
const rootFiles = ['.env.example', '.gitignore', 'compose.yaml', 'Dockerfile', 'package.json', 'README.md'];
const sourceDirectories = ['apps', 'packages', 'scripts', 'docs'];

function addFile(path) {
  const name = relative(root, path).split(sep).join('/');
  files.set(`APPGOG-CMS/${name}`, readFileSync(path));
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) addFile(path);
  }
}

for (const name of rootFiles) {
  const path = join(root, name);
  if (statSync(path).isFile()) addFile(path);
}
for (const name of sourceDirectories) walk(join(root, name));

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(output, writeZip(files, { date: new Date() }), { mode: 0o600 });
console.log(`CMS 安装包已生成：${output}`);
console.log(`文件数量：${files.size}`);
console.log(`安装包名称：${basename(output)}`);
