import { manilaToday, type BankAccountDoc, type CheckRecord, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BankAccountSelect, maskAccount } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { reportHref } from '../../components/source';
import { ConfirmDialog, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useCollection } from '../../hooks/useCollection';
import { errorMessage } from '../../services/functions/api';
import { disbApi } from './api';

const CHECK_STATUSES = ['ISSUED', 'RELEASED', 'CLEARED', 'CANCELLED', 'VOID'];

/** Checks register per bank account: issue/release dates, cancellation (number retained) with reason. */
export function ChecksTab() {
  const { can } = useAuth();
  const { notify } = useToast();
  const { barangayId, fiscalYear } = useBarangay();
  const [bank, setBank] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [target, setTarget] = useState<WithId<CheckRecord> | null>(null);
  const [cancelAs, setCancelAs] = useState<'CANCELLED' | 'VOID'>('CANCELLED');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const scope = barangayId ? ([['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] as const) : null;
  const { rows, loading } = useCollection<CheckRecord>('checks', scope);
  const banks = useCollection<BankAccountDoc>('bankAccounts', barangayId ? [['barangayId', '==', barangayId]] : null).rows;
  if (!barangayId) return null;
  const list = rows
    .filter((r) => (!bank || r.bankAccountId === bank) && (!status || r.status === status))
    .sort((a, b) => b.checkDate.localeCompare(a.checkDate) || b.checkNumber.localeCompare(a.checkNumber));
  const canCancel = can('treasury.submit', barangayId);
  const total = list.filter((c) => !['CANCELLED', 'VOID'].includes(c.status)).reduce((t, c) => t + c.amount, 0);

  async function onCancel() {
    if (!target) return;
    setBusy(true);
    try {
      await disbApi.cancelCheck({ checkId: target.id, status: cancelAs, reason: reason.trim(), cancelledDate: manilaToday() });
      notify(`Check ${target.checkNumber} ${cancelAs.toLowerCase()}.`, 'success');
      setTarget(null);
      setReason('');
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <RegisterTable
        caption={`Checks issued in FY ${fiscalYear}`}
        rows={list}
        loading={loading}
        toolbar={
          <>
            <label className="label mb-0" htmlFor="chk-bank">Bank account</label>
            <div className="min-w-[14rem]"><BankAccountSelect id="chk-bank" barangayId={barangayId} value={bank} onChange={(v) => setBank(v)} /></div>
            <StatusFilter id="chk-status" value={status} onChange={setStatus} options={CHECK_STATUSES} />
            <div className="ml-auto flex gap-2">
              <Link className="btn-secondary btn-sm" to={reportHref('CHECKS_ISSUED', { fiscalYear, bankAccountId: bank ?? undefined })}>Report of checks issued</Link>
              <Link className="btn-secondary btn-sm" to={reportHref('CANCELLED_CHECKS', { fiscalYear, bankAccountId: bank ?? undefined })}>Cancelled checks</Link>
            </div>
          </>
        }
        empty="No checks match the filters."
        footer={list.length ? <p className="border-t border-slate-200 px-4 py-2 text-right text-sm">Total of valid checks listed: <strong><Money value={total} /></strong></p> : undefined}
        columns={[
          { label: 'Check no.', render: (r) => <span className="font-mono">{r.checkNumber}</span> },
          { label: 'Date', render: (r) => r.checkDate },
          { label: 'Bank', render: (r) => { const b = banks.find((x) => x.id === r.bankAccountId); return <span className="text-xs">{b ? `${b.bankName} ${maskAccount(b.accountNumber)}` : '—'}</span>; } },
          { label: 'DV no.', render: (r) => <Link className="text-navy-700 underline" to={`/disbursements/vouchers?open=${r.dvId}`}>{r.dvNumber ?? '—'}</Link> },
          { label: 'Payee', className: 'max-w-[14rem] truncate', render: (r) => r.payee?.name },
          { label: 'Amount', numeric: true, render: (r) => <Money value={r.amount} /> },
          { label: 'Released', render: (r) => r.releasedDate ?? '—' },
          { label: 'Status', render: (r) => <span title={r.cancelReason ?? undefined}><StatusChip status={r.status} /></span> },
          {
            label: 'Actions',
            render: (r) =>
              canCancel && ['ISSUED', 'RELEASED'].includes(r.status) ? (
                <button type="button" className="btn-ghost btn-sm text-red-700" onClick={() => setTarget(r)} aria-label={`Cancel or void check ${r.checkNumber}`}>Cancel / void…</button>
              ) : r.cancelReason ? (
                <span className="text-xs text-slate-600">{r.cancelReason}</span>
              ) : null,
          },
        ]}
      />
      {target && (
        <ConfirmDialog
          open
          danger
          busy={busy}
          title={`Check ${target.checkNumber}`}
          message={
            <div className="space-y-3">
              <p>The check number stays in the register and cannot be reused. DV {target.dvNumber} becomes unpaid so a new check can be issued.</p>
              <div>
                <label className="label" htmlFor="chk-cancel-as">Record as</label>
                <select id="chk-cancel-as" className="input" value={cancelAs} onChange={(e) => setCancelAs(e.target.value as 'CANCELLED' | 'VOID')}>
                  <option value="CANCELLED">Cancelled (spoiled / not released)</option>
                  <option value="VOID">Void (released but not to be honored)</option>
                </select>
              </div>
            </div>
          }
          confirmLabel="Record"
          requireReason
          reason={reason}
          onReasonChange={setReason}
          onCancel={() => setTarget(null)}
          onConfirm={() => void onCancel()}
        />
      )}
    </>
  );
}
