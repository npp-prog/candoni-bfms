import {
  bankPeriodDocId,
  formatPesos,
  lastDayOfMonth,
  parseStatementPaste,
  periodKey,
  type BankReconciliationRecord,
  type BankStatementRecord,
  type Centavos,
  type PasteResult,
} from '@bfms/shared';
import { useEffect, useState } from 'react';
import { LinesEditor, MoneyInput } from '../../components/forms';
import { Field, Icon, Modal, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useDocument } from '../../hooks/useDocument';
import { errorMessage } from '../../services/functions/api';
import { bankApi } from './api';
import type { BankPeriod } from './BankPage';

interface LineRow {
  lineId: string | null;
  date: string;
  reference: string;
  description: string;
  debit: Centavos | null;
  credit: Centavos | null;
}

/** Signed peso input for balances (an overdrawn account has a negative balance). */
function SignedMoney({ value, onChange, id }: { value: number; onChange(v: number): void; id?: string }) {
  const [neg, setNeg] = useState(value < 0);
  useEffect(() => {
    if (value !== 0) setNeg(value < 0);
  }, [value]);
  return (
    <div className="flex gap-1">
      <MoneyInput id={id} value={Math.abs(value)} onChange={(v) => onChange((v ?? 0) * (neg ? -1 : 1))} />
      <button type="button" className={`btn-secondary btn-sm ${neg ? 'text-red-700' : ''}`} aria-pressed={neg} title="Overdrawn (negative balance)" onClick={() => { setNeg(!neg); onChange(-value); }}>±</button>
    </div>
  );
}

/** Bank statement of the month: header balances and lines, typed or pasted from the bank's export. */
export function StatementsTab({ period, onCreated }: { period: BankPeriod; onCreated(): void }) {
  const { can } = useAuth();
  const { notify } = useToast();
  const { bank, month, fiscalYear } = period;
  const id = bankPeriodDocId(bank.barangayId, bank.id, fiscalYear, month);
  const prevId = month > 1 ? bankPeriodDocId(bank.barangayId, bank.id, fiscalYear, month - 1) : bankPeriodDocId(bank.barangayId, bank.id, fiscalYear - 1, 12);
  const { data: stmt, loading } = useDocument<BankStatementRecord>('bankStatements', id);
  const { data: prev } = useDocument<BankStatementRecord>('bankStatements', prevId);
  const { data: recon } = useDocument<BankReconciliationRecord>('bankReconciliations', id);
  const [f, setF] = useState({ statementDate: lastDayOfMonth(fiscalYear, month), beginningBalance: 0, endingBalance: 0 });
  const [lines, setLines] = useState<LineRow[]>([]);
  const [source, setSource] = useState<'MANUAL' | 'IMPORT'>('MANUAL');
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [paste, setPaste] = useState(false);
  const [busy, setBusy] = useState(false);

  // Load the stored statement (or carry the previous month's ending balance forward) until edited.
  useEffect(() => {
    if (loading || dirty) return;
    const stamp = stmt ? String(stmt.updatedAt?.seconds ?? 'x') : `new-${prev?.endingBalance ?? 0}`;
    if (stamp === loadedAt) return;
    setLoadedAt(stamp);
    if (stmt) {
      setF({ statementDate: stmt.statementDate, beginningBalance: stmt.beginningBalance, endingBalance: stmt.endingBalance });
      setLines(stmt.lines.map((l) => ({ lineId: l.lineId, date: l.date, reference: l.reference, description: l.description, debit: l.debit, credit: l.credit })));
      setSource(stmt.source);
    } else {
      setF((x) => ({ ...x, beginningBalance: prev?.endingBalance ?? 0, endingBalance: prev?.endingBalance ?? 0 }));
      setLines([]);
    }
  }, [loading, dirty, stmt, prev, loadedAt]);

  const locked = recon?.status === 'FINAL' || recon?.status === 'FOR_REVIEW';
  const editable = can('recon.prepare', bank.barangayId) && !locked;
  const edit = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF({ ...f, [k]: v }); setDirty(true); };
  const debits = lines.reduce((t, l) => t + (l.debit ?? 0), 0);
  const credits = lines.reduce((t, l) => t + (l.credit ?? 0), 0);
  const computed = f.beginningBalance + credits - debits;
  const key = periodKey(fiscalYear, month);
  const lineErrors = lines.map((l) => (!l.date.startsWith(key) ? `Date must be in ${key}` : (l.debit ?? 0) > 0 === (l.credit ?? 0) > 0 ? 'Enter a debit or a credit' : null));
  const valid = lineErrors.every((e) => !e) && lines.every((l) => l.debit !== null && l.credit !== null);

  async function save() {
    setBusy(true);
    try {
      const r = await bankApi.saveBankStatement({
        barangayId: bank.barangayId,
        bankAccountId: bank.id,
        fiscalYear,
        month,
        statementDate: f.statementDate,
        beginningBalance: f.beginningBalance,
        endingBalance: f.endingBalance,
        source,
        lines: lines.map((l) => ({ lineId: l.lineId, date: l.date, reference: l.reference, description: l.description, debit: l.debit ?? 0, credit: l.credit ?? 0 })),
      });
      notify(r.balanced ? 'Statement saved.' : `Saved, but the lines add up to ${formatPesos(r.computedEndingBalance as Centavos)} — not the ending balance.`, r.balanced ? 'success' : 'error');
      setDirty(false);
      setLoadedAt(null);
      if (!stmt) onCreated();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  function importLines(parsed: PasteResult, mode: 'replace' | 'append') {
    const rows = parsed.lines.map((l) => ({ lineId: null, date: l.date, reference: l.reference, description: l.description, debit: l.debit, credit: l.credit }));
    setLines(mode === 'replace' ? rows : [...lines, ...rows]);
    setSource('IMPORT');
    setDirty(true);
    setPaste(false);
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Bank statement — {bank.bankName} {bank.accountNumber.slice(-4).padStart(8, '•')} · {key}</h2>
          <div className="flex items-center gap-2">
            {stmt && (
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${stmt.balanced ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-red-50 text-red-800 ring-red-200'}`}>
                <Icon name={stmt.balanced ? 'check' : 'alert'} className="h-3 w-3" /> {stmt.balanced ? 'Lines agree with ending balance' : 'Lines do not agree with ending balance'}
              </span>
            )}
            {recon && <StatusChip status={recon.status} />}
          </div>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <Field label="Statement date" required>{(p) => <input {...p} type="date" className="input" disabled={!editable} value={f.statementDate} onChange={(e) => edit('statementDate', e.target.value)} />}</Field>
          <Field label="Beginning balance" required hint={prev ? `Last month's ending: ${formatPesos(prev.endingBalance)}` : undefined}>{(p) => (editable ? <SignedMoney id={p.id} value={f.beginningBalance} onChange={(v) => edit('beginningBalance', v)} /> : <p className="input num"><Money value={f.beginningBalance} dashZero={false} /></p>)}</Field>
          <Field label="Ending balance per bank" required error={lines.length && computed !== f.endingBalance ? `Lines add up to ${formatPesos(computed as Centavos)}` : null}>{(p) => (editable ? <SignedMoney id={p.id} value={f.endingBalance} onChange={(v) => edit('endingBalance', v)} /> : <p className="input num"><Money value={f.endingBalance} dashZero={false} /></p>)}</Field>
        </div>
        {locked && <p className="mx-4 mb-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">The reconciliation for this month is {recon?.status.replace('_', ' ')}; the statement is read-only.</p>}
        <div className="border-t border-slate-200">
          <div className="flex flex-wrap items-center gap-2 px-4 py-2">
            <h3 className="text-sm font-semibold text-slate-800">Lines ({lines.length})</h3>
            {editable && <button type="button" className="btn-secondary btn-sm ml-auto" onClick={() => setPaste(true)}><Icon name="file" /> Paste from bank export…</button>}
          </div>
          <LinesEditor<LineRow>
            caption={`Bank statement lines for ${key}`}
            rows={lines}
            min={0}
            max={1000}
            disabled={!editable}
            addLabel="Add line"
            onChange={(r) => { setLines(r); setDirty(true); }}
            blank={() => ({ lineId: null, date: lines.at(-1)?.date ?? `${key}-01`, reference: '', description: '', debit: 0 as Centavos, credit: 0 as Centavos })}
            columns={[
              { label: 'Date', required: true, render: (r, set, i) => <input type="date" aria-label={`Line ${i + 1} date`} aria-invalid={lineErrors[i]?.startsWith('Date') ? true : undefined} className="input w-36" disabled={!editable} value={r.date} onChange={(e) => set({ date: e.target.value })} /> },
              { label: 'Reference / check no.', render: (r, set, i) => <input aria-label={`Line ${i + 1} reference`} className="input w-32 font-mono" disabled={!editable} value={r.reference} onChange={(e) => set({ reference: e.target.value })} /> },
              { label: 'Description', render: (r, set, i) => <input aria-label={`Line ${i + 1} description`} className="input min-w-[12rem]" disabled={!editable} value={r.description} onChange={(e) => set({ description: e.target.value })} /> },
              { label: 'Debit (withdrawal)', numeric: true, render: (r, set, i) => <MoneyInput aria-label={`Line ${i + 1} debit`} className="w-32" disabled={!editable} value={r.debit} onChange={(v) => set({ debit: v })} /> },
              { label: 'Credit (deposit)', numeric: true, render: (r, set, i) => <MoneyInput aria-label={`Line ${i + 1} credit`} className="w-32" disabled={!editable} value={r.credit} onChange={(v) => set({ credit: v })} /> },
              { label: 'Balance', numeric: true, render: (_r, _s, i) => <span className="block pt-2 text-right text-sm tabular-nums text-slate-600">{formatPesos((f.beginningBalance + lines.slice(0, i + 1).reduce((t, l) => t + (l.credit ?? 0) - (l.debit ?? 0), 0)) as Centavos)}</span> },
            ]}
            footer={
              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <div><dt className="inline text-slate-600">Debits </dt><dd className="inline font-semibold tabular-nums">{formatPesos(debits as Centavos)}</dd></div>
                <div><dt className="inline text-slate-600">Credits </dt><dd className="inline font-semibold tabular-nums">{formatPesos(credits as Centavos)}</dd></div>
                <div>
                  <dt className="inline text-slate-600">Computed ending </dt>
                  <dd className={`inline font-semibold tabular-nums ${computed === f.endingBalance ? 'text-emerald-700' : 'text-red-700'}`}>{formatPesos(computed as Centavos)} {computed === f.endingBalance ? '✓' : '≠ statement'}</dd>
                </div>
              </dl>
            }
          />
          {lineErrors.some(Boolean) && (
            <ul role="alert" className="mx-4 mb-3 list-disc pl-5 text-sm text-red-700">
              {lineErrors.map((e, i) => (e ? <li key={i}>Line {i + 1}: {e}.</li> : null))}
            </ul>
          )}
        </div>
        {editable && (
          <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
            {dirty && <span className="mr-auto self-center text-sm text-amber-800">Unsaved changes</span>}
            <button type="button" className="btn-primary" disabled={busy || !valid || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save statement'}</button>
          </div>
        )}
      </div>
      {paste && <PasteDialog fiscalYear={fiscalYear} monthKey={key} hasLines={lines.length > 0} onClose={() => setPaste(false)} onImport={importLines} />}
    </div>
  );
}

function PasteDialog({ fiscalYear, monthKey, hasLines, onClose, onImport }: { fiscalYear: number; monthKey: string; hasLines: boolean; onClose(): void; onImport(r: PasteResult, mode: 'replace' | 'append'): void }) {
  const [text, setText] = useState('');
  const parsed = text.trim() ? parseStatementPaste(text, fiscalYear) : null;
  const outside = parsed?.lines.filter((l) => !l.date.startsWith(monthKey)).length ?? 0;
  return (
    <Modal
      open
      wide
      title="Paste statement lines"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          {hasLines && <button type="button" className="btn-secondary" disabled={!parsed?.lines.length} onClick={() => parsed && onImport(parsed, 'append')}>Append {parsed?.lines.length ?? 0} lines</button>}
          <button type="button" className="btn-primary" disabled={!parsed?.lines.length} onClick={() => parsed && onImport(parsed, 'replace')}>{hasLines ? 'Replace' : 'Import'} {parsed?.lines.length ?? 0} lines</button>
        </>
      }
    >
      <p className="mb-2 text-sm text-slate-700">
        Copy the rows from the bank's statement (Excel, CSV or the online-banking table) and paste them below. Columns: <strong>date, reference / check no., description, debit, credit</strong> — a header row may name them in another order; a balance column is ignored.
      </p>
      <label className="label" htmlFor="paste-area">Statement rows</label>
      <textarea id="paste-area" className="input font-mono text-xs" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'03/06/2026\t1762250\tCHECK PAID\t1,500.00\t\n03/31/2026\t\tSERVICE CHARGE\t50.00\t'} />
      {parsed && (
        <div className="mt-3 space-y-2 text-sm" aria-live="polite">
          <p>
            <strong>{parsed.lines.length}</strong> line(s) recognised · debits {formatPesos(parsed.lines.reduce((t, l) => t + l.debit, 0) as Centavos)} · credits {formatPesos(parsed.lines.reduce((t, l) => t + l.credit, 0) as Centavos)}
          </p>
          {outside > 0 && <p className="text-amber-800">{outside} line(s) are dated outside {monthKey}; correct or remove them before saving.</p>}
          {parsed.errors.length > 0 && (
            <ul className="list-disc pl-5 text-red-700">
              {parsed.errors.slice(0, 8).map((e) => <li key={e.row}>Row {e.row}: {e.message}</li>)}
              {parsed.errors.length > 8 && <li>… and {parsed.errors.length - 8} more</li>}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
