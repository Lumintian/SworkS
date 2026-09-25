import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

// ---------------------------------------------------------------- Toast

export type ToastTone = 'info' | 'success' | 'error' | 'warn';
interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-3), { id, tone, message }]);
    // 错误提示停留更久；成功提示立即出现，不做人为延迟
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === 'error' ? 9000 : 3500);
  }, []);
  const toneClass: Record<ToastTone, string> = {
    info: 'border-line bg-surface text-ink',
    success: 'border-sage bg-sage-soft text-sage-deep',
    warn: 'border-clay bg-ochre-soft text-ochre',
    error: 'border-terracotta bg-terracotta-soft text-terracotta',
  };
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,380px)] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={`toast pointer-events-auto flex items-start gap-2 border px-4 py-3 text-sm font-semibold shadow-[var(--shadow-lift)] ${toneClass[t.tone]}`}
            style={{ borderRadius: 'var(--radius-organic-sm)' }}
          >
            <span className="flex-1">{t.message}</span>
            <button type="button" className="opacity-60 hover:opacity-100" aria-label="关闭提示" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}>
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ---------------------------------------------------------------- Dialog（原生 <dialog>，自带焦点管理与 Esc 关闭）

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={`card m-auto max-h-[86vh] overflow-hidden p-0 text-ink backdrop:bg-[rgb(59_42_32/0.28)]`}
      style={{ width: `min(94vw, ${wide ? 760 : 520}px)` }}
    >
      {open ? (
        <div className="flex max-h-[86vh] flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
            <h2 id={titleId} className="text-lg font-semibold text-stone">
              {title}
            </h2>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="关闭" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

// ---------------------------------------------------------------- 杂项

export function Spinner({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-ink-faint" role="status">
      <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-sage" />
      {label}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card-flat flex flex-col items-center gap-2 px-6 py-10 text-center">
      <p className="font-serif text-lg text-stone">{title}</p>
      {children ? <div className="max-w-md text-sm text-ink-soft">{children}</div> : null}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 border border-terracotta/40 bg-terracotta-soft px-4 py-3 text-sm text-terracotta" style={{ borderRadius: 'var(--radius-organic-sm)' }}>
      <span className="flex-1 font-semibold">{message}</span>
      {onRetry ? (
        <button type="button" className="btn btn-sm btn-danger" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-stone">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
