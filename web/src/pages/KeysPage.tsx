import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, Clipboard, Download, Eye, KeyRound, Laptop, PauseCircle, PlayCircle, Plus, RefreshCw, Search, ShieldAlert, Smartphone, TriangleAlert, XCircle } from 'lucide-react';
import { api, fetchAllPages, queryString } from '../api/client';
import type { DeviceBinding, Feature, License, Page, Policy, Product } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { Drawer, Empty, Modal, QueryError, SkeletonRows } from '../components/Ui';
import { useToast } from '../components/Toast';
import { formatDate, JsonField, Pagination, parseJsonObject, PermissionNotice, toLocalDateTime } from '../components/AdminForms';

const PAGE_SIZE = 25;
const DEVICE_PAGE_SIZE = 20;
const stateName: Record<string, string> = { CREATED: '未激活', ACTIVE: '生效中', SUSPENDED: '已暂停', EXPIRED: '已过期', REVOKED: '已吊销', DISABLED: '已禁用' };
const licenseTypeName: Record<string, string> = { TRIAL: '试用', DURATION: '时长', FIXED_EXPIRY: '固定到期', PERPETUAL: '永久' };

type Delivery = { generation_batch_id: string; plain_key?: string; count?: number; items?: Array<{ plain_key: string; license: License }>; license?: License };
type ManagedAction = { path: string; body?: unknown; successMessage: string };
type ConfirmAction = { kind: 'revoke' } | { kind: 'unbind' | 'block' | 'unblock'; deviceId: string; deviceName: string };

export function KeysPage() {
  const auth = useAuth();
  const canWrite = auth.has('licenses.write');
  const canExport = auth.has('licenses.export');
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [productId, setProductId] = useState('');
  const [offset, setOffset] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<Delivery | null>(null);

  const products = useQuery({ queryKey: ['products', 'all-options'], queryFn: () => fetchAllPages<Product>('/admin/v1/products') });
  const policies = useQuery({ queryKey: ['policies', 'all-options'], queryFn: () => fetchAllPages<Policy>('/admin/v1/license-policies') });
  const keys = useQuery({
    queryKey: ['keys', status, productId, offset],
    queryFn: () => api<Page<License>>(`/admin/v1/license-keys${queryString({ limit: PAGE_SIZE, offset, status: status || undefined, product_id: productId || undefined })}`),
  });
  const activeProducts = products.data?.filter((product) => product.status === 'ACTIVE') ?? [];
  const activePolicies = policies.data?.filter((policy) => policy.status === 'ACTIVE') ?? [];
  const generationReady = products.isSuccess && policies.isSuccess && activeProducts.length > 0 && activePolicies.length > 0;
  const visible = useMemo(() => keys.data?.items.filter((key) => key.display_key.toLowerCase().includes(search.toLowerCase())) ?? [], [keys.data, search]);
  useEffect(() => {
    const total = keys.data?.total;
    if (total === undefined) return;
    if (total === 0 && offset !== 0) setOffset(0);
    else if (total > 0 && offset >= total) setOffset(Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
  }, [keys.data?.total, offset]);
  const generate = useMutation({
    mutationFn: ({ body, batch }: { body: unknown; batch: boolean }) => api<Delivery>(batch ? '/admin/v1/license-keys/batch' : '/admin/v1/license-keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data) => { setDelivery(data); void qc.invalidateQueries({ queryKey: ['keys'] }); toast('Key 已真实生成，请立即保存明文'); },
    onError: (error: Error) => toast(error.message, 'error'),
  });

  return <div className="page-stack">
    <div className="toolbar wrap">
      <div className="search"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索当前页 Key 前缀或后缀" /></div>
      <select value={productId} disabled={!products.isSuccess} onChange={(event) => { setProductId(event.target.value); setOffset(0); }}><option value="">{products.isLoading ? '正在读取产品...' : products.isError ? '产品列表读取失败' : '全部产品'}</option>{products.data?.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select>
      <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}><option value="">全部状态</option>{Object.entries(stateName).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
      {canWrite && <button className="primary" disabled={!generationReady} title={!generationReady ? '必须先成功读取且至少存在一个启用产品和启用策略' : undefined} onClick={() => { setDelivery(null); setCreateOpen(true); }}><Plus />生成 Key</button>}
    </div>
    {!canWrite && <PermissionNotice>当前账号只有 Key 读取权限，生成和状态操作已隐藏。</PermissionNotice>}
    {products.isError && <QueryError compact title="产品列表读取失败" error={products.error} onRetry={() => void products.refetch()} />}
    {canWrite && policies.isError && <QueryError compact title="授权策略读取失败，Key 生成已停用" error={policies.error} onRetry={() => void policies.refetch()} />}
    {canWrite && (products.isLoading || policies.isLoading) && <div className="dependency-hint"><RefreshCw />正在读取真实产品和策略，完成前暂不可生成 Key。</div>}
    {canWrite && products.isSuccess && activeProducts.length === 0 && <div className="dependency-hint"><TriangleAlert />没有启用产品，请先在产品管理中创建或启用产品。</div>}
    {canWrite && policies.isSuccess && activePolicies.length === 0 && <div className="dependency-hint"><TriangleAlert />没有启用授权策略，请先在策略管理中创建或启用策略。</div>}
    <section className="panel table-panel">
      {keys.isLoading ? <SkeletonRows /> : keys.isError ? <QueryError title="Key 列表读取失败" error={keys.error} onRetry={() => void keys.refetch()} /> : visible.length === 0 ? <Empty icon={<KeyRound />} title={search ? "当前页没有匹配的 Key" : status || productId ? "当前筛选没有 Key" : offset > 0 ? "当前页没有 Key" : "暂无 Key"} text={search ? "请调整当前页搜索词。" : status || productId ? "数据库中没有符合当前产品或状态条件的 Key。" : offset > 0 ? "请返回上一页继续查看。" : "数据库中还没有授权 Key。"} /> : <div className="data-table">
        <div className="tr head"><span>Key</span><span>状态</span><span>授权类型</span><span>设备 / 并发</span><span>到期时间</span><span /></div>
        {visible.map((key) => <button className="tr" key={key.id} onClick={() => setSelectedId(key.id)}>
          <span><code>{key.display_key}</code><small>{key.id}</small></span>
          <span><i className={`status-dot ${key.status.toLowerCase()}`} /><b className={`badge ${key.status.toLowerCase()}`}>{stateName[key.status] ?? key.status}</b></span>
          <span>{licenseTypeName[key.license_type] ?? key.license_type}</span><span>{key.max_devices} / {key.max_concurrent_sessions}</span><span>{key.expires_at ? formatDate(key.expires_at) : '永久'}</span><span><Eye /></span>
        </button>)}
      </div>}
      {!keys.isError && <Pagination offset={offset} limit={PAGE_SIZE} itemCount={keys.data?.items.length ?? 0} total={keys.data?.total} busy={keys.isFetching} onChange={setOffset} />}
    </section>
    <GenerateModal open={createOpen && generationReady} close={() => setCreateOpen(false)} products={products.data ?? []} policies={policies.data ?? []} canBatch={canExport} submit={(body, batch) => generate.mutate({ body, batch })} busy={generate.isPending} delivery={delivery} onInvalid={(message) => toast(message, 'error')} />
    <KeyDrawer id={selectedId} canWrite={canWrite} canReadDevices={auth.has('devices.read')} canUnbind={auth.has('devices.unbind')} canBlock={auth.has('devices.block')} close={() => setSelectedId(null)} />
  </div>;
}

function GenerateModal({ open, close, products, policies, canBatch, submit, busy, delivery, onInvalid }: { open: boolean; close(): void; products: Product[]; policies: Policy[]; canBatch: boolean; submit(body: unknown, batch: boolean): void; busy: boolean; delivery: Delivery | null; onInvalid(message: string): void }) {
  const [batch, setBatch] = useState(false);
  const [productId, setProductId] = useState('');
  const [policyId, setPolicyId] = useState('');
  const toast = useToast();
  const features = useQuery({ queryKey: ['features', productId, 'generation'], queryFn: () => api<{ items: Feature[] }>(`/admin/v1/products/${productId}/features`), enabled: open && Boolean(productId) });
  const matching = policies.filter((policy) => policy.status === 'ACTIVE' && (policy.product_id === null || policy.product_id === productId));
  useEffect(() => { if (!open) { setBatch(false); setProductId(''); setPolicyId(''); } }, [open]);
  useEffect(() => { setPolicyId(''); }, [productId]);

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      if (!productId) throw new Error('请选择启用产品');
      if (!policyId || !matching.some((policy) => policy.id === policyId)) throw new Error('请选择与当前产品匹配的启用策略');
      if (features.isLoading) throw new Error('产品功能定义仍在读取，请稍后再试');
      if (features.isError) throw features.error;
      const grants = (features.data?.items ?? []).filter((feature) => String(form.get(`grant-mode:${feature.code}`) ?? '') !== '').map((feature) => ({ code: feature.code, allowed: form.get(`grant-mode:${feature.code}`) === 'allow', limits: parseJsonObject(form, `limits:${feature.code}`), ...(form.get(`expires:${feature.code}`) ? { expires_at: new Date(String(form.get(`expires:${feature.code}`))).toISOString() } : {}) }));
      const maxDevices = String(form.get('max_devices') ?? '').trim();
      const maxSessions = String(form.get('max_concurrent_sessions') ?? '').trim();
      submit({ product_id: form.get('product_id'), policy_id: form.get('policy_id'), ...(batch ? { count: Number(form.get('count')) } : {}), ...(maxDevices ? { max_devices: Number(maxDevices) } : {}), ...(maxSessions ? { max_concurrent_sessions: Number(maxSessions) } : {}), metadata: parseJsonObject(form, 'metadata'), features: grants }, batch);
    } catch (error) { onInvalid(error instanceof Error ? error.message : 'Key 配置格式错误'); }
  }
  const plainKeys = delivery ? delivery.plain_key ? [delivery.plain_key] : delivery.items?.map((item) => item.plain_key) ?? [] : [];
  async function copyAll() { try { await navigator.clipboard.writeText(plainKeys.join('\n')); toast('明文 Key 已复制'); } catch { toast('浏览器未允许访问剪贴板，请下载保存', 'error'); } }
  function download() { const url = URL.createObjectURL(new Blob([`${plainKeys.join('\n')}\n`], { type: 'text/plain;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `license-keys-${delivery?.generation_batch_id ?? Date.now()}.txt`; anchor.click(); URL.revokeObjectURL(url); }

  return <Modal open={open} onClose={busy ? () => undefined : close} title={delivery ? '保存真实明文 Key' : '生成授权 Key'} subtitle={delivery ? '明文只存在于本次响应，关闭后无法找回。' : '产品、策略、功能、限制和元数据会提交到真实 Key 生成 API。'} wide>
    {delivery ? <div className="delivery"><div className="delivery-warning"><ShieldAlert /><span><strong>请立即安全保存</strong><small>数据库只保存带 Pepper 的摘要，不保存完整明文。</small></span></div><div className="key-box">{plainKeys.map((key) => <code key={key}>{key}</code>)}</div><div className="form-actions"><button className="secondary" onClick={() => void copyAll()}><Clipboard />复制全部</button><button className="primary" onClick={download}><Download />下载 TXT</button></div></div> : (
      <form className="form-grid" onSubmit={submitForm}>
        <label>生成方式<select value={batch ? 'batch' : 'single'} onChange={(event) => setBatch(event.target.value === 'batch')}><option value="single">单枚 Key</option>{canBatch && <option value="batch">批量生成</option>}</select></label>
        {batch && <label>生成数量<input name="count" type="number" min="1" max="500" defaultValue="10" required /></label>}
        <label>产品<select name="product_id" value={productId} onChange={(event) => setProductId(event.target.value)} required><option value="">请选择启用产品</option>{products.filter((item) => item.status === 'ACTIVE').map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <label>授权策略<select name="policy_id" value={policyId} onChange={(event) => setPolicyId(event.target.value)} disabled={!productId || matching.length === 0} required><option value="">{!productId ? '请先选择产品' : matching.length === 0 ? '没有匹配的启用策略' : '请选择启用策略'}</option>{matching.map((policy) => <option value={policy.id} key={policy.id}>{policy.name} · {licenseTypeName[policy.license_type]}</option>)}</select></label>
        <label>覆盖最大设备数<input name="max_devices" type="number" min="1" max="1000" placeholder="留空使用策略值" /></label>
        <label>覆盖最大并发数<input name="max_concurrent_sessions" type="number" min="1" max="1000" placeholder="留空使用策略值" /></label>
        <JsonField name="metadata" label="Key Metadata JSON" defaultValue={{}} help="例如客户编号、订单号、交付批次等真实业务数据。" />
        <div className="full feature-grants"><div className="section-title"><div><h3>功能授权</h3><p>直接读取所选产品的功能定义</p></div></div>{!productId ? <div className="compact-empty">请先选择产品</div> : features.isLoading ? <SkeletonRows /> : features.isError ? <QueryError compact title="产品功能定义读取失败" error={features.error} onRetry={() => void features.refetch()} /> : features.data?.items.filter((feature) => feature.status === 'ACTIVE').length ? features.data.items.filter((feature) => feature.status === 'ACTIVE').map((feature) => <article key={feature.id}><label>{feature.name} <code>{feature.code}</code><select name={`grant-mode:${feature.code}`} defaultValue=""><option value="">不写入授权快照</option><option value="allow">明确允许</option><option value="deny">明确拒绝</option></select></label><textarea name={`limits:${feature.code}`} rows={2} defaultValue="{}" spellCheck={false} aria-label={`${feature.name} 限制 JSON`} /><input name={`expires:${feature.code}`} type="datetime-local" aria-label={`${feature.name} 到期时间`} /></article>) : <div className="compact-empty">该产品没有启用的功能定义</div>}</div>
        {productId && matching.length === 0 && <div className="dependency-hint full"><TriangleAlert />当前产品没有可用的通用策略或专属策略，请先到策略管理中创建或启用策略。</div>}
        <div className="form-actions full"><button className="ghost" type="button" onClick={close}>取消</button><button className="primary" disabled={busy || !productId || !policyId || matching.length === 0 || features.isLoading || features.isError}>{busy ? '正在生成...' : batch ? '批量生成' : '生成 Key'}</button></div>
      </form>
    )}
  </Modal>;
}

function KeyDrawer({ id, canWrite, canReadDevices, canUnbind, canBlock, close }: { id: string | null; canWrite: boolean; canReadDevices: boolean; canUnbind: boolean; canBlock: boolean; close(): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [renewOpen, setRenewOpen] = useState(false);
  const [deviceStatus, setDeviceStatus] = useState('');
  const [deviceOffset, setDeviceOffset] = useState(0);
  const detail = useQuery({ queryKey: ['license', id], queryFn: () => api<License>(`/admin/v1/license-keys/${id}`), enabled: Boolean(id) });
  const devices = useQuery({ queryKey: ['devices', id, deviceStatus, deviceOffset], queryFn: () => api<Page<DeviceBinding>>(`/admin/v1/license-keys/${id}/devices${queryString({ limit: DEVICE_PAGE_SIZE, offset: deviceOffset, activation_status: deviceStatus || undefined })}`), enabled: Boolean(id) && canReadDevices });
  useEffect(() => {
    setConfirmAction(null);
    setRenewOpen(false);
    setDeviceStatus('');
    setDeviceOffset(0);
  }, [id]);
  useEffect(() => {
    const total = devices.data?.total;
    if (total === undefined) return;
    if (total === 0 && deviceOffset !== 0) setDeviceOffset(0);
    else if (total > 0 && deviceOffset >= total) setDeviceOffset(Math.floor((total - 1) / DEVICE_PAGE_SIZE) * DEVICE_PAGE_SIZE);
  }, [devices.data?.total, deviceOffset]);

  const action = useMutation({
    mutationFn: ({ path, body }: ManagedAction) => api(`/admin/v1/${path}`, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    onSuccess: (_data, variables) => { void qc.invalidateQueries({ queryKey: ['license', id] }); void qc.invalidateQueries({ queryKey: ['keys'] }); void qc.invalidateQueries({ queryKey: ['devices', id] }); setConfirmAction(null); setRenewOpen(false); toast(variables.successMessage); },
    onError: (error: Error) => toast(error.message, 'error'),
  });
  const key = detail.data;
  if (!id) return null;
  function submitConfirmedAction(reason: string) {
    if (!confirmAction) return;
    if (confirmAction.kind === 'revoke') { action.mutate({ path: `license-keys/${id}/revoke`, body: { reason }, successMessage: 'Key 已永久吊销' }); return; }
    action.mutate({ path: `devices/${confirmAction.deviceId}/${confirmAction.kind}`, body: { reason, ...(confirmAction.kind === 'unbind' ? { license_id: id } : {}) }, successMessage: confirmAction.kind === 'unbind' ? '设备已强制解绑' : confirmAction.kind === 'block' ? '设备已封禁' : '设备已解封' });
  }
  async function copyDisplayKey() { if (!key) return; try { await navigator.clipboard.writeText(key.display_key); toast('脱敏 Key 标识已复制'); } catch { toast('浏览器未允许访问剪贴板', 'error'); } }

  return <>
    <Drawer open title={key?.display_key ?? '加载 Key 详情'} subtitle={key ? `${stateName[key.status]} · ${licenseTypeName[key.license_type]}` : '正在读取真实数据'} onClose={close}>
      {!key ? <SkeletonRows /> : <div className="drawer-stack">
        <div className="key-identity"><code>{key.display_key}</code><button onClick={() => void copyDisplayKey()}><Clipboard /></button><span className={`badge ${key.status.toLowerCase()}`}>{stateName[key.status]}</span></div>
        <div className="detail-grid">
          <Info label="Key ID" value={key.id} mono wide /><Info label="生成批次" value={key.generation_batch_id ?? '—'} mono wide />
          <Info label="产品 ID" value={key.product_id} mono /><Info label="策略 ID" value={key.policy_id ?? '—'} mono />
          <Info label="最大设备" value={String(key.max_devices)} /><Info label="最大并发" value={String(key.max_concurrent_sessions)} />
          <Info label="离线宽限" value={`${Math.round(key.offline_grace_seconds / 3600)} 小时`} /><Info label="自助解绑" value={key.allow_self_unbind ? `允许，冷却 ${Math.round(key.unbind_cooldown_seconds / 3600)} 小时` : '不允许'} />
          <Info label="创建时间" value={formatDate(key.created_at)} /><Info label="激活时间" value={formatDate(key.activated_at)} />
          <Info label="开始时间" value={formatDate(key.starts_at)} /><Info label="到期时间" value={key.expires_at ? formatDate(key.expires_at) : '永久'} />
          <Info label="吊销时间" value={formatDate(key.revoked_at)} /><Info label="更新时间" value={formatDate(key.updated_at)} />
          <Info label="Metadata JSON" value={JSON.stringify(key.metadata, null, 2)} mono wide />
        </div>
        <section className="feature-detail"><h3>功能授权快照</h3>{key.features.length === 0 ? <div className="compact-empty">没有附加功能授权</div> : key.features.map((feature) => <article key={feature.code}><div><strong>{feature.code}</strong><span className={`badge ${feature.allowed ? 'active' : 'disabled'}`}>{feature.allowed ? '允许' : '拒绝'}</span></div><pre>{JSON.stringify(feature.limits, null, 2)}</pre><small>到期：{formatDate(feature.expires_at)}</small></article>)}</section>
        {canWrite && <section className="action-zone"><h3>Key 状态操作</h3><div>
          {key.status === 'SUSPENDED' ? <button className="secondary" disabled={action.isPending} onClick={() => action.mutate({ path: `license-keys/${id}/resume`, successMessage: 'Key 已恢复' })}><PlayCircle />恢复</button> : <button className="secondary" disabled={action.isPending || key.status !== 'ACTIVE'} onClick={() => action.mutate({ path: `license-keys/${id}/suspend`, successMessage: 'Key 已暂停' })}><PauseCircle />暂停</button>}
          <button className="secondary" disabled={action.isPending || key.status === 'REVOKED' || key.license_type === 'PERPETUAL'} onClick={() => setRenewOpen(true)}><RefreshCw />续期</button>
          <button className="danger" disabled={action.isPending || key.status === 'REVOKED'} onClick={() => setConfirmAction({ kind: 'revoke' })}><Ban />永久吊销</button>
        </div></section>}
        <section className="device-zone"><div className="section-title"><div><h3>绑定设备</h3><p>真实设备、绑定、在线与封禁状态</p></div>{canReadDevices && <select value={deviceStatus} onChange={(event) => { setDeviceStatus(event.target.value); setDeviceOffset(0); }}><option value="">全部绑定状态</option><option value="ACTIVE">ACTIVE</option><option value="UNBOUND">UNBOUND</option><option value="BLOCKED">BLOCKED</option><option value="REPLACED">REPLACED</option></select>}</div>
          {!canReadDevices ? <PermissionNotice>当前账号没有 devices.read 权限。</PermissionNotice> : devices.isLoading ? <SkeletonRows /> : devices.isError ? <QueryError compact title="设备记录读取失败" error={devices.error} onRetry={() => void devices.refetch()} /> : devices.data?.items.length === 0 ? <div className="compact-empty">当前条件下没有设备记录。</div> : <div className="device-list detailed">{devices.data?.items.map((device) => <article key={`${device.activation_id}:${device.device_id}`}>
            <span className="device-icon">{device.platform?.toLowerCase().includes('win') ? <Laptop /> : <Smartphone />}</span>
            <div className="device-main"><strong>{device.display_name || '未命名设备'}</strong><small>{device.platform || '未知平台'} {device.os_version || ''} · {device.activation_status}</small><code>{device.device_id}</code><div><span>活跃会话 {device.active_session_count}</span><span>风险分 {device.risk_score}</span><span>最近验证 {formatDate(device.last_verified_at)}</span></div><details><summary>查看设备安全信息</summary><pre>{JSON.stringify({ fingerprint_hash: device.fingerprint_hash, public_key_fingerprint: device.device_public_key_fingerprint, first_seen_at: device.first_seen_at, last_seen_at: device.last_seen_at, blocked_at: device.blocked_at, block_reason: device.block_reason }, null, 2)}</pre></details></div>
            <span className={`badge ${device.blocked ? 'revoked' : device.activation_status === 'ACTIVE' ? 'active' : 'disabled'}`}>{device.blocked ? '已封禁' : device.activation_status}</span>
            <div className="device-actions">{canUnbind && <button title="强制解绑" disabled={action.isPending || device.activation_status !== 'ACTIVE'} onClick={() => setConfirmAction({ kind: 'unbind', deviceId: device.device_id, deviceName: device.display_name || device.device_id })}><XCircle /></button>}{canBlock && <button title={device.blocked ? '解封设备' : '封禁设备'} disabled={action.isPending} onClick={() => setConfirmAction({ kind: device.blocked ? 'unblock' : 'block', deviceId: device.device_id, deviceName: device.display_name || device.device_id })}>{device.blocked ? <Check /> : <ShieldAlert />}</button>}</div>
          </article>)}</div>}
          {canReadDevices && !devices.isError && <Pagination offset={deviceOffset} limit={DEVICE_PAGE_SIZE} itemCount={devices.data?.items.length ?? 0} total={devices.data?.total} busy={devices.isFetching} onChange={setDeviceOffset} />}
        </section>
      </div>}
    </Drawer>
    <RenewModal keyData={key} open={renewOpen} busy={action.isPending} close={() => setRenewOpen(false)} submit={(body, message) => action.mutate({ path: `license-keys/${id}/renew`, body, successMessage: message })} />
    <OperationModal key={confirmAction ? `${confirmAction.kind}:${'deviceId' in confirmAction ? confirmAction.deviceId : id}` : 'closed'} action={confirmAction} keyLabel={key?.display_key ?? ''} busy={action.isPending} close={() => setConfirmAction(null)} submit={submitConfirmedAction} />
  </>;
}

function RenewModal({ keyData, open, busy, close, submit }: { keyData: License | undefined; open: boolean; busy: boolean; close(): void; submit(body: unknown, message: string): void }) {
  function go(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!keyData) return; const form = new FormData(event.currentTarget); if (keyData.license_type === 'FIXED_EXPIRY') { const value = String(form.get('expires_at')); submit({ expires_at: new Date(value).toISOString() }, 'Key 固定到期时间已更新'); } else { const days = Number(form.get('days')); submit({ extend_seconds: days * 86400 }, `Key 已续期 ${days} 天`); } }
  return <Modal open={open} title="续期 Key" subtitle={keyData?.license_type === 'FIXED_EXPIRY' ? '固定到期授权必须指定新的未来到期时间' : '从当前到期时间或当前时间向后延长'} onClose={busy ? () => undefined : close}><form className="form-grid" onSubmit={go}>{keyData?.license_type === 'FIXED_EXPIRY' ? <label className="full">新的到期时间<input name="expires_at" type="datetime-local" required defaultValue={toLocalDateTime(keyData.expires_at)} /></label> : <label className="full">延长天数<input name="days" type="number" min="1" max="36500" defaultValue="30" required /></label>}<div className="form-actions full"><button type="button" className="ghost" onClick={close}>取消</button><button className="primary" disabled={busy}>{busy ? '正在续期...' : '确认续期'}</button></div></form></Modal>;
}

function OperationModal({ action, keyLabel, busy, close, submit }: { action: ConfirmAction | null; keyLabel: string; busy: boolean; close(): void; submit(reason: string): void }) {
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  if (!action) return null;
  const config = action.kind === 'revoke' ? { title: '永久吊销 Key', subtitle: '这是不可恢复的危险操作。', subject: keyLabel, description: '吊销后 Key 无法激活、验证或恢复，相关会话会失效。', label: '吊销原因', placeholder: '例如：Key 泄露、退款、违规使用', confirmText: '永久吊销', buttonText: '确认永久吊销', dangerous: true } : action.kind === 'unbind' ? { title: '强制解绑设备', subtitle: '释放设备占用的授权名额。', subject: action.deviceName, description: '当前绑定和会话将失效，设备需要重新激活。', label: '解绑原因', placeholder: '例如：用户换机、设备报废', confirmText: '', buttonText: '确认解绑', dangerous: false } : action.kind === 'block' ? { title: '封禁设备', subtitle: '阻止设备继续访问授权服务。', subject: action.deviceName, description: '后续激活和验证会被拒绝，现有会话被撤销。', label: '封禁原因', placeholder: '例如：设备被盗、异常使用', confirmText: '', buttonText: '确认封禁', dangerous: true } : { title: '解封设备', subtitle: '恢复设备使用授权服务的资格。', subject: action.deviceName, description: '解封不会自动恢复旧绑定和旧会话。', label: '解封原因', placeholder: '例如：人工核验通过', confirmText: '', buttonText: '确认解封', dangerous: false };
  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= 255 && (!config.confirmText || confirmation === config.confirmText) && !busy;
  return <Modal open title={config.title} subtitle={config.subtitle} onClose={busy ? () => undefined : close}><form className="operation-form" onSubmit={(event) => { event.preventDefault(); if (canSubmit) submit(trimmed); }}><div className={`operation-impact ${config.dangerous ? 'critical' : ''}`}><span><TriangleAlert /></span><div><small>操作对象</small><strong>{config.subject}</strong><p>{config.description}</p></div></div><label><span>{config.label}<small>{trimmed.length}/255</small></span><textarea autoFocus value={reason} maxLength={255} rows={4} placeholder={config.placeholder} onChange={(event) => setReason(event.target.value)} /></label>{config.confirmText && <label><span>安全确认</span><input value={confirmation} placeholder={`请输入“${config.confirmText}”`} autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} /></label>}<div className="form-actions operation-actions"><button className="ghost" type="button" disabled={busy} onClick={close}>取消</button><button className={config.dangerous ? 'danger confirm-danger' : 'primary'} disabled={!canSubmit}>{busy ? <span className="spinner" /> : config.dangerous ? <ShieldAlert /> : <Check />}{busy ? '正在执行...' : config.buttonText}</button></div></form></Modal>;
}

function Info({ label, value, mono = false, wide = false }: { label: string; value: string; mono?: boolean; wide?: boolean }) { return <div className={`info-block ${wide ? 'wide' : ''}`}><small>{label}</small>{mono ? <pre>{value}</pre> : <strong>{value}</strong>}</div>; }
