import {
  MONTH_NAMES,
  barangayName,
  type AccountBalanceDoc,
  type AccountingPeriodDoc,
  type BankAccountDoc,
  type BankReconciliationDoc,
  type BarangayId,
  type JournalEntryDoc,
  type PpeScheduleDoc,
} from '@bfms/shared';
import { useNavigate } from 'react-router-dom';
import { Icon, Money, PageHeader, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { useDocument } from '../../hooks/useDocument';

/**
 * Status board of the barangay books — the legacy workbooks' "TO DO LISTS" sheet, computed:
 * opening balances, journal recorded and posted, TB balanced, bank reconciliation, unliquidated
 * cash advances, PPE schedule/depreciation and locked months, for every barangay the user keeps.
 */
export function DashboardPage() {
  const { accessibleBarangays } = useAuth();
  const { fiscalYear } = useBarangay();
  const many = accessibleBarangays.length > 1;
  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${many ? `${accessibleBarangays.length} barangays` : `Barangay ${barangayName(accessibleBarangays[0] as BarangayId)}`} · Fiscal Year ${fiscalYear}`}
        breadcrumbs={['BFMS', 'Dashboard']}
      />
      <section aria-labelledby="board-h" className="card">
        <div className="card-header">
          <h2 id="board-h" className="card-title">Status of the books</h2>
          <p className="text-xs text-slate-600">Select a barangay to open its journal.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="table-base table-hover">
            <caption className="sr-only">Accounting status per barangay for FY {fiscalYear}</caption>
            <thead>
              <tr>
                <th scope="col">Barangay</th>
                <th scope="col">Opening balances</th>
                <th scope="col">Journal</th>
                <th scope="col">Trial balance</th>
                <th scope="col" className="num">Cash in bank</th>
                <th scope="col">Bank recon</th>
                <th scope="col" className="num">Unliquidated CA</th>
                <th scope="col">PPE / depreciation</th>
                <th scope="col">Locked through</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {accessibleBarangays.map((b) => <StatusRow key={b} barangayId={b as BarangayId} fiscalYear={fiscalYear} />)}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-600">
          <Icon name="check" className="inline h-3.5 w-3.5 text-emerald-700" /> done · <Icon name="alert" className="inline h-3.5 w-3.5 text-amber-700" /> needs attention. Figures come from posted entries only.
        </p>
      </section>
    </>
  );
}

const Ok = ({ ok, children }: { ok: boolean | null; children: React.ReactNode }) => (
  <span className={`inline-flex items-center gap-1 text-xs ${ok === null ? 'text-slate-500' : ok ? 'text-emerald-800' : 'text-amber-800'}`}>
    {ok !== null && <Icon name={ok ? 'check' : 'alert'} className="h-3.5 w-3.5" />}
    {children}
  </span>
);

function StatusRow({ barangayId, fiscalYear }: { barangayId: BarangayId; fiscalYear: number }) {
  const navigate = useNavigate();
  const { setBarangayId } = useBarangay();
  const scope = [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] as const;
  const balances = useCollection<AccountBalanceDoc>('accountBalances', scope).rows;
  const pending = useCollection<JournalEntryDoc>('journalEntries', [...scope, ['status', 'in', ['DRAFT', 'FOR_REVIEW', 'RETURNED', 'APPROVED']]]).rows;
  const recons = useCollection<BankReconciliationDoc>('bankReconciliations', scope).rows;
  const banks = useCollection<BankAccountDoc>('bankAccounts', [['barangayId', '==', barangayId]]).rows.filter((b) => b.active);
  const periods = useCollection<AccountingPeriodDoc>('accountingPeriods', scope).rows;
  const ppe = useDocument<PpeScheduleDoc>('ppeSchedules', `${barangayId}_${fiscalYear}`).data;

  const roll = balances.filter((b) => b.subsidiaryId === null);
  const opening = roll.filter((b) => b.month === 0);
  const lastMonth = roll.reduce((m, b) => (b.month >= 1 && b.month <= 12 ? Math.max(m, b.month) : m), 0);
  const dr = roll.reduce((t, b) => t + b.debit, 0);
  const cr = roll.reduce((t, b) => t + b.credit, 0);
  const net = (prefix: string) => roll.filter((b) => b.accountCode.startsWith(prefix)).reduce((t, b) => t + b.debit - b.credit, 0);
  const cib = net('1-01-02-010');
  const ca = net('1-03-03-');
  const depreciation = roll.filter((b) => b.accountCode.startsWith('5-04-01-')).reduce((t, b) => t + b.debit - b.credit, 0);
  const waiting = pending.filter((j) => j.status === 'FOR_REVIEW' || j.status === 'APPROVED').length;
  const drafts = pending.length - waiting;
  const finalMonths = (bankId: string) => recons.filter((r) => r.bankAccountId === bankId && r.status === 'FINAL').reduce((m, r) => Math.max(m, r.month), 0);
  const reconThrough = banks.length ? Math.min(...banks.map((b) => finalMonths(b.id))) : null;
  const locked = periods.filter((p) => p.month >= 1 && p.month <= 12 && (p.status === 'LOCKED' || p.status === 'CLOSED')).reduce((m, p) => Math.max(m, p.month), 0);
  const mon = (m: number) => (m ? MONTH_NAMES[m - 1]!.slice(0, 3) : '—');

  function open() {
    setBarangayId(barangayId);
    navigate('/accounting');
  }

  return (
    <tr className="cursor-pointer" onClick={open}>
      <th scope="row" className="whitespace-nowrap bg-transparent text-left text-sm font-medium normal-case tracking-normal text-navy-800">
        <button type="button" className="hover:underline focus-visible:underline" onClick={(e) => { e.stopPropagation(); open(); }}>{barangayName(barangayId)}</button>
      </th>
      <td><Ok ok={roll.length ? opening.length > 0 : null}>{opening.length ? 'Recorded' : roll.length ? 'Missing' : 'Not started'}</Ok></td>
      <td className="whitespace-nowrap">
        <Ok ok={roll.length ? waiting === 0 && drafts === 0 : null}>{lastMonth ? `Through ${mon(lastMonth)}` : 'No entries'}</Ok>
        {(waiting > 0 || drafts > 0) && <div className="text-[11px] text-slate-600">{waiting ? `${waiting} to post` : ''}{waiting && drafts ? ' · ' : ''}{drafts ? `${drafts} draft` : ''}</div>}
      </td>
      <td><Ok ok={roll.length ? dr === cr : null}>{!roll.length ? '—' : dr === cr ? 'Balanced' : <>Off by <Money value={Math.abs(dr - cr)} /></>}</Ok></td>
      <td className="num text-xs">{roll.length ? <Money value={cib} dashZero={false} /> : '—'}</td>
      <td className="whitespace-nowrap"><Ok ok={reconThrough === null || !lastMonth ? null : reconThrough >= lastMonth}>{reconThrough === null ? 'No bank account' : reconThrough ? `Final through ${mon(reconThrough)}` : 'Not done'}</Ok></td>
      <td className="num text-xs">{roll.length ? <Money value={ca} dashZero={false} /> : '—'}</td>
      <td className="whitespace-nowrap"><Ok ok={!roll.length ? null : !!ppe && depreciation > 0}>{ppe ? (depreciation > 0 ? 'Depreciation recorded' : 'Schedule saved') : 'No schedule'}</Ok></td>
      <td>{locked ? <StatusChip status="LOCKED" /> : null} <span className="text-xs text-slate-700">{locked ? mon(locked) : '—'}</span></td>
    </tr>
  );
}
