import type { ChartOfAccountDoc } from '@bfms/shared';
import { collection, endAt, orderBy, query, startAt } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { EmptyState, Pager, TableSkeleton } from '../../components/ui';
import { usePaginatedQuery } from '../../hooks/usePaginatedQuery';
import { db } from '../../services/firebase/app';

export function CoaPanel() {
  const [prefix, setPrefix] = useState('');
  const base = useMemo(() => {
    const c = collection(db, 'chartOfAccounts');
    return prefix ? query(c, orderBy('accountCode'), startAt(prefix), endAt(prefix + '')) : query(c, orderBy('accountCode'));
  }, [prefix]);
  const page = usePaginatedQuery<ChartOfAccountDoc>(base, 50, [prefix]);
  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Chart of Accounts</h2>
        <input type="search" className="input max-w-xs" placeholder="Filter by code prefix, e.g. 1-07" value={prefix} onChange={(e) => setPrefix(e.target.value.trim())} aria-label="Filter by account code prefix" />
      </div>
      {page.loading ? <TableSkeleton rows={8} label="Loading accounts…" /> : page.rows.length === 0 ? (
        <div className="p-4"><EmptyState title={prefix ? `No accounts start with “${prefix}”` : 'No accounts loaded'}>{!prefix && 'Seed reference data under the System tab.'}</EmptyState></div>
      ) : (
        <div className="max-h-[70vh] overflow-auto">
          <table className="table-base table-hover">
            <thead><tr><th scope="col">Code</th><th scope="col">Account name</th><th scope="col">Type</th><th scope="col">Normal</th><th scope="col"><abbr title="Requires subsidiary ledger">SL</abbr></th><th scope="col">FS line</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {page.rows.map((a) => (
                <tr key={a.id} className={a.active ? '' : 'text-slate-500'}>
                  <td className="whitespace-nowrap font-mono text-xs">{a.accountCode}</td>
                  <td>{a.accountName}{!a.active && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">Inactive</span>}</td>
                  <td className="text-xs">{a.accountType}</td>
                  <td className="text-xs">{a.normalBalance}</td>
                  <td className="text-xs">{a.requiresSubsidiaryLedger ? 'Yes' : ''}</td>
                  <td className="font-mono text-[11px] text-slate-600">{a.financialStatementClassification}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page.page} hasPrev={page.hasPrev} hasNext={page.hasNext} onPrev={() => void page.prev()} onNext={() => void page.next()} loading={page.loading} />
    </div>
  );
}
