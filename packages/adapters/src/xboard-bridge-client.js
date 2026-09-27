import { randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { DomainError, invariant } from '../../core/src/errors.js';

const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) denied.addSubnet(address,prefix,'ipv4');
const v6Global = new BlockList(); v6Global.addSubnet('2000::',3,'ipv6');
const v6Denied = new BlockList();
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) v6Denied.addSubnet(address,prefix,'ipv6');
export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !denied.check(address,'ipv4') : family === 6 && v6Global.check(address,'ipv6') && !v6Denied.check(address,'ipv6');
}
export function normalizeBridgeTarget(value) {
  let url; try { url = new URL(String(value)); } catch { throw new DomainError('BRIDGE_TARGET_INVALID','请输入 Xboard 的 HTTPS 站点地址'); }
  invariant(url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash,
    'BRIDGE_TARGET_INVALID','站点必须是 HTTPS 域名根地址，不包含后台路径、参数或非标准端口');
  invariant(!url.hostname.endsWith('.local') && url.hostname !== 'localhost', 'BRIDGE_TARGET_INVALID','目标必须是可公开访问的 Xboard 站点');
  return url.origin;
}

// Resolve and pin the selected public address to the TLS connection. Never follow target redirects.
export async function publicHttps(url, { method='GET', headers={}, body, maxBytes=2*1024*1024, timeout=15000, resolve=lookup }={}) {
  const parsed = new URL(url);
  normalizeBridgeTarget(parsed.origin);
  invariant(!parsed.username && !parsed.password, 'BRIDGE_TARGET_INVALID', '目标 URL 不允许携带凭证');
  let addresses;
  let dnsTimer;
  try { addresses = await Promise.race([resolve(parsed.hostname.replace(/^\[|\]$/g,''), { all:true }), new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('dns deadline')), timeout); })]); }
  catch { throw new DomainError('BRIDGE_DNS_FAILED','目标域名解析失败或超时',502); }
  finally { clearTimeout(dnsTimer); }
  invariant(addresses.length && addresses.every(a=>publicAddress(a.address)), 'BRIDGE_TARGET_PRIVATE','禁止连接本机、内网或保留地址',400);
  const chosen = addresses[0];
  return new Promise((resolveResult,reject)=>{
    const timer = setTimeout(()=>req.destroy(new Error('deadline')),timeout);
    const req = httpsRequest(parsed,{method,headers,agent:false,lookup:(_host,options,callback)=>{
      if(options.all) callback(null,[chosen]); else callback(null,chosen.address,chosen.family);
    }},res=>{
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)req.destroy(new Error('size'));else chunks.push(chunk);});
      res.on('end',()=>{clearTimeout(timer);resolveResult({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)});});
      res.on('error',()=>{clearTimeout(timer);reject(new DomainError('BRIDGE_NETWORK_FAILED','目标响应中断，请检查服务状态',502));});
    });
    req.on('error',()=>{clearTimeout(timer);reject(new DomainError('BRIDGE_NETWORK_FAILED','目标连接失败、超时或响应过大，请检查 HTTPS 和服务状态',502));});
    req.end(body);
  });
}

export function createXboardBridgeClient({ transport=publicHttps }={}) {
  async function call(connection,path,body,extra={}) {
    const raw = Buffer.isBuffer(body) ? body : body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const response=await transport(connection.origin+path,{method:raw?'POST':'GET',body:raw,headers:{
      accept:'application/json',...(connection.token?{authorization:connection.token}:{}),
      ...(raw?{'content-type':'application/json','content-length':raw.length}:{}),...extra,
    }});
    invariant(response.status>=200&&response.status<300,'BRIDGE_REMOTE_REJECTED',`Xboard 请求失败（HTTP ${response.status}）；请检查登录、插件启用状态和目标站点`,502);
    let data;try{data=JSON.parse(response.body.toString('utf8'));}catch{throw new DomainError('BRIDGE_RESPONSE_INVALID','Xboard 返回了非 JSON 响应',502);}
    invariant(data?.status!=='fail'&&data?.status!=='error','BRIDGE_REMOTE_REJECTED','Xboard 拒绝了操作，请检查插件管理日志',502);
    return data;
  }
  const admin=(c,path,body,extra)=>call(c,'/api/v2/'+c.adminPath+path,body,extra);
  return {
    async connect(input) {
      const origin=normalizeBridgeTarget(input.origin);
      invariant(/^[A-Za-z0-9_-]{1,128}$/.test(input.admin_path||''),'BRIDGE_PATH_INVALID','后台安全路径仅填写路径标识，不含斜杠或域名');
      invariant(typeof input.email==='string'&&input.email.length<=254&&input.email.includes('@')&&typeof input.password==='string'&&input.password.length>0&&input.password.length<=1024,'BRIDGE_LOGIN_REQUIRED','请输入目标 Xboard 管理员邮箱和密码');
      const result=await call({origin},'/api/v1/passport/auth/login',{email:input.email,password:input.password});
      invariant(typeof result.data?.auth_data==='string'&&result.data.auth_data.length<8192,'BRIDGE_LOGIN_FAILED','Xboard 登录失败或返回格式不兼容',502);
      const c={origin,adminPath:input.admin_path,token:result.data.auth_data};
      return c;
    },
    async inspect(c) {
      const result=await admin(c,'/plugin/getPlugins');
      invariant(Array.isArray(result.data),'BRIDGE_PLUGIN_LIST_INVALID','无法读取 Xboard 插件列表',502);
      const plugin=result.data.find(p=>p.code==='appgog_license_bridge');
      invariant(plugin,'BRIDGE_NOT_INSTALLED','目标未安装授权桥，请先在原生插件管理完成首次安装',409);
      invariant(plugin.is_enabled===true||plugin.is_enabled===1,'BRIDGE_DISABLED','授权桥已停用，请在原生后台确认并启用；此处不会自动恢复被停用的插件',409);
      const health=await call(c,'/api/v1/appgog-license-bridge/health');
      invariant(health.ok===true&&health.code==='appgog_license_bridge'&&/^\d+\.\d+\.\d+$/.test(health.version||'')&&health.identity?.installation_id,
        'BRIDGE_HEALTH_INVALID','授权桥运行状态无效',502);
      invariant(plugin.version===health.version,'BRIDGE_RUNTIME_STALE','插件文件版本与运行进程不一致，请先从原生后台重载应用',409);
      return {version:health.version,identity:health.identity.installation_id};
    },
    async upload(c,buffer,version) {
      const boundary='APPGOGBridge'+randomUUID().replaceAll('-','');
      const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="appgog-license-bridge-${version}.zip"\r\nContent-Type: application/zip\r\n\r\n`),buffer,Buffer.from(`\r\n--${boundary}--\r\n`)]);
      return admin(c,'/plugin/upload',body,{'content-type':'multipart/form-data; boundary='+boundary});
    },
    repair(c) { return call(c,'/api/v1/appgog-license-bridge/runtime/repair',{}); },
  };
}
