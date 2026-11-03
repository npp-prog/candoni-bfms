import { CHECK_STATUS_LABEL, formatPesos, lastDayOfMonth, periodKey, type Centavos, type Schedule1Row } from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { reportHref } from '../../components/source';
import { ConfirmDialog, EmptyState, Field, Icon, Modal, Money, TableSkeleton } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { errorMessage } from '../../services/functions/api';
import { bankApi } from './api';
import type { BankTabProps } from './BankPage';

const STATUS_TONE: Record<Schedule1Row['status'], string> = {
  CLEARED: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  OUTSTANDING: 'bg-sky-50 text-sky-800 ring-sky-200',
  STALE: 'bg-amber-50 text-amber-900 ring-amber-200',
  CANCELLED: 'bg-slate-100 text-slate-700 ring-slate-200',
  AMOUNT_DIFFERS: 'bg-red-50 text-red-800 ring-red-200',
};

/**
 * Checks issued per the journal (legacy 04.1): credits to Cash in Bank with a check no. on this
 * account's ledger, plus the cancelled-checks register at 0.00, with their bank status.
 */
export function ChecksIssuedTab({ period, rec, onChanged }: BankTabProps) {
  const { can } = useAuth();
  const { notify } = useToast();
  const { bank, month, fiscalYear } = period;
  const [ytd, setYtd] = useState(false);
  const [form, setForm] = useState(false);
  const [del, setDel] = useState<{ id: string; checkNumber: string } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = can('jev.prepare', bank.barangayId);
  if (!rec.run) return rec.loading ? <TableSkeleton /> : null;
  const key = periodKey(fiscalYear, month);
  const rows = rec.run.schedule1.filter((s) => !s.priorYear && !s.key.startsWith('LINE:') && (ytd || s.date.startsWith(key)));
  const total = rows.reduce((t, s) => t + s.book, 0);
  const others = rec.run.adjustments.filter((a) => a.key.startsWith('JL:') && (ytd || a.date.startsWith(key)));

  async function remove() {
    if (!del) return;
    setBusy(true);
    try {
      await bankApi.deleteCancelledCheck({ id: del.id, reason: reason.trim() });
      notify(`Check ${del.checkNumber} removed from the cancelled-checks register.`, 'success');
      setDel(null);
      setReason('');
      onChanged();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section aria-labelledby="checks-issued" className="card">
        <div className="card-header">
          <h2 id="checks-issued" className="card-title">Checks issued per the books — {ytd ? `FY ${fiscalYear} to ${key}` : key}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ytd} onChange={(e) => setYtd(e.target.checked)} /> Year to date</label>
            <Link className="btn-secondary btn-sm" to={reportHref('CHECKS_ISSUED', { fiscalYear, month, bankAccountId: bank.id })}><Icon name="file" /> Report</Link>
            {canEdit && <button type="button" className="btn-primary btn-sm" onClick={() => setForm(true)}><Icon name="plus" /> Record cancelled check</button>}
          </div>
        </div>
        {rows.length === 0 ? (
          <EmptyState title="No checks in the journal">
            Checks come from posted journal entries that credit Cash in Bank ({bank.subsidiaryId.split('_').pop()}) with the check number as the first reference.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <caption className="sr-only">Checks issued with their status at the bank</caption>
              <thead>
                <tr><th scope="col">Date</th><th scope="col">Check no.</th><th scope="col">DV no.</th><th scope="col">Payee</th><th scope="col">JEV no.</th><th scope="col" className="num">Amount</th><th scope="col">Bank status</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((s) => (
                  <tr key={s.key} className={s.status === 'CANCELLED' ? 'text-slate-500' : ''}>
                    <td className="whitespace-nowrap tabular-nums">{s.date}</td>
                    <td className="font-mono text-xs">{s.checkNumber}</td>
                    <td className="font-mono text-xs">{s.dvNumber}</td>
                    <td className="max-w-[16rem] truncate" title={s.payeeName}>{s.payeeName}</td>
                    <td className="font-mono text-xs">{s.jevNumbers.join(', ')}</td>
                    <td className="num"><Money value={s.book} dashZero={false} /></td>
                    <td>
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${STATUS_TONE[s.status]}`}>{CHECK_STATUS_LABEL[s.status]}</span>
                      {s.clearedDate && <span className="ml-1 text-xs text-slate-600">{s.clearedDate}</span>}
                      {s.status === 'AMOUNT_DIFFERS' && <span className="ml-1 text-xs text-red-800">bank {formatPesos(s.bank)}</span>}
                      {s.status === 'CANCELLED' && <span className="ml-1 text-xs">{s.remarks}</span>}
                    </td>
                    <td>
                      {canEdit && s.key.startsWith('CXL:') && (
                        <button type="button" className="btn-ghost btn-icon text-slate-500 hover:text-red-700" aria-label={`Remove cancelled check ${s.checkNumber}`} onClick={() => setDel({ id: s.key.slice(4), checkNumber: s.checkNumber })}>
                          <Icon name="trash" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold"><td colSpan={5}>Total — {rows.length} check(s), {rows.filter((r) => r.status === 'CANCELLED').length} cancelled</td><td className="num"><Money value={total} dashZero={false} /></td><td colSpan={2} /></tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {others.length > 0 && (
        <section aria-labelledby="other-disb" className="card">
          <div className="card-header"><h2 id="other-disb" className="card-title">Other book disbursements (no check no.)</h2></div>
          <div className="overflow-x-auto">
            <table className="table-base">
              <caption className="sr-only">Credits to Cash in Bank without a check number</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">Reference</th><th scope="col">Particulars</th><th scope="col" className="num">Amount</th><th scope="col">Bank</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {others.map((a) => (
                  <tr key={a.key}><td className="tabular-nums">{a.date}</td><td className="font-mono text-xs">{a.reference}</td><td>{a.particulars}</td><td className="num"><Money value={-a.book} /></td><td className="text-xs">{a.bankDate ? `Debited ${a.bankDate}` : 'Not yet on the statement'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {form && <CancelledCheckForm period={period} onClose={() => setForm(false)} onSaved={() => { setForm(false); onChanged(); }} />}
      {del && (
        <ConfirmDialog
          open
          danger
          busy={busy}
          title={`Remove cancelled check ${del.checkNumber}`}
          message="Use this only when the check was recorded as cancelled by mistake. The reason is kept in the audit trail."
          confirmLabel="Remove"
          requireReason
          reason={reason}
          onReasonChange={setReason}
          onCancel={() => setDel(null)}
          onConfirm={() => void remove()}
        />
      )}
    </div>
  );
}

function CancelledCheckForm({ period, onClose, onSaved }: { period: BankTabProps['period']; onClose(): void; onSaved(): void }) {
  const { notify } = useToast();
  const { bank, fiscalYear, month } = period;
  const [f, setF] = useState({ checkNumber: '', checkDate: lastDayOfMonth(fiscalYear, month), payeeName: '', remarks: 'Cancelled check' });
  const [busy, setBusy] = useState(false);
  const valid = /^[0-9A-Za-z-]{3,20}$/.test(f.checkNumber.trim()) && f.checkDate.startsWith(String(fiscalYear));
  async function save() {
    setBusy(true);
    try {
      await bankApi.recordCancelledCheck({ barangayId: bank.barangayId, bankAccountId: bank.id, checkNumber: f.checkNumber.trim(), checkDate: f.checkDate, payeeName: f.payeeName.trim() || null, remarks: f.remarks.trim() || 'Cancelled check' });
      notify(`Check ${f.checkNumber.trim()} recorded as cancelled (listed at ${formatPesos(0 as Centavos)}).`, 'success');
      onSaved();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="Record cancelled check"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" disabled={!valid || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Record'}</button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-700">A cancelled or spoiled check keeps its number in the series: it is listed at 0.00 on the Report of Checks Issued and Schedule 1. A check already recorded in the books is cancelled by reversing its journal entry instead.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Check no." required>{(p) => <input {...p} className="input font-mono" value={f.checkNumber} onChange={(e) => setF({ ...f, checkNumber: e.target.value })} />}</Field>
        <Field label="Check date" required error={f.checkDate.startsWith(String(fiscalYear)) ? null : `Must be in FY ${fiscalYear}`}>{(p) => <input {...p} type="date" className="input" value={f.checkDate} onChange={(e) => setF({ ...f, checkDate: e.target.value })} />}</Field>
        <Field label="Payee" className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.payeeName} onChange={(e) => setF({ ...f, payeeName: e.target.value })} />}</Field>
        <Field label="Remarks" className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}
