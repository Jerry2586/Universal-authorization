import { readFileSync } from 'node:fs';

// Capture the running process version once; never report a newer on-disk update as loaded.
export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(PACKAGE_VERSION)) throw new Error('Invalid package version');

export function renderVersionedHtml(source) {
  const html = source.replaceAll('{{APPGOG_VERSION}}', PACKAGE_VERSION)
    .replace(/((?:src|href)=["'])\/assets\/(?!v\/)/g, '$1/assets/v/' + PACKAGE_VERSION + '/')
    .replace('</head>', '<meta name="appgog-document-version" content="' + PACKAGE_VERSION + '"></head>');
  return Buffer.from(html);
}

// Versioned module paths keep relative imports in the same browser cache namespace.
export function portalAssetPath(pathname) {
  return pathname.replace(/^\/assets\/v\/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\//, '/assets/');
}
