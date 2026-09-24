import type { ChartOfAccountDoc } from '@bfms/shared';
import { collection, endAt, orderBy, query, startAt } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { Pager, Spinner } from '../../components/ui';
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
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="font-serif font-bold text-navy-800">Chart of Accounts</h2>
        <input className="input max-w-xs" placeholder="Filter by code prefix, e.g. 1-07" value={prefix} onChange={(e) => setPrefix(e.target.value.trim())} aria-label="Account code prefix" />
      </div>
      {page.loading ? <Spinner /> : (
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>Code</th><th>Account name</th><th>Type</th><th>Normal</th><th>SL</th><th>FS line</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {page.rows.map((a) => (
                <tr key={a.id} className={a.active ? '' : 'opacity-50'}>
                  <td className="font-mono text-xs">{a.accountCode}</td>
                  <td>{a.accountName}</td>
                  <td className="text-xs">{a.accountType}</td>
                  <td className="text-xs">{a.normalBalance}</td>
                  <td className="text-xs">{a.requiresSubsidiaryLedger ? 'Yes' : ''}</td>
                  <td className="font-mono text-[11px] text-slate-500">{a.financialStatementClassification}</td>
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
