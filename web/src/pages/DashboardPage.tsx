import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpRight, Boxes, Clock3, KeyRound, Plus, ShieldCheck, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, fetchAllPages } from '../api/client';
import type { License, Policy, Product } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { PermissionNotice } from '../components/AdminForms';

const statusText: Record<string, string> = { CREATED: '未激活', ACTIVE: '生效中', SUSPENDED: '已暂停', EXPIRED: '已过期', REVOKED: '已吊销', DISABLED: '已禁用' };
interface HealthData { status: string; service?: string; version?: string }

export function DashboardPage() {
  const { has } = useAuth();
  const canReadProducts = has('products.read');
  const canReadLicenses = has('licenses.read');
  const canWriteLicenses = has('licenses.write');
  const products = useQuery({ queryKey: ['products', 'dashboard-all'], queryFn: () => fetchAllPages<Product>('/admin/v1/products'), enabled: canReadProducts });
  const policies = useQuery({ queryKey: ['policies', 'dashboard-all'], queryFn: () => fetchAllPages<Policy>('/admin/v1/license-policies'), enabled: canReadLicenses });
  const keys = useQuery({ queryKey: ['keys', 'dashboard-all'], queryFn: () => fetchAllPages<License>('/admin/v1/license-keys'), enabled: canReadLicenses });
  const health = useQuery({ queryKey: ['health', 'global'], queryFn: () => api<HealthData>('/health'), refetchInterval: 15_000, retry: false });

  const active = keys.data?.filter((key) => key.status === 'ACTIVE').length ?? 0;
  const created = keys.data?.filter((key) => key.status === 'CREATED').length ?? 0;
  const recent = [...(keys.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6);
  const dataErrors = [products.error, policies.error, keys.error].filter(Boolean);

  return <div className="page-stack">
    <section className="hero-card">
      <div>
        <span className="eyebrow"><Sparkles /> AUTHORIZATION CONTROL PLANE</span>
        <h2>欢迎进入授权控制中心</h2>
        <p>所有统计都会遍历现有管理 API 的全部分页，显示数据库中的真实结果，不使用演示数字。</p>
        <div className="hero-actions">
          {canWriteLicenses && <Link className="primary" to="/keys"><Plus />生成 Key</Link>}
          {canReadProducts && <Link className="secondary" to="/products">管理产品<ArrowUpRight /></Link>}
        </div>
      </div>
      <div className="orbital"><div className="orbit one"><i /></div><div className="orbit two"><i /></div><div className="core"><ShieldCheck /></div></div>
    </section>

    {dataErrors.length > 0 && <div className="data-error"><AlertTriangle /><div><strong>部分真实数据读取失败</strong><span>{dataErrors.map((error) => error instanceof Error ? error.message : '未知错误').join('；')}</span></div></div>}

    <section className="metrics">
      <Metric icon={<Boxes />} label="产品总数" value={metricValue(products.isLoading, products.isError, products.data?.length, canReadProducts)} hint="完整产品数据" tone="cyan" />
      <Metric icon={<ShieldCheck />} label="授权策略" value={metricValue(policies.isLoading, policies.isError, policies.data?.length, canReadLicenses)} hint="完整策略数据" tone="violet" />
      <Metric icon={<KeyRound />} label="有效 Key" value={metricValue(keys.isLoading, keys.isError, active, canReadLicenses)} hint={canReadLicenses ? `${created} 枚等待激活` : '需要 licenses.read'} tone="green" />
      <Metric icon={<Clock3 />} label="Key 总数" value={metricValue(keys.isLoading, keys.isError, keys.data?.length, canReadLicenses)} hint="完整 Key 数据" tone="orange" />
    </section>

    <section className="panel dashboard-status">
      <div className="panel-head"><div><span>LIVE SERVICE</span><h3>服务器实时状态</h3></div><Link to="/api-center">查看接口中心<ArrowUpRight /></Link></div>
      <div className={`live-status-row ${health.isSuccess ? 'online' : 'offline'}`}><i /><div><strong>{health.isLoading ? '正在检测' : health.isSuccess ? '服务在线' : '服务不可用'}</strong><span>{health.data ? healthLabel(health.data) : health.error instanceof Error ? health.error.message : '等待健康检查'}</span></div></div>
    </section>

    <section className="panel">
      <div className="panel-head"><div><span>RECENT LICENSES</span><h3>最近生成的 Key</h3></div>{canReadLicenses && <Link to="/keys">查看全部<ArrowUpRight /></Link>}</div>
      {!canReadLicenses ? <PermissionNotice>需要 licenses.read 权限才能读取真实 Key 数据。</PermissionNotice> : keys.isLoading ? <div className="compact-empty">正在加载全部 Key...</div> : keys.isError ? <div className="compact-empty error-text">{keys.error instanceof Error ? keys.error.message : 'Key 数据读取失败'}</div> : recent.length === 0 ? <div className="compact-empty">数据库中还没有 Key，创建产品和策略后即可生成。</div> : <div className="recent-list">{recent.map((item) => <div key={item.id}><span className={`status-dot ${item.status.toLowerCase()}`} /><code>{item.display_key}</code><span className={`badge ${item.status.toLowerCase()}`}>{statusText[item.status] ?? item.status}</span><time>{new Date(item.created_at).toLocaleString('zh-CN')}</time><Link to="/keys"><ArrowUpRight /></Link></div>)}</div>}
    </section>
  </div>;
}

function healthLabel(data: HealthData): string {
  if (data.service && data.version) return `${data.service} · v${data.version}`;
  if (data.service) return data.service;
  return data.status || '健康检查已通过';
}

function metricValue(loading: boolean, error: boolean, value: number | undefined, allowed: boolean): string | number {
  if (!allowed) return '无权限';
  if (loading) return '—';
  if (error) return '读取失败';
  return value ?? 0;
}

function Metric({ icon, label, value, hint, tone }: { icon: React.ReactNode; label: string; value: string | number; hint: string; tone: string }) {
  return <article className={`metric ${tone}`}><div className="metric-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{hint}</small></div><i /></article>;
}
