import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Execute the actual startup module with process/files/child spawning substituted.
// This catches unresolved names in the top-level lifecycle before Linux Docker CI.
const body = readFileSync(new URL('../scripts/docker/start.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const Startup = Object.getPrototypeOf(async function(){}).constructor;
for (const [role, unpaired, expected] of [
  ['all', false, ['license-center','build-center','build-worker','caddy']],
  ['license', false, ['license-center','caddy']],
  ['build', false, ['build-center','build-worker','caddy']],
  ['build', true, ['build-standby','caddy']],
]) {
  test('Business container startup has only supported processes: '+role+(unpaired?' unpaired':''), async () => {
    let captured;
    const processStub = {env:{PATH:'fixture',SECURITY_CLOUD_URL:'https://legacy-cloud.example.test',SECURITY_CLOUD_LICENSE_NODE_ID:'legacy-license',SECURITY_CLOUD_BUILD_NODE_ID:'legacy-build',APPGOG_STARTUP_TIMEOUT_MS:'10000'},execPath:'node',on(){}};
    const startup = new Startup('writeFileSync','rmSync','initialize','supervise','checkHealth','process','console',body);
    await startup(()=>{},()=>{},()=>({authUrl:'https://auth.example.test',buildUrl:'https://build.example.test',deploymentRole:role,unpaired}),
      options=>{captured=options;return {ready:Promise.resolve([]),done:Promise.resolve(0),stop(){}};},
      async()=>{},processStub,{log(){},error(message){throw new Error(message);}});
    assert.deepEqual(captured.specs.map(item=>item.name),expected);
    assert.equal(processStub.exitCode,0);
    for(const spec of captured.specs) assert.equal(Object.keys(spec.env).some(key=>key.startsWith('SECURITY_')),false);
  });
}
