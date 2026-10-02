#!/usr/bin/env sh
# Ephemeral CI only. Never runs on an existing APPGOG security installation.
set -eu
[ "${GITHUB_ACTIONS:-}" = true ] || { echo 'Only isolated GitHub Actions runners are supported' >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo 'Requires root on the isolated runner' >&2; exit 1; }
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
TEST_ROOT=/appgog-host-security-ci
UNIT=/etc/systemd/system/appgog-host-security.service
STATE=/var/lib/appgog-security
AGENT=/usr/local/lib/appgog-security/host-security-agent.py
[ -d /run/systemd/system ] || { echo 'Running systemd required' >&2; exit 1; }
for target in "$TEST_ROOT" "$UNIT" "$STATE" "$AGENT"; do
  [ ! -e "$target" ] && [ ! -L "$target" ] || { echo "Existing installation: $target" >&2; exit 1; }
done
install -d -o root -g root -m 0700 "$TEST_ROOT/releases/candidate" "$TEST_ROOT/shared"
RELEASE=$TEST_ROOT/releases/candidate
cp -R "$SOURCE/apps" "$SOURCE/packages" "$SOURCE/scripts" "$RELEASE/"
for name in package.json pnpm-lock.yaml release-contract.json Dockerfile compose.yaml compose.license.yaml compose.build.yaml Caddyfile Caddyfile.license Caddyfile.build .env.example .env.docker.example .dockerignore install-docker.sh; do cp "$SOURCE/$name" "$RELEASE/$name"; done
chown -R root:root "$TEST_ROOT"
ln -s releases/candidate "$TEST_ROOT/current"
printf 'AUTH_DOMAIN=license.appgog.test
BUILD_DOMAIN=build.appgog.test
' > "$TEST_ROOT/shared/.env"
chmod 600 "$TEST_ROOT/shared/.env"
export APPGOG_INSTALL_ROOT=$TEST_ROOT APPGOG_HOST_ENV_FILE=$TEST_ROOT/shared/.env PYTHONDONTWRITEBYTECODE=1
lifecycle() { sh "$RELEASE/scripts/install-host-security.sh" "$1"; }
cleanup() {
  result=$?
  trap - 0 INT TERM
  if [ "$result" -ne 0 ]; then journalctl -u appgog-host-security.service --no-pager -n 35 || true; fi
  lifecycle uninstall || true
  # The baseline/history/group remain as required by the uninstall contract.
  exit "$result"
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM
# Do not make lifecycle acceptance depend on a third-party feed CDN.
# An invalid CI-only daily file intentionally leaves production malware status unknown.
if [ ! -f /var/lib/clamav/daily.cvd ] && [ ! -f /var/lib/clamav/daily.cld ]; then
  systemctl stop clamav-freshclam.service || true
  printf 'CI-only invalid daily database; never a trusted feed' > /var/lib/clamav/daily.cvd
fi
# Reject environment overrides before privileged scripts can execute.
UNTRUSTED=$TEST_ROOT/untrusted
install -d -m 0777 "$UNTRUSTED/scripts"
printf 'touch %s/unsafe-executed\n' "$TEST_ROOT" > "$UNTRUSTED/scripts/install-host-security.sh"
if APPGOG_INSTALL_ROOT="$UNTRUSTED" sh "$SOURCE/scripts/security-local.sh" engine; then echo 'Untrusted local root accepted' >&2; exit 1; fi
if APPGOG_ROOT="$UNTRUSTED" sh "$SOURCE/scripts/appgog.sh" status; then echo 'Untrusted manager root accepted' >&2; exit 1; fi
[ ! -e "$TEST_ROOT/unsafe-executed" ]
lifecycle prepare
lifecycle install
gid=$(getent group appgog-security | cut -d: -f3)
[ "$(stat -c '%u:%g:%a' /run/appgog-security)" = "0:$gid:750" ]
[ "$(stat -c '%u:%g:%a' /run/appgog-security/scan.sock)" = "0:$gid:660" ]
[ "$(stat -c '%u:%g:%a' "$STATE/baseline.json")" = '0:0:600' ]
[ "$(stat -c '%u:%g:%a' "$STATE/host-baseline.json")" = '0:0:600' ]
systemctl is-active --quiet appgog-host-security.service
systemctl is-enabled --quiet appgog-local-response.timer
systemctl is-active --quiet appgog-local-response.timer
[ "$(stat -c '%u:%g:%a' /usr/local/sbin/appgog-security-response)" = '0:0:700' ]
[ "$(stat -c '%u:%g:%a' /usr/local/lib/appgog-security/response-config.json)" = '0:0:600' ]
[ "$(stat -c '%u:%g:%a' /usr/local/lib/appgog-security/release-public.pem)" = '0:0:600' ]
response_hash=$(sha256sum /usr/local/lib/appgog-security/host-security-response.py | cut -d' ' -f1)
config_hash=$(sha256sum /usr/local/lib/appgog-security/response-config.json | cut -d' ' -f1)
key_hash=$(sha256sum /usr/local/lib/appgog-security/release-public.pem | cut -d' ' -f1)
program_hash=$(sha256sum "$STATE/baseline.json" | cut -d' ' -f1)
host_hash=$(sha256sum "$STATE/host-baseline.json" | cut -d' ' -f1)
printf '
// acceptance-only mutation
' >> "$RELEASE/apps/web/public/assets/portal/security-poller.js"
lifecycle install
[ "$(sha256sum "$STATE/baseline.json" | cut -d' ' -f1)" = "$program_hash" ]
[ "$(sha256sum "$STATE/host-baseline.json" | cut -d' ' -f1)" = "$host_hash" ]
attempt=0
while [ "$attempt" -lt 90 ]; do
  curl -fsS --max-time 5 --unix-socket /run/appgog-security/scan.sock http://localhost/status > "$TEST_ROOT/report.json"
  if jq -e '.state == "finished"' "$TEST_ROOT/report.json" >/dev/null; then break; fi
  attempt=$((attempt + 1)); sleep 2
done
jq -e '.state == "finished" and any(.checks[]; .id == "integrity.program" and .state == "finding") and (.history | length > 0)' "$TEST_ROOT/report.json" >/dev/null
# A rejected upgrade must restore the prior active executable and service.
agent_hash=$(sha256sum "$AGENT" | cut -d' ' -f1)
printf '
invalid python syntax (
' >> "$RELEASE/scripts/host-security-agent.py"
if lifecycle install; then echo 'Broken candidate unexpectedly installed' >&2; exit 1; fi
[ "$(sha256sum "$AGENT" | cut -d' ' -f1)" = "$agent_hash" ]
systemctl is-active --quiet appgog-host-security.service
cp "$SOURCE/scripts/host-security-agent.py" "$RELEASE/scripts/host-security-agent.py"
[ "$(sha256sum /usr/local/lib/appgog-security/host-security-response.py | cut -d' ' -f1)" = "$response_hash" ]
[ "$(sha256sum /usr/local/lib/appgog-security/response-config.json | cut -d' ' -f1)" = "$config_hash" ]
[ "$(sha256sum /usr/local/lib/appgog-security/release-public.pem | cut -d' ' -f1)" = "$key_hash" ]
systemctl is-active --quiet appgog-local-response.timer
# A later-phase error must restore all independent files and a stopped-but-enabled timer.
systemctl stop appgog-local-response.timer
printf '
invalid response syntax (
' >> "$RELEASE/scripts/host-security-response.py"
if lifecycle install; then echo 'Broken response candidate unexpectedly installed' >&2; exit 1; fi
[ "$(sha256sum /usr/local/lib/appgog-security/host-security-response.py | cut -d' ' -f1)" = "$response_hash" ]
systemctl is-enabled --quiet appgog-local-response.timer
if systemctl is-active --quiet appgog-local-response.timer; then echo 'Rollback changed prior inactive timer state' >&2; exit 1; fi
cp "$SOURCE/scripts/host-security-response.py" "$RELEASE/scripts/host-security-response.py"
lifecycle install
systemctl is-active --quiet appgog-local-response.timer
# Independent key pin mismatch fails without silently rotating the trust root.
printf 'invalid key
' > "$RELEASE/scripts/release-public.pem"
if lifecycle install; then echo 'Changed independent signing pin accepted' >&2; exit 1; fi
[ "$(sha256sum /usr/local/lib/appgog-security/release-public.pem | cut -d' ' -f1)" = "$key_hash" ]
cp "$SOURCE/scripts/release-public.pem" "$RELEASE/scripts/release-public.pem"
# Verify real non-root containers can use only the explicitly granted socket.
docker pull node:24-bookworm-slim
client='const http=require("http"); const r=http.get({socketPath:"/scan/scan.sock",path:"/status"},s=>{let b="";s.on("data",c=>b+=c);s.on("end",()=>{if(s.statusCode!==200||!JSON.parse(b).state)process.exit(2)});});r.on("error",()=>process.exit(3));'
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user "65534:$gid" --group-add "$gid" -v /run/appgog-security:/scan:ro node:24-bookworm-slim node -e "$client"
if docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 -v /run/appgog-security:/scan:ro node:24-bookworm-slim node -e "$client"; then echo 'Unauthorized container accessed scan socket' >&2; exit 1; fi
python3 -I "$SOURCE/scripts/verify-host-security-engine.py" "$SOURCE/scripts/host-security-agent.py"
python3 -I "$SOURCE/scripts/verify-host-security-response-linux.py" "$TEST_ROOT"
# Successful signed repair creates a new approved source baseline; preserve that exact baseline thereafter.
program_hash=$(sha256sum "$STATE/baseline.json" | cut -d' ' -f1)
lifecycle uninstall
[ ! -e "$UNIT" ] && [ ! -e "$AGENT" ] && [ ! -e /run/appgog-security/scan.sock ]
[ ! -e /usr/local/sbin/appgog-security-response ]
[ ! -e /etc/systemd/system/appgog-local-response.timer ]
[ ! -e /etc/systemd/system/appgog-local-response.service ]
[ "$(sha256sum /usr/local/lib/appgog-security/response-config.json | cut -d' ' -f1)" = "$config_hash" ]
[ "$(sha256sum /usr/local/lib/appgog-security/release-public.pem | cut -d' ' -f1)" = "$key_hash" ]
if systemctl is-active --quiet appgog-local-response.timer; then echo 'Response timer survived uninstall' >&2; exit 1; fi
[ "$(sha256sum "$STATE/baseline.json" | cut -d' ' -f1)" = "$program_hash" ]
[ "$(sha256sum "$STATE/host-baseline.json" | cut -d' ' -f1)" = "$host_hash" ]
[ -s "$STATE/events.json" ] && getent group appgog-security >/dev/null
# Released history survives repeated uninstall and must not block a safe reinstall.
incident_hash=$(sha256sum "$STATE/incident.json" | cut -d' ' -f1)
cp -p "$STATE/incident.json" "$TEST_ROOT/released-incident.json"
lifecycle uninstall
[ "$(sha256sum "$STATE/incident.json" | cut -d' ' -f1)" = "$incident_hash" ]
# No CLI remains: active, malformed, oversized, foreign or linked records stay fenced.
for invalid in active malformed oversized foreign-root bad-container unsafe-mode symlink; do
  python3 -I - "$STATE/incident.json" "$TEST_ROOT/released-incident.json" "$invalid" <<'PY'
import json,os,sys
path,backup,case=sys.argv[1:]
if os.path.lexists(path): os.unlink(path)
item=json.load(open(backup))
if case == 'symlink':
    os.symlink(backup,path)
else:
    if case == 'active': item['state']='contained'
    if case == 'foreign-root': item['root']='/foreign-installation'
    if case == 'bad-container': item['container_id']='short-id'
    payload='invalid JSON' if case == 'malformed' else json.dumps(item)
    if case == 'oversized': payload += ' ' * 32769
    with open(path,'w') as stream: stream.write(payload)
    os.chmod(path,0o666 if case == 'unsafe-mode' else 0o600)
PY
  for action in install uninstall; do
    if lifecycle "$action" > "$TEST_ROOT/incident-guard.log" 2>&1; then
      echo "Invalid retained incident accepted: $invalid / $action" >&2; exit 1
    fi
    [ ! -e /usr/local/sbin/appgog-security-response ] && [ ! -e "$UNIT" ]
    [ "$(sha256sum /usr/local/lib/appgog-security/response-config.json | cut -d' ' -f1)" = "$config_hash" ]
    [ "$(sha256sum "$STATE/baseline.json" | cut -d' ' -f1)" = "$program_hash" ]
  done
done
rm -f "$STATE/incident.json"
cp -p "$TEST_ROOT/released-incident.json" "$STATE/incident.json"
lifecycle install
[ "$(sha256sum "$STATE/incident.json" | cut -d' ' -f1)" = "$incident_hash" ]
systemctl is-active --quiet appgog-host-security.service
systemctl is-active --quiet appgog-local-response.timer
[ "$(sha256sum "$STATE/baseline.json" | cut -d' ' -f1)" = "$program_hash" ]
[ "$(sha256sum "$STATE/host-baseline.json" | cut -d' ' -f1)" = "$host_hash" ]
echo 'Isolated Linux agent: install, upgrade, rollback, socket grants, engine and preserving uninstall passed'
