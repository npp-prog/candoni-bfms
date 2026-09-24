import { type AccountingPeriodDoc, type PeriodStatus } from '@bfms/shared';
import { useState } from 'react';
import { ConfirmDialog, Spinner, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { usePeriods } from '../../hooks/usePeriods';
import { api, errorMessage } from '../../services/functions/api';

const MONTHS = ['00 Opening balances', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', '13 Closing entries'];
type Act = { kind: 'lock' | 'reopen' | 'review' | 'unreview'; p: AccountingPeriodDoc & { id: string } };

export function PeriodsPanel() {
  const { can } = useAuth();
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const { notify } = useToast();
  const { periods, loading } = usePeriods(barangayId, fiscalYear);
  const [act, setAct] = useState<Act | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!barangayId) return null;
  const bid = barangayId;

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      notify(ok, 'success');
      setAct(null);
      setReason('');
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const actions = (status: PeriodStatus) => ({
    review: status === 'OPEN' && can('period.lock', bid),
    unreview: status === 'REVIEW' && can('period.lock', bid),
    lock: (status === 'OPEN' || status === 'REVIEW') && can('period.lock', bid),
    reopen: status === 'LOCKED' && can('period.reopen', bid),
  });

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="font-serif font-bold text-navy-800">Fiscal year {fiscalYear} · {barangayLabel}</h2>
        <div className="flex gap-2">
          {can('fiscalYear.manage', 'ALL') && (
            <button className="btn-secondary" disabled={busy} onClick={() => void run(() => api.createFiscalYear({ fiscalYear }), `Fiscal year ${fiscalYear} created.`)}>Create FY {fiscalYear}</button>
          )}
          {can('fiscalYear.manage', bid) && periods.length === 0 && (
            <button className="btn-primary" disabled={busy} onClick={() => void run(() => api.openBarangayFiscalYear({ barangayId: bid, fiscalYear }), `${bid} FY ${fiscalYear} opened.`)}>Open FY for {bid}</button>
          )}
        </div>
      </div>
      {loading ? <Spinner /> : periods.length === 0 ? (
        <p className="p-4 text-sm text-slate-600">No periods yet. Create the fiscal year, then open it for this barangay.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>Period</th><th>Status</th><th>Last change</th><th className="text-right">Actions</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {periods.map((p) => {
                const a = actions(p.status);
                const last = p.history?.[p.history.length - 1];
                return (
                  <tr key={p.id}>
                    <td className="font-medium">{MONTHS[p.month]}</td>
                    <td><StatusChip status={p.status} /></td>
                    <td className="text-xs text-slate-500">{last ? `${last.from} → ${last.to}${last.reason ? ` · ${last.reason}` : ''}` : '—'}</td>
                    <td className="space-x-1 text-right">
                      {a.review && <button className="btn-ghost px-2 py-1" onClick={() => setAct({ kind: 'review', p })}>Set review</button>}
                      {a.unreview && <button className="btn-ghost px-2 py-1" onClick={() => setAct({ kind: 'unreview', p })}>Return to open</button>}
                      {a.lock && <button className="btn-secondary px-2 py-1" onClick={() => setAct({ kind: 'lock', p })}>Lock</button>}
                      {a.reopen && <button className="btn-danger px-2 py-1" onClick={() => setAct({ kind: 'reopen', p })}>Reopen…</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {act && (
        <ConfirmDialog
          open
          busy={busy}
          danger={act.kind === 'reopen'}
          title={{ lock: 'Lock period', reopen: 'Reopen locked period', review: 'Set period to review', unreview: 'Return period to open' }[act.kind]}
          message={
            act.kind === 'reopen'
              ? <>Reopening <strong>{MONTHS[act.p.month]}</strong> allows new postings. Final reports for this period are flagged as stale, and new versions are needed after you lock it again. This action is audited.</>
              : <>Confirm this action for <strong>{MONTHS[act.p.month]}</strong> ({bid}, FY {fiscalYear}).</>
          }
          requireReason={act.kind === 'reopen'}
          reason={reason}
          onReasonChange={setReason}
          confirmLabel={act.kind === 'reopen' ? 'Reopen period' : 'Confirm'}
          onCancel={() => setAct(null)}
          onConfirm={() => {
            const base = { barangayId: bid, fiscalYear, month: act.p.month };
            if (act.kind === 'lock') void run(() => api.lockAccountingPeriod(base), 'Period locked.');
            if (act.kind === 'reopen') void run(() => api.reopenAccountingPeriod({ ...base, reason }), 'Period reopened.');
            if (act.kind === 'review') void run(() => api.setPeriodReview({ ...base, review: true }), 'Period set to review.');
            if (act.kind === 'unreview') void run(() => api.setPeriodReview({ ...base, review: false }), 'Period returned to open.');
          }}
        />
      )}
    </div>
  );
}
