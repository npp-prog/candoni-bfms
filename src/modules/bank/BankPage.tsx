import { MONTH_NAMES, manilaToday, type BankAccountDoc, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { Link, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { maskAccount } from '../../components/forms';
import { ModuleTabs } from '../../components/register';
import { reportHref } from '../../components/source';
import { EmptyState, Icon, PageHeader } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { ChecksIssuedTab } from './ChecksIssuedTab';
import { MemosTab } from './MemosTab';
import { OpeningTab } from './OpeningTab';
import { ReconciliationTab } from './ReconciliationTab';
import { StatementsTab } from './StatementsTab';
import { useBankRecon, type BankRecon } from './useBankRecon';

/** Selected bank account and month, shared by the tabs through the URL (?bank=…&month=…). */
export interface BankPeriod {
  bank: WithId<BankAccountDoc>;
  month: number;
  fiscalYear: number;
}

/** What every tab receives: the period and the loaded reconciliation data. */
export interface BankTabProps {
  period: BankPeriod;
  rec: BankRecon;
  /** Reload after an action (and remount document listeners created by it). */
  onChanged(): void;
}

function defaultMonth(fiscalYear: number): number {
  const today = manilaToday();
  // Reconciliations are prepared after month-end: default to last month of the current year.
  if (Number(today.slice(0, 4)) !== fiscalYear) return 12;
  return Math.max(1, Number(today.slice(5, 7)) - 1);
}

/**
 * Bank reconciliation from the journal (legacy 04.1–04.4 and 04 BR): checks issued per the books,
 * the bank statement, Schedule 1 / Schedule 2 and the BRS, prior-year outstanding items and memos.
 */
export function BankPage() {
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const [sp, setSp] = useSearchParams();
  // Security Rules deny a listener on a document that does not exist yet; remount the tabs after
  // an action so listeners attach to documents it created.
  const [nonce, setNonce] = useState(0);
  const { rows: banks, loading } = useCollection<BankAccountDoc>('bankAccounts', barangayId ? [['barangayId', '==', barangayId]] : null);
  const sorted = [...banks].sort((a, b) => Number(b.active) - Number(a.active) || a.subsidiaryId.localeCompare(b.subsidiaryId));
  const bank = sorted.find((b) => b.id === sp.get('bank')) ?? sorted[0] ?? null;
  const month = Math.min(12, Math.max(1, Number(sp.get('month')) || defaultMonth(fiscalYear)));
  const rec = useBankRecon(bank, fiscalYear, month);
  const set = (k: string, v: string) => setSp((s) => { s.set(k, v); return s; }, { replace: true });
  const qs = bank ? `?bank=${bank.id}&month=${month}` : '';
  const rp = bank ? { fiscalYear, month, bankAccountId: bank.id } : { fiscalYear, month };
  const onChanged = () => {
    rec.reload();
    setNonce((n) => n + 1);
  };

  return (
    <>
      <PageHeader
        title="Bank Reconciliation"
        subtitle={`${barangayLabel} · FY ${fiscalYear}`}
        breadcrumbs={['BAS', 'Accounting', 'Bank Reconciliation']}
        actions={
          <>
            <Link className="btn-secondary" to={reportHref('BRS', rp)}>BRS</Link>
            <Link className="btn-secondary" to={reportHref('BRS_SCHEDULES', rp)}>Schedules 1 & 2</Link>
            <Link className="btn-secondary" to={reportHref('CHECKS_ISSUED', rp)}>Checks issued</Link>
            <Link className="btn-secondary" to={reportHref('CHECKS_CLEARED', rp)}>Checks encashed</Link>
            <Link className="btn-secondary" to={reportHref('OUTSTANDING_CHECKS', rp)}>Outstanding checks</Link>
            <Link className="btn-secondary" to={reportHref('RBDCM', { fiscalYear, month })}>RBDCM</Link>
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
        <button type="button" className="btn-secondary" onClick={onChanged} disabled={rec.loading} aria-label="Reload the journal and statements">
          <Icon name="calendar" /> {rec.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <ModuleTabs
        label="Bank reconciliation sections"
        tabs={[
          { to: `/bank-reconciliation/checks${qs}`, label: 'Checks issued' },
          { to: `/bank-reconciliation/statements${qs}`, label: 'Bank statement' },
          { to: `/bank-reconciliation/reconciliation${qs}`, label: 'Reconciliation' },
          { to: `/bank-reconciliation/prior-year${qs}`, label: 'Prior-year outstanding' },
          { to: `/bank-reconciliation/memos${qs}`, label: 'Debit / credit memos' },
        ]}
      />
      {rec.error && <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">Could not load the reconciliation data: {rec.error}</p>}
      {!barangayId ? null : !bank ? (
        loading ? null : <EmptyState title="No bank account yet">Add the barangay's bank account (with its CIB subsidiary ledger) under Setup first.</EmptyState>
      ) : (
        <Routes>
          <Route index element={<Navigate to={`reconciliation${qs}`} replace />} />
          <Route path="checks" element={<ChecksIssuedTab period={{ bank, month, fiscalYear }} rec={rec} onChanged={onChanged} />} />
          <Route path="statements" element={<StatementsTab key={`${bank.id}-${month}-${nonce}`} period={{ bank, month, fiscalYear }} rec={rec} onChanged={onChanged} />} />
          <Route path="reconciliation" element={<ReconciliationTab key={`${bank.id}-${month}-${nonce}`} period={{ bank, month, fiscalYear }} rec={rec} onChanged={onChanged} />} />
          <Route path="prior-year" element={<OpeningTab key={`${bank.id}-${fiscalYear}-${nonce}`} period={{ bank, month, fiscalYear }} rec={rec} onChanged={onChanged} />} />
          <Route path="memos" element={<MemosTab period={{ bank, month, fiscalYear }} />} />
        </Routes>
      )}
    </>
  );
}
