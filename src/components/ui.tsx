import { formatPesos, type Centavos } from '@bfms/shared';
import { useEffect, useRef, type ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions, breadcrumbs }: { title: string; subtitle?: string; actions?: ReactNode; breadcrumbs?: string[] }) {
  return (
    <div className="mb-6 flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {breadcrumbs && (
          <nav aria-label="Breadcrumb" className="mb-1 text-xs text-slate-500">
            {breadcrumbs.join(' / ')}
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
    <div role="status" className="flex items-center gap-2 py-6 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-navy-200 border-t-navy-700" />
      {label}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center">
      <p className="font-medium text-slate-800">{title}</p>
      {children && <div className="mt-2 text-sm text-slate-600">{children}</div>}
    </div>
  );
}

export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: string; onClose(): void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className={`w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} rounded-lg p-0 shadow-xl backdrop:bg-navy-900/40`}>
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h2 className="font-serif text-lg font-bold text-navy-800">{title}</h2>
        <button type="button" onClick={onClose} className="btn-ghost px-2 py-1" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">{footer}</div>}
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
          <button className="btn-secondary" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </button>
          <button className={props.danger ? 'btn-danger' : 'btn-primary'} onClick={props.onConfirm} disabled={props.busy || needs}>
            {props.busy ? 'Working…' : props.confirmLabel ?? 'Confirm'}
          </button>
        </>
      }
    >
      <div className="text-sm text-slate-700">{props.message}</div>
      {props.requireReason && (
        <div className="mt-4">
          <label className="label" htmlFor="confirm-reason">
            Justification (required, at least 10 characters)
          </label>
          <textarea id="confirm-reason" className="input" rows={3} value={props.reason ?? ''} onChange={(e) => props.onReasonChange?.(e.target.value)} />
        </div>
      )}
    </Modal>
  );
}

export function Pager({ page, hasPrev, hasNext, onPrev, onNext, loading }: { page: number; hasPrev: boolean; hasNext: boolean; onPrev(): void; onNext(): void; loading?: boolean }) {
  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-sm text-slate-600">
      <span>Page {Math.max(page, 1)}</span>
      <div className="flex gap-2">
        <button className="btn-secondary px-3 py-1" onClick={onPrev} disabled={!hasPrev || loading}>
          Previous
        </button>
        <button className="btn-secondary px-3 py-1" onClick={onNext} disabled={!hasNext || loading}>
          Next
        </button>
      </div>
    </div>
  );
}
