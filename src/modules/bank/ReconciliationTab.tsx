import {
  CASH_IN_BANK,
  LINE_CLASSES,
  RECON_CATEGORY_LABELS,
  RECON_CATEGORY_ORDER,
  SIGNED_CATEGORIES,
  bankPeriodDocId,
  bookBalanceFromRows,
  buildReconciliation,
  formatPesos,
  lastDayOfMonth,
  periodKey,
  toReconAda,
  toReconCheck,
  toReconDeposit,
  toReconMemo,
  type AccountBalanceDoc,
  type BankMemoRecord,
  type BankReconciliationRecord,
  type BankStatementRecord,
  type Centavos,
  type CheckDoc,
  type DepositDoc,
  type LineClass,
  type ManualMatch,
  type ManualReconItem,
  type ReconItemCategory,
  type ReconItemRecord,
  type ReconMatch,
  type StatementLine,
} from '@bfms/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MoneyInput } from '../../components/forms';
import { ReturnBanner, WorkflowTrail, reportHref } from '../../components/source';
import { ConfirmDialog, EmptyState, Field, Icon, Money, StatusChip, TableSkeleton } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useCollection } from '../../hooks/useCollection';
import { useDocument } from '../../hooks/useDocument';
import { errorMessage } from '../../services/functions/api';
import { bankApi } from './api';
import type { BankPeriod } from './BankPage';

interface Inputs {
  classifications: Record<string, LineClass>;
  manualItems: ManualReconItem[];
  manualMatches: ManualMatch[];
}

const SOURCE_LABEL: Record<ReconMatch['sourceCollection'], string> = { checks: 'Check', deposits: 'Deposit', adas: 'ADA', bankMemos: 'Memo' };

/**
 * Reconciliation workspace: the same pure `buildReconciliation` the server runs, applied live to the
 * statement and the book documents, so every classification shows its effect at once. "Save &
 * prepare" stores it (the server recomputes); FOR_REVIEW and FINAL show the stored result.
 */
export function ReconciliationTab({ period, onCreated }: { period: BankPeriod; onCreated(): void }) {
  const { can } = useAuth();
  const { notify } = useToast();
  const { bank, month, fiscalYear } = period;
  const bid = bank.barangayId;
  const id = bankPeriodDocId(bid, bank.id, fiscalYear, month);
  const { data: stmt, loading: ls } = useDocument<BankStatementRecord>('bankStatements', id);
  const { data: recon, loading: lr } = useDocument<BankReconciliationRecord>('bankReconciliations', id);
  const stored = useCollection<ReconItemRecord>(`bankReconciliations/${id}/items`, recon ? [] : null).rows;
  const byBank = [['barangayId', '==', bid], ['bankAccountId', '==', bank.id]] as const;
  const checks = useCollection<CheckDoc>('checks', byBank).rows;
  const deposits = useCollection<DepositDoc & { bankReconciledDate?: string | null }>('deposits', byBank).rows;
  const adas = useCollection<Record<string, unknown>>('adas', byBank).rows;
  const memos = useCollection<BankMemoRecord>('bankMemos', byBank).rows;
  const balances = useCollection<AccountBalanceDoc>('accountBalances', [['barangayId', '==', bid], ['fiscalYear', '==', fiscalYear], ['accountCode', '==', CASH_IN_BANK], ['subsidiaryId', '==', bank.subsidiaryId]]).rows;

  const [inputs, setInputs] = useState<Inputs>({ classifications: {}, manualItems: [], manualMatches: [] });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'RETURN' | 'FINALIZE' | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!dirty) setInputs({ classifications: recon?.classifications ?? {}, manualItems: recon?.manualItems ?? [], manualMatches: recon?.manualMatches ?? [] });
  }, [recon, dirty]);
  const update = (patch: Partial<Inputs>) => { setInputs((x) => ({ ...x, ...patch })); setDirty(true); };

  const status = recon?.status ?? 'DRAFT';
  const editable = ['DRAFT', 'RETURNED'].includes(status) && can('recon.prepare', bid);
  const live = useMemo(() => {
    if (!stmt) return null;
    return buildReconciliation({
      monthStart: `${periodKey(fiscalYear, month)}-01`,
      monthEnd: lastDayOfMonth(fiscalYear, month),
      bookBalance: bookBalanceFromRows(balances, CASH_IN_BANK, bank.subsidiaryId, month),
      bankBalance: stmt.endingBalance,
      lines: stmt.lines,
      checks: checks.map((c) => toReconCheck(c.id, c)),
      // Same scope as the server's queries (current and previous fiscal year).
      deposits: deposits.filter((d) => d.fiscalYear >= fiscalYear - 1 && d.fiscalYear <= fiscalYear).map((d) => toReconDeposit(d.id, d)),
      adas: adas.filter((a) => Number(a.fiscalYear) >= fiscalYear - 1 && Number(a.fiscalYear) <= fiscalYear).flatMap((a) => toReconAda(a.id, a) ?? []),
      memos: memos.filter((m) => m.accountingPeriod === periodKey(fiscalYear, month)).map((m) => toReconMemo(m.id, m)),
      ...inputs,
    });
  }, [stmt, balances, checks, deposits, adas, memos, inputs, bank.subsidiaryId, fiscalYear, month]);

  if (ls || lr) return <TableSkeleton />;
  if (!stmt)
    return (
      <EmptyState title="No bank statement for this month" action={<Link className="btn-primary" to={`/bank-reconciliation/statements?bank=${bank.id}&month=${month}`}>Enter the statement</Link>}>
        Enter or paste the bank statement first; the reconciliation compares it with the checks, deposits and the Cash in Bank ledger.
      </EmptyState>
    );

  // Stored figures once it left the preparer; live preview while it is being prepared.
  const useStored = !editable && !!recon;
  const fig = useStored
    ? { ...recon!, items: [...stored].sort((a, b) => a.seq - b.seq), matches: recon!.matches ?? [], lineClasses: {} as Record<string, { cls: LineClass; suggested: boolean }> }
    : { ...live!, bookBalance: bookBalanceFromRows(balances, CASH_IN_BANK, bank.subsidiaryId, month), bankBalance: stmt.endingBalance, ...live!.totals };
  const stale = editable && recon && !dirty && (recon.difference !== live!.difference || recon.adjustedBookBalance !== live!.adjustedBookBalance || recon.itemCount !== live!.items.length);
  const matchByLine = new Map(fig.matches.map((m) => [m.lineId, m]));
  const per = { barangayId: bid, bankAccountId: bank.id, fiscalYear, month };

  async function run(label: string, fn: () => Promise<unknown>, ok: string) {
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
    run('prepare', async () => {
      await bankApi.prepareBankReconciliation({ ...per, ...inputs });
      setDirty(false);
      if (!recon) onCreated();
    }, 'Reconciliation prepared.');
  const genMemos = () =>
    run('memos', async () => {
      // Save the current classifications first: the server records memos from the stored ones.
      await bankApi.prepareBankReconciliation({ ...per, ...inputs });
      const r = await bankApi.generateRbdcmEntries(per);
      await bankApi.prepareBankReconciliation(per);
      setDirty(false);
      if (!recon) onCreated();
      notify(`${r.created} memo(s) recorded, ${r.jevs} draft JEV(s) generated for approval and posting.`, 'info');
    }, 'Reconciliation refreshed.');

  const lineLabel = (m: ReconMatch) => {
    if (m.sourceCollection === 'checks') return `Check ${checks.find((c) => c.id === m.sourceId)?.checkNumber ?? ''}`;
    if (m.sourceCollection === 'deposits') return `Deposit ${deposits.find((d) => d.id === m.sourceId)?.depositSlipNumber ?? ''}`;
    if (m.sourceCollection === 'bankMemos') {
      const memo = memos.find((x) => x.id === m.sourceId);
      return `Memo ${memo?.memoNumber ?? '(draft)'}${memo?.jevNumber ? ` · JEV ${memo.jevNumber}` : ' · JEV not posted'}`;
    }
    return 'ADA';
  };
  // Book items still open on the bank side (candidates for a manual match).
  const openBook = fig.items.filter((i) => (i.category === 'OUTSTANDING_CHECK' || i.category === 'DEPOSIT_IN_TRANSIT') && i.sourceId && i.sourceCollection);
  const diff = fig.difference;

  return (
    <div className="space-y-4">
      {recon && <ReturnBanner record={{ ...recon, id }} />}
      <section aria-labelledby="recon-summary" className="card">
        <div className="card-header">
          <h2 id="recon-summary" className="card-title">Statement of bank reconciliation — {periodKey(fiscalYear, month)}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={status} />
            {editable && (dirty || !recon || stale) && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">Preview — not saved</span>}
            {!stmt.balanced && <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-800 ring-1 ring-inset ring-red-200">Statement lines ≠ ending balance</span>}
          </div>
        </div>
        <div className="grid gap-4 p-4 md:grid-cols-2">
          <Side
            title="Bank side"
            rows={[
              ['Balance per bank statement', fig.bankBalance, 'base'],
              ['Add: deposits in transit', fig.depositInTransit, 'plus'],
              ['Less: outstanding checks', fig.outstandingChecks, 'minus'],
              ['Add/(deduct): bank errors & other', fig.bankErrors + fig.otherBankItems, 'signed'],
            ]}
            total={['Adjusted bank balance', fig.adjustedBankBalance]}
          />
          <Side
            title="Book side"
            rows={[
              ['Balance per books (GL 1-01-02-010)', fig.bookBalance, 'base'],
              ['Add: credit memos', fig.creditMemos, 'plus'],
              ['Add: interest earned', fig.interestIncome, 'plus'],
              ['Less: debit memos', fig.debitMemos, 'minus'],
              ['Less: bank charges', fig.bankCharges, 'minus'],
              ['Add/(deduct): book errors & other', fig.bookErrors + fig.otherBookItems, 'signed'],
            ]}
            total={['Adjusted book balance', fig.adjustedBookBalance]}
          />
        </div>
        <div className={`flex flex-wrap items-center gap-3 border-t px-4 py-3 ${diff === 0 ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`} aria-live="polite">
          <Icon name={diff === 0 ? 'check' : 'alert'} className={`h-5 w-5 ${diff === 0 ? 'text-emerald-700' : 'text-red-700'}`} />
          <p className={`text-sm font-semibold ${diff === 0 ? 'text-emerald-900' : 'text-red-900'}`}>
            {diff === 0 ? 'Reconciled — adjusted book balance equals adjusted bank balance.' : <>Difference (book − bank): <span className="tabular-nums">{formatPesos(diff as Centavos)}</span></>}
          </p>
          <div className="ml-auto flex flex-wrap gap-2">
            {editable && <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void prepare()}>{busy === 'prepare' ? 'Saving…' : recon ? 'Save & re-prepare' : 'Prepare reconciliation'}</button>}
            {editable && can('jev.prepare', bid) && fig.items.some((i) => i.statementLineId && !i.sourceId && i.side === 'BOOK') && (
              <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void genMemos()} title="Records a bank memo for each unrecorded charge, interest or memo line and drafts its JEV">
                {busy === 'memos' ? 'Recording…' : 'Record memos & draft JEVs'}
              </button>
            )}
            {editable && recon && (
              <button type="button" className="btn-secondary" disabled={!!busy || dirty || !stmt.balanced} onClick={() => void run('submit', () => bankApi.submitBankReconciliation({ id }), 'Submitted for review.')}>
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
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section aria-labelledby="bank-lines" className="card">
          <div className="card-header"><h2 id="bank-lines" className="card-title">Bank statement ({stmt.lines.length} lines)</h2></div>
          <div className="max-h-[32rem] overflow-auto">
            <table className="table-base">
              <caption className="sr-only">Statement lines with their match or classification</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">Ref.</th><th scope="col">Description</th><th scope="col" className="num">Amount</th><th scope="col">Match / treatment</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {stmt.lines.map((l) => (
                  <LineRow
                    key={l.lineId}
                    line={l}
                    match={matchByLine.get(l.lineId)}
                    matchLabel={lineLabel}
                    item={fig.items.find((i) => i.statementLineId === l.lineId)}
                    cls={useStored ? undefined : live!.lineClasses[l.lineId]}
                    editable={editable}
                    candidates={openBook.filter((i) => i.amount === (l.debit || l.credit) && (i.category === 'OUTSTANDING_CHECK') === l.debit > 0)}
                    onClassify={(c) => update({ classifications: { ...inputs.classifications, [l.lineId]: c } })}
                    onMatch={(i) => update({ manualMatches: [...inputs.manualMatches, { lineId: l.lineId, sourceCollection: i.sourceCollection!, sourceId: i.sourceId! }] })}
                    onUnmatch={() => update({ manualMatches: inputs.manualMatches.filter((m) => m.lineId !== l.lineId) })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="book-items" className="card">
          <div className="card-header"><h2 id="book-items" className="card-title">Reconciling items</h2></div>
          <div className="max-h-[32rem] overflow-auto">
            {fig.items.length === 0 ? (
              <p className="p-4 text-sm text-slate-600">No reconciling items — every book item matched the statement.</p>
            ) : (
              <table className="table-base">
                <caption className="sr-only">Reconciling items by category</caption>
                <thead><tr><th scope="col">Category</th><th scope="col">Date</th><th scope="col">Ref.</th><th scope="col">Particulars</th><th scope="col" className="num">Amount</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {RECON_CATEGORY_ORDER.flatMap((c) =>
                    fig.items.filter((i) => i.category === c).map((i) => (
                      <tr key={`${i.seq}-${i.statementLineId ?? i.sourceId}`}>
                        <td className="whitespace-nowrap text-xs"><span className={i.side === 'BANK' ? 'text-sky-800' : 'text-violet-800'}>{RECON_CATEGORY_LABELS[c]}</span>{i.suggested && <span className="ml-1 text-slate-500">(suggested)</span>}</td>
                        <td className="whitespace-nowrap tabular-nums">{i.date}</td>
                        <td className="font-mono text-xs">{i.reference}</td>
                        <td className="max-w-xs truncate" title={i.remarks || i.name}>{i.name}{i.requiresJev && <span className="ml-1 text-xs text-amber-800">· needs JEV</span>}</td>
                        <td className="num"><Money value={i.amount} /></td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>

      <ManualItems items={inputs.manualItems} editable={editable} fiscalYear={fiscalYear} month={month} onChange={(manualItems) => update({ manualItems })} />

      <div className="flex flex-wrap gap-2">
        <Link className="btn-secondary" to={reportHref('BRS', { fiscalYear, month, bankAccountId: bank.id })}><Icon name="file" /> Print BRS</Link>
        <Link className="btn-secondary" to={reportHref('BRS_SCHEDULES', { fiscalYear, month, bankAccountId: bank.id })}><Icon name="file" /> Schedules</Link>
        <Link className="btn-secondary" to={reportHref('CHECKS_CLEARED', { fiscalYear, month, bankAccountId: bank.id })}><Icon name="file" /> Checks cleared</Link>
        <Link className="btn-secondary" to={reportHref('OUTSTANDING_CHECKS', { fiscalYear, month, bankAccountId: bank.id })}><Icon name="file" /> Outstanding checks</Link>
      </div>
      {recon && <WorkflowTrail barangayId={bid} recordId={id} />}

      {confirm && (
        <ConfirmDialog
          open
          busy={!!busy}
          title={confirm === 'FINALIZE' ? 'Finalize bank reconciliation' : 'Return bank reconciliation'}
          message={confirm === 'FINALIZE' ? 'Finalizing recomputes the reconciliation from current data, marks the matched checks CLEARED with the statement date and locks the statement. It is required before the period can be locked.' : 'The preparer will see your reason and can correct and resubmit.'}
          confirmLabel={confirm === 'FINALIZE' ? 'Finalize' : 'Return'}
          requireReason={confirm === 'RETURN'}
          reason={reason}
          onReasonChange={setReason}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            void run(confirm, () => (confirm === 'FINALIZE' ? bankApi.finalizeBankReconciliation({ id }) : bankApi.returnBankReconciliation({ id, remarks: reason.trim() })), confirm === 'FINALIZE' ? 'Reconciliation finalized.' : 'Returned to the preparer.').then((ok) => ok && (setConfirm(null), setReason('')))
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

function LineRow({ line: l, match, matchLabel, item, cls, editable, candidates, onClassify, onMatch, onUnmatch }: {
  line: StatementLine;
  match: ReconMatch | undefined;
  matchLabel(m: ReconMatch): string;
  item: ReconItemRecord | undefined;
  cls: { cls: LineClass; suggested: boolean } | undefined;
  editable: boolean;
  candidates: ReconItemRecord[];
  onClassify(c: LineClass): void;
  onMatch(i: ReconItemRecord): void;
  onUnmatch(): void;
}) {
  const amount = l.debit ? -l.debit : l.credit;
  const options = LINE_CLASSES.filter((c) => c.side === 'BOTH' || (c.side === 'DEBIT') === l.debit > 0);
  return (
    <tr className={match ? '' : 'bg-amber-50/40'}>
      <td className="whitespace-nowrap tabular-nums">{l.date}</td>
      <td className="font-mono text-xs">{l.reference}</td>
      <td className="max-w-[14rem] truncate" title={l.description}>{l.description}</td>
      <td className={`num ${amount < 0 ? 'text-red-800' : ''}`}><Money value={amount} /></td>
      <td className="min-w-[13rem]">
        {match ? (
          <span className="inline-flex flex-wrap items-center gap-1 text-xs text-emerald-800">
            <Icon name="check" className="h-3.5 w-3.5" /> {matchLabel(match)}
            {match.how === 'MANUAL' && (editable ? <button type="button" className="link ml-1" onClick={onUnmatch} aria-label={`Undo match of ${l.reference || l.description}`}>undo</button> : <span className="text-slate-500">(manual)</span>)}
            {item?.requiresJev && <span className="text-amber-800">· memo JEV not posted</span>}
          </span>
        ) : editable && cls ? (
          <div className="space-y-1">
            <select aria-label={`Treatment of ${l.description || l.reference} ${formatPesos(Math.abs(amount) as Centavos)}`} className="input py-1 text-xs" value={cls.cls} onChange={(e) => onClassify(e.target.value as LineClass)}>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}{cls.suggested && o.value === cls.cls ? ' (suggested)' : ''}</option>)}
            </select>
            {candidates.length > 0 && (
              <select aria-label="Match to a book item" className="input py-1 text-xs" value="" onChange={(e) => { const i = candidates.find((c) => `${c.sourceCollection}:${c.sourceId}` === e.target.value); if (i) onMatch(i); }}>
                <option value="">Match to book item…</option>
                {candidates.map((c) => <option key={`${c.sourceCollection}:${c.sourceId}`} value={`${c.sourceCollection}:${c.sourceId}`}>{c.reference} · {c.date} · {c.name}</option>)}
              </select>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-700">{item ? RECON_CATEGORY_LABELS[item.category] : cls ? LINE_CLASSES.find((c) => c.value === cls.cls)?.label : '—'}</span>
        )}
      </td>
    </tr>
  );
}

const MANUAL_CATEGORIES: ReconItemCategory[] = ['BOOK_ERROR', 'BANK_ERROR', 'OTHER_BOOK', 'OTHER_BANK', 'OUTSTANDING_CHECK', 'DEPOSIT_IN_TRANSIT'];

/** Person-entered items: errors (signed), pre-BFMS outstanding checks / deposits in transit. */
function ManualItems({ items, editable, fiscalYear, month, onChange }: { items: ManualReconItem[]; editable: boolean; fiscalYear: number; month: number; onChange(v: ManualReconItem[]): void }) {
  const blank = { category: 'BOOK_ERROR' as ReconItemCategory, date: lastDayOfMonth(fiscalYear, month), reference: '', name: '', amount: 0 as Centavos | null, negative: false };
  const [f, setF] = useState(blank);
  const signed = SIGNED_CATEGORIES.includes(f.category);
  const valid = f.name.trim().length >= 2 && (f.amount ?? 0) > 0;
  if (!editable && !items.length) return null;
  return (
    <section aria-labelledby="manual-items" className="card">
      <div className="card-header"><h2 id="manual-items" className="card-title">Manual items (errors, pre-BFMS items)</h2></div>
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
