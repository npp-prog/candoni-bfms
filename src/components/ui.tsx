import { formatPesos, type Centavos } from '@bfms/shared';
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

/** Inline stroke icons (Lucide geometry) so the bundle needs no icon package. Decorative unless labelled by the parent. */
const ICONS = {
  x: 'M18 6 6 18M6 6l12 12',
  menu: 'M4 6h16M4 12h16M4 18h16',
  plus: 'M12 5v14M5 12h14',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  chevronLeft: 'm15 18-6-6 6-6',
  chevronRight: 'm9 18 6-6-6-6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  check: 'M20 6 9 17l-5-5',
  info: 'M12 16v-4M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, className = 'h-4 w-4' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
      <path d={ICONS[name]} />
    </svg>
  );
}

export function PageHeader({ title, subtitle, actions, breadcrumbs }: { title: string; subtitle?: string; actions?: ReactNode; breadcrumbs?: string[] }) {
  return (
    <div className="mb-6 flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {breadcrumbs && (
          <nav aria-label="Breadcrumb" className="mb-1 text-xs text-slate-600">
            <ol className="flex flex-wrap items-center gap-1">
              {breadcrumbs.map((b, i) => (
                <li key={i} className="flex items-center gap-1" aria-current={i === breadcrumbs.length - 1 ? 'page' : undefined}>
                  {i > 0 && <span aria-hidden="true" className="text-slate-400">/</span>}
                  {b}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <h1 className="font-serif text-2xl font-bold text-navy-800">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const CHIP: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 ring-slate-300',
  SUBMITTED: 'bg-sky-50 text-sky-800 ring-sky-200',
  FOR_REVIEW: 'bg-amber-50 text-amber-800 ring-amber-200',
  REVIEW: 'bg-amber-50 text-amber-800 ring-amber-200',
  RETURNED: 'bg-orange-50 text-orange-800 ring-orange-200',
  RESUBMITTED: 'bg-sky-50 text-sky-800 ring-sky-200',
  APPROVED: 'bg-indigo-50 text-indigo-800 ring-indigo-200',
  ACCEPTED: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  POSTED: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
  FINAL: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
  OPEN: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  LOCKED: 'bg-navy-50 text-navy-800 ring-navy-200',
  CLOSED: 'bg-slate-200 text-slate-800 ring-slate-300',
  REVERSED: 'bg-rose-50 text-rose-800 ring-rose-200',
  VOID: 'bg-rose-50 text-rose-800 ring-rose-200',
  OVERDUE: 'bg-red-50 text-red-800 ring-red-200',
  SETUP: 'bg-slate-100 text-slate-700 ring-slate-300',
  DISABLED: 'bg-slate-200 text-slate-800 ring-slate-300',
  ACTIVE: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  CERTIFIED: 'bg-indigo-50 text-indigo-800 ring-indigo-200',
  CANCELLED: 'bg-rose-50 text-rose-800 ring-rose-200',
  PREPARED: 'bg-slate-100 text-slate-700 ring-slate-300',
  ISSUED: 'bg-sky-50 text-sky-800 ring-sky-200',
  RELEASED: 'bg-indigo-50 text-indigo-800 ring-indigo-200',
  CLEARED: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
  OUTSTANDING: 'bg-amber-50 text-amber-800 ring-amber-200',
  STALE: 'bg-orange-50 text-orange-800 ring-orange-200',
  EXHAUSTED: 'bg-slate-200 text-slate-800 ring-slate-300',
  PARTIALLY_LIQUIDATED: 'bg-amber-50 text-amber-800 ring-amber-200',
  FULLY_LIQUIDATED: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
  FULLY_UTILIZED: 'bg-slate-200 text-slate-800 ring-slate-300',
  TRANSFERRED: 'bg-sky-50 text-sky-800 ring-sky-200',
  UNSERVICEABLE: 'bg-orange-50 text-orange-800 ring-orange-200',
  DISPOSED: 'bg-slate-200 text-slate-800 ring-slate-300',
  PASSED: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  WARNING: 'bg-amber-50 text-amber-800 ring-amber-200',
  FAILED: 'bg-red-50 text-red-800 ring-red-200',
  GENERATED: 'bg-sky-50 text-sky-800 ring-sky-200',
  REQUIRED: 'bg-slate-100 text-slate-700 ring-slate-300',
  MISSING: 'bg-red-50 text-red-800 ring-red-200',
  NOT_STARTED: 'bg-slate-100 text-slate-700 ring-slate-300',
  NOT_APPLICABLE: 'bg-slate-50 text-slate-600 ring-slate-200',
  ARCHIVED: 'bg-slate-200 text-slate-700 ring-slate-300',
};

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${CHIP[status] ?? 'bg-slate-100 text-slate-700 ring-slate-300'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function Money({ value, dashZero = true }: { value: Centavos | number; dashZero?: boolean }) {
  return <span className="tabular-nums">{formatPesos(value as Centavos, { dashZero })}</span>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 px-4 py-6 text-sm text-slate-600">
      <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-navy-200 border-t-navy-700" />
      {label}
    </div>
  );
}

/** Placeholder rows that reserve the table's space while it loads, so the page does not jump. */
export function TableSkeleton({ rows = 5, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div role="status" className="space-y-3 px-4 py-4">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden="true" className="skeleton h-5" style={{ width: `${92 - (i % 3) * 9}%` }} />
      ))}
    </div>
  );
}

/** Label + control + inline error/hint, with the ids wired for screen readers. */
export function Field({ label, error, hint, required, className, children }: { label: string; error?: string | null; hint?: ReactNode; required?: boolean; className?: string; children(props: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string; required?: boolean }): ReactNode }) {
  const id = useId();
  const describedBy = [error && `${id}-err`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <label className={`label ${required ? 'required' : ''}`} htmlFor={id}>{label}</label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy, required })}
      {error && <p id={`${id}-err`} className="field-error">{error}</p>}
      {hint && !error && <p id={`${id}-hint`} className="field-hint">{hint}</p>}
    </div>
  );
}

/** WAI-ARIA tabs with arrow-key / Home / End navigation. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix }: { tabs: readonly T[]; value: T; onChange(t: T): void; label: string; idPrefix: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKey(e: KeyboardEvent, i: number) {
    const last = tabs.length - 1;
    const next = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1) : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (next === null) return;
    e.preventDefault();
    onChange(tabs[next]!);
    refs.current[next]?.focus();
  }
  return (
    <div role="tablist" aria-label={label} className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((t, i) => (
        <button
          key={t}
          ref={(el) => { refs.current[i] = el; }}
          id={`${idPrefix}-tab-${i}`}
          role="tab"
          type="button"
          aria-selected={value === t}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={value === t ? 0 : -1}
          onClick={() => onChange(t)}
          onKeyDown={(e) => onKey(e, i)}
          className={`-mb-px min-h-[2.5rem] border-b-2 px-4 py-2 text-sm transition-colors ${value === t ? 'border-gold-500 font-semibold text-navy-800' : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-navy-700'}`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ title, children, icon = 'file', action }: { title: string; children?: ReactNode; icon?: IconName; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center">
      <Icon name={icon} className="mx-auto mb-3 h-8 w-8 text-slate-400" />
      <p className="font-medium text-slate-800">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-prose text-sm text-slate-600">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: string; onClose(): void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby={titleId} className={`w-[calc(100vw-2rem)] ${wide ? 'max-w-5xl' : 'max-w-lg'} rounded-lg p-0 shadow-xl backdrop:bg-navy-900/50`}>
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
        <h2 id={titleId} className="font-serif text-lg font-bold text-navy-800">{title}</h2>
        <button type="button" onClick={onClose} className="btn-ghost btn-icon" aria-label="Close dialog">
          <Icon name="x" />
        </button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
      {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">{footer}</div>}
    </dialog>
  );
}

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  requireReason?: boolean;
  /** Show the remarks box without requiring it (e.g. a waiver reason that is only sometimes needed). */
  optionalReason?: string;
  reason?: string;
  onReasonChange?(v: string): void;
  onConfirm(): void;
  onCancel(): void;
}) {
  const needs = props.requireReason && (props.reason ?? '').trim().length < 10;
  return (
    <Modal
      open={props.open}
      title={props.title}
      onClose={props.onCancel}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </button>
          <button type="button" className={props.danger ? 'btn-danger' : 'btn-primary'} onClick={props.onConfirm} disabled={props.busy || needs}>
            {props.busy ? 'Working…' : props.confirmLabel ?? 'Confirm'}
          </button>
        </>
      }
    >
      <div className="text-sm text-slate-700">{props.message}</div>
      {props.optionalReason && !props.requireReason && (
        <div className="mt-4">
          <label className="label" htmlFor="confirm-remarks">Remarks</label>
          <textarea id="confirm-remarks" className="input" rows={2} aria-describedby="confirm-remarks-hint" value={props.reason ?? ''} onChange={(e) => props.onReasonChange?.(e.target.value)} />
          <p id="confirm-remarks-hint" className="field-hint">{props.optionalReason}</p>
        </div>
      )}
      {props.requireReason && (
        <div className="mt-4">
          <label className="label required" htmlFor="confirm-reason">
            Justification
          </label>
          <textarea id="confirm-reason" className="input" rows={3} required aria-describedby="confirm-reason-hint" value={props.reason ?? ''} onChange={(e) => props.onReasonChange?.(e.target.value)} />
          <p id="confirm-reason-hint" className="field-hint">
            At least 10 characters ({(props.reason ?? '').trim().length}/10). This is recorded in the audit trail.
          </p>
        </div>
      )}
    </Modal>
  );
}

export function Pager({ page, hasPrev, hasNext, onPrev, onNext, loading }: { page: number; hasPrev: boolean; hasNext: boolean; onPrev(): void; onNext(): void; loading?: boolean }) {
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-sm text-slate-600">
      <span aria-live="polite">Page {Math.max(page, 1)}</span>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary btn-sm" onClick={onPrev} disabled={!hasPrev || loading} aria-label="Previous page">
          <Icon name="chevronLeft" /> Previous
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={onNext} disabled={!hasNext || loading} aria-label="Next page">
          Next <Icon name="chevronRight" />
        </button>
      </div>
    </nav>
  );
}
