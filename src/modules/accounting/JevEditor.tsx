import {
  computeJournalTotals,
  formatPesos,
  manilaToday,
  parsePesos,
  type Centavos,
  type JournalEntryDoc,
  type JournalLineDoc,
} from '@bfms/shared';
import { collection, doc, getDoc, getDocs, orderBy, query } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { ConfirmDialog, Modal, Spinner, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useChartOfAccounts } from '../../hooks/useChartOfAccounts';
import { db } from '../../services/firebase/app';
import { api, errorMessage } from '../../services/functions/api';

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
  const [h, setH] = useState({ jevDate: manilaToday(), journal: 'GJ' as 'JCT' | 'GJ', particulars: '', primaryReference: '', secondaryReference: '' });
  const [rows, setRows] = useState<Row[]>([blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'post' | 'return' | 'reverse'>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!jevId) return;
    void (async () => {
      const s = await getDoc(doc(db, 'journalEntries', jevId));
      if (!s.exists()) return;
      const j = { id: s.id, ...(s.data() as JournalEntryDoc) };
      setJev(j);
      setH({ jevDate: j.jevDate, journal: j.journal, particulars: j.particulars, primaryReference: j.primaryReference ?? '', secondaryReference: j.secondaryReference ?? '' });
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
      <button className="btn-secondary" onClick={onClose}>Close</button>
      {editable && can('jev.prepare', barangayId) && <button className="btn-secondary" disabled={busy || invalid} onClick={() => void save()}>Save draft</button>}
      {jev && editable && can('jev.prepare', barangayId) && <button className="btn-primary" disabled={busy || !totals?.balanced} onClick={() => void run(() => api.submitJournalEntry({ jevId: jev.id }), 'Submitted for review.')}>Submit for review</button>}
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
          {jev && <div className="mb-3 flex items-center gap-2 text-sm"><StatusChip status={jev.status} />{jev.returnInfo && jev.status === 'RETURNED' && <span className="text-orange-800">Returned: {jev.returnInfo.reasonForReturn}</span>}</div>}
          <div className="grid gap-3 sm:grid-cols-4">
            <div><label className="label" htmlFor="jd">JEV date</label><input id="jd" type="date" className="input" disabled={!editable} value={h.jevDate} onChange={(e) => setH({ ...h, jevDate: e.target.value })} /></div>
            <div><label className="label" htmlFor="jb">Book</label><select id="jb" className="input" disabled={!editable} value={h.journal} onChange={(e) => setH({ ...h, journal: e.target.value as 'JCT' | 'GJ' })}><option value="GJ">General Journal</option><option value="JCT">Journal of Cash Transactions</option></select></div>
            <div><label className="label" htmlFor="pr">Primary ref (check/OR)</label><input id="pr" className="input" disabled={!editable} value={h.primaryReference} onChange={(e) => setH({ ...h, primaryReference: e.target.value })} /></div>
            <div><label className="label" htmlFor="sr">Secondary ref (DV/RCD)</label><input id="sr" className="input" disabled={!editable} value={h.secondaryReference} onChange={(e) => setH({ ...h, secondaryReference: e.target.value })} /></div>
            <div className="sm:col-span-4"><label className="label" htmlFor="pt">Particulars</label><input id="pt" className="input" disabled={!editable} value={h.particulars} onChange={(e) => setH({ ...h, particulars: e.target.value })} /></div>
          </div>
          <datalist id="coa-codes">{[...coa.values()].filter((a) => a.active).map((a) => <option key={a.accountCode} value={a.accountCode}>{a.accountName}</option>)}</datalist>
          <div className="mt-4 overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Account</th><th>Subsidiary ID</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => {
                  const acct = coa.get(r.accountCode.trim());
                  return (
                    <tr key={i}>
                      <td className="min-w-[14rem]">
                        <input list="coa-codes" className="input font-mono" disabled={!editable} value={r.accountCode} onChange={(e) => set(i, 'accountCode', e.target.value)} aria-label={`Line ${i + 1} account`} />
                        <div className={`mt-0.5 text-[11px] ${acct ? 'text-slate-500' : 'text-red-600'}`}>{r.accountCode ? acct?.accountName ?? 'Unknown account' : ''}</div>
                      </td>
                      <td><input className="input font-mono text-xs" disabled={!editable} value={r.subsidiaryId} placeholder={acct?.requiresSubsidiaryLedger ? 'required' : ''} onChange={(e) => set(i, 'subsidiaryId', e.target.value)} aria-label={`Line ${i + 1} subsidiary`} /></td>
                      <td><input className="input" disabled={!editable} value={r.lineDescription} onChange={(e) => set(i, 'lineDescription', e.target.value)} aria-label={`Line ${i + 1} description`} /></td>
                      <td><input className={`input num ${parsed[i]!.debit === null ? 'border-red-500' : ''}`} inputMode="decimal" disabled={!editable} value={r.debit} onChange={(e) => set(i, 'debit', e.target.value)} aria-label={`Line ${i + 1} debit`} /></td>
                      <td><input className={`input num ${parsed[i]!.credit === null ? 'border-red-500' : ''}`} inputMode="decimal" disabled={!editable} value={r.credit} onChange={(e) => set(i, 'credit', e.target.value)} aria-label={`Line ${i + 1} credit`} /></td>
                      <td>{editable && rows.length > 2 && <button className="btn-ghost px-2" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>✕</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={3} className="px-3 py-2">{editable && <button className="btn-ghost px-2 py-1" onClick={() => setRows([...rows, blank()])}>+ Add line</button>}</td>
                  <td className="num px-3 py-2">{totals ? formatPesos(totals.totalDebit) : '—'}</td>
                  <td className="num px-3 py-2">{totals ? formatPesos(totals.totalCredit) : '—'}</td>
                  <td />
                </tr>
                <tr><td colSpan={6} className={`px-3 pb-2 text-right text-xs ${totals?.balanced ? 'text-emerald-700' : 'text-red-700'}`}>{totals ? (totals.balanced ? (totals.totalDebit > 0 ? 'Balanced' : '') : `Out of balance by ${formatPesos(totals.difference)}`) : 'Fix invalid amounts'}</td></tr>
              </tfoot>
            </table>
          </div>
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
