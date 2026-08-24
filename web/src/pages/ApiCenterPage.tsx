import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BookOpen, CheckCircle2, Copy, ExternalLink, FileJson, HeartPulse, KeyRound, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { api, setCsrfToken } from '../api/client';
import { allEndpoints, authEndpoints, clientEndpoints, managementEndpoints } from '../api/catalog';
import { useToast } from '../components/Toast';

interface HealthData { status: string; service?: string; version?: string }
interface ReadyData { status: string; components: Record<string, unknown> }
type CatalogTab = 'client' | 'management' | 'auth';

export function ApiCenterPage() {
  const toast = useToast();
  const [tab, setTab] = useState<CatalogTab>('client');
  const health = useQuery({ queryKey: ['health', 'global'], queryFn: () => api<HealthData>('/health'), refetchInterval: 15_000, retry: false });
  const ready = useQuery({ queryKey: ['ready', 'global'], queryFn: () => api<ReadyData>('/ready'), refetchInterval: 15_000, retry: false });
  const csrf = useMutation({
    mutationFn: () => api<{ csrf_token: string; expires_at: string }>('/admin/auth/csrf'),
    onSuccess: (data) => { setCsrfToken(data.csrf_token); toast('CSRF 安全令牌已从服务器真实刷新'); },
    onError: (error) => toast(error instanceof Error ? error.message : '安全令牌刷新失败', 'error'),
  });
  const catalogs = { client: clientEndpoints, management: managementEndpoints, auth: authEndpoints };
  const endpoints = catalogs[tab];

  async function copy(path: string) {
    try { await navigator.clipboard.writeText(path); toast('接口路径已复制'); }
    catch { toast('复制失败，请手动复制', 'error'); }
  }

  return <div className="page-stack">
    <section className="api-hero"><div><span className="eyebrow"><BookOpen /> COMPLETE API COVERAGE</span><h2>真实接口中心</h2><p>目录与当前服务端路由一一对应；管理功能由对应页面请求真实 API，客户端接口必须由持有 Ed25519 私钥的真实设备签名调用。</p></div><FileJson /></section>
    <section className="service-grid">
      <StatusCard icon={<HeartPulse />} title="进程健康" ok={health.isSuccess} loading={health.isLoading} detail={health.data ? healthLabel(health.data) : undefined} />
      <StatusCard icon={<Server />} title="基础设施就绪" ok={ready.isSuccess} loading={ready.isLoading} detail={ready.data ? JSON.stringify(ready.data.components) : undefined} />
      <article className="service-card"><span className="service-icon cyan"><ShieldCheck /></span><div><small>管理员安全会话</small><strong>Cookie + CSRF</strong><p>令牌只保存在当前页面内存</p></div><button type="button" className="icon-button refresh-token" disabled={csrf.isPending} title="从真实接口刷新 CSRF" onClick={() => csrf.mutate()}><RefreshCw /></button></article>
    </section>
    <section className="panel">
      <div className="panel-head"><div><span>ENDPOINT CATALOG · {allEndpoints.length} ROUTES</span><h3>服务端全部现有 API 接口</h3></div></div>
      <div className="subnav api-tabs">
        <button type="button" className={tab === 'client' ? 'active' : ''} onClick={() => setTab('client')}>客户端接口 ({clientEndpoints.length})</button>
        <button type="button" className={tab === 'management' ? 'active' : ''} onClick={() => setTab('management')}>管理接口 ({managementEndpoints.length})</button>
        <button type="button" className={tab === 'auth' ? 'active' : ''} onClick={() => setTab('auth')}>认证与状态 ({authEndpoints.length})</button>
      </div>
      <div className="endpoint-list complete">{endpoints.map((endpoint) => <article key={`${endpoint.method}-${endpoint.path}`}><span className={`method ${endpoint.method.toLowerCase()}`}>{endpoint.method}</span><code>{endpoint.path}</code><strong>{endpoint.name}</strong><small>{endpoint.permission ?? endpoint.ui}</small><button type="button" onClick={() => void copy(endpoint.path)}><Copy /></button></article>)}</div>
    </section>
    <section className="integration-note"><KeyRound /><div><h3>为什么不在后台伪造客户端调用</h3><p>激活、验证、心跳、释放和自助解绑依赖真实设备密钥、挑战值、签名、会话令牌与幂等键。后台不会生成假设备或 Mock 请求；请由真实客户端 SDK 调用。现有 27 个管理业务接口均已映射到产品、策略、Key、设备、审计页面。</p></div><ExternalLink /></section>
  </div>;
}

function healthLabel(data: HealthData): string {
  if (data.service && data.version) return `${data.service} · v${data.version}`;
  if (data.service) return data.service;
  return data.status || '健康检查已通过';
}

function StatusCard({ icon, title, ok, loading, detail }: { icon: React.ReactNode; title: string; ok: boolean; loading: boolean; detail?: string }) {
  return <article className="service-card"><span className={`service-icon ${ok ? 'green' : 'orange'}`}>{icon}</span><div><small>{title}</small><strong>{loading ? '检测中...' : ok ? '运行正常' : '暂不可用'}</strong><p title={detail}>{ok ? detail ?? '最近一次检查通过' : '请查看服务日志'}</p></div>{ok ? <CheckCircle2 className="ok" /> : <span className="service-light" />}</article>;
}
