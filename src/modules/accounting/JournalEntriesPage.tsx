import { JEV_SOURCE_LABELS, JEV_STATUSES, type JevStatus, type JournalBook, type JournalEntryDoc } from '@bfms/shared';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { reportHref } from '../../components/source';
import { EmptyState, Icon, Money, PageHeader, Pager, StatusChip, TableSkeleton } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { usePaginatedQuery } from '../../hooks/usePaginatedQuery';
import { db } from '../../services/firebase/app';
import { JevEditor } from './JevEditor';

type SourceFilter = '' | 'MANUAL' | 'GENERATED';

function sourceLabel(j: JournalEntryDoc): string {
  if (j.sourceModule === 'MANUAL') return j.entryType === 'REGULAR' ? 'Manual' : `Manual · ${j.entryType.toLowerCase()}`;
  return JEV_SOURCE_LABELS[j.sourceModule] ?? j.sourceModule;
}

export function JournalEntriesPage() {
  const { can } = useAuth();
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const [status, setStatus] = useState<JevStatus | ''>('');
  const [book, setBook] = useState<JournalBook | ''>('');
  const [source, setSource] = useState<SourceFilter>('');
  const [openId, setOpenId] = useState<string | 'new' | null>(null);
  // Server-side filters use the existing (barangayId, fiscalYear, status|journal, jevDate) indexes;
  // when both are chosen the book is applied to the loaded page, as is the source filter.
  const base = useMemo(() => {
    if (!barangayId) return null;
    const c = collection(db, 'journalEntries');
    const f = [where('barangayId', '==', barangayId), where('fiscalYear', '==', fiscalYear)];
    if (status) f.push(where('status', '==', status));
    else if (book) f.push(where('journal', '==', book));
    return query(c, ...f, orderBy('jevDate', 'desc'));
  }, [barangayId, fiscalYear, status, book]);
  const page = usePaginatedQuery<JournalEntryDoc>(base, 25, [barangayId, fiscalYear, status, book]);
  const rows = page.rows.filter((j) => (!book || j.journal === book) && (!source || (source === 'MANUAL') === (j.sourceModule === 'MANUAL')));
  if (!barangayId) return null;
  const canPrepare = can('jev.prepare', barangayId);
  const filtered = !!(status || book || source);

  return (
    <>
      <PageHeader
        title="Journal Entry Vouchers"
        subtitle={`${barangayLabel} · FY ${fiscalYear}`}
        breadcrumbs={['BFMS', 'Accounting', 'JEV']}
        actions={
          <>
            <Link className="btn-secondary" to="/books">Books of accounts</Link>
            {canPrepare && <button type="button" className="btn-primary" onClick={() => setOpenId('new')}><Icon name="plus" /> New JEV</button>}
          </>
        }
      />
      <div className="card">
        <div className="card-header justify-start">
          <div className="flex items-center gap-2">
            <label className="label mb-0" htmlFor="st">Status</label>
            <select id="st" className="input max-w-[12rem]" value={status} onChange={(e) => setStatus(e.target.value as JevStatus | '')}>
              <option value="">All statuses</option>
              {JEV_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="label mb-0" htmlFor="bk">Book</label>
            <select id="bk" className="input max-w-[14rem]" value={book} onChange={(e) => setBook(e.target.value as JournalBook | '')}>
              <option value="">All books</option>
              <option value="JCT">Cash (JCT)</option>
              <option value="GJ">General (GJ)</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="label mb-0" htmlFor="src">Source</label>
            <select id="src" className="input max-w-[14rem]" value={source} onChange={(e) => setSource(e.target.value as SourceFilter)}>
              <option value="">All sources</option>
              <option value="MANUAL">Manual entries</option>
              <option value="GENERATED">Generated from documents</option>
            </select>
          </div>
          {filtered && <button type="button" className="btn-ghost btn-sm text-xs" onClick={() => { setStatus(''); setBook(''); setSource(''); }}>Clear filters</button>}
        </div>
        {page.loading ? <TableSkeleton label="Loading journal entries…" /> : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={filtered ? `No matching entries${page.rows.length ? ' on this page' : ''} for FY ${fiscalYear}` : `No journal entries for FY ${fiscalYear}`}
              action={canPrepare && !filtered ? <button type="button" className="btn-primary" onClick={() => setOpenId('new')}><Icon name="plus" /> New JEV</button> : undefined}
            />
          </div>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="table-base table-hover">
              <caption className="sr-only">Journal entry vouchers. Select an entry to open it.</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">JEV No.</th><th scope="col">Book</th><th scope="col">Particulars</th><th scope="col">Source</th><th scope="col" className="num">Debit</th><th scope="col" className="num">Credit</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Print</span></th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((j) => (
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
                    <td className="whitespace-nowrap text-xs">
                      <span className="text-slate-700">{sourceLabel(j)}</span>
                      {j.sourceModule !== 'MANUAL' && (j.secondaryReference || j.primaryReference) && <span className="block font-mono text-slate-600">{j.secondaryReference ?? j.primaryReference}</span>}
                    </td>
                    <td className="num"><Money value={j.totalDebit} /></td>
                    <td className="num"><Money value={j.totalCredit} /></td>
                    <td><StatusChip status={j.status} /></td>
                    <td>
                      <Link className="btn-ghost btn-sm" to={reportHref('JEV', { documentId: j.id, fiscalYear })} onClick={(e) => e.stopPropagation()} aria-label={`Print JEV ${j.jevNumber ?? j.particulars}`}><Icon name="file" /></Link>
                    </td>
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
