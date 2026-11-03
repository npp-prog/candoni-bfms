import {
  CHECK_STATUS_LABEL,
  LINE_CLASSES,
  RECON_CATEGORY_LABELS,
  SIGNED_CATEGORIES,
  formatPesos,
  lastDayOfMonth,
  lineCheckNo,
  periodKey,
  runBankRecon,
  storedReconInputs,
  type BankReconInputs,
  type BookItem,
  type Centavos,
  type LineClass,
  type ManualReconItem,
  type ReconItemCategory,
  type ReconItemRecord,
  type ReconMatch,
  type Schedule1Row,
  type Schedule2Row,
  type StatementLine,
} from '@bfms/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MoneyInput } from '../../components/forms';
import { ReturnBanner, WorkflowTrail, reportHref } from '../../components/source';
import { ConfirmDialog, EmptyState, Field, Icon, Money, StatusChip, Tabs, TableSkeleton } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { errorMessage } from '../../services/functions/api';
import { bankApi } from './api';
import type { BankTabProps } from './BankPage';

const VIEWS = ['Statement lines', 'Schedule 1 — Checks', 'Schedule 2 — Deposits', 'Reconciling items'] as const;
type View = (typeof VIEWS)[number];

/**
 * Reconciliation workspace: the shared journal-based `reconcileBank` applied live to the loaded
 * journal and statements, so every classification or match shows its effect at once. "Save &
 * prepare" stores it (the server recomputes); FOR_REVIEW and FINAL show the stored figures.
 */
export function ReconciliationTab({ period, rec, onChanged }: BankTabProps) {
  const { can } = useAuth();
  const { notify } = useToast();
  const { bank, month, fiscalYear } = period;
  const bid = bank.barangayId;
  const data = rec.data;
  const [inputs, setInputs] = useState<BankReconInputs>({ classifications: {}, manualItems: [], manualMatches: [] });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'RETURN' | 'FINALIZE' | null>(null);
  const [reason, setReason] = useState('');
  const [view, setView] = useState<View>('Statement lines');
  useEffect(() => {
    if (data && !dirty) setInputs(storedReconInputs(data));
  }, [data, dirty]);
  const live = useMemo(() => (data ? runBankRecon(data, inputs) : null), [data, inputs]);
  const update = (patch: Partial<BankReconInputs>) => { setInputs((x) => ({ ...x, ...patch })); setDirty(true); };

  if (!data || !live) return <TableSkeleton />;
  const recon = data.recon;
  const id = data.id;
  const stmt = data.statement;
  if (!stmt)
    return (
      <EmptyState title="No bank statement for this month" action={<Link className="btn-primary" to={`/bank-reconciliation/statements?bank=${bank.id}&month=${month}`}>Enter the statement</Link>}>
        Enter or paste the bank statement first; the reconciliation compares it with the checks and deposits in the journal (Cash in Bank, {bank.subsidiaryId.split('_').pop()}).
      </EmptyState>
    );

  const status = recon?.status ?? 'DRAFT';
  const editable = ['DRAFT', 'RETURNED'].includes(status) && can('recon.prepare', bid);
  // Stored figures once it left the preparer; live preview while it is being prepared.
  const useStored = !editable && !!recon;
  const fig = useStored
    ? { bookBalance: recon!.bookBalance, bankBalance: recon!.bankBalance, adjustedBookBalance: recon!.adjustedBookBalance, adjustedBankBalance: recon!.adjustedBankBalance, difference: recon!.difference, t: recon! }
    : { bookBalance: live.bookBalance, bankBalance: live.bankBalance, adjustedBookBalance: live.adjustedBookBalance, adjustedBankBalance: live.adjustedBankBalance, difference: live.difference, t: live.totals };
  const stale = editable && recon && !dirty && (recon.difference !== live.difference || recon.adjustedBookBalance !== live.adjustedBookBalance || recon.itemCount !== live.items.length);
  const matchByLine = new Map(live.matches.map((m) => [m.lineId, m]));
  const bookByKey = new Map(live.book.map((b) => [b.key, b]));
  const per = { barangayId: bid, bankAccountId: bank.id, fiscalYear, month };
  const key = periodKey(fiscalYear, month);
  // This month's lines, and earlier lines still unmatched (they carry until explained).
  const lines = data.statements.flatMap((s) => s.lines).filter((l) => l.date.startsWith(key) || !matchByLine.has(l.lineId));
  const openBook = live.book.filter((b) => !b.cancelled && b.amount > 0 && !live.matches.some((m) => m.bookKey === b.key));
  const diff = fig.difference;

  async function act(label: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(label);
    try {
      await fn();
      notify(ok, 'success');
      return true;
    } catch (e) {
      notify(errorMessage(e), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  }
  const prepare = () =>
    act('prepare', async () => {
      const r = await bankApi.prepareBankReconciliation({ ...per, ...inputs });
      setDirty(false);
      onChanged();
      if (r.difference !== 0) notify(`Prepared with a difference of ${formatPesos(r.difference as Centavos)} — explain it before submitting.`, 'info');
    }, 'Reconciliation prepared.');
  const genMemos = () =>
    act('memos', async () => {
      // Save the current classifications first: the server records memos from the stored ones.
      await bankApi.prepareBankReconciliation({ ...per, ...inputs });
      const r = await bankApi.generateRbdcmEntries(per);
      await bankApi.prepareBankReconciliation(per);
      setDirty(false);
      onChanged();
      notify(`${r.created} memo(s) recorded, ${r.jevs} draft JEV(s) generated for review and posting.`, 'info');
    }, 'Reconciliation refreshed.');

  const bookLabel = (b: BookItem | undefined) => (!b ? 'Book item' : b.kind === 'CHECK' ? `Check ${b.checkNumber}${b.priorYear ? ' (prior year)' : ''}` : `${b.kind === 'DEPOSIT' ? 'Deposit' : 'Disbursement'} ${b.date}${b.jevNumbers[0] ? ` · JEV ${b.jevNumbers[0]}` : ''}`);
  const matchLabel = (m: ReconMatch) => `${bookLabel(bookByKey.get(m.bookKey))}${m.how === 'MEMO' ? ' · memo JEV' : ''}`;

  return (
    <div className="space-y-4">
      {recon && <ReturnBanner record={{ ...recon, id }} />}
      <section aria-labelledby="recon-summary" className="card">
        <div className="card-header">
          <h2 id="recon-summary" className="card-title">Statement of bank reconciliation — as of {lastDayOfMonth(fiscalYear, month)}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={status} />
            {editable && (dirty || !recon || stale) && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">Preview — not saved</span>}
            {!stmt.balanced && <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-800 ring-1 ring-inset ring-red-200">Statement lines ≠ ending balance</span>}
          </div>
        </div>
        <div className="grid gap-4 p-4 md:grid-cols-2">
          <Side
            title="Book side (items requiring adjustment by agency)"
            rows={[
              ['Book balance (Cash in Bank ledger)', fig.bookBalance, 'base'],
              ['Add: credit memos / unrecorded credits', fig.t.creditMemos, 'plus'],
              ['Add: interest earned', fig.t.interestIncome, 'plus'],
              ['Less: debit memos / unrecorded debits', fig.t.debitMemos, 'minus'],
              ['Less: bank charges', fig.t.bankCharges, 'minus'],
              ['Add/(deduct): book errors & other', fig.t.bookErrors + fig.t.otherBookItems, 'signed'],
            ]}
            total={['Adjusted book balance', fig.adjustedBookBalance]}
          />
          <Side
            title="Bank side"
            rows={[
              ['Bank balance per statement', fig.bankBalance, 'base'],
              ['Add: deposits in transit', fig.t.depositInTransit, 'plus'],
              ['Less: outstanding checks (Schedule 1)', fig.t.outstandingChecks, 'minus'],
              ['Add/(deduct): bank errors & other', fig.t.bankErrors + fig.t.otherBankItems, 'signed'],
            ]}
            total={['Adjusted bank balance', fig.adjustedBankBalance]}
          />
        </div>
        <div className={`flex flex-wrap items-center gap-3 border-t px-4 py-3 ${diff === 0 ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`} aria-live="polite">
          <Icon name={diff === 0 ? 'check' : 'alert'} className={`h-5 w-5 ${diff === 0 ? 'text-emerald-700' : 'text-red-700'}`} />
          <p className={`text-sm font-semibold ${diff === 0 ? 'text-emerald-900' : 'text-red-900'}`}>
            {diff === 0 ? 'Proof: 0.00 — adjusted book balance equals adjusted bank balance.' : <>Difference (book − bank): <span className="tabular-nums">{formatPesos(diff as Centavos)}</span></>}
          </p>
          <div className="ml-auto flex flex-wrap gap-2">
            {editable && <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void prepare()}>{busy === 'prepare' ? 'Saving…' : recon ? 'Save & re-prepare' : 'Prepare reconciliation'}</button>}
            {editable && can('jev.prepare', bid) && live.items.some((i) => i.statementLineId && !i.sourceId && i.side === 'BOOK' && i.amount > 0) && (
              <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void genMemos()} title="Records a bank memo for each unrecorded charge, interest or memo line and drafts its JEV">
                {busy === 'memos' ? 'Recording…' : 'Record memos & draft JEVs'}
              </button>
            )}
            {editable && recon && (
              <button type="button" className="btn-secondary" disabled={!!busy || dirty || !stmt.balanced} onClick={() => void act('submit', () => bankApi.submitBankReconciliation({ id }), 'Submitted for review.').then((ok) => ok && onChanged())}>
                {status === 'RETURNED' ? 'Resubmit for review' : 'Submit for review'}
              </button>
            )}
            {status === 'FOR_REVIEW' && can('recon.finalize', bid) && (
              <>
                <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => setConfirm('RETURN')}>Return…</button>
                <button type="button" className="btn-primary" disabled={!!busy || diff !== 0} title={diff !== 0 ? 'The difference must be zero' : undefined} onClick={() => setConfirm('FINALIZE')}>Finalize</button>
              </>
            )}
          </div>
        </div>
        {live.warnings.length > 0 && (
          <ul className="space-y-1 border-t border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            {live.warnings.map((w) => <li key={w} className="flex gap-2"><Icon name="info" className="mt-0.5 h-4 w-4" /> {w}</li>)}
          </ul>
        )}
      </section>

      <section className="card" aria-label="Reconciliation details">
        <div className="px-4 pt-3"><Tabs<View> tabs={VIEWS} value={view} onChange={(v) => setView(v)} label="Reconciliation details" idPrefix="recon-view" /></div>
        <div id="recon-view-panel" role="tabpanel" aria-labelledby={`recon-view-tab-${VIEWS.indexOf(view)}`} className="max-h-[36rem] overflow-auto">
          {view === 'Statement lines' && (
            <table className="table-base">
              <caption className="sr-only">Statement lines with their match or treatment</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">Check / ref.</th><th scope="col">Description</th><th scope="col" className="num">Amount</th><th scope="col">Match / treatment</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {lines.length === 0 && <tr><td colSpan={5} className="p-4 text-sm text-slate-600">The statement has no lines this month.</td></tr>}
                {lines.map((l) => (
                  <LineRow
                    key={l.lineId}
                    line={l}
                    earlier={!l.date.startsWith(key)}
                    match={matchByLine.get(l.lineId)}
                    matchLabel={matchLabel}
                    item={live.items.find((i) => i.statementLineId === l.lineId)}
                    cls={useStored ? undefined : live.lineClasses[l.lineId]}
                    editable={editable}
                    candidates={openBook.filter((b) => (b.kind === 'DEPOSIT') === l.credit > 0 && (b.kind === 'CHECK' || b.amount === (l.debit || l.credit)))}
                    bookLabel={bookLabel}
                    onClassify={(c) => update({ classifications: { ...inputs.classifications, [l.lineId]: c } })}
                    onMatch={(bookKey) => update({ manualMatches: [...inputs.manualMatches.filter((m) => m.lineId !== l.lineId), { lineId: l.lineId, bookKey }] })}
                    onUnmatch={() => update({ manualMatches: inputs.manualMatches.filter((m) => m.lineId !== l.lineId) })}
                  />
                ))}
              </tbody>
            </table>
          )}
          {view === 'Schedule 1 — Checks' && <Schedule1Table rows={live.schedule1} />}
          {view === 'Schedule 2 — Deposits' && (
            <>
              <Schedule2Table caption="Deposits reconciliation (Schedule 2)" rows={live.schedule2} />
              <h3 className="px-4 pt-4 text-sm font-semibold text-slate-800">Bank adjustments (debits shown negative)</h3>
              <Schedule2Table caption="Bank adjustments" rows={live.adjustments} />
            </>
          )}
          {view === 'Reconciling items' && <ItemsTable items={live.items} />}
        </div>
      </section>

      <ManualItems items={inputs.manualItems} editable={editable} fiscalYear={fiscalYear} month={month} onChange={(manualItems) => update({ manualItems })} />

      <div className="flex flex-wrap gap-2">
        <Link className="btn-secondary" to={reportHref('BRS', { fiscalYear, month, bankAccountId: bank.id })}><Icon name="file" /> Print BRS</Link>
        <Link className="btn-secondary" to={reportHref('BRS_SCHEDULES', { fiscalYear, month, bankAccountId: bank.id })}><Icon name="file" /> Schedules 1 & 2</Link>
        <Link className="btn-secondary" to={reportHref('OUTSTANDING_CHECKS', { fiscalYear, month, bankAccountId: bank.id })}><Icon name="file" /> Outstanding checks</Link>
      </div>
      {recon && <WorkflowTrail barangayId={bid} recordId={id} />}

      {confirm && (
        <ConfirmDialog
          open
          busy={!!busy}
          title={confirm === 'FINALIZE' ? 'Finalize bank reconciliation' : 'Return bank reconciliation'}
          message={confirm === 'FINALIZE' ? 'Finalizing recomputes the reconciliation from the journal and the statements and locks this month\'s statement. It is required before the period can be locked.' : 'The preparer will see your reason and can correct and resubmit.'}
          confirmLabel={confirm === 'FINALIZE' ? 'Finalize' : 'Return'}
          requireReason={confirm === 'RETURN'}
          reason={reason}
          onReasonChange={setReason}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            void act(confirm, () => (confirm === 'FINALIZE' ? bankApi.finalizeBankReconciliation({ id }) : bankApi.returnBankReconciliation({ id, remarks: reason.trim() })), confirm === 'FINALIZE' ? 'Reconciliation finalized.' : 'Returned to the preparer.').then((ok) => ok && (setConfirm(null), setReason(''), onChanged()))
          }
        />
      )}
    </div>
  );
}

function Side({ title, rows, total }: { title: string; rows: Array<[string, number, 'base' | 'plus' | 'minus' | 'signed']>; total: [string, number] }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600">{title}</h3>
      <dl className="divide-y divide-slate-100 text-sm">
        {rows.map(([label, v, kind]) =>
          kind !== 'base' && v === 0 ? null : (
            <div key={label} className="flex justify-between gap-3 py-1.5">
              <dt className={kind === 'base' ? 'font-medium text-slate-900' : 'pl-3 text-slate-700'}>{label}</dt>
              <dd className="tabular-nums">{kind === 'minus' ? `(${formatPesos(v as Centavos)})` : formatPesos(v as Centavos)}</dd>
            </div>
          ),
        )}
        <div className="flex justify-between gap-3 border-t-2 border-slate-300 py-2 font-semibold text-navy-800">
          <dt>{total[0]}</dt>
          <dd className="tabular-nums">{formatPesos(total[1] as Centavos)}</dd>
        </div>
      </dl>
    </div>
  );
}

function LineRow({ line: l, earlier, match, matchLabel, item, cls, editable, candidates, bookLabel, onClassify, onMatch, onUnmatch }: {
  line: StatementLine;
  earlier: boolean;
  match: ReconMatch | undefined;
  matchLabel(m: ReconMatch): string;
  item: ReconItemRecord | undefined;
  cls: { cls: LineClass; suggested: boolean } | undefined;
  editable: boolean;
  candidates: BookItem[];
  bookLabel(b: BookItem): string;
  onClassify(c: LineClass): void;
  onMatch(bookKey: string): void;
  onUnmatch(): void;
}) {
  const amount = l.debit ? -l.debit : l.credit;
  const options = LINE_CLASSES.filter((c) => c.side === 'BOTH' || (c.side === 'DEBIT') === l.debit > 0);
  const chk = lineCheckNo(l);
  return (
    <tr className={match ? '' : 'bg-amber-50/40'}>
      <td className="whitespace-nowrap tabular-nums">{l.date}{earlier && <span className="ml-1 text-xs text-slate-500">(earlier)</span>}</td>
      <td className="font-mono text-xs">{l.checkNumber || l.reference}{chk && !l.checkNumber && !l.reference ? chk : ''}</td>
      <td className="max-w-[14rem] truncate" title={l.description}>{l.description}</td>
      <td className={`num ${amount < 0 ? 'text-red-800' : ''}`}><Money value={amount} /></td>
      <td className="min-w-[14rem]">
        {match ? (
          <span className="inline-flex flex-wrap items-center gap-1 text-xs text-emerald-800">
            <Icon name="check" className="h-3.5 w-3.5" /> {matchLabel(match)}
            {match.amount !== match.bookAmount && <span className="text-red-800">· books {formatPesos(match.bookAmount)}</span>}
            {match.how === 'MANUAL' && (editable ? <button type="button" className="link ml-1" onClick={onUnmatch} aria-label={`Undo match of ${l.reference || l.description}`}>undo</button> : <span className="text-slate-500">(manual)</span>)}
          </span>
        ) : editable && cls ? (
          <div className="space-y-1">
            <select aria-label={`Treatment of ${l.description || l.reference} ${formatPesos(Math.abs(amount) as Centavos)}`} className="input py-1 text-xs" value={cls.cls} onChange={(e) => onClassify(e.target.value as LineClass)}>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}{cls.suggested && o.value === cls.cls ? ' (suggested)' : ''}</option>)}
            </select>
            {candidates.length > 0 && (
              <select aria-label="Match to a book item" className="input py-1 text-xs" value="" onChange={(e) => e.target.value && onMatch(e.target.value)}>
                <option value="">Match to book item…</option>
                {candidates.slice(0, 60).map((c) => <option key={c.key} value={c.key}>{bookLabel(c)} · {formatPesos(c.amount)} · {c.payeeName || c.reference}</option>)}
              </select>
            )}
            {item?.requiresJev && <span className="block text-xs text-amber-800">Needs a JEV</span>}
          </div>
        ) : (
          <span className="text-xs text-slate-700">{item ? `${RECON_CATEGORY_LABELS[item.category]}${item.remarks ? ` — ${item.remarks}` : ''}` : cls ? LINE_CLASSES.find((c) => c.value === cls.cls)?.label : '—'}</span>
        )}
      </td>
    </tr>
  );
}

function Schedule1Table({ rows }: { rows: Schedule1Row[] }) {
  const groups: Array<[string, Schedule1Row[]]> = [['Prior Years', rows.filter((r) => r.priorYear)], ['Current Year', rows.filter((r) => !r.priorYear)]];
  const tot = (xs: Schedule1Row[], k: 'book' | 'bank' | 'diff') => xs.reduce((t, x) => t + x[k], 0);
  return (
    <table className="table-base">
      <caption className="sr-only">Schedule 1 — Checks issued reconciliation</caption>
      <thead><tr><th scope="col">Date</th><th scope="col">Check no.</th><th scope="col">Payee</th><th scope="col" className="num">Book</th><th scope="col" className="num">Bank</th><th scope="col" className="num">Diff</th><th scope="col">Remarks</th></tr></thead>
      {groups.map(([title, list]) =>
        list.length === 0 && title === 'Prior Years' ? null : (
          <tbody key={title} className="divide-y divide-slate-100">
            <tr className="bg-slate-50"><th scope="rowgroup" colSpan={7} className="text-left text-xs font-semibold uppercase tracking-wide text-slate-600">{title}</th></tr>
            {list.map((r) => (
              <tr key={r.key} className={r.status === 'CANCELLED' ? 'text-slate-500' : r.status === 'AMOUNT_DIFFERS' ? 'bg-red-50/50' : ''}>
                <td className="whitespace-nowrap tabular-nums">{r.date}</td>
                <td className="font-mono text-xs">{r.checkNumber}</td>
                <td className="max-w-[14rem] truncate" title={r.payeeName}>{r.payeeName}</td>
                <td className="num"><Money value={r.book} /></td>
                <td className="num"><Money value={r.bank} /></td>
                <td className="num"><Money value={r.diff} /></td>
                <td className="text-xs">{CHECK_STATUS_LABEL[r.status]}{r.clearedDate ? ` ${r.clearedDate}` : ''}{r.status === 'CANCELLED' && r.remarks ? ` — ${r.remarks}` : ''}</td>
              </tr>
            ))}
            <tr className="font-semibold"><td colSpan={3}>Total {title.toLowerCase()}</td><td className="num"><Money value={tot(list, 'book')} dashZero={false} /></td><td className="num"><Money value={tot(list, 'bank')} dashZero={false} /></td><td className="num"><Money value={tot(list, 'diff')} dashZero={false} /></td><td /></tr>
          </tbody>
        ),
      )}
      <tfoot><tr className="font-bold"><td colSpan={3}>Grand total</td><td className="num"><Money value={tot(rows, 'book')} dashZero={false} /></td><td className="num"><Money value={tot(rows, 'bank')} dashZero={false} /></td><td className="num"><Money value={tot(rows, 'diff')} dashZero={false} /></td><td /></tr></tfoot>
    </table>
  );
}

function Schedule2Table({ caption, rows }: { caption: string; rows: Schedule2Row[] }) {
  const tot = (k: 'book' | 'bank' | 'diff') => rows.reduce((t, x) => t + x[k], 0);
  return (
    <table className="table-base">
      <caption className="sr-only">{caption}</caption>
      <thead><tr><th scope="col">Date</th><th scope="col">Particulars</th><th scope="col" className="num">Book</th><th scope="col" className="num">Bank</th><th scope="col" className="num">Diff</th><th scope="col">Remarks</th></tr></thead>
      <tbody className="divide-y divide-slate-100">
        {rows.length === 0 && <tr><td colSpan={6} className="p-3 text-sm text-slate-600">None.</td></tr>}
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="whitespace-nowrap tabular-nums">{r.date}</td>
            <td className="max-w-[18rem] truncate" title={r.particulars}>{[r.reference, r.particulars].filter(Boolean).join(' — ')}</td>
            <td className="num"><Money value={r.book} /></td>
            <td className="num"><Money value={r.bank} /></td>
            <td className="num"><Money value={r.diff} /></td>
            <td className="text-xs">{r.remarks || (r.bankDate ? `Credited ${r.bankDate}` : '')}</td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr className="font-semibold"><td colSpan={2}>Total</td><td className="num"><Money value={tot('book')} dashZero={false} /></td><td className="num"><Money value={tot('bank')} dashZero={false} /></td><td className="num"><Money value={tot('diff')} dashZero={false} /></td><td /></tr></tfoot>
    </table>
  );
}

function ItemsTable({ items }: { items: ReconItemRecord[] }) {
  if (!items.length) return <p className="p-4 text-sm text-slate-600">No reconciling items — every book item matched the statement.</p>;
  return (
    <table className="table-base">
      <caption className="sr-only">Reconciling items by category</caption>
      <thead><tr><th scope="col">Side</th><th scope="col">Category</th><th scope="col">Date</th><th scope="col">Ref.</th><th scope="col">Particulars</th><th scope="col" className="num">Amount</th></tr></thead>
      <tbody className="divide-y divide-slate-100">
        {items.map((i) => (
          <tr key={`${i.seq}-${i.statementLineId ?? i.sourceId}`}>
            <td className="text-xs">{i.side === 'BOOK' ? 'Book (agency)' : 'Bank'}</td>
            <td className="whitespace-nowrap text-xs">{RECON_CATEGORY_LABELS[i.category]}{i.suggested && <span className="ml-1 text-slate-500">(suggested)</span>}</td>
            <td className="whitespace-nowrap tabular-nums">{i.date}</td>
            <td className="font-mono text-xs">{i.reference}</td>
            <td className="max-w-xs truncate" title={i.remarks || i.name}>{i.name}{i.requiresJev && <span className="ml-1 text-xs text-amber-800">· needs JEV</span>}</td>
            <td className="num"><Money value={i.amount} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const MANUAL_CATEGORIES: ReconItemCategory[] = ['BOOK_ERROR', 'BANK_ERROR', 'OTHER_BOOK', 'OTHER_BANK', 'OUTSTANDING_CHECK', 'DEPOSIT_IN_TRANSIT'];

/** Person-entered items: errors (signed) and other reconciling items. */
function ManualItems({ items, editable, fiscalYear, month, onChange }: { items: ManualReconItem[]; editable: boolean; fiscalYear: number; month: number; onChange(v: ManualReconItem[]): void }) {
  const blank = { category: 'BOOK_ERROR' as ReconItemCategory, date: lastDayOfMonth(fiscalYear, month), reference: '', name: '', amount: 0 as Centavos | null, negative: false };
  const [f, setF] = useState(blank);
  const signed = SIGNED_CATEGORIES.includes(f.category);
  const valid = f.name.trim().length >= 2 && (f.amount ?? 0) > 0;
  if (!editable && !items.length) return null;
  return (
    <section aria-labelledby="manual-items" className="card">
      <div className="card-header"><h2 id="manual-items" className="card-title">Manual items (errors, other reconciling items)</h2></div>
      {items.length > 0 && (
        <table className="table-base">
          <caption className="sr-only">Manual reconciling items</caption>
          <thead><tr><th scope="col">Category</th><th scope="col">Date</th><th scope="col">Ref.</th><th scope="col">Particulars</th><th scope="col" className="num">Amount</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((i) => (
              <tr key={i.id}>
                <td className="text-xs">{RECON_CATEGORY_LABELS[i.category]}</td>
                <td className="tabular-nums">{i.date}</td>
                <td className="font-mono text-xs">{i.reference}</td>
                <td>{i.name}</td>
                <td className="num"><Money value={i.amount} /></td>
                <td>{editable && <button type="button" className="btn-ghost btn-icon text-slate-500 hover:text-red-700" aria-label={`Remove ${i.name}`} onClick={() => onChange(items.filter((x) => x.id !== i.id))}><Icon name="trash" /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable && (
        <form
          className="grid gap-3 border-t border-slate-200 p-4 sm:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            const amount = ((f.amount ?? 0) * (signed && f.negative ? -1 : 1)) as Centavos;
            onChange([...items, { id: `M${Date.now().toString(36)}`, category: f.category, date: f.date, reference: f.reference.trim(), name: f.name.trim(), amount, remarks: '' }]);
            setF(blank);
          }}
        >
          <Field label="Category" className="sm:col-span-2">{(p) => <select {...p} className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as ReconItemCategory })}>{MANUAL_CATEGORIES.map((c) => <option key={c} value={c}>{RECON_CATEGORY_LABELS[c]}</option>)}</select>}</Field>
          <Field label="Date">{(p) => <input {...p} type="date" className="input" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
          <Field label="Reference">{(p) => <input {...p} className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}</Field>
          <Field label="Amount" required hint={signed ? 'Tick "deduct" to subtract' : 'Entered positive'}>
            {(p) => (
              <div className="flex items-center gap-2">
                <MoneyInput {...p} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />
                {signed && <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.negative} onChange={(e) => setF({ ...f, negative: e.target.checked })} /> deduct</label>}
              </div>
            )}
          </Field>
          <Field label="Particulars" required className="sm:col-span-5">{(p) => <input {...p} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Check 1762250 recorded as ₱1,500 instead of ₱1,050" />}</Field>
          <div className="flex items-end"><button type="submit" className="btn-secondary w-full" disabled={!valid}><Icon name="plus" /> Add item</button></div>
        </form>
      )}
    </section>
  );
}
