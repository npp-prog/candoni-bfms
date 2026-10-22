import { transitionsFrom, type ModuleTransition, type ReportParams, type SourceModuleDef } from '@bfms/shared';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useCollection } from '../hooks/useCollection';
import { api, errorMessage } from '../services/functions/api';
import { ConfirmDialog, Icon, StatusChip } from './ui';

type Rec = { id: string; barangayId: string; status: string; createdBy?: string; returnInfo?: { reasonForReturn: string } | null; jevId?: string | null };

/**
 * Workflow buttons for a source document: only the transitions the module allows from the
 * record's status AND the user holds the permission for. The server re-checks everything.
 */
export function ActionBar({ def, record, onDone, payload, extra }: { def: SourceModuleDef; record: Rec; onDone?(result: { status: string; number: string | null; jevId: string | null }): void; payload?(action: string): Record<string, unknown> | undefined; extra?: ReactNode }) {
  const { can, user } = useAuth();
  const { notify } = useToast();
  const [pending, setPending] = useState<ModuleTransition | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // A user may hold several matching transitions (e.g. RETURN by PB vs accounting); keep the ones they can run.
  const actions = transitionsFrom(def, record.status).filter((t) =>
    def.transitions.some((x) => x.action === t.action && x.from.includes(record.status) && can(x.permission, record.barangayId as never)),
  );

  async function run(t: ModuleTransition) {
    setBusy(true);
    try {
      const r = await api.sourceAction({ module: def.key, id: record.id, action: t.action, remarks: reason.trim() || undefined, payload: payload?.(t.action) });
      notify(`${def.label}: ${t.label.replace('…', '')} done${r.number ? ` — No. ${r.number}` : ''}.`, 'success');
      setPending(null);
      setReason('');
      onDone?.(r);
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!actions.length && !extra) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {extra}
      {actions.map((t) => {
        const selfBlocked = t.segregation && record.createdBy === user?.uid;
        return (
          <button
            key={t.action}
            type="button"
            className={t.tone === 'danger' ? 'btn-danger' : t.tone === 'primary' ? 'btn-primary' : 'btn-secondary'}
            disabled={busy || selfBlocked}
            title={selfBlocked ? 'You prepared this record, so another person must do this.' : undefined}
            onClick={() => (t.requiresReason || t.confirm ? setPending(t) : void run(t))}
          >
            {t.label}
          </button>
        );
      })}
      {pending && (
        <ConfirmDialog
          open
          busy={busy}
          danger={pending.tone === 'danger'}
          title={`${pending.label.replace('…', '')} — ${def.label}`}
          message={pending.confirm ?? `Confirm "${pending.label.replace('…', '')}" for this ${def.label.toLowerCase()}.`}
          confirmLabel={pending.label.replace('…', '')}
          requireReason={pending.requiresReason}
          reason={reason}
          onReasonChange={setReason}
          onCancel={() => setPending(null)}
          onConfirm={() => void run(pending)}
        />
      )}
    </div>
  );
}

/** Banner shown on RETURNED records with the reviewer's reason. */
export function ReturnBanner({ record }: { record: Rec }) {
  if (record.status !== 'RETURNED' || !record.returnInfo) return null;
  return (
    <div role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-orange-300 bg-orange-50 px-4 py-3 text-sm text-orange-900">
      <Icon name="alert" className="mt-0.5 h-4 w-4" />
      <p><strong>Returned for correction:</strong> {record.returnInfo.reasonForReturn}</p>
    </div>
  );
}

/** Status history of a record (workflowHistory, append-only). */
export function WorkflowTrail({ barangayId, recordId }: { barangayId: string; recordId: string }) {
  const { rows } = useCollection<{ fromStatus: string | null; toStatus: string; actedByName: string; actedAt: { seconds: number }; remarks: string | null }>(
    'workflowHistory',
    [['barangayId', '==', barangayId], ['recordId', '==', recordId]],
  );
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => (a.actedAt?.seconds ?? 0) - (b.actedAt?.seconds ?? 0));
  return (
    <details className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm">
      <summary className="font-medium text-slate-800">History ({sorted.length})</summary>
      <ol className="mt-2 space-y-1.5">
        {sorted.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
            <span className="tabular-nums text-slate-500">{h.actedAt ? new Date(h.actedAt.seconds * 1000).toLocaleString('en-PH') : ''}</span>
            {h.fromStatus && <StatusChip status={h.fromStatus} />}
            <span aria-hidden="true">→</span>
            <StatusChip status={h.toStatus} />
            <span>by {h.actedByName}</span>
            {h.remarks && <span className="italic">“{h.remarks}”</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** URL of the report viewer for a report code and parameters. */
export function reportHref(code: string, params: Partial<ReportParams> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && k !== 'barangayId') q.set(k, String(v));
  const s = q.toString();
  return `/reports/view/${code}${s ? `?${s}` : ''}`;
}

/** "Print form" link for a FORM-type report of one document (DV, OR, LR, Payroll …). */
export function PrintLink({ code, documentId, fiscalYear, label = 'Print', className = 'btn-secondary' }: { code: string; documentId: string; fiscalYear: number; label?: string; className?: string }) {
  return (
    <Link className={className} to={reportHref(code, { documentId, fiscalYear })}>
      <Icon name="file" /> {label}
    </Link>
  );
}

/** Save a source document through the engine with toast feedback; returns the id or null. */
export function useSaveSource(moduleKey: string) {
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  async function save(barangayId: string, data: unknown, id?: string): Promise<string | null> {
    setBusy(true);
    try {
      const r = await api.saveSource({ module: moduleKey, id, barangayId: barangayId as never, data });
      notify('Saved.', 'success');
      return r.id;
    } catch (e) {
      notify(errorMessage(e), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { save, busy };
}

/** Status filter options for a module register. */
export function statusOptions(def: SourceModuleDef): string[] {
  const s = new Set<string>(['DRAFT']);
  def.transitions.forEach((t) => {
    t.from.forEach((f) => s.add(f));
    s.add(t.to);
  });
  s.add('POSTED');
  return [...s];
}
