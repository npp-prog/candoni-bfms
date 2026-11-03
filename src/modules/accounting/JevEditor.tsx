import {
  JEV_SOURCE_LABELS,
  TRANSACTION_TYPES,
  bookForLines,
  computeJournalTotals,
  formatPesos,
  manilaToday,
  parsePesos,
  transactionType,
  type Centavos,
  type JournalEntryDoc,
  type JournalLineDoc,
  type SubsidiaryAccountDoc,
  type TransactionType,
  type WithId,
} from '@bfms/shared';
import { collection, doc, getDoc, getDocs, orderBy, query } from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import { PrintLink } from '../../components/source';
import { ConfirmDialog, Icon, Modal, Spinner, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useChartOfAccounts } from '../../hooks/useChartOfAccounts';
import { useCollection } from '../../hooks/useCollection';
import { useDocument } from '../../hooks/useDocument';
import { db } from '../../services/firebase/app';
import { api, errorMessage } from '../../services/functions/api';

/** Adjusting/correcting stay available for "Others"; OPENING follows the Opening-balance type. */
const ENTRY_TYPES = [
  { value: 'REGULAR', label: 'Regular' },
  { value: 'ADJUSTING', label: 'Adjusting' },
  { value: 'CORRECTING', label: 'Correcting' },
] as const;
type ManualEntryType = (typeof ENTRY_TYPES)[number]['value'] | 'OPENING';

interface Row { accountCode: string; subsidiaryId: string; debit: string; credit: string; lineDescription: string; hint?: string }
const blank = (hint?: string): Row => ({ accountCode: '', subsidiaryId: '', debit: '', credit: '', lineDescription: '', hint });

interface Header {
  transactionType: TransactionType;
  jevDate: string;
  entryType: ManualEntryType;
  primaryReference: string;
  secondaryReference: string;
  tertiaryReference: string;
  payeeName: string;
  particulars: string;
}

function safeParse(v: string): Centavos | null {
  try {
    return parsePesos(v);
  } catch {
    return null;
  }
}

/** Pick the ledger the template asks for: the only SL of the account, or the first matching prefix. */
function pickSl(sls: WithId<SubsidiaryAccountDoc>[], accountCode: string, prefix?: string): string {
  const of = sls.filter((s) => s.accountCode === accountCode && s.active).sort((a, b) => a.subsidiaryCode.localeCompare(b.subsidiaryCode));
  if (of.length === 1) return of[0]!.id;
  return (prefix && of.find((s) => s.subsidiaryCode.startsWith(prefix))?.id) || '';
}

function templateRows(type: TransactionType, sls: WithId<SubsidiaryAccountDoc>[]): Row[] {
  const t = transactionType(type);
  if (!t) return [blank(), blank()];
  return t.template.map((l) => ({ ...blank(`${l.side === 'D' ? 'Dr' : 'Cr'} · ${l.hint}`), accountCode: l.accountCode ?? '', subsidiaryId: l.accountCode ? pickSl(sls, l.accountCode, l.slPrefix) : '' }));
}

const freshHeader = (type: TransactionType, date = manilaToday()): Header => ({
  transactionType: type,
  jevDate: date,
  entryType: type === 'OPENING' ? 'OPENING' : 'REGULAR',
  primaryReference: '',
  secondaryReference: '',
  tertiaryReference: '',
  payeeName: '',
  particulars: '',
});

/**
 * Journal entry (JEV) encoder shaped like the legacy 01_CY DB sheet: transaction type, check/OR no.,
 * DV/RCD no., name, particulars and account/SL lines. Totals are a preview computed with the same
 * shared function the server uses; the server recomputes and enforces debit = credit.
 * Workflow: encoder saves & submits → the Municipal Accountant reviews and posts in one step.
 */
export function JevEditor({ jevId, initialType = 'DISBURSEMENT', onClose }: { jevId: string | null; initialType?: TransactionType; onClose(): void }) {
  const { can, user } = useAuth();
  const { barangayId } = useBarangay();
  const { notify } = useToast();
  const coa = useChartOfAccounts();
  const sls = useCollection<SubsidiaryAccountDoc>('subsidiaryAccounts', barangayId ? [['barangayId', '==', barangayId]] : null).rows;
  const settings = useDocument<{ allowSelfPost?: boolean }>('systemSettings', 'global').data;
  const [loading, setLoading] = useState(!!jevId);
  const [jev, setJev] = useState<WithId<JournalEntryDoc> | null>(null);
  const [h, setH] = useState<Header>(freshHeader(initialType));
  const [rows, setRows] = useState<Row[]>([blank(), blank()]);
  const [touched, setTouched] = useState(false);
  const [keepOpen, setKeepOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'post' | 'return' | 'reverse'>(null);
  const [reason, setReason] = useState('');
  const focusLine = useRef<number | null>(null);
  const tableRef = useRef<HTMLTableSectionElement>(null);
  const firstField = useRef<HTMLInputElement>(null);

  // New entry: apply the type's template until the encoder starts typing lines.
  useEffect(() => {
    if (jevId || touched) return;
    setRows(templateRows(h.transactionType, sls));
  }, [jevId, touched, h.transactionType, sls]);

  useEffect(() => {
    if (focusLine.current === null) return;
    tableRef.current?.querySelector<HTMLInputElement>(`#jev-acct-${focusLine.current}`)?.focus();
    focusLine.current = null;
  }, [rows.length]);

  useEffect(() => {
    if (!jevId) return;
    void (async () => {
      const s = await getDoc(doc(db, 'journalEntries', jevId));
      if (!s.exists()) return;
      const j = { ...(s.data() as JournalEntryDoc), id: s.id };
      setJev(j);
      setH({
        transactionType: j.transactionType ?? (j.entryType === 'OPENING' ? 'OPENING' : 'OTHERS'),
        jevDate: j.jevDate,
        entryType: (['REGULAR', 'ADJUSTING', 'CORRECTING', 'OPENING'] as const).includes(j.entryType as ManualEntryType) ? (j.entryType as ManualEntryType) : 'REGULAR',
        primaryReference: j.primaryReference ?? '',
        secondaryReference: j.secondaryReference ?? '',
        tertiaryReference: j.tertiaryReference ?? '',
        payeeName: j.payeeName ?? '',
        particulars: j.particulars,
      });
      const ls = await getDocs(query(collection(db, 'journalEntries', jevId, 'lines'), orderBy('lineNo')));
      setRows(ls.docs.map((d) => {
        const l = d.data() as JournalLineDoc;
        return { accountCode: l.accountCode, subsidiaryId: l.subsidiaryId ?? '', debit: l.debit ? formatPesos(l.debit, { parens: false }) : '', credit: l.credit ? formatPesos(l.credit, { parens: false }) : '', lineDescription: l.lineDescription };
      }));
      setTouched(true);
      setLoading(false);
    })();
  }, [jevId]);

  if (!barangayId) return null;
  const def = transactionType(h.transactionType)!;
  const editable = !jev || jev.status === 'DRAFT' || jev.status === 'RETURNED';
  const systemEntry = !!jev && !['REGULAR', 'ADJUSTING', 'CORRECTING', 'OPENING'].includes(jev.entryType);
  const parsed = rows.map((r) => ({ debit: safeParse(r.debit || '0'), credit: safeParse(r.credit || '0') }));
  const invalid = parsed.some((p) => p.debit === null || p.credit === null);
  const totals = invalid ? null : computeJournalTotals(parsed as Array<{ debit: Centavos; credit: Centavos }>);
  const book = bookForLines(rows.filter((r) => r.accountCode));

  const lineErrors = rows.map((r, i) => {
    const acct = coa?.get(r.accountCode.trim());
    const d = parsed[i]!.debit;
    const c = parsed[i]!.credit;
    return {
      account: r.accountCode.trim() && coa && !acct ? 'Unknown account code' : acct && !acct.active ? 'Account is inactive' : null,
      subsidiary: acct?.requiresSubsidiaryLedger && !r.subsidiaryId ? 'Required for this account' : null,
      debit: d === null ? 'Enter an amount like 1,234.56' : d < 0 ? 'Cannot be negative' : null,
      credit: c === null ? 'Enter an amount like 1,234.56' : c < 0 ? 'Cannot be negative' : d !== null && d > 0 && c > 0 ? 'Use either debit or credit, not both' : null,
      missing: !r.accountCode.trim() ? 'account code is required' : d !== null && c !== null && d === 0 && c === 0 ? 'enter a debit or a credit' : null,
    };
  });
  const problems: string[] = [];
  const particularsError = h.particulars.trim().length < 3 ? 'Enter at least 3 characters.' : null;
  if (particularsError) problems.push('Particulars: enter at least 3 characters.');
  lineErrors.forEach((e, i) => {
    const msgs = [e.missing, e.account, e.subsidiary && `subsidiary ${e.subsidiary.toLowerCase()}`, e.debit && `debit: ${e.debit.toLowerCase()}`, e.credit && `credit: ${e.credit.toLowerCase()}`].filter(Boolean);
    if (msgs.length) problems.push(`Line ${i + 1}: ${msgs.join('; ')}.`);
  });
  if (totals && !totals.balanced) problems.push(`Debits and credits differ by ${formatPesos(totals.difference)}.`);
  if (totals && totals.balanced && totals.totalDebit === 0) problems.push('Enter at least one amount.');

  const payload = () => ({
    jevId: jev?.id,
    barangayId,
    jevDate: h.jevDate,
    fundId: 'GF',
    transactionType: h.transactionType,
    payeeName: h.payeeName.trim() || null,
    ...(systemEntry ? {} : { entryType: h.transactionType === 'OPENING' ? ('OPENING' as const) : (h.entryType as 'REGULAR' | 'ADJUSTING' | 'CORRECTING') }),
    particulars: h.particulars,
    primaryReference: h.primaryReference.trim() || null,
    secondaryReference: h.secondaryReference.trim() || null,
    tertiaryReference: h.tertiaryReference.trim() || null,
    lines: rows.map((r, i) => ({
      accountCode: r.accountCode.trim(),
      subsidiaryId: r.subsidiaryId || null,
      debit: parsed[i]!.debit ?? (0 as Centavos),
      credit: parsed[i]!.credit ?? (0 as Centavos),
      lineDescription: r.lineDescription,
    })),
  });

  /** Reset for the next entry of the same type (fast encoding of a month's documents). */
  function nextEntry() {
    setJev(null);
    setH(freshHeader(h.transactionType, h.jevDate));
    setTouched(false);
    setRows(templateRows(h.transactionType, sls));
    setTimeout(() => firstField.current?.focus(), 0);
  }

  async function run<T>(fn: () => Promise<T>, ok: string, after: 'close' | 'next' = 'close') {
    setBusy(true);
    try {
      await fn();
      notify(ok, 'success');
      if (after === 'next') nextEntry();
      else onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  const saveDraft = () => run(() => api.saveJournalDraft(payload()), 'Draft saved.');
  const saveAndSubmit = () =>
    run(
      async () => {
        const { jevId: id } = await api.saveJournalDraft(payload());
        await api.submitJournalEntry({ jevId: id });
      },
      'Saved and submitted for posting.',
      keepOpen && !jev ? 'next' : 'close',
    );

  const set = (i: number, k: keyof Row, v: string) => {
    setTouched(true);
    setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v, ...(k === 'accountCode' ? { subsidiaryId: pickSl(sls, v.trim()) } : {}) } : r)));
  };
  /** Put the amount that balances the entry on the last line (the usual Cr Cash line). */
  const balanceLast = () => {
    if (!totals || totals.balanced) return;
    const last = rows.length - 1;
    const others = parsed.slice(0, last).reduce((t, p) => ({ d: t.d + (p.debit ?? 0), c: t.c + (p.credit ?? 0) }), { d: 0, c: 0 });
    const diff = others.d - others.c;
    setTouched(true);
    setRows(rows.map((r, j) => (j === last ? { ...r, debit: diff < 0 ? formatPesos(-diff as Centavos, { parens: false }) : '', credit: diff > 0 ? formatPesos(diff as Centavos, { parens: false }) : '' } : r)));
  };

  const own = jev?.createdBy === user?.uid;
  const selfBlocked = own && !settings?.allowSelfPost;
  const footer = (
    <>
      {editable && can('jev.prepare', barangayId) && !jev && (
        <label className="mr-auto flex items-center gap-2 self-center text-xs text-slate-700">
          <input type="checkbox" className="h-4 w-4 accent-navy-700" checked={keepOpen} onChange={(e) => setKeepOpen(e.target.checked)} /> Next entry after submit
        </label>
      )}
      <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
      {editable && can('jev.prepare', barangayId) && <button type="button" className="btn-secondary" disabled={busy || invalid || !!particularsError} onClick={() => void saveDraft()}>Save draft</button>}
      {editable && can('jev.prepare', barangayId) && <button type="button" className="btn-primary" disabled={busy || problems.length > 0} title={problems[0]} onClick={() => void saveAndSubmit()}>Save &amp; submit</button>}
      {jev && ['FOR_REVIEW', 'APPROVED'].includes(jev.status) && can('jev.review', barangayId) && <button type="button" className="btn-secondary" onClick={() => setConfirm('return')}>Return…</button>}
      {jev && ['FOR_REVIEW', 'APPROVED'].includes(jev.status) && can('jev.post', barangayId) && (
        <button type="button" className="btn-primary" disabled={busy || selfBlocked} title={selfBlocked ? 'You encoded this entry; another accounting user must post it (or enable self-posting under Administration → System).' : undefined} onClick={() => setConfirm('post')}>Post</button>
      )}
      {jev?.status === 'POSTED' && can('jev.reverse', barangayId) && <button type="button" className="btn-danger" disabled={busy} onClick={() => setConfirm('reverse')}>Reverse…</button>}
    </>
  );

  const ref = (k: 'primaryReference' | 'secondaryReference' | 'tertiaryReference', label: string, id: string, autoFocus = false) => (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} ref={autoFocus ? firstField : undefined} className="input" disabled={!editable} value={h[k]} onChange={(e) => setH({ ...h, [k]: e.target.value })} />
    </div>
  );

  return (
    <Modal open wide title={jev ? `JEV ${jev.jevNumber ?? '(number assigned on posting)'}` : `New entry — ${def.label}`} onClose={onClose} footer={footer}>
      {loading || !coa ? <Spinner /> : (
        <>
          {jev && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <StatusChip status={jev.status} />
              {jev.entryType !== 'REGULAR' && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">{jev.entryType.toLowerCase()}</span>}
              {jev.sourceModule !== 'MANUAL' && <span className="text-slate-700">Source: <strong>{JEV_SOURCE_LABELS[jev.sourceModule] ?? jev.sourceModule}</strong></span>}
              {jev.returnInfo && jev.status === 'RETURNED' && <span className="text-orange-800">Returned: {jev.returnInfo.reasonForReturn}</span>}
              <span className="ml-auto"><PrintLink code="JEV" documentId={jev.id} fiscalYear={jev.fiscalYear} label="Print JEV" className="btn-ghost btn-sm" /></span>
            </div>
          )}
          <fieldset className="mb-3" disabled={!editable || !!jev}>
            <legend className="label">Transaction type</legend>
            <div className="flex flex-wrap gap-1.5" role="radiogroup">
              {TRANSACTION_TYPES.map((t) => (
                <button
                  key={t.code}
                  type="button"
                  role="radio"
                  aria-checked={h.transactionType === t.code}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${h.transactionType === t.code ? 'border-navy-700 bg-navy-800 text-white' : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'} disabled:cursor-not-allowed disabled:opacity-70`}
                  onClick={() => setH({ ...h, transactionType: t.code, entryType: t.code === 'OPENING' ? 'OPENING' : h.entryType === 'OPENING' ? 'REGULAR' : h.entryType })}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div><label className="label required" htmlFor="jd">Date</label><input id="jd" type="date" className="input" disabled={!editable} value={h.jevDate} onChange={(e) => setH({ ...h, jevDate: e.target.value })} /></div>
            {ref('primaryReference', def.primaryLabel, 'pr', true)}
            {ref('secondaryReference', def.secondaryLabel, 'sr')}
            {h.transactionType === 'OTHERS' ? (
              <div>
                <label className="label" htmlFor="et">Entry type</label>
                <select id="et" className="input" disabled={!editable || systemEntry} value={h.entryType} onChange={(e) => setH({ ...h, entryType: e.target.value as ManualEntryType })}>
                  {ENTRY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
            ) : (
              ref('tertiaryReference', def.tertiaryLabel, 'tr')
            )}
            <div className="sm:col-span-2 lg:col-span-1"><label className="label" htmlFor="nm">Name (payee / payor)</label><input id="nm" className="input" disabled={!editable} value={h.payeeName} onChange={(e) => setH({ ...h, payeeName: e.target.value })} /></div>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="label required" htmlFor="pt">Particulars</label>
              <input id="pt" className="input" required minLength={3} disabled={!editable} placeholder={def.particularsHint} value={h.particulars} onChange={(e) => setH({ ...h, particulars: e.target.value })} />
            </div>
          </div>
          {h.transactionType === 'OPENING' && <p className="field-hint mt-1">Opening balances post to period 00 of the date&apos;s fiscal year.</p>}
          <datalist id="coa-codes">{[...coa.values()].filter((a) => a.active).map((a) => <option key={a.accountCode} value={a.accountCode}>{a.accountName}</option>)}</datalist>
          <div className="mt-4 overflow-x-auto">
            <table className="table-base">
              <caption className="sr-only">Journal lines</caption>
              <thead><tr><th scope="col">Account</th><th scope="col">Subsidiary ledger</th><th scope="col">Line description</th><th scope="col" className="num">Debit</th><th scope="col" className="num">Credit</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
              <tbody ref={tableRef} className="divide-y divide-slate-100">
                {rows.map((r, i) => {
                  const acct = coa.get(r.accountCode.trim());
                  const err = lineErrors[i]!;
                  const options = sls.filter((s) => s.accountCode === r.accountCode.trim() && (s.active || s.id === r.subsidiaryId));
                  const msg = (k: 'subsidiary' | 'debit' | 'credit', id: string) => (err[k] ? <p id={id} className="field-error">{err[k]}</p> : null);
                  return (
                    <tr key={i}>
                      <td className="min-w-[14rem]">
                        <input id={`jev-acct-${i}`} list="coa-codes" className="input font-mono" disabled={!editable} value={r.accountCode} placeholder={r.hint ?? '0-00-00-000'} onChange={(e) => set(i, 'accountCode', e.target.value)} aria-label={`Line ${i + 1} account`} aria-invalid={err.account ? true : undefined} aria-describedby={`jev-acct-${i}-m`} />
                        {err.account ? <p id={`jev-acct-${i}-m`} className="field-error">{err.account}</p> : <p id={`jev-acct-${i}-m`} className="mt-0.5 text-[11px] text-slate-600">{acct?.accountName ?? (r.hint && !r.accountCode ? r.hint : '')}</p>}
                      </td>
                      <td className="min-w-[11rem]">
                        <select className="input text-xs" disabled={!editable || (!options.length && !acct?.requiresSubsidiaryLedger)} value={r.subsidiaryId} onChange={(e) => set(i, 'subsidiaryId', e.target.value)} aria-label={`Line ${i + 1} subsidiary ledger`} aria-invalid={err.subsidiary ? true : undefined} aria-describedby={err.subsidiary ? `jev-sl-${i}-m` : undefined}>
                          <option value="">{options.length ? '— select —' : acct?.requiresSubsidiaryLedger ? 'Add a ledger in Setup' : '—'}</option>
                          {options.map((s) => <option key={s.id} value={s.id}>{s.subsidiaryCode} — {s.subsidiaryName}</option>)}
                        </select>
                        {msg('subsidiary', `jev-sl-${i}-m`)}
                      </td>
                      <td className="min-w-[10rem]"><input className="input" disabled={!editable} value={r.lineDescription} onChange={(e) => set(i, 'lineDescription', e.target.value)} aria-label={`Line ${i + 1} description`} /></td>
                      <td className="min-w-[8rem]">
                        <input className="input num" inputMode="decimal" placeholder="0.00" disabled={!editable} value={r.debit} onChange={(e) => set(i, 'debit', e.target.value)} aria-label={`Line ${i + 1} debit`} aria-invalid={err.debit ? true : undefined} aria-describedby={err.debit ? `jev-dr-${i}-m` : undefined} />
                        {msg('debit', `jev-dr-${i}-m`)}
                      </td>
                      <td className="min-w-[8rem]">
                        <input
                          className="input num"
                          inputMode="decimal"
                          placeholder="0.00"
                          disabled={!editable}
                          value={r.credit}
                          onChange={(e) => set(i, 'credit', e.target.value)}
                          onKeyDown={(e) => {
                            // Enter on the last credit adds a line (keyboard-only encoding).
                            if (e.key === 'Enter' && i === rows.length - 1 && editable) {
                              e.preventDefault();
                              focusLine.current = rows.length;
                              setRows([...rows, blank()]);
                            }
                          }}
                          aria-label={`Line ${i + 1} credit`}
                          aria-invalid={err.credit ? true : undefined}
                          aria-describedby={err.credit ? `jev-cr-${i}-m` : undefined}
                        />
                        {msg('credit', `jev-cr-${i}-m`)}
                      </td>
                      <td>{editable && rows.length > 2 && <button type="button" className="btn-ghost btn-icon text-slate-500 hover:text-red-700" onClick={() => { setTouched(true); setRows(rows.filter((_, j) => j !== i)); }} aria-label={`Remove line ${i + 1}`}><Icon name="trash" /></button>}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={3} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {editable && <button type="button" className="btn-ghost btn-sm" onClick={() => { focusLine.current = rows.length; setTouched(true); setRows([...rows, blank()]); }}><Icon name="plus" /> Add line</button>}
                      {editable && totals && !totals.balanced && <button type="button" className="btn-ghost btn-sm" onClick={balanceLast}>Put difference on last line</button>}
                      <span className="text-xs font-normal text-slate-600">Book: {book === 'JCT' ? 'Journal of Cash Transactions' : 'General Journal'}</span>
                    </div>
                  </td>
                  <td className="num px-3 py-2">{totals ? formatPesos(totals.totalDebit) : '—'}</td>
                  <td className="num px-3 py-2">{totals ? formatPesos(totals.totalCredit) : '—'}</td>
                  <td />
                </tr>
                <tr>
                  <td colSpan={6} className="px-3 pb-2 text-right text-xs" aria-live="polite">
                    {totals ? (
                      totals.balanced ? (
                        totals.totalDebit > 0 && <span className="inline-flex items-center gap-1 font-semibold text-emerald-800"><Icon name="check" className="h-3.5 w-3.5" /> Balanced</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-semibold text-red-700"><Icon name="alert" className="h-3.5 w-3.5" /> Out of balance by {formatPesos(totals.difference)}</span>
                      )
                    ) : (
                      <span className="font-semibold text-red-700">Fix invalid amounts</span>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          {editable && touched && problems.length > 0 && (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="flex items-center gap-1.5 font-semibold"><Icon name="alert" /> Before submitting</p>
              <ul className="mt-1 list-disc pl-6">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
        </>
      )}
      {confirm && jev && (
        <ConfirmDialog
          open
          busy={busy}
          danger={confirm !== 'post'}
          title={{ post: 'Post journal entry', return: 'Return for correction', reverse: 'Reverse posted entry' }[confirm]}
          message={{ post: 'Posting reviews and approves the entry, assigns the JEV number, freezes it and updates the ledgers. Corrections after posting need a reversing or adjusting entry.', return: 'The encoder receives the entry back with your reason.', reverse: 'A new REVERSING entry dated today is created and posted. The original stays in the books, marked REVERSED.' }[confirm]}
          requireReason={confirm !== 'post'}
          reason={reason}
          onReasonChange={setReason}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm === 'post') void run(() => api.postJournalEntry({ jevId: jev.id }), 'Posted.');
            if (confirm === 'return') void run(() => api.returnJournalEntry({ jevId: jev.id, remarks: reason }), 'Returned.');
            if (confirm === 'reverse') void run(() => api.reverseJournalEntry({ jevId: jev.id, reversalDate: manilaToday(), reason }), 'Reversed.');
          }}
        />
      )}
    </Modal>
  );
}
