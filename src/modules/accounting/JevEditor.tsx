import {
  JEV_SOURCE_LABELS,
  computeJournalTotals,
  formatPesos,
  manilaToday,
  parsePesos,
  type Centavos,
  type JournalEntryDoc,
  type JournalLineDoc,
} from '@bfms/shared';
import { collection, doc, getDoc, getDocs, orderBy, query } from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import { PrintLink } from '../../components/source';
import { ConfirmDialog, Icon, Modal, Spinner, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useChartOfAccounts } from '../../hooks/useChartOfAccounts';
import { db } from '../../services/firebase/app';
import { api, errorMessage } from '../../services/functions/api';

/** Entry types a preparer may choose (REVERSING/CLOSING are created by the system). */
const ENTRY_TYPES = [
  { value: 'REGULAR', label: 'Regular' },
  { value: 'ADJUSTING', label: 'Adjusting' },
  { value: 'CORRECTING', label: 'Correcting' },
  { value: 'OPENING', label: 'Opening balances (period 00)' },
] as const;
type ManualEntryType = (typeof ENTRY_TYPES)[number]['value'];
const isManualType = (t: string): t is ManualEntryType => ENTRY_TYPES.some((x) => x.value === t);

interface Row { accountCode: string; subsidiaryId: string; debit: string; credit: string; lineDescription: string }
const blank = (): Row => ({ accountCode: '', subsidiaryId: '', debit: '', credit: '', lineDescription: '' });

function safeParse(v: string): Centavos | null {
  try {
    return parsePesos(v);
  } catch {
    return null;
  }
}

/**
 * JEV editor. Totals shown here are a PREVIEW computed with the same shared function the server
 * uses; the server recomputes and enforces debit = credit on submit and on posting.
 */
export function JevEditor({ jevId, onClose }: { jevId: string | null; onClose(): void }) {
  const { can, user } = useAuth();
  const { barangayId } = useBarangay();
  const { notify } = useToast();
  const coa = useChartOfAccounts();
  const [loading, setLoading] = useState(!!jevId);
  const [jev, setJev] = useState<(JournalEntryDoc & { id: string }) | null>(null);
  const [h, setH] = useState({ jevDate: manilaToday(), journal: 'GJ' as 'JCT' | 'GJ', entryType: 'REGULAR' as ManualEntryType, particulars: '', primaryReference: '', secondaryReference: '' });
  const [rows, setRows] = useState<Row[]>([blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'post' | 'return' | 'reverse'>(null);
  const [reason, setReason] = useState('');
  const focusLine = useRef<number | null>(null);
  const tableRef = useRef<HTMLTableSectionElement>(null);

  // After "Add line", move focus to the new line's account field.
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
      const j = { id: s.id, ...(s.data() as JournalEntryDoc) };
      setJev(j);
      setH({ jevDate: j.jevDate, journal: j.journal, entryType: isManualType(j.entryType) ? j.entryType : 'REGULAR', particulars: j.particulars, primaryReference: j.primaryReference ?? '', secondaryReference: j.secondaryReference ?? '' });
      const ls = await getDocs(query(collection(db, 'journalEntries', jevId, 'lines'), orderBy('lineNo')));
      setRows(ls.docs.map((d) => {
        const l = d.data() as JournalLineDoc;
        return { accountCode: l.accountCode, subsidiaryId: l.subsidiaryId ?? '', debit: l.debit ? formatPesos(l.debit, { parens: false }) : '', credit: l.credit ? formatPesos(l.credit, { parens: false }) : '', lineDescription: l.lineDescription };
      }));
      setLoading(false);
    })();
  }, [jevId]);

  if (!barangayId) return null;
  const editable = !jev || jev.status === 'DRAFT' || jev.status === 'RETURNED';
  const parsed = rows.map((r) => ({ debit: safeParse(r.debit || '0'), credit: safeParse(r.credit || '0') }));
  const invalid = parsed.some((p) => p.debit === null || p.credit === null);
  const totals = invalid ? null : computeJournalTotals(parsed as Array<{ debit: Centavos; credit: Centavos }>);

  // Per-line problems, shown inline and summarised above the footer. The server re-validates everything.
  const lineErrors = rows.map((r, i) => {
    const acct = coa?.get(r.accountCode.trim());
    const d = parsed[i]!.debit;
    const c = parsed[i]!.credit;
    return {
      account: r.accountCode.trim() && coa && !acct ? 'Unknown account code' : acct && !acct.active ? 'Account is inactive' : null,
      subsidiary: acct?.requiresSubsidiaryLedger && !r.subsidiaryId.trim() ? 'Required for this account' : null,
      debit: d === null ? 'Enter an amount like 1,234.56' : d < 0 ? 'Cannot be negative' : null,
      credit: c === null ? 'Enter an amount like 1,234.56' : c < 0 ? 'Cannot be negative' : d !== null && d > 0 && c > 0 ? 'Use either debit or credit, not both' : null,
      // Mirrors validateJournalBalance: every line needs an account and exactly one non-zero side.
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

  async function run<T>(fn: () => Promise<T>, ok: string) {
    setBusy(true);
    try {
      await fn();
      notify(ok, 'success');
      onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  const save = () =>
    run(
      () =>
        api.saveJournalDraft({
          jevId: jev?.id,
          barangayId,
          jevDate: h.jevDate,
          fundId: 'GF',
          journal: h.journal,
          // System entry types (REVERSING/CLOSING) are never re-sent; the server defaults to REGULAR.
          ...(jev && !isManualType(jev.entryType) ? {} : { entryType: h.entryType }),
          particulars: h.particulars,
          primaryReference: h.primaryReference || null,
          secondaryReference: h.secondaryReference || null,
          lines: rows.map((r, i) => ({
            accountCode: r.accountCode.trim(),
            subsidiaryId: r.subsidiaryId.trim() || null,
            debit: parsed[i]!.debit ?? (0 as Centavos),
            credit: parsed[i]!.credit ?? (0 as Centavos),
            lineDescription: r.lineDescription,
          })),
        }),
      'Draft saved.',
    );

  const set = (i: number, k: keyof Row, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const footer = (
    <>
      {editable && problems.length > 0 && jev && can('jev.prepare', barangayId) && <span className="mr-auto self-center text-xs text-slate-600">Fix the items above to submit.</span>}
      <button className="btn-secondary" onClick={onClose}>Close</button>
      {editable && can('jev.prepare', barangayId) && <button className="btn-secondary" disabled={busy || invalid || !!particularsError} title={particularsError ? 'Particulars need at least 3 characters' : undefined} onClick={() => void save()}>Save draft</button>}
      {jev && editable && can('jev.prepare', barangayId) && <button className="btn-primary" disabled={busy || problems.length > 0} onClick={() => void run(() => api.submitJournalEntry({ jevId: jev.id }), 'Submitted for review.')}>Submit for review</button>}
      {jev?.status === 'FOR_REVIEW' && can('jev.review', barangayId) && <button className="btn-secondary" onClick={() => setConfirm('return')}>Return</button>}
      {jev?.status === 'FOR_REVIEW' && can('jev.approve', barangayId) && <button className="btn-primary" disabled={busy || jev.createdBy === user?.uid} title={jev.createdBy === user?.uid ? 'The preparer cannot approve their own entry' : ''} onClick={() => void run(() => api.approveJournalEntry({ jevId: jev.id }), 'Approved.')}>Approve</button>}
      {jev?.status === 'APPROVED' && can('jev.post', barangayId) && <button className="btn-primary" disabled={busy} onClick={() => setConfirm('post')}>Post</button>}
      {jev?.status === 'POSTED' && can('jev.reverse', barangayId) && <button className="btn-danger" disabled={busy} onClick={() => setConfirm('reverse')}>Reverse…</button>}
    </>
  );

  return (
    <Modal open wide title={jev ? `JEV ${jev.jevNumber ?? '(number assigned on posting)'}` : 'New Journal Entry Voucher'} onClose={onClose} footer={footer}>
      {loading || !coa ? <Spinner /> : (
        <>
          {jev && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <StatusChip status={jev.status} />
              {jev.entryType !== 'REGULAR' && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">{jev.entryType.toLowerCase()}</span>}
              {jev.sourceModule !== 'MANUAL' && (
                <span className="text-slate-700">
                  Generated from <strong>{JEV_SOURCE_LABELS[jev.sourceModule] ?? jev.sourceModule}</strong>
                  {(jev.secondaryReference || jev.primaryReference) && <> {jev.secondaryReference ?? jev.primaryReference}</>}
                </span>
              )}
              {jev.returnInfo && jev.status === 'RETURNED' && <span className="text-orange-800">Returned: {jev.returnInfo.reasonForReturn}</span>}
              <span className="ml-auto"><PrintLink code="JEV" documentId={jev.id} fiscalYear={jev.fiscalYear} label="Print JEV" className="btn-ghost btn-sm" /></span>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div><label className="label required" htmlFor="jd">JEV date</label><input id="jd" type="date" className="input" disabled={!editable} value={h.jevDate} onChange={(e) => setH({ ...h, jevDate: e.target.value })} /></div>
            <div><label className="label" htmlFor="jb">Book</label><select id="jb" className="input" disabled={!editable} value={h.journal} onChange={(e) => setH({ ...h, journal: e.target.value as 'JCT' | 'GJ' })}><option value="GJ">General Journal</option><option value="JCT">Journal of Cash Transactions</option></select></div>
            <div>
              <label className="label" htmlFor="et">Entry type</label>
              <select id="et" className="input" disabled={!editable || (!!jev && !isManualType(jev.entryType))} value={h.entryType} onChange={(e) => setH({ ...h, entryType: e.target.value as ManualEntryType })} aria-describedby={h.entryType === 'OPENING' ? 'et-hint' : undefined}>
                {ENTRY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              {h.entryType === 'OPENING' && <p id="et-hint" className="field-hint">Posts to period 00 of the date&apos;s fiscal year (beginning balances).</p>}
            </div>
            <div><label className="label" htmlFor="pr">Primary ref (check/OR)</label><input id="pr" className="input" disabled={!editable} value={h.primaryReference} onChange={(e) => setH({ ...h, primaryReference: e.target.value })} /></div>
            <div><label className="label" htmlFor="sr">Secondary ref (DV/RCD)</label><input id="sr" className="input" disabled={!editable} value={h.secondaryReference} onChange={(e) => setH({ ...h, secondaryReference: e.target.value })} /></div>
            <div className="sm:col-span-2 lg:col-span-5"><label className="label required" htmlFor="pt">Particulars</label><input id="pt" className="input" required minLength={3} disabled={!editable} value={h.particulars} onChange={(e) => setH({ ...h, particulars: e.target.value })} aria-describedby="pt-hint" /><p id="pt-hint" className="field-hint">Describe the transaction; at least 3 characters.</p></div>
          </div>
          <datalist id="coa-codes">{[...coa.values()].filter((a) => a.active).map((a) => <option key={a.accountCode} value={a.accountCode}>{a.accountName}</option>)}</datalist>
          <div className="mt-4 overflow-x-auto">
            <table className="table-base">
              <caption className="sr-only">Journal lines</caption>
              <thead><tr><th scope="col">Account</th><th scope="col">Subsidiary ID</th><th scope="col">Description</th><th scope="col" className="num">Debit</th><th scope="col" className="num">Credit</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
              <tbody ref={tableRef} className="divide-y divide-slate-100">
                {rows.map((r, i) => {
                  const acct = coa.get(r.accountCode.trim());
                  const err = lineErrors[i]!;
                  const msg = (k: 'subsidiary' | 'debit' | 'credit', id: string) => (err[k] ? <p id={id} className="field-error">{err[k]}</p> : null);
                  return (
                    <tr key={i}>
                      <td className="min-w-[14rem]">
                        <input id={`jev-acct-${i}`} list="coa-codes" className="input font-mono" disabled={!editable} value={r.accountCode} onChange={(e) => set(i, 'accountCode', e.target.value)} aria-label={`Line ${i + 1} account`} aria-invalid={err.account ? true : undefined} aria-describedby={`jev-acct-${i}-m`} />
                        {err.account ? <p id={`jev-acct-${i}-m`} className="field-error">{err.account}</p> : <p id={`jev-acct-${i}-m`} className="mt-0.5 text-[11px] text-slate-600">{acct?.accountName ?? ''}</p>}
                      </td>
                      <td className="min-w-[8rem]">
                        <input className="input font-mono text-xs" disabled={!editable} value={r.subsidiaryId} placeholder={acct?.requiresSubsidiaryLedger ? 'Required' : 'Optional'} onChange={(e) => set(i, 'subsidiaryId', e.target.value)} aria-label={`Line ${i + 1} subsidiary`} aria-invalid={err.subsidiary ? true : undefined} aria-describedby={err.subsidiary ? `jev-sl-${i}-m` : undefined} />
                        {msg('subsidiary', `jev-sl-${i}-m`)}
                      </td>
                      <td className="min-w-[12rem]"><input className="input" disabled={!editable} value={r.lineDescription} onChange={(e) => set(i, 'lineDescription', e.target.value)} aria-label={`Line ${i + 1} description`} /></td>
                      <td className="min-w-[8rem]">
                        <input className="input num" inputMode="decimal" placeholder="0.00" disabled={!editable} value={r.debit} onChange={(e) => set(i, 'debit', e.target.value)} aria-label={`Line ${i + 1} debit`} aria-invalid={err.debit ? true : undefined} aria-describedby={err.debit ? `jev-dr-${i}-m` : undefined} />
                        {msg('debit', `jev-dr-${i}-m`)}
                      </td>
                      <td className="min-w-[8rem]">
                        <input className="input num" inputMode="decimal" placeholder="0.00" disabled={!editable} value={r.credit} onChange={(e) => set(i, 'credit', e.target.value)} aria-label={`Line ${i + 1} credit`} aria-invalid={err.credit ? true : undefined} aria-describedby={err.credit ? `jev-cr-${i}-m` : undefined} />
                        {msg('credit', `jev-cr-${i}-m`)}
                      </td>
                      <td>{editable && rows.length > 2 && <button type="button" className="btn-ghost btn-icon text-slate-500 hover:text-red-700" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}><Icon name="trash" /></button>}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={3} className="px-3 py-2">{editable && <button type="button" className="btn-ghost btn-sm" onClick={() => { focusLine.current = rows.length; setRows([...rows, blank()]); }}><Icon name="plus" /> Add line</button>}</td>
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
          {editable && jev && problems.length > 0 && (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="flex items-center gap-1.5 font-semibold"><Icon name="alert" /> Before submitting for review</p>
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
          message={{ post: 'Posting assigns the official JEV number, freezes the entry, and updates the ledgers. After posting, the entry can only be corrected with a reversing, correcting or adjusting entry.', return: 'The preparer receives the entry back with your reason.', reverse: 'A new REVERSING entry dated today is created and posted. The original stays in the books, marked REVERSED.' }[confirm]}
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
