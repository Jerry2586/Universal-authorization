import { createHash, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readZip, writeZip } from '../../core/src/zip.js';
import { invariant } from '../../core/src/errors.js';
// Fixed release hosts may use Node's configured outbound proxy. Customer targets use
// the separate DNS-pinned transport and never inherit a proxy that could bypass IP checks.
export async function releaseTransport(url, { headers, maxBytes, timeout }) {
  const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  if ([301,302,303,307,308].includes(response.status)) {
    await response.body?.cancel();
    return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.alloc(0) };
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    invariant(size <= maxBytes, 'BRIDGE_RELEASE_TOO_LARGE', '发布响应超出大小限制', 502);
    chunks.push(Buffer.from(chunk));
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.concat(chunks) };
}

const root='https://api.github.com/repos/Jerry2586/Universal-authorization/releases';
const key=readFileSync(new URL('../../../scripts/release-public.pem',import.meta.url),'utf8');
const trusted = host => ['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(host);
export function bridgeFromSignedRelease(manifestBytes,signature,zipBytes,{publicKey=key,version}={}) {
  invariant(verify(null,manifestBytes,publicKey,signature),'BRIDGE_RELEASE_SIGNATURE','授权桥发布清单签名无效',502);
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  invariant(manifest.schema===2&&manifest.product==='appgog'&&manifest.version===version&&manifest.zip_name===`APPGOG-Packaging-Licensing-System-${version}.zip`, 'BRIDGE_RELEASE_INVALID','发布清单版本或产品不匹配',502);
  invariant(createHash('sha256').update(zipBytes).digest('hex')===manifest.zip_sha256,'BRIDGE_RELEASE_HASH','授权桥源制品摘要校验失败',502);
  const all=readZip(zipBytes,{maxEntries:1500,maxSingleFileBytes:32*1024*1024,maxUncompressedBytes:256*1024*1024});
  const prefix=`APPGOG-Packaging-Licensing-System-${version}/apps/build-worker/xboard-bridge/`;
  const files=new Map([...all].filter(([name])=>name.startsWith(prefix)).map(([name,data])=>[name.slice(prefix.length),data]));
  let descriptor;try{descriptor=JSON.parse(files.get('AppgogLicenseBridge/config.json'));}catch{}
  invariant(descriptor?.code==='appgog_license_bridge'&&/^\d+\.\d+\.\d+$/.test(descriptor.version||'')&&files.has('AppgogLicenseBridge/Plugin.php'),'BRIDGE_PACKAGE_INVALID','签名制品中缺少有效授权桥',502);
  const buffer=writeZip(files,{date:new Date('2026-09-28T00:00:00Z')});
  invariant(buffer.length<=10*1024*1024,'BRIDGE_PACKAGE_TOO_LARGE','授权桥包超过 Xboard 官方 10 MB 上传限制',502);
  return {version:descriptor.version,release_version:version,buffer};
}
export function createBridgeReleaseSource({transport=releaseTransport,publicKey=key}={}) {
  let cached=null;
  async function download(url,maxBytes,depth=0) {
    const parsed=new URL(url);
    invariant(parsed.protocol==='https:'&&trusted(parsed.hostname),'BRIDGE_RELEASE_URL','发布下载地址不受信任',502);
    const result=await transport(url,{maxBytes,timeout:60000,headers:{accept:parsed.hostname==='api.github.com'?'application/vnd.github+json':'application/octet-stream','user-agent':'APPGOG-Bridge-Updater'}});
    if([301,302,303,307,308].includes(result.status)) {
      invariant(depth<4&&result.headers.location,'BRIDGE_RELEASE_REDIRECT','发布下载重定向异常',502);
      return download(new URL(result.headers.location,url).href,maxBytes,depth+1);
    }
    invariant(result.status===200,'BRIDGE_RELEASE_UNAVAILABLE',`发布源不可用（HTTP ${result.status}）`,502);
    return result.body;
  }
  return {
    async latest() {
      const release=JSON.parse((await download(root+'/latest',1024*1024)).toString('utf8'));
      invariant(/^v\d+\.\d+\.\d+$/.test(release.tag_name||'')&&!release.draft&&!release.prerelease,'BRIDGE_RELEASE_INVALID','没有可用的正式签名版本',502);
      const fingerprint=JSON.stringify([release.id,release.tag_name,(release.assets||[]).map(a=>[a.id,a.name,a.updated_at,a.size])]);
      if(cached?.fingerprint===fingerprint) return cached.artifact;
      const version=release.tag_name.slice(1),assets=release.assets||[];
      const asset=name=>{const matches=assets.filter(x=>x.name===name);invariant(matches.length===1,'BRIDGE_RELEASE_INCOMPLETE','发布附件缺失或重复',502);return matches[0].browser_download_url;};
      const manifest=await download(asset('release-manifest.json'),65536);
      const signature=await download(asset('release-manifest.json.sig'),1024);
      invariant(verify(null,manifest,publicKey,signature),'BRIDGE_RELEASE_SIGNATURE','发布清单签名无效',502);
      const zip=await download(asset(`APPGOG-Packaging-Licensing-System-${version}.zip`),64*1024*1024);
      const artifact=bridgeFromSignedRelease(manifest,signature,zip,{publicKey,version});
      cached={fingerprint,artifact};return artifact;
    },
  };
}
