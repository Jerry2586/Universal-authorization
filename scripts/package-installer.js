import { createHash } from 'node:crypto';

// Text-only self-extracting installer: uploaded directly, no unzip step or Git credentials required.
export function createInstaller(archive, releaseName, { signature = null, publicKey = '' } = {}) {
  if (!/^[A-Za-z0-9.-]+$/.test(releaseName)) throw new Error('Invalid release directory');
  const hash = createHash('sha256').update(archive).digest('hex');
  const encodedSignature = signature ? Buffer.from(signature).toString('base64') : '';
  const encodedPublicKey = publicKey ? Buffer.from(publicKey).toString('base64') : '';
  const signatureVerification = signature && publicKey ? `
printf '%s' '${encodedSignature}' | base64 -d > "$work/archive.sig"
printf '%s' '${encodedPublicKey}' | base64 -d > "$work/release-public.pem"
openssl pkeyutl -verify -pubin -inkey "$work/release-public.pem" -rawin -in "$work/source.zip" -sigfile "$work/archive.sig" >/dev/null
` : '';
  const header = `#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo '请使用 root 或 sudo 执行安装文件' >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo '仅支持 Linux' >&2; exit 1; }
missing=false
for tool in unzip base64 sha256sum openssl; do command -v "$tool" >/dev/null 2>&1 || missing=true; done
if [ "$missing" = true ]; then
  echo '正在补齐自解压所需工具...'
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y unzip coreutils openssl
  elif command -v dnf >/dev/null 2>&1; then dnf install -y unzip coreutils openssl
  elif command -v yum >/dev/null 2>&1; then yum install -y unzip coreutils openssl
  else echo '未找到支持的软件包管理器' >&2; exit 1
  fi
fi
umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' 0
trap 'exit 130' 2
trap 'exit 143' 15
line=$(awk '/^__APPGOG_ARCHIVE_BELOW__$/ { print NR + 1; exit }' "$0")
[ -n "$line" ] || { echo '安装文件不完整' >&2; exit 1; }
tail -n +"$line" "$0" | base64 -d > "$work/source.zip"
printf '%s  %s\n' '${hash}' "$work/source.zip" | sha256sum -c -
${signatureVerification}
unzip -q "$work/source.zip" -d "$work"
sh "$work/${releaseName}/scripts/install-linux.sh" --source-dir "$work/${releaseName}" "$@"
exit 0
__APPGOG_ARCHIVE_BELOW__
`;
  return Buffer.from(header + archive.toString('base64').match(/.{1,76}/g).join('\n') + '\n');
}
