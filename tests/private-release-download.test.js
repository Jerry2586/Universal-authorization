import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const library = join(root, 'scripts/lib/release-download.sh');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'appgog-private-release-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const token = join(dir, 'token');
  writeFileSync(token, 'github_pat_example123\n', { mode: 0o600 });
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
output=''; endpoint=''; header=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -H) case "$2" in @*) header=\${2#@} ;; esac; shift 2 ;;
    https://*) endpoint=$1; shift ;;
    *) shift ;;
  esac
done
[ -n "$header" ] && [ "$(cat "$header")" = 'Authorization: Bearer github_pat_example123' ] || exit 22
case "$endpoint" in
  https://api.github.com/repos/Jerry2586/Universal-authorization/releases/latest|https://api.github.com/repos/Jerry2586/Universal-authorization/releases/tags/v1.2.61)
    if [ "$TEST_MISSING" = 1 ]; then printf '{"assets":[]}' > "$output"; else printf '{"assets":[{"name":"release-manifest.json","state":"uploaded","url":"https://api.github.com/repos/Jerry2586/Universal-authorization/releases/assets/42"}]}' > "$output"; fi ;;
  https://api.github.com/repos/Jerry2586/Universal-authorization/releases/assets/42)
    printf 'signed manifest bytes' > "$output" ;;
  *) exit 22 ;;
esac
`, { mode: 0o700 });
  return { dir, token, bin };
}

function run(source, data, expression) {
  return spawnSync('sh', ['-c', `. "$LIBRARY"; ${expression}`], {
    encoding: 'utf8',
    env: { ...process.env, LIBRARY: source, APPGOG_GITHUB_TOKEN_FILE: data.token, PATH: `${data.bin}:${process.env.PATH}` },
  });
}

test('private GitHub release requires a protected read-only token and never falls back to a proxy', { skip: process.platform === 'win32' }, () => {
  const data = fixture();
  const destination = join(data.dir, 'manifest');
  try {
    let result = spawnSync('sh', ['-c', '. "$LIBRARY"; appgog_latest_release_sources; appgog_download_release_file appgog-private-github:latest release-manifest.json "$DESTINATION"'], {
      encoding: 'utf8',
      env: { ...process.env, LIBRARY: library, DESTINATION: destination, APPGOG_GITHUB_TOKEN_FILE: data.token, PATH: `${data.bin}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'appgog-private-github:latest');
    assert.equal(readFileSync(destination, 'utf8'), 'signed manifest bytes');
    assert.ok(!(`${result.stdout}${result.stderr}`).includes('github_pat_example123'));

    result = spawnSync('sh', ['-c', '. "$LIBRARY"; appgog_download_release_file appgog-private-github:latest release-manifest.json "$DESTINATION"'], {
      encoding: 'utf8',
      env: { ...process.env, LIBRARY: library, DESTINATION: destination, TEST_MISSING: '1', APPGOG_GITHUB_TOKEN_FILE: data.token, PATH: `${data.bin}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0, 'missing asset must be rejected');

    chmodSync(data.token, 0o644);
    result = run(library, data, 'appgog_download_release_file appgog-private-github:latest release-manifest.json /dev/null');
    assert.notEqual(result.status, 0, 'world-readable token must be rejected');
    chmodSync(data.token, 0o600);
    result = run(library, data, 'appgog_download_release_file appgog-private-github:latest absent.zip /dev/null');
    assert.notEqual(result.status, 0, 'missing or unexpected asset must be rejected');
    result = run(library, data, 'appgog_download_release_file appgog-private-github:latest release-manifest.json /dev/null');
    assert.equal(result.status, 0, result.stderr);
    rmSync(data.token);
    result = run(library, data, 'appgog_download_release_file appgog-private-github:latest release-manifest.json /dev/null');
    assert.notEqual(result.status, 0, 'missing token must be rejected');
  } finally {
    rmSync(data.dir, { recursive: true, force: true });
  }
});

test('standalone installer embeds the same private asset download code as the library', () => {
  const source = readFileSync(library, 'utf8').replaceAll('\r\n', '\n');
  const installer = readFileSync(join(root, 'install-docker.sh'), 'utf8').replaceAll('\r\n', '\n');
  const begin = 'appgog_private_release_enabled() {';
  const end = '\nappgog_latest_release_sources() {';
  const implementation = source.slice(source.indexOf(begin), source.indexOf(end));
  assert.ok(implementation.length > 100);
  assert.ok(installer.includes(implementation), 'standalone installer has diverged from the shared implementation');
});
