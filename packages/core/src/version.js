import { readFileSync } from 'node:fs';

// Capture the running process version once; never report a newer on-disk update as loaded.
export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(PACKAGE_VERSION)) throw new Error('Invalid package version');

export function renderVersionedHtml(source) {
  return Buffer.from(source.replaceAll('{{APPGOG_VERSION}}', PACKAGE_VERSION));
}
