import { MONTH_NAMES, manilaToday, type BankAccountDoc, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { Link, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { maskAccount } from '../../components/forms';
import { ModuleTabs } from '../../components/register';
import { reportHref } from '../../components/source';
import { EmptyState, PageHeader } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { MemosTab } from './MemosTab';
import { ReconciliationTab } from './ReconciliationTab';
import { StatementsTab } from './StatementsTab';

/** Selected bank account and month, shared by the tabs through the URL (?bank=…&month=…). */
export interface BankPeriod {
  bank: WithId<BankAccountDoc>;
  month: number;
  fiscalYear: number;
}

function defaultMonth(fiscalYear: number): number {
  const today = manilaToday();
  // Reconciliations are prepared after month-end: default to last month of the current year.
  if (Number(today.slice(0, 4)) !== fiscalYear) return 12;
  return Math.max(1, Number(today.slice(5, 7)) - 1);
}

/** Phase 9 — bank statements, two-sided reconciliation and debit/credit memos. */
export function BankPage() {
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const [sp, setSp] = useSearchParams();
  // Security Rules deny a listener on a document that does not exist yet; remount the tab once the
  // first save creates the statement / reconciliation so its listeners attach to the new document.
  const [nonce, setNonce] = useState(0);
  const remount = () => setNonce((n) => n + 1);
  const { rows: banks, loading } = useCollection<BankAccountDoc>('bankAccounts', barangayId ? [['barangayId', '==', barangayId]] : null);
  const sorted = [...banks].sort((a, b) => Number(b.active) - Number(a.active) || a.subsidiaryId.localeCompare(b.subsidiaryId));
  const bank = sorted.find((b) => b.id === sp.get('bank')) ?? sorted[0] ?? null;
  const month = Math.min(12, Math.max(1, Number(sp.get('month')) || defaultMonth(fiscalYear)));
  const set = (k: string, v: string) => setSp((s) => { s.set(k, v); return s; }, { replace: true });
  const qs = bank ? `?bank=${bank.id}&month=${month}` : '';
  const rp = bank ? { fiscalYear, month, bankAccountId: bank.id } : { fiscalYear, month };

  return (
    <>
      <PageHeader
        title="Bank Reconciliation"
        subtitle={`${barangayLabel} · FY ${fiscalYear}`}
        breadcrumbs={['BFMS', 'Accounting', 'Bank Reconciliation']}
        actions={
          <>
            <Link className="btn-secondary" to={reportHref('BRS', rp)}>BRS</Link>
            <Link className="btn-secondary" to={reportHref('BRS_SCHEDULES', rp)}>Schedules</Link>
            <Link className="btn-secondary" to={reportHref('RBDCM', { fiscalYear, month })}>RBDCM</Link>
            <Link className="btn-secondary" to={reportHref('CHECKS_CLEARED', rp)}>Checks cleared</Link>
            <Link className="btn-secondary" to={reportHref('OUTSTANDING_CHECKS', rp)}>Outstanding checks</Link>
          </>
        }
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-[16rem] flex-1">
          <label className="label" htmlFor="bank-pick">Bank account</label>
          <select id="bank-pick" className="input" value={bank?.id ?? ''} onChange={(e) => set('bank', e.target.value)} disabled={!sorted.length}>
            {sorted.map((b) => (
              <option key={b.id} value={b.id}>{b.bankName} · {maskAccount(b.accountNumber)} · {b.subsidiaryId.split('_').pop()}{b.active ? '' : ' (inactive)'}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="month-pick">Month</label>
          <select id="month-pick" className="input" value={month} onChange={(e) => set('month', e.target.value)}>
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m} {fiscalYear}</option>)}
          </select>
        </div>
      </div>
      <ModuleTabs
        label="Bank reconciliation sections"
        tabs={[
          { to: `/bank-reconciliation/statements${qs}`, label: 'Statements' },
          { to: `/bank-reconciliation/reconciliation${qs}`, label: 'Reconciliation' },
          { to: `/bank-reconciliation/memos${qs}`, label: 'Debit / credit memos' },
        ]}
      />
      {!barangayId ? null : !bank ? (
        loading ? null : <EmptyState title="No bank account yet">Add the barangay's bank account (with its CIB subsidiary ledger) under Setup first.</EmptyState>
      ) : (
        <Routes>
          <Route index element={<Navigate to={`reconciliation${qs}`} replace />} />
          <Route path="statements" element={<StatementsTab key={`${bank.id}-${month}-${nonce}`} period={{ bank, month, fiscalYear }} onCreated={remount} />} />
          <Route path="reconciliation" element={<ReconciliationTab key={`${bank.id}-${month}-${nonce}`} period={{ bank, month, fiscalYear }} onCreated={remount} />} />
          <Route path="memos" element={<MemosTab period={{ bank, month, fiscalYear }} />} />
        </Routes>
      )}
    </>
  );
}
