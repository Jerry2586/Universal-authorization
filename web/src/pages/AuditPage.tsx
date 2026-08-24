import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Clipboard, Filter, RotateCcw, ScrollText, Search, ShieldCheck } from 'lucide-react';
import { api, queryString } from '../api/client';
import type { AuditItem, LicenseEvent, Page } from '../api/types';
import { formatDate, Pagination, PermissionNotice } from '../components/AdminForms';
import { useAuth } from '../auth/AuthProvider';
import { useToast } from '../components/Toast';
import { Drawer, Empty, SkeletonRows } from '../components/Ui';

const PAGE_SIZE = 50;
type Tab = 'audit' | 'events';
type Filters = Record<string, string>;

const emptyAuditFilters: Filters = {
  actor_type: '', actor_id: '', action: '', resource_type: '', resource_id: '', result: '', request_id: '', occurred_from: '', occurred_to: '',
};
const emptyEventFilters: Filters = {
  product_id: '', license_id: '', device_id: '', activation_id: '', session_id: '', event_type: '', result: '', reason_code: '', request_id: '', occurred_from: '', occurred_to: '',
};

export function AuditPage() {
  const { has } = useAuth();
  const [tab, setTab] = useState<Tab>('audit');
  const [offset, setOffset] = useState(0);
  const [auditDraft, setAuditDraft] = useState(emptyAuditFilters);
  const [eventDraft, setEventDraft] = useState(emptyEventFilters);
  const [auditFilters, setAuditFilters] = useState(emptyAuditFilters);
  const [eventFilters, setEventFilters] = useState(emptyEventFilters);
  const [selectedAudit, setSelectedAudit] = useState<AuditItem | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<LicenseEvent | null>(null);
  const canRead = has('audit.read');

  const audit = useQuery({
    queryKey: ['audit', auditFilters, offset],
    queryFn: () => api<Page<AuditItem>>(`/admin/v1/audit-logs${queryString({ limit: PAGE_SIZE, offset, ...toQuery(auditFilters) })}`),
    enabled: canRead && tab === 'audit',
  });
  const events = useQuery({
    queryKey: ['events', eventFilters, offset],
    queryFn: () => api<Page<LicenseEvent>>(`/admin/v1/license-events${queryString({ limit: PAGE_SIZE, offset, ...toQuery(eventFilters) })}`),
    enabled: canRead && tab === 'events',
  });

  const current = tab === 'audit' ? audit : events;
  const items = current.data?.items ?? [];
  const draft = tab === 'audit' ? auditDraft : eventDraft;
  const setDraft = tab === 'audit' ? setAuditDraft : setEventDraft;

  function changeTab(next: Tab) {
    setTab(next);
    setOffset(0);
  }

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    if (tab === 'audit') setAuditFilters({ ...auditDraft });
    else setEventFilters({ ...eventDraft });
    setOffset(0);
  }

  function resetFilters() {
    if (tab === 'audit') {
      setAuditDraft(emptyAuditFilters);
      setAuditFilters(emptyAuditFilters);
    } else {
      setEventDraft(emptyEventFilters);
      setEventFilters(emptyEventFilters);
    }
    setOffset(0);
  }

  if (!canRead) return <PermissionNotice>当前账号没有 audit.read 权限，不能读取管理员审计和授权事件。</PermissionNotice>;

  return (
    <div className="page-stack">
      <div className="subnav">
        <button type="button" className={tab === 'audit' ? 'active' : ''} onClick={() => changeTab('audit')}><ScrollText />管理员审计</button>
        <button type="button" className={tab === 'events' ? 'active' : ''} onClick={() => changeTab('events')}><Activity />授权事件</button>
      </div>

      <form className="panel filter-panel" onSubmit={applyFilters}>
        <div className="panel-head compact">
          <div><span>REAL API FILTERS</span><h3>{tab === 'audit' ? '管理员审计完整筛选' : '授权事件完整筛选'}</h3></div>
          <Filter />
        </div>
        <div className="filter-grid">
          {tab === 'audit'
            ? <AuditFilters values={draft} onChange={setDraft} />
            : <EventFilters values={draft} onChange={setDraft} />}
        </div>
        <div className="filter-actions">
          <button type="button" className="ghost" onClick={resetFilters}><RotateCcw />清空筛选</button>
          <button type="submit" className="primary"><Search />查询真实记录</button>
        </div>
      </form>

      <section className="panel table-panel">
        {current.isLoading ? <SkeletonRows /> : current.isError ? (
          <Empty icon={<Activity />} title="读取失败" text={current.error instanceof Error ? current.error.message : '无法读取审计数据'} />
        ) : items.length === 0 ? (
          <Empty icon={<ScrollText />} title="暂无记录" text="当前筛选条件下没有真实审计数据。" />
        ) : tab === 'audit' ? (
          <AuditList items={items as AuditItem[]} onOpen={setSelectedAudit} />
        ) : (
          <EventList items={items as LicenseEvent[]} onOpen={setSelectedEvent} />
        )}
        <Pagination offset={offset} limit={PAGE_SIZE} itemCount={items.length} busy={current.isFetching} onChange={setOffset} />
      </section>

      <AuditDrawer item={selectedAudit} onClose={() => setSelectedAudit(null)} />
      <EventDrawer item={selectedEvent} onClose={() => setSelectedEvent(null)} />
    </div>
  );
}

function AuditFilters({ values, onChange }: { values: Filters; onChange(value: Filters): void }) {
  return <>
    <SelectField label="主体类型" value={values.actor_type} onChange={(value) => onChange({ ...values, actor_type: value })} options={['ADMIN_USER', 'SYSTEM', 'API_CLIENT']} />
    <Field label="主体 UUID" value={values.actor_id} onChange={(value) => onChange({ ...values, actor_id: value })} />
    <Field label="操作代码" value={values.action} onChange={(value) => onChange({ ...values, action: value })} />
    <Field label="资源类型" value={values.resource_type} onChange={(value) => onChange({ ...values, resource_type: value })} />
    <Field label="资源 ID" value={values.resource_id} onChange={(value) => onChange({ ...values, resource_id: value })} />
    <SelectField label="操作结果" value={values.result} onChange={(value) => onChange({ ...values, result: value })} options={['SUCCESS', 'FAILURE']} />
    <Field label="请求 ID" value={values.request_id} onChange={(value) => onChange({ ...values, request_id: value })} />
    <DateField label="开始时间" value={values.occurred_from} onChange={(value) => onChange({ ...values, occurred_from: value })} />
    <DateField label="结束时间" value={values.occurred_to} onChange={(value) => onChange({ ...values, occurred_to: value })} />
  </>;
}

function EventFilters({ values, onChange }: { values: Filters; onChange(value: Filters): void }) {
  return <>
    <Field label="产品 UUID" value={values.product_id} onChange={(value) => onChange({ ...values, product_id: value })} />
    <Field label="Key UUID" value={values.license_id} onChange={(value) => onChange({ ...values, license_id: value })} />
    <Field label="设备 UUID" value={values.device_id} onChange={(value) => onChange({ ...values, device_id: value })} />
    <Field label="激活 UUID" value={values.activation_id} onChange={(value) => onChange({ ...values, activation_id: value })} />
    <Field label="会话 UUID" value={values.session_id} onChange={(value) => onChange({ ...values, session_id: value })} />
    <Field label="事件类型" value={values.event_type} onChange={(value) => onChange({ ...values, event_type: value })} />
    <SelectField label="事件结果" value={values.result} onChange={(value) => onChange({ ...values, result: value })} options={['SUCCESS', 'FAILURE']} />
    <Field label="原因代码" value={values.reason_code} onChange={(value) => onChange({ ...values, reason_code: value })} />
    <Field label="请求 ID" value={values.request_id} onChange={(value) => onChange({ ...values, request_id: value })} />
    <DateField label="开始时间" value={values.occurred_from} onChange={(value) => onChange({ ...values, occurred_from: value })} />
    <DateField label="结束时间" value={values.occurred_to} onChange={(value) => onChange({ ...values, occurred_to: value })} />
  </>;
}

function Field({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  return <label>{label}<input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}
function DateField({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  return <label>{label}<input type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}
function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange(value: string): void }) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}><option value="">全部</option>{options.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>;
}

function AuditList({ items, onOpen }: { items: AuditItem[]; onOpen(item: AuditItem): void }) {
  return <div className="timeline">{items.map((item) => <button type="button" className="timeline-entry" key={item.id} onClick={() => onOpen(item)}>
    <span className={`timeline-icon ${item.result.toLowerCase()}`}>{item.result === 'SUCCESS' ? <ShieldCheck /> : <Activity />}</span>
    <span className="timeline-main"><span className="timeline-header"><strong>{item.action}</strong><span className={`badge ${item.result.toLowerCase()}`}>{item.result}</span><time>{formatDate(item.occurred_at)}</time></span><span className="timeline-copy">{item.actor_type} 对 {item.resource_type}{item.resource_id ? ` · ${item.resource_id}` : ''} 执行操作</span><span className="timeline-footer"><code>{item.request_id ?? '无请求编号'}</code><span>{item.source_ip ?? '未知来源'}</span></span></span>
  </button>)}</div>;
}

function EventList({ items, onOpen }: { items: LicenseEvent[]; onOpen(item: LicenseEvent): void }) {
  return <div className="timeline">{items.map((item) => <button type="button" className="timeline-entry" key={item.id} onClick={() => onOpen(item)}>
    <span className={`timeline-icon ${item.result.toLowerCase()}`}><Activity /></span>
    <span className="timeline-main"><span className="timeline-header"><strong>{item.event_type}</strong><span className={`badge ${item.result.toLowerCase()}`}>{item.result}</span><time>{formatDate(item.occurred_at)}</time></span><span className="timeline-copy">{item.reason_code ? `原因：${item.reason_code}` : '授权生命周期事件'}{item.license_id ? ` · Key ${item.license_id}` : ''}</span><span className="timeline-footer"><code>{item.request_id ?? '无请求编号'}</code><span>{item.ip_address ?? '未知来源'}</span></span></span>
  </button>)}</div>;
}

function AuditDrawer({ item, onClose }: { item: AuditItem | null; onClose(): void }) {
  return <Drawer open={item !== null} title="管理员审计详情" subtitle={item?.action} onClose={onClose}>{item && <div className="drawer-stack">
    <DetailGrid entries={[
      ['记录 UUID', item.id], ['租户 UUID', item.tenant_id], ['主体类型', item.actor_type], ['主体 UUID', item.actor_id],
      ['操作代码', item.action], ['资源类型', item.resource_type], ['资源 ID', item.resource_id], ['结果', item.result],
      ['请求 ID', item.request_id], ['来源 IP', item.source_ip], ['发生时间', formatDate(item.occurred_at)], ['User-Agent', item.user_agent],
    ]} />
    <JsonBlock title="变更前数据" value={item.before_data} />
    <JsonBlock title="变更后数据" value={item.after_data} />
    <JsonBlock title="元数据" value={item.metadata} />
  </div>}</Drawer>;
}

function EventDrawer({ item, onClose }: { item: LicenseEvent | null; onClose(): void }) {
  return <Drawer open={item !== null} title="授权事件详情" subtitle={item?.event_type} onClose={onClose}>{item && <div className="drawer-stack">
    <DetailGrid entries={[
      ['记录 UUID', item.id], ['租户 UUID', item.tenant_id], ['产品 UUID', item.product_id], ['Key UUID', item.license_id],
      ['设备 UUID', item.device_id], ['激活 UUID', item.activation_id], ['会话 UUID', item.session_id], ['事件类型', item.event_type],
      ['结果', item.result], ['原因代码', item.reason_code], ['请求 ID', item.request_id], ['来源 IP', item.ip_address], ['发生时间', formatDate(item.occurred_at)],
    ]} />
    <JsonBlock title="事件元数据" value={item.metadata} />
  </div>}</Drawer>;
}

function DetailGrid({ entries }: { entries: Array<[string, string | null | undefined]> }) {
  const toast = useToast();
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); toast('内容已复制'); }
    catch { toast('复制失败，请手动复制', 'error'); }
  }
  return <div className="detail-grid">{entries.map(([label, value]) => <div key={label}><span>{label}</span><strong title={value ?? '—'}>{value ?? '—'}</strong>{value && <button type="button" className="copy-mini" onClick={() => void copy(value)} aria-label={`复制${label}`}><Clipboard /></button>}</div>)}</div>;
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return <section className="info-block"><h4>{title}</h4><pre>{JSON.stringify(value ?? null, null, 2)}</pre></section>;
}

function toQuery(filters: Filters): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, value ? (key.startsWith('occurred_') ? new Date(value).toISOString() : value.trim()) : undefined]));
}
