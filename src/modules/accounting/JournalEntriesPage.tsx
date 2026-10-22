import { JEV_STATUSES, type JevStatus, type JournalEntryDoc } from '@bfms/shared';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { EmptyState, Icon, Money, PageHeader, Pager, StatusChip, TableSkeleton } from '../../components/ui';
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
  const canPrepare = can('jev.prepare', barangayId);
    const c = collection(db, 'journalEntries');
    const f = [where('barangayId', '==', barangayId), where('fiscalYear', '==', fiscalYear)];
    return status ? query(c, ...f, where('status', '==', status), orderBy('jevDate', 'desc')) : query(c, ...f, orderBy('jevDate', 'desc'));
  }, [barangayId, fiscalYear, status]);
  const page = usePaginatedQuery<JournalEntryDoc>(base, 25, [barangayId, fiscalYear, status]);
  if (!barangayId) return null;
  const canPrepare = can('jev.prepare', barangayId);

  return (
    <>
      <PageHeader
        title="Journal Entry Vouchers"
        subtitle={`${barangayLabel} · FY ${fiscalYear}`}
        breadcrumbs={['BFMS', 'Accounting', 'JEV']}
        actions={canPrepare && <button type="button" className="btn-primary" onClick={() => setOpenId('new')}><Icon name="plus" /> New JEV</button>}
      />
      <div className="card">
        <div className="card-header justify-start">
          <label className="label mb-0" htmlFor="st">Status</label>
          <select id="st" className="input max-w-[12rem]" value={status} onChange={(e) => setStatus(e.target.value as JevStatus | '')}>
            <option value="">All statuses</option>
            {JEV_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          {status && <button type="button" className="btn-ghost btn-sm text-xs" onClick={() => setStatus('')}>Clear filter</button>}
        </div>
        {page.loading ? <TableSkeleton label="Loading journal entries…" /> : page.rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={status ? `No ${status.replace(/_/g, ' ').toLowerCase()} entries for FY ${fiscalYear}` : `No journal entries for FY ${fiscalYear}`}
              action={canPrepare && !status ? <button type="button" className="btn-primary" onClick={() => setOpenId('new')}><Icon name="plus" /> New JEV</button> : undefined}
            />
          </div>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="table-base table-hover">
              <caption className="sr-only">Journal entry vouchers. Select an entry to open it.</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">JEV No.</th><th scope="col">Book</th><th scope="col">Particulars</th><th scope="col" className="num">Debit</th><th scope="col" className="num">Credit</th><th scope="col">Status</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {page.rows.map((j) => (
                  <tr key={j.id} className="cursor-pointer" onClick={() => setOpenId(j.id)}>
                    <td className="whitespace-nowrap">{j.jevDate}</td>
                    <td className="whitespace-nowrap font-mono text-xs">{j.jevNumber ?? <span className="text-slate-500">unassigned</span>}</td>
                    <td>{j.journal}</td>
                    <td className="max-w-md">
                      {/* The real control for keyboard and screen-reader users; the row click is a mouse convenience. */}
                      <button type="button" className="block w-full truncate text-left text-navy-800 hover:underline focus-visible:underline" onClick={(e) => { e.stopPropagation(); setOpenId(j.id); }}>
                        {j.particulars}
                      </button>
                    </td>
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
