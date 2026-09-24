import { JEV_STATUSES, type JevStatus, type JournalEntryDoc } from '@bfms/shared';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { EmptyState, Money, PageHeader, Pager, Spinner, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { usePaginatedQuery } from '../../hooks/usePaginatedQuery';
import { db } from '../../services/firebase/app';
import { JevEditor } from './JevEditor';

export function JournalEntriesPage() {
  const { can } = useAuth();
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const [status, setStatus] = useState<JevStatus | ''>('');
  const [openId, setOpenId] = useState<string | 'new' | null>(null);
  const base = useMemo(() => {
    if (!barangayId) return null;
    const c = collection(db, 'journalEntries');
    const f = [where('barangayId', '==', barangayId), where('fiscalYear', '==', fiscalYear)];
    return status ? query(c, ...f, where('status', '==', status), orderBy('jevDate', 'desc')) : query(c, ...f, orderBy('jevDate', 'desc'));
  }, [barangayId, fiscalYear, status]);
  const page = usePaginatedQuery<JournalEntryDoc>(base, 25, [barangayId, fiscalYear, status]);
  if (!barangayId) return null;

  return (
    <>
      <PageHeader
        title="Journal Entry Vouchers"
        subtitle={`${barangayLabel} · FY ${fiscalYear}`}
        breadcrumbs={['BFMS', 'Accounting', 'JEV']}
        actions={can('jev.prepare', barangayId) && <button className="btn-primary" onClick={() => setOpenId('new')}>New JEV</button>}
      />
      <div className="card">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <label className="label mb-0" htmlFor="st">Status</label>
          <select id="st" className="input max-w-[12rem]" value={status} onChange={(e) => setStatus(e.target.value as JevStatus | '')}>
            <option value="">All</option>
            {JEV_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        {page.loading ? <Spinner /> : page.rows.length === 0 ? <div className="p-4"><EmptyState title="No journal entries" /></div> : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Date</th><th>JEV No.</th><th>Book</th><th>Particulars</th><th className="num">Debit</th><th className="num">Credit</th><th>Status</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {page.rows.map((j) => (
                  <tr key={j.id} className="cursor-pointer hover:bg-navy-50" onClick={() => setOpenId(j.id)}>
                    <td className="whitespace-nowrap">{j.jevDate}</td>
                    <td className="whitespace-nowrap font-mono text-xs">{j.jevNumber ?? <span className="text-slate-400">unassigned</span>}</td>
                    <td>{j.journal}</td>
                    <td className="max-w-md truncate">{j.particulars}</td>
                    <td className="num"><Money value={j.totalDebit} /></td>
                    <td className="num"><Money value={j.totalCredit} /></td>
                    <td><StatusChip status={j.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page.page} hasPrev={page.hasPrev} hasNext={page.hasNext} onPrev={() => void page.prev()} onNext={() => void page.next()} loading={page.loading} />
      </div>
      {openId && <JevEditor jevId={openId === 'new' ? null : openId} onClose={() => { setOpenId(null); void page.reload(); }} />}
    </>
  );
}
