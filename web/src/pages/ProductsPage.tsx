import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Edit3, Layers3, Plus, Power, Puzzle, Search, Tag } from 'lucide-react';
import { api, queryString } from '../api/client';
import type { Feature, Page, Product, ProductVersion } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { Drawer, Empty, Modal, SkeletonRows } from '../components/Ui';
import { useToast } from '../components/Toast';
import { formatDate, JsonField, Pagination, parseJsonObject, PermissionNotice, toLocalDateTime } from '../components/AdminForms';

const PAGE_SIZE = 20;

export function ProductsPage() {
  const auth = useAuth();
  const canWrite = auth.has('products.write');
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const products = useQuery({
    queryKey: ['products', offset],
    queryFn: () => api<Page<Product>>(`/admin/v1/products${queryString({ limit: PAGE_SIZE, offset })}`),
  });
  const filtered = useMemo(
    () => products.data?.items.filter((product) => `${product.name} ${product.code}`.toLowerCase().includes(search.toLowerCase())) ?? [],
    [products.data, search],
  );
  const create = useMutation({
    mutationFn: (body: unknown) => api<Product>('/admin/v1/products', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (product) => {
      void qc.invalidateQueries({ queryKey: ['products'] });
      setCreateOpen(false);
      setSelectedId(product.id);
      toast('产品创建成功');
    },
    onError: (error: Error) => toast(error.message, 'error'),
  });

  return (
    <div className="page-stack">
      <div className="toolbar wrap">
        <div className="search"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索当前页产品名称或代码" /></div>
        {canWrite && <button className="primary" onClick={() => setCreateOpen(true)}><Plus />新建产品</button>}
      </div>
      {!canWrite && <PermissionNotice>当前账号只有产品读取权限，修改按钮已隐藏。</PermissionNotice>}
      <section className="panel table-panel">
        {products.isLoading ? <SkeletonRows /> : filtered.length === 0 ? (
          <Empty icon={<Boxes />} title="暂无产品" text="当前页没有匹配产品。" action={canWrite ? <button className="primary" onClick={() => setCreateOpen(true)}><Plus />创建产品</button> : undefined} />
        ) : (
          <div className="card-grid">
            {filtered.map((product) => (
              <button type="button" className="product-card product-card-button" key={product.id} onClick={() => setSelectedId(product.id)}>
                <div className="product-card-top"><span className="product-symbol">{product.name.slice(0, 2).toUpperCase()}</span><span className={`badge ${product.status.toLowerCase()}`}>{product.status === 'ACTIVE' ? '运行中' : '已停用'}</span></div>
                <h3>{product.name}</h3><code>{product.code}</code><p>{product.description || '暂无产品说明'}</p>
                <div className="product-meta"><span><Tag />推荐版本 {product.recommended_client_version || '未设置'}</span><span>更新于 {formatDate(product.updated_at)}</span></div>
                <span className="card-link">进入完整配置</span>
              </button>
            ))}
          </div>
        )}
        <Pagination offset={offset} limit={PAGE_SIZE} itemCount={products.data?.items.length ?? 0} busy={products.isFetching} onChange={setOffset} />
      </section>
      <ProductFormModal mode="create" open={createOpen} busy={create.isPending} onClose={() => setCreateOpen(false)} onSubmit={(body) => create.mutate(body)} onInvalid={(message) => toast(message, 'error')} />
      <ProductDrawer productId={selectedId} canWrite={canWrite} onClose={() => setSelectedId(null)} />
    </div>
  );
}

function ProductDrawer({ productId, canWrite, onClose }: { productId: string | null; canWrite: boolean; onClose(): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'overview' | 'versions' | 'features'>('overview');
  const [editProduct, setEditProduct] = useState(false);
  const [versionModal, setVersionModal] = useState<ProductVersion | 'create' | null>(null);
  const [featureModal, setFeatureModal] = useState<Feature | 'create' | null>(null);
  const product = useQuery({ queryKey: ['product', productId], queryFn: () => api<Product>(`/admin/v1/products/${productId}`), enabled: productId !== null });
  const versions = useQuery({ queryKey: ['versions', productId], queryFn: () => api<{ items: ProductVersion[] }>(`/admin/v1/products/${productId}/versions`), enabled: productId !== null });
  const features = useQuery({ queryKey: ['features', productId], queryFn: () => api<{ items: Feature[] }>(`/admin/v1/products/${productId}/features`), enabled: productId !== null });

  const updateProduct = useMutation({
    mutationFn: (body: unknown) => api<Product>(`/admin/v1/products/${productId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['product', productId] }); void qc.invalidateQueries({ queryKey: ['products'] }); setEditProduct(false); toast('产品配置已保存'); },
    onError: (error: Error) => toast(error.message, 'error'),
  });
  const saveVersion = useMutation({
    mutationFn: ({ body, item }: { body: unknown; item: ProductVersion | 'create' }) => api(
      item === 'create' ? `/admin/v1/products/${productId}/versions` : `/admin/v1/products/${productId}/versions/${item.id}`,
      { method: item === 'create' ? 'POST' : 'PATCH', body: JSON.stringify(body) },
    ),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['versions', productId] }); setVersionModal(null); toast('产品版本已保存'); },
    onError: (error: Error) => toast(error.message, 'error'),
  });
  const saveFeature = useMutation({
    mutationFn: ({ body, item }: { body: unknown; item: Feature | 'create' }) => api(
      item === 'create' ? `/admin/v1/products/${productId}/features` : `/admin/v1/products/${productId}/features/${item.id}`,
      { method: item === 'create' ? 'POST' : 'PATCH', body: JSON.stringify(body) },
    ),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['features', productId] }); setFeatureModal(null); toast('功能定义已保存'); },
    onError: (error: Error) => toast(error.message, 'error'),
  });

  const current = product.data;
  return (
    <>
      <Drawer open={productId !== null} title={current?.name ?? '读取产品...'} subtitle={current?.code} onClose={onClose}>
        {product.isLoading || !current ? <SkeletonRows /> : (
          <div className="drawer-stack">
            <div className="detail-actions">
              <span className={`badge ${current.status.toLowerCase()}`}>{current.status}</span>
              {canWrite && <button className="secondary" onClick={() => setEditProduct(true)}><Edit3 />编辑产品</button>}
            </div>
            <div className="drawer-tabs">
              <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>产品配置</button>
              <button className={tab === 'versions' ? 'active' : ''} onClick={() => setTab('versions')}>版本 {versions.data?.items.length ?? 0}</button>
              <button className={tab === 'features' ? 'active' : ''} onClick={() => setTab('features')}>功能 {features.data?.items.length ?? 0}</button>
            </div>
            {tab === 'overview' && <ProductOverview product={current} />}
            {tab === 'versions' && <VersionPanel items={versions.data?.items ?? []} loading={versions.isLoading} canWrite={canWrite} onCreate={() => setVersionModal('create')} onEdit={setVersionModal} />}
            {tab === 'features' && <FeaturePanel items={features.data?.items ?? []} loading={features.isLoading} canWrite={canWrite} onCreate={() => setFeatureModal('create')} onEdit={setFeatureModal} />}
          </div>
        )}
      </Drawer>
      <ProductFormModal mode="edit" product={current} open={editProduct} busy={updateProduct.isPending} onClose={() => setEditProduct(false)} onSubmit={(body) => updateProduct.mutate(body)} onInvalid={(message) => toast(message, 'error')} />
      <VersionModal item={versionModal} busy={saveVersion.isPending} onClose={() => setVersionModal(null)} onSubmit={(body, item) => saveVersion.mutate({ body, item })} />
      <FeatureModal item={featureModal} busy={saveFeature.isPending} onClose={() => setFeatureModal(null)} onSubmit={(body, item) => saveFeature.mutate({ body, item })} />
    </>
  );
}

function ProductOverview({ product }: { product: Product }) {
  return <div className="detail-grid">
    <Info label="产品名称" value={product.name} /><Info label="产品代码" value={product.code} mono />
    <Info label="最低客户端版本" value={product.minimum_client_version ?? '未限制'} /><Info label="推荐版本" value={product.recommended_client_version ?? '未设置'} />
    <Info label="强制升级版本" value={product.force_update_version ?? '未设置'} /><Info label="更新时间" value={formatDate(product.updated_at)} />
    <Info label="产品说明" value={product.description ?? '暂无'} wide /><Info label="Settings JSON" value={JSON.stringify(product.settings, null, 2)} wide mono />
  </div>;
}

function VersionPanel({ items, loading, canWrite, onCreate, onEdit }: { items: ProductVersion[]; loading: boolean; canWrite: boolean; onCreate(): void; onEdit(item: ProductVersion): void }) {
  return <div className="nested-panel">
    {canWrite && <button className="primary compact" onClick={onCreate}><Plus />新增版本</button>}
    {loading ? <SkeletonRows /> : items.length === 0 ? <Empty icon={<Layers3 />} title="暂无版本" text="还没有登记产品版本。" /> : items.map((item) => (
      <article className="nested-row" key={item.id}><div><strong>{item.version}</strong><span>{item.release_notes || '无发布说明'}</span><small>{formatDate(item.released_at ?? item.created_at)}</small></div><div><span className={`badge ${item.status.toLowerCase()}`}>{item.status}</span>{item.force_update && <span className="badge warning">强制升级</span>}{canWrite && <button className="icon-button" onClick={() => onEdit(item)}><Edit3 /></button>}</div></article>
    ))}
  </div>;
}

function FeaturePanel({ items, loading, canWrite, onCreate, onEdit }: { items: Feature[]; loading: boolean; canWrite: boolean; onCreate(): void; onEdit(item: Feature): void }) {
  return <div className="nested-panel">
    {canWrite && <button className="primary compact" onClick={onCreate}><Plus />新增功能</button>}
    {loading ? <SkeletonRows /> : items.length === 0 ? <Empty icon={<Puzzle />} title="暂无功能定义" text="还没有为产品定义可授权功能。" /> : items.map((item) => (
      <article className="nested-row" key={item.id}><div><strong>{item.name}</strong><code>{item.code}</code><span>{item.description || '无说明'}</span></div><div><span className={`badge ${item.status.toLowerCase()}`}>{item.status}</span>{canWrite && <button className="icon-button" onClick={() => onEdit(item)}><Edit3 /></button>}</div></article>
    ))}
  </div>;
}

function ProductFormModal({ mode, product, open, busy, onClose, onSubmit, onInvalid }: { mode: 'create' | 'edit'; product?: Product; open: boolean; busy: boolean; onClose(): void; onSubmit(body: unknown): void; onInvalid(message: string): void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      onSubmit({
        ...(mode === 'create' ? { code: form.get('code') } : {}),
        name: form.get('name'), description: form.get('description') || null, status: form.get('status'),
        minimum_client_version: form.get('minimum_client_version') || null,
        recommended_client_version: form.get('recommended_client_version') || null,
        force_update_version: form.get('force_update_version') || null,
        settings: parseJsonObject(form, 'settings'),
      });
    } catch (error) { onInvalid(error instanceof Error ? error.message : 'JSON 配置格式错误'); }
  }
  return <Modal open={open} onClose={onClose} title={mode === 'create' ? '新建产品' : '编辑产品完整配置'} subtitle="所有字段直接提交到真实产品管理 API" wide>
    <form className="form-grid" onSubmit={submit}>
      <label>产品名称<input name="name" required maxLength={120} defaultValue={product?.name} /></label>
      <label>产品代码<input name="code" required disabled={mode === 'edit'} defaultValue={product?.code} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label>
      <label>状态<select name="status" defaultValue={product?.status ?? 'ACTIVE'}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label>
      <label>最低客户端版本<input name="minimum_client_version" defaultValue={product?.minimum_client_version ?? ''} placeholder="1.0.0" /></label>
      <label>推荐客户端版本<input name="recommended_client_version" defaultValue={product?.recommended_client_version ?? ''} placeholder="1.2.0" /></label>
      <label>强制升级版本<input name="force_update_version" defaultValue={product?.force_update_version ?? ''} placeholder="1.0.0" /></label>
      <label className="full">产品说明<textarea name="description" rows={3} defaultValue={product?.description ?? ''} /></label>
      <JsonField name="settings" label="产品 Settings JSON" defaultValue={product?.settings ?? {}} help="必须是合法 JSON 对象，将原样保存到产品配置。" />
      <div className="form-actions full"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? '正在保存...' : '保存产品'}</button></div>
    </form>
  </Modal>;
}

function VersionModal({ item, busy, onClose, onSubmit }: { item: ProductVersion | 'create' | null; busy: boolean; onClose(): void; onSubmit(body: unknown, item: ProductVersion | 'create'): void }) {
  if (item === null) return null;
  const editing = item !== 'create';
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); onSubmit({ ...(editing ? {} : { version: form.get('version') }), status: form.get('status'), force_update: form.get('force_update') === 'on', release_notes: form.get('release_notes') || null, released_at: form.get('released_at') ? new Date(String(form.get('released_at'))).toISOString() : null }, item!); }
  return <Modal open title={editing ? '编辑产品版本' : '新增产品版本'} subtitle="保存后立即影响客户端版本判断" onClose={onClose}>
    <form className="form-grid" onSubmit={submit}>
      <label>版本号<input name="version" required disabled={editing} defaultValue={editing ? item.version : ''} placeholder="1.0.0" /></label>
      <label>版本状态<select name="status" defaultValue={editing ? item.status : 'ACTIVE'}><option value="ACTIVE">正常</option><option value="BLOCKED">禁止</option><option value="DEPRECATED">废弃</option></select></label>
      <label>发布时间<input name="released_at" type="datetime-local" defaultValue={editing ? toLocalDateTime(item.released_at) : ''} /></label>
      <label className="check"><input name="force_update" type="checkbox" defaultChecked={editing && item.force_update} />强制客户端升级</label>
      <label className="full">发布说明<textarea name="release_notes" rows={4} defaultValue={editing ? item.release_notes ?? '' : ''} /></label>
      <div className="form-actions full"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? '正在保存...' : '保存版本'}</button></div>
    </form>
  </Modal>;
}

function FeatureModal({ item, busy, onClose, onSubmit }: { item: Feature | 'create' | null; busy: boolean; onClose(): void; onSubmit(body: unknown, item: Feature | 'create'): void }) {
  if (item === null) return null;
  const editing = item !== 'create';
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); onSubmit({ ...(editing ? {} : { code: form.get('code') }), name: form.get('name'), description: form.get('description') || null, status: form.get('status') }, item!); }
  return <Modal open title={editing ? '编辑功能定义' : '新增功能定义'} subtitle="Key 生成时可选择这些真实功能授权" onClose={onClose}>
    <form className="form-grid" onSubmit={submit}>
      <label>功能名称<input name="name" required defaultValue={editing ? item.name : ''} /></label>
      <label>功能代码<input name="code" required disabled={editing} defaultValue={editing ? item.code : ''} placeholder="module.export" /></label>
      <label>状态<select name="status" defaultValue={editing ? item.status : 'ACTIVE'}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label>
      <label className="full">功能说明<textarea name="description" rows={4} defaultValue={editing ? item.description ?? '' : ''} /></label>
      <div className="form-actions full"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? '正在保存...' : '保存功能'}</button></div>
    </form>
  </Modal>;
}

function Info({ label, value, wide = false, mono = false }: { label: string; value: string; wide?: boolean; mono?: boolean }) {
  return <div className={`info-block ${wide ? 'wide' : ''}`}><small>{label}</small>{mono ? <pre>{value}</pre> : <strong>{value}</strong>}</div>;
}
