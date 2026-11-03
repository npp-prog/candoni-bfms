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
import type { BankTabProps } from './BankPage';

interface LineRow {
  lineId: string | null;
  date: string;
  checkNumber: string;
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

/**
 * Bank statement of the month (legacy 04.2 Checks Encashed): date, check no., debit (encashed /
 * charges), credit (deposits / credits) and the running balance from the beginning balance —
 * typed, or pasted from the bank's export or the legacy sheet.
 */
export function StatementsTab({ period, onChanged }: BankTabProps) {
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
      setLines(stmt.lines.map((l) => ({ lineId: l.lineId, date: l.date, checkNumber: l.checkNumber ?? '', reference: l.reference, description: l.description, debit: l.debit, credit: l.credit })));
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
  const lineErrors = lines.map((l) => (!l.date.startsWith(key) ? `Date must be in ${key}` : (l.debit ?? 0) > 0 === (l.credit ?? 0) > 0 ? 'Enter a debit or a credit' : l.checkNumber && (l.credit ?? 0) > 0 ? 'A check no. goes with a debit' : null));
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
        lines: lines.map((l) => ({ lineId: l.lineId, date: l.date, checkNumber: l.checkNumber.trim() || null, reference: l.reference || l.checkNumber.trim(), description: l.description, debit: l.debit ?? 0, credit: l.credit ?? 0 })),
      });
      notify(r.balanced ? 'Statement saved.' : `Saved, but the lines add up to ${formatPesos(r.computedEndingBalance as Centavos)} — not the ending balance.`, r.balanced ? 'success' : 'error');
      setDirty(false);
      setLoadedAt(null);
      onChanged();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  function importLines(parsed: PasteResult, mode: 'replace' | 'append') {
    const inMonth = parsed.lines.filter((l) => l.date.startsWith(key));
    const rows = inMonth.map((l) => ({ lineId: null, date: l.date, checkNumber: l.checkNumber ?? '', reference: l.checkNumber ? '' : l.reference, description: l.description, debit: l.debit, credit: l.credit }));
    setLines(mode === 'replace' ? rows : [...lines, ...rows]);
    // A whole-year legacy sheet: the month's beginning balance is the running balance before its first line.
    const before = parsed.lines.filter((l) => l.date < `${key}-01`);
    if (mode === 'replace' && parsed.beginningBalance !== undefined) {
      const begin = before.reduce((t, l) => t + l.credit - l.debit, parsed.beginningBalance as number);
      const end = rows.reduce((t, l) => t + (l.credit ?? 0) - (l.debit ?? 0), begin);
      setF((x) => ({ ...x, beginningBalance: begin, endingBalance: end }));
    }
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
          <Field label="Beginning balance" required hint={prev ? `Last month's ending: ${formatPesos(prev.endingBalance)}` : undefined} error={prev && stmt && prev.endingBalance !== f.beginningBalance ? 'Differs from last month\'s ending balance' : null}>{(p) => (editable ? <SignedMoney id={p.id} value={f.beginningBalance} onChange={(v) => edit('beginningBalance', v)} /> : <p className="input num"><Money value={f.beginningBalance} dashZero={false} /></p>)}</Field>
          <Field label="Ending balance per bank" required error={lines.length && computed !== f.endingBalance ? `Lines add up to ${formatPesos(computed as Centavos)}` : null}>{(p) => (editable ? <SignedMoney id={p.id} value={f.endingBalance} onChange={(v) => edit('endingBalance', v)} /> : <p className="input num"><Money value={f.endingBalance} dashZero={false} /></p>)}</Field>
        </div>
        {locked && <p className="mx-4 mb-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">The reconciliation for this month is {recon?.status.replace('_', ' ')}; the statement is read-only.</p>}
        <div className="border-t border-slate-200">
          <div className="flex flex-wrap items-center gap-2 px-4 py-2">
            <h3 className="text-sm font-semibold text-slate-800">Lines ({lines.length})</h3>
            {editable && <button type="button" className="btn-secondary btn-sm ml-auto" onClick={() => setPaste(true)}><Icon name="file" /> Paste from bank export / legacy sheet…</button>}
          </div>
          <LinesEditor<LineRow>
            caption={`Bank statement lines for ${key}`}
            rows={lines}
            min={0}
            max={1000}
            disabled={!editable}
            addLabel="Add line"
            onChange={(r) => { setLines(r); setDirty(true); }}
            blank={() => ({ lineId: null, date: lines.at(-1)?.date ?? `${key}-01`, checkNumber: '', reference: '', description: '', debit: 0 as Centavos, credit: 0 as Centavos })}
            columns={[
              { label: 'Date', required: true, render: (r, set, i) => <input type="date" aria-label={`Line ${i + 1} date`} aria-invalid={lineErrors[i]?.startsWith('Date') ? true : undefined} className="input w-36" disabled={!editable} value={r.date} onChange={(e) => set({ date: e.target.value })} /> },
              { label: 'Check no.', render: (r, set, i) => <input aria-label={`Line ${i + 1} check number`} className="input w-28 font-mono" disabled={!editable} value={r.checkNumber} onChange={(e) => set({ checkNumber: e.target.value })} /> },
              { label: 'Reference', render: (r, set, i) => <input aria-label={`Line ${i + 1} reference`} className="input w-28 font-mono" disabled={!editable} value={r.reference} onChange={(e) => set({ reference: e.target.value })} /> },
              { label: 'Description', render: (r, set, i) => <input aria-label={`Line ${i + 1} description`} className="input min-w-[10rem]" disabled={!editable} value={r.description} onChange={(e) => set({ description: e.target.value })} /> },
              { label: 'Debit (encashed / charges)', numeric: true, render: (r, set, i) => <MoneyInput aria-label={`Line ${i + 1} debit`} className="w-32" disabled={!editable} value={r.debit} onChange={(v) => set({ debit: v })} /> },
              { label: 'Credit (deposits)', numeric: true, render: (r, set, i) => <MoneyInput aria-label={`Line ${i + 1} credit`} className="w-32" disabled={!editable} value={r.credit} onChange={(v) => set({ credit: v })} /> },
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
  const inMonth = parsed?.lines.filter((l) => l.date.startsWith(monthKey)) ?? [];
  const outside = (parsed?.lines.length ?? 0) - inMonth.length;
  return (
    <Modal
      open
      wide
      title="Paste statement lines"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          {hasLines && <button type="button" className="btn-secondary" disabled={!inMonth.length} onClick={() => parsed && onImport(parsed, 'append')}>Append {inMonth.length} lines</button>}
          <button type="button" className="btn-primary" disabled={!inMonth.length} onClick={() => parsed && onImport(parsed, 'replace')}>{hasLines ? 'Replace with' : 'Import'} {inMonth.length} lines</button>
        </>
      }
    >
      <p className="mb-2 text-sm text-slate-700">
        Copy the rows from the bank statement (Excel, CSV or the online-banking table) and paste them below. Two layouts are recognised:
      </p>
      <ul className="mb-2 list-disc pl-5 text-sm text-slate-700">
        <li>Bank export: <strong>date, reference / check no., description, debit, credit</strong> (a balance column is ignored; a header row may reorder the columns).</li>
        <li>Legacy <em>Checks Encashed</em> sheet: <strong>date, check no., debit amount, credit amount, balance</strong>. A whole-year sheet may be pasted: only {monthKey} lines are imported and the "Balance" row sets the beginning balance.</li>
      </ul>
      <label className="label" htmlFor="paste-area">Statement rows</label>
      <textarea id="paste-area" className="input font-mono text-xs" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'03/06/2026\t1762250\t1,500.00\t\n03/31/2026\t\t\t20,000.00'} />
      {parsed && (
        <div className="mt-3 space-y-2 text-sm" aria-live="polite">
          <p>
            <strong>{inMonth.length}</strong> line(s) for {monthKey}{parsed.legacyLayout ? ' (legacy Checks Encashed layout)' : ''} · debits {formatPesos(inMonth.reduce((t, l) => t + l.debit, 0) as Centavos)} · credits {formatPesos(inMonth.reduce((t, l) => t + l.credit, 0) as Centavos)}
            {parsed.beginningBalance !== undefined && <> · balance row {formatPesos(parsed.beginningBalance)}</>}
          </p>
          {outside > 0 && <p className="text-amber-800">{outside} line(s) dated outside {monthKey} will be skipped.</p>}
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
