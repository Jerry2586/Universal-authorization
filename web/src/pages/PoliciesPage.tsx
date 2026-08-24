import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Edit3, Filter, Gauge, Plus, Search, ShieldCheck, Smartphone, Timer, WifiOff } from 'lucide-react';
import { api, fetchAllPages, queryString } from '../api/client';
import type { LicenseType, Page, Policy, Product } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { Empty, Modal, SkeletonRows } from '../components/Ui';
import { useToast } from '../components/Toast';
import { formatDate, JsonField, Pagination, parseJsonObject, PermissionNotice, toLocalDateTime } from '../components/AdminForms';

const PAGE_SIZE = 20;
const typeName: Record<LicenseType, string> = { TRIAL: '试用授权', DURATION: '时长授权', FIXED_EXPIRY: '固定到期', PERPETUAL: '永久授权' };

export function PoliciesPage() {
  const auth = useAuth();
  const canWrite = auth.has('licenses.write');
  const qc = useQueryClient();
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const [editor, setEditor] = useState<Policy | 'create' | null>(null);

  const products = useQuery({ queryKey: ['products', 'policy-options'], queryFn: () => fetchAllPages<Product>('/admin/v1/products') });
  const policies = useQuery({
    queryKey: ['policies', productId, offset],
    queryFn: () => api<Page<Policy>>(`/admin/v1/license-policies${queryString({ limit: PAGE_SIZE, offset, product_id: productId || undefined })}`),
  });
  const filtered = useMemo(() => policies.data?.items.filter((policy) => `${policy.name} ${policy.code}`.toLowerCase().includes(search.toLowerCase())) ?? [], [policies.data, search]);
  const save = useMutation({
    mutationFn: ({ body, item }: { body: unknown; item: Policy | 'create' }) => api<Policy>(item === 'create' ? '/admin/v1/license-policies' : `/admin/v1/license-policies/${item.id}`, { method: item === 'create' ? 'POST' : 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['policies'] }); setEditor(null); toast('授权策略已保存'); },
    onError: (error: Error) => toast(error.message, 'error'),
  });

  return <div className="page-stack">
    <div className="toolbar wrap">
      <div className="search"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索当前页策略名称或代码" /></div>
      <div className="select-icon"><Filter /><select value={productId} onChange={(event) => { setProductId(event.target.value); setOffset(0); }}><option value="">全部产品和通用策略</option>{products.data?.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}</select></div>
      {canWrite && <button className="primary" onClick={() => setEditor('create')}><Plus />新建策略</button>}
    </div>
    {!canWrite && <PermissionNotice>当前账号只有授权读取权限，策略编辑功能已隐藏。</PermissionNotice>}
    <section className="panel table-panel">
      {policies.isLoading ? <SkeletonRows /> : filtered.length === 0 ? <Empty icon={<ShieldCheck />} title="暂无授权策略" text="当前筛选条件下没有策略。" /> : (
        <div className="policy-grid">
          {filtered.map((policy) => <article className="policy-card" key={policy.id}>
            <header><span><ShieldCheck /></span><div><h3>{policy.name}</h3><code>{policy.code}</code></div>{canWrite && <button className="icon-button" onClick={() => setEditor(policy)}><Edit3 /></button>}</header>
            <div className="policy-type">{typeName[policy.license_type]}</div>
            <div className="policy-stats">
              <div><Smartphone /><span><strong>{policy.max_devices}</strong>台设备</span></div>
              <div><Gauge /><span><strong>{policy.max_concurrent_sessions}</strong>并发</span></div>
              <div><WifiOff /><span><strong>{Math.round(policy.offline_grace_seconds / 3600)}</strong>小时离线</span></div>
              <div><Timer /><span><strong>{durationLabel(policy)}</strong></span></div>
            </div>
            <footer><span className={`badge ${policy.status.toLowerCase()}`}>{policy.status === 'ACTIVE' ? '启用' : '停用'}</span><span>{policy.allow_self_unbind ? `允许自助解绑 · 冷却 ${Math.round(policy.unbind_cooldown_seconds / 3600)} 小时` : '仅管理员解绑'}</span><small>更新于 {formatDate(policy.updated_at)}</small></footer>
          </article>)}
        </div>
      )}
      <Pagination offset={offset} limit={PAGE_SIZE} itemCount={policies.data?.items.length ?? 0} busy={policies.isFetching} onChange={setOffset} />
    </section>
    <PolicyModal key={editor === 'create' ? 'create' : editor?.id ?? 'closed'} item={editor} products={products.data ?? []} busy={save.isPending} onClose={() => setEditor(null)} onSubmit={(body, item) => save.mutate({ body, item })} onInvalid={(message) => toast(message, 'error')} />
  </div>;
}

function PolicyModal({ item, products, busy, onClose, onSubmit, onInvalid }: { item: Policy | 'create' | null; products: Product[]; busy: boolean; onClose(): void; onSubmit(body: unknown, item: Policy | 'create'): void; onInvalid(message: string): void }) {
  const [type, setType] = useState<LicenseType>(item && item !== 'create' ? item.license_type : 'DURATION');
  if (item === null) return null;
  const editing = item !== 'create';
  const policy = editing ? item : undefined;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      const rules = parseJsonObject(form, 'rules');
      const selectedType = String(form.get('license_type')) as LicenseType;
      if (selectedType === 'FIXED_EXPIRY') {
        const fixed = String(form.get('fixed_expires_at') ?? '');
        if (!fixed) throw new Error('固定到期授权必须设置到期时间');
        rules.fixed_expires_at = new Date(fixed).toISOString();
      } else {
        delete rules.fixed_expires_at;
      }
      const durationDays = Number(form.get('duration_days'));
      onSubmit({
        ...(editing ? {} : { code: form.get('code') }),
        product_id: form.get('product_id') || null,
        name: form.get('name'), license_type: selectedType,
        duration_seconds: selectedType === 'TRIAL' || selectedType === 'DURATION' ? durationDays * 86400 : null,
        max_devices: Number(form.get('max_devices')),
        max_concurrent_sessions: Number(form.get('max_concurrent_sessions')),
        offline_grace_seconds: Number(form.get('offline_hours')) * 3600,
        allow_self_unbind: form.get('allow_self_unbind') === 'on',
        unbind_cooldown_seconds: Number(form.get('unbind_cooldown_hours')) * 3600,
        rules, status: form.get('status'),
      }, item!);
    } catch (error) { onInvalid(error instanceof Error ? error.message : '策略配置格式错误'); }
  }
  const fixedExpiry = typeof policy?.rules.fixed_expires_at === 'string' ? policy.rules.fixed_expires_at : null;
  return <Modal open title={editing ? '编辑授权策略' : '创建授权策略'} subtitle="所有字段直接保存到授权策略 API，已生成 Key 保留原策略快照" wide onClose={onClose}>
    <form className="form-grid" onSubmit={submit}>
      <label>策略名称<input name="name" required defaultValue={policy?.name} /></label>
      <label>策略代码<input name="code" required disabled={editing} defaultValue={policy?.code} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label>
      <label>所属产品<select name="product_id" defaultValue={policy?.product_id ?? ''}><option value="">通用策略</option>{products.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}</select></label>
      <label>授权类型<select name="license_type" value={type} onChange={(event) => setType(event.target.value as LicenseType)}><option value="TRIAL">试用授权</option><option value="DURATION">时长授权</option><option value="FIXED_EXPIRY">固定到期</option><option value="PERPETUAL">永久授权</option></select></label>
      {(type === 'TRIAL' || type === 'DURATION') && <label>有效天数<input name="duration_days" type="number" min="1" required defaultValue={policy?.duration_seconds ? Math.round(policy.duration_seconds / 86400) : type === 'TRIAL' ? 7 : 365} /></label>}
      {type === 'FIXED_EXPIRY' && <label>固定到期时间<input name="fixed_expires_at" type="datetime-local" required defaultValue={toLocalDateTime(fixedExpiry)} /></label>}
      <label>状态<select name="status" defaultValue={policy?.status ?? 'ACTIVE'}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label>
      <label>最大设备数<input name="max_devices" type="number" min="1" max="1000" required defaultValue={policy?.max_devices ?? 1} /></label>
      <label>最大并发会话<input name="max_concurrent_sessions" type="number" min="1" max="1000" required defaultValue={policy?.max_concurrent_sessions ?? 1} /></label>
      <label>离线宽限（小时）<input name="offline_hours" type="number" min="0" max="8760" required defaultValue={policy ? policy.offline_grace_seconds / 3600 : 24} /></label>
      <label>解绑冷却（小时）<input name="unbind_cooldown_hours" type="number" min="0" max="8760" required defaultValue={policy ? policy.unbind_cooldown_seconds / 3600 : 168} /></label>
      <label className="check full"><input name="allow_self_unbind" type="checkbox" defaultChecked={policy?.allow_self_unbind ?? false} />允许客户端调用自助解绑接口</label>
      <JsonField name="rules" label="策略 Rules JSON" defaultValue={policy?.rules ?? {}} help="固定到期时间由上方字段维护；其他业务规则可以保存在此 JSON 对象中。" />
      <div className="form-actions full"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? '正在保存...' : '保存策略'}</button></div>
    </form>
  </Modal>;
}

function durationLabel(policy: Policy): string {
  if (policy.license_type === 'PERPETUAL') return '永久';
  if (policy.license_type === 'FIXED_EXPIRY') {
    const value = policy.rules.fixed_expires_at;
    return typeof value === 'string' ? new Date(value).toLocaleDateString('zh-CN') : '未配置';
  }
  return `${Math.round((policy.duration_seconds ?? 0) / 86400)} 天`;
}
