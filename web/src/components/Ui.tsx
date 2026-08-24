import { useEffect, useId, useRef, type ReactNode } from 'react';
import { CircleAlert, RefreshCw, X } from 'lucide-react';

let openLayerCount = 0;
let previousBodyOverflow = '';

function useOverlay(open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;

    if (openLayerCount === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    openLayerCount += 1;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      openLayerCount = Math.max(0, openLayerCount - 1);
      if (openLayerCount === 0) document.body.style.overflow = previousBodyOverflow;
    };
  }, [open]);
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  useOverlay(open, onClose);
  if (!open) return null;

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose(): void;
  children: ReactNode;
}) {
  const titleId = useId();
  useOverlay(open, onClose);
  if (!open) return null;

  return (
    <div
      className="overlay drawer-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-button" aria-label="关闭详情" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

export function queryErrorMessage(error: unknown, fallback = '数据读取失败'): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function QueryError({
  title,
  error,
  onRetry,
  compact = false,
}: {
  title: string;
  error: unknown;
  onRetry?(): void;
  compact?: boolean;
}) {
  const message = queryErrorMessage(error);
  const retry = onRetry ? (
    <button type="button" className="ghost" onClick={onRetry}>
      <RefreshCw />重新读取
    </button>
  ) : undefined;

  if (compact) {
    return (
      <div className="data-error query-error-compact" role="alert">
        <CircleAlert />
        <div><strong>{title}</strong><span>{message}</span></div>
        {retry}
      </div>
    );
  }

  return <Empty icon={<CircleAlert />} title={title} text={message} action={retry} />;
}

export function SkeletonRows() {
  return (
    <div className="skeleton-list" aria-label="正在加载">
      {[1, 2, 3, 4].map((number) => (
        <div className="skeleton-row" key={number} />
      ))}
    </div>
  );
}
