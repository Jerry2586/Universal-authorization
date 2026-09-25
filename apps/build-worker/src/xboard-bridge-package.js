import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../../../packages/core/src/zip.js';

const PLUGIN_ROOT = fileURLToPath(new URL('../xboard-bridge/AppgogLicenseBridge/', import.meta.url));
let cachedPackage = null;
let cachedDescriptor = null;

function collect(directory, prefix, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      collect(absolute, `${relative}/`, files);
      continue;
    }
    if (!entry.isFile()) throw new Error(`APPGOG Xboard 插件模板包含不支持的文件类型：${absolute}`);
    files.set(relative, readFileSync(absolute));
  }
}

export function xboardBridgeDescriptor() {
  if (!cachedDescriptor) {
    cachedDescriptor = Object.freeze(JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config.json'), 'utf8')));
  }
  return cachedDescriptor;
}

export function createXboardBridgePackage() {
  if (!cachedPackage) {
    const files = new Map();
    collect(PLUGIN_ROOT, `${basename(PLUGIN_ROOT)}/`, files);
    cachedPackage = writeZip(files, { date: new Date('2026-09-25T00:00:00.000Z') });
  }
  return Buffer.from(cachedPackage);
}
