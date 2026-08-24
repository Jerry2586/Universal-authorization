import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, LockKeyhole } from 'lucide-react';

export function Pagination({
  offset,
  limit,
  itemCount,
  total,
  onChange,
  busy = false,
}: {
  offset: number;
  limit: number;
  itemCount: number;
  total?: number;
  onChange(nextOffset: number): void;
  busy?: boolean;
}) {
  const page = Math.floor(offset / limit) + 1;
  const reachedEnd = total === undefined ? itemCount < limit : offset + itemCount >= total;
  return (
    <div className="pagination">
      <span>第 {page} 页 · 当前 {itemCount} 条{total === undefined ? '' : ` · 共 ${total} 条`}</span>
      <div>
        <button type="button" className="ghost" disabled={busy || offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          <ChevronLeft />上一页
        </button>
        <button type="button" className="ghost" disabled={busy || reachedEnd} onClick={() => onChange(offset + limit)}>
          下一页<ChevronRight />
        </button>
      </div>
    </div>
  );
}

export function JsonField({
  name,
  label,
  defaultValue = {},
  help,
  rows = 5,
}: {
  name: string;
  label: string;
  defaultValue?: Record<string, unknown>;
  help?: string;
  rows?: number;
}) {
  return (
    <label className="full">
      {label}
      <textarea name={name} rows={rows} defaultValue={JSON.stringify(defaultValue, null, 2)} spellCheck={false} />
      {help && <small className="field-help">{help}</small>}
    </label>
  );
}

export function parseJsonObject(form: FormData, name: string): Record<string, unknown> {
  const raw = String(form.get(name) ?? '').trim();
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${name} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

export function PermissionNotice({ children }: { children: ReactNode }) {
  return <div className="permission-notice"><LockKeyhole />{children}</div>;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN');
}

export function toLocalDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
