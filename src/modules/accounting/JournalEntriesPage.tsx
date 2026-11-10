import { JEV_SOURCE_LABELS, JEV_STATUSES, TRANSACTION_TYPES, transactionType, type JevStatus, type JournalEntryDoc, type TransactionType } from '@bfms/shared';
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

function typeLabel(j: JournalEntryDoc): string {
  if (j.transactionType) return transactionType(j.transactionType)?.label.replace(/ \(.*\)$/, '') ?? j.transactionType;
  if (j.entryType === 'OPENING') return 'Opening balance';
  if (j.sourceModule !== 'MANUAL') return JEV_SOURCE_LABELS[j.sourceModule] ?? j.sourceModule;
  return j.entryType === 'REGULAR' ? '—' : j.entryType.toLowerCase();
}

/**
 * The barangay journal (legacy 01_CY DB). Encoders add entries by transaction type; the Municipal
 * Accountant works the "Waiting for posting" queue.
 */
export function JournalEntriesPage() {
  const { can } = useAuth();
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const [status, setStatus] = useState<JevStatus | ''>('');
  const [type, setType] = useState<TransactionType | ''>('');
  const [open, setOpen] = useState<{ id: string | null; type?: TransactionType } | null>(null);
  // Server filters use the (barangayId, fiscalYear, status, jevDate) index; the type filter applies to the loaded page.
  const base = useMemo(() => {
    if (!barangayId) return null;
    const f = [where('barangayId', '==', barangayId), where('fiscalYear', '==', fiscalYear)];
    if (status) f.push(where('status', '==', status));
    return query(collection(db, 'journalEntries'), ...f, orderBy('jevDate', 'desc'));
  }, [barangayId, fiscalYear, status]);
  const page = usePaginatedQuery<JournalEntryDoc>(base, 50, [barangayId, fiscalYear, status]);
  const rows = page.rows.filter((j) => !type || j.transactionType === type || (type === 'OPENING' && j.entryType === 'OPENING'));
  if (!barangayId) return null;
  const canPrepare = can('jev.prepare', barangayId);
  const canPost = can('jev.post', barangayId);
  const filtered = !!(status || type);

  return (
    <>
      <PageHeader
        title="Journal Entries"
        subtitle={`${barangayLabel} · FY ${fiscalYear}`}
        breadcrumbs={['BAS', 'Accounting', 'Journal']}
        actions={
          <>
            <Link className="btn-secondary" to="/books">Books &amp; trial balance</Link>
            {canPrepare && <button type="button" className="btn-primary" onClick={() => setOpen({ id: null, type: 'DISBURSEMENT' })}><Icon name="plus" /> New entry</button>}
          </>
        }
      />
      {canPrepare && (
        <nav aria-label="New entry by transaction type" className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {TRANSACTION_TYPES.map((t) => (
            <button key={t.code} type="button" className="btn-secondary w-full" onClick={() => setOpen({ id: null, type: t.code })}>
              <Icon name="plus" /> {t.label.replace(/ \(.*\)$/, '')}
            </button>
          ))}
        </nav>
      )}
      <div className="card">
        <div className="card-header justify-start">
          {canPost && (
            <button type="button" className={status === 'FOR_REVIEW' ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'} aria-pressed={status === 'FOR_REVIEW'} onClick={() => setStatus(status === 'FOR_REVIEW' ? '' : 'FOR_REVIEW')}>
              Waiting for posting
            </button>
          )}
          <div className="flex items-center gap-2">
            <label className="label mb-0" htmlFor="st">Status</label>
            <select id="st" className="input max-w-[12rem]" value={status} onChange={(e) => setStatus(e.target.value as JevStatus | '')}>
              <option value="">All statuses</option>
              {JEV_STATUSES.map((s) => <option key={s} value={s}>{s === 'FOR_REVIEW' ? 'FOR POSTING' : s.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="label mb-0" htmlFor="tt">Type</label>
            <select id="tt" className="input max-w-[14rem]" value={type} onChange={(e) => setType(e.target.value as TransactionType | '')}>
              <option value="">All types</option>
              {TRANSACTION_TYPES.map((t) => <option key={t.code} value={t.code}>{t.label.replace(/ \(.*\)$/, '')}</option>)}
            </select>
          </div>
          {filtered && <button type="button" className="btn-ghost btn-sm text-xs" onClick={() => { setStatus(''); setType(''); }}>Clear filters</button>}
        </div>
        {page.loading ? <TableSkeleton label="Loading journal entries…" /> : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={filtered ? `No matching entries${page.rows.length ? ' on this page' : ''} for FY ${fiscalYear}` : `No journal entries for FY ${fiscalYear}`}
              action={canPrepare && !filtered ? <Link className="btn-secondary" to="/import">Import the barangay workbook</Link> : undefined}
            >
              {!filtered && 'Encode entries by transaction type above, or import the existing Google Sheets workbook.'}
            </EmptyState>
          </div>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="table-base table-hover">
              <caption className="sr-only">Journal entries. Select an entry to open it.</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th><th scope="col">JEV No.</th><th scope="col">Type</th><th scope="col" className="whitespace-nowrap">Check / OR</th><th scope="col">DV / RCD</th><th scope="col">Name</th><th scope="col">Particulars</th><th scope="col" className="num">Amount</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Print</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((j) => (
                  <tr key={j.id} className="cursor-pointer" onClick={() => setOpen({ id: j.id })}>
                    <td className="whitespace-nowrap">{j.jevDate}</td>
                    <td className="whitespace-nowrap font-mono text-xs">{j.jevNumber ?? <span className="text-slate-500">—</span>}</td>
                    <td className="whitespace-nowrap text-xs">{typeLabel(j)} <span className="text-slate-500">· {j.journal}</span></td>
                    <td className="whitespace-nowrap font-mono text-xs">{j.primaryReference ?? ''}</td>
                    <td className="whitespace-nowrap font-mono text-xs">{j.secondaryReference ?? ''}</td>
                    <td className="max-w-[9rem] truncate text-xs" title={j.payeeName ?? undefined}>{j.payeeName ?? ''}</td>
                    <td className="max-w-[16rem]">
                      <button type="button" className="block w-full truncate text-left text-navy-800 hover:underline focus-visible:underline" onClick={(e) => { e.stopPropagation(); setOpen({ id: j.id }); }}>
                        {j.particulars}
                      </button>
                    </td>
                    <td className="num"><Money value={j.totalDebit} /></td>
                    <td><StatusChip status={j.status === 'FOR_REVIEW' ? 'SUBMITTED' : j.status} /></td>
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
      {open && <JevEditor key={open.id ?? `new-${open.type}`} jevId={open.id} initialType={open.type} onClose={() => { setOpen(null); void page.reload(); }} />}
    </>
  );
}
