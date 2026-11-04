import { barangayName, type ChartOfAccountDoc } from '@bfms/shared';
import { useMemo, useState } from 'react';
import { EmptyState, Money, TableSkeleton } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { onNormalSide, useYearBalances, type YearBalance } from '../../hooks/useYearBalances';

const ZERO: YearBalance = { beginning: 0, debit: 0, credit: 0, ending: 0 };

/**
 * Chart of Accounts with the selected barangay's posted balances for the fiscal year:
 * beginning (opening entry), debits and credits for January–December, and the pre-closing
 * ending balance, each shown on the account's normal side (a negative figure is an abnormal balance).
 */
export function CoaPanel() {
  const { barangayId, fiscalYear } = useBarangay();
  const [prefix, setPrefix] = useState('');
  const [onlyWithBalances, setOnlyWithBalances] = useState(true);
  const coa = useCollection<ChartOfAccountDoc>('chartOfAccounts', [], { limit: 2000 });
  const bal = useYearBalances(barangayId, fiscalYear);

  const accounts = useMemo(() => [...coa.rows].sort((a, b) => a.accountCode.localeCompare(b.accountCode)), [coa.rows]);
  const hasAny = bal.byAccount.size > 0;
  const filter = onlyWithBalances && hasAny;
  const rows = accounts.filter((a) => {
    if (prefix && !a.accountCode.startsWith(prefix) && !a.accountName.toLowerCase().includes(prefix.toLowerCase())) return false;
    if (!filter) return true;
    const b = bal.byAccount.get(a.accountCode);
    return !!b && (b.beginning !== 0 || b.debit !== 0 || b.credit !== 0);
  });
  const totals = rows.reduce(
    (t, a) => {
      const b = bal.byAccount.get(a.accountCode) ?? ZERO;
      t.debit += b.debit;
      t.credit += b.credit;
      if (b.beginning > 0) t.begDr += b.beginning;
      else t.begCr -= b.beginning;
      if (b.ending > 0) t.endDr += b.ending;
      else t.endCr -= b.ending;
      return t;
    },
    { debit: 0, credit: 0, begDr: 0, begCr: 0, endDr: 0, endCr: 0 },
  );
  const where = barangayId ? `Barangay ${barangayName(barangayId)} · FY ${fiscalYear}` : `FY ${fiscalYear}`;

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Chart of Accounts</h2>
          <p className="text-xs text-slate-500">Balances: {where} · posted entries, before closing</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" checked={onlyWithBalances} onChange={(e) => setOnlyWithBalances(e.target.checked)} disabled={!hasAny} />
            Only accounts used in FY {fiscalYear}
          </label>
          <input type="search" className="input w-64" placeholder="Code prefix or name, e.g. 1-07" value={prefix} onChange={(e) => setPrefix(e.target.value.trim())} aria-label="Filter by account code prefix or name" />
        </div>
      </div>
      {coa.loading || bal.loading ? (
        <TableSkeleton rows={8} label="Loading accounts…" />
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title={prefix ? `No accounts match “${prefix}”` : 'No accounts loaded'}>{!prefix && 'Seed reference data under the System tab.'}</EmptyState>
        </div>
      ) : (
        <div className="max-h-[70vh] overflow-auto">
          <table className="table-base table-hover">
            <caption className="sr-only">Chart of accounts with {where} balances</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Account name</th>
                <th scope="col">Type</th>
                <th scope="col">Normal</th>
                <th scope="col"><abbr title="Requires subsidiary ledger">SL</abbr></th>
                <th scope="col" className="num">Beginning</th>
                <th scope="col" className="num">Debits</th>
                <th scope="col" className="num">Credits</th>
                <th scope="col" className="num">Ending</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((a) => {
                const b = bal.byAccount.get(a.accountCode) ?? ZERO;
                const end = onNormalSide(b.ending, a.normalBalance);
                return (
                  <tr key={a.id} className={a.active ? '' : 'text-slate-500'}>
                    <td className="whitespace-nowrap font-mono text-xs">{a.accountCode}</td>
                    <td className="min-w-[14rem]">
                      {a.accountName}
                      {!a.active && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">Inactive</span>}
                    </td>
                    <td className="text-xs">{a.accountType}</td>
                    <td className="text-xs">{a.normalBalance === 'DEBIT' ? 'Dr' : 'Cr'}</td>
                    <td className="text-xs">{a.requiresSubsidiaryLedger ? 'Yes' : ''}</td>
                    <td className="num whitespace-nowrap"><Money value={onNormalSide(b.beginning, a.normalBalance)} /></td>
                    <td className="num whitespace-nowrap"><Money value={b.debit} /></td>
                    <td className="num whitespace-nowrap"><Money value={b.credit} /></td>
                    <td className={`num whitespace-nowrap font-medium ${end < 0 ? 'text-red-700' : ''}`} title={end < 0 ? 'Abnormal balance' : undefined}><Money value={end} /></td>
                  </tr>
                );
              })}
            </tbody>
            {hasAny && (
              <tfoot className="border-t-2 border-slate-300 bg-slate-50 text-sm font-semibold">
                <tr>
                  <td colSpan={5}>
                    Total{prefix || filter ? ' of the accounts shown' : ''}
                    <span className="block text-2xs font-normal text-slate-500">Beginning and ending: debit balances / credit balances</span>
                  </td>
                  <td className="num whitespace-nowrap"><Money value={totals.begDr} /><br /><Money value={totals.begCr} /></td>
                  <td className="num whitespace-nowrap align-top"><Money value={totals.debit} /></td>
                  <td className="num whitespace-nowrap align-top"><Money value={totals.credit} /></td>
                  <td className="num whitespace-nowrap"><Money value={totals.endDr} /><br /><Money value={totals.endCr} /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
