import { bankPeriodDocId, formatPesos, type Centavos, type ReconItemRecord } from '@bfms/shared';
import { useEffect, useState } from 'react';
import { LinesEditor, MoneyInput } from '../../components/forms';
import { Field, Icon, Money, TableSkeleton } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { clientDataSource } from '../../services/datasource';
import { errorMessage } from '../../services/functions/api';
import { bankApi } from './api';
import type { BankTabProps } from './BankPage';

interface CheckRow { id: string; date: string; checkNumber: string; payeeName: string; dvNumber: string; amount: Centavos | null }
interface DepRow { id: string; date: string; reference: string; particulars: string; amount: Centavos | null }

const newId = () => `I${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Reconciliation set-up of the year: checks and deposits outstanding on January 1 (legacy
 * Schedule 1 "Prior Years"). They are inside the opening book balance and are carried on the
 * schedules until the bank clears them.
 */
export function OpeningTab({ period, rec, onChanged }: BankTabProps) {
  const { can } = useAuth();
  const { notify } = useToast();
  const { bank, fiscalYear } = period;
  const opening = rec.data?.opening ?? null;
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [deps, setDeps] = useState<DepRow[]>([]);
  const [bankBalance, setBankBalance] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!rec.data || dirty) return;
    const stamp = `${rec.data.period.bankAccountId}-${String(opening?.updatedAt?.seconds ?? 'none')}`;
    if (stamp === loadedFor) return;
    setLoadedFor(stamp);
    setChecks((opening?.outstandingChecks ?? []).map((c) => ({ ...c })));
    setDeps((opening?.depositsInTransit ?? []).map((d) => ({ ...d })));
    setBankBalance(opening?.bankBalance ?? null);
  }, [rec.data, opening, dirty, loadedFor]);

  if (!rec.data) return <TableSkeleton />;
  const statuses = rec.data.recon ? [rec.data.recon, ...rec.data.priorRecons].map((r) => r.status) : rec.data.priorRecons.map((r) => r.status);
  const locked = statuses.some((s) => s === 'FINAL' || s === 'FOR_REVIEW');
  const editable = can('recon.prepare', bank.barangayId) && !locked;
  const ocTotal = checks.reduce((t, c) => t + (c.amount ?? 0), 0);
  const ditTotal = deps.reduce((t, d) => t + (d.amount ?? 0), 0);
  const jan = rec.data.statements.find((s) => s.month === 1);
  const janBank = jan?.beginningBalance ?? bankBalance;
  const book = rec.data.openingBookBalance;
  const cleared = new Map((rec.run?.schedule1 ?? []).filter((s) => s.priorYear).map((s) => [s.key.slice(3), s]));
  const cutoff = `${fiscalYear}-01-01`;
  const errors = [
    ...checks.map((c, i) => (!c.checkNumber.trim() ? `Check line ${i + 1}: enter the check no.` : !(c.amount && c.amount > 0) ? `Check line ${i + 1}: enter the amount` : c.date >= cutoff ? `Check line ${i + 1}: date must be before ${cutoff}` : null)),
    ...deps.map((d, i) => (!(d.amount && d.amount > 0) ? `Deposit line ${i + 1}: enter the amount` : d.date >= cutoff ? `Deposit line ${i + 1}: date must be before ${cutoff}` : null)),
  ].filter(Boolean) as string[];

  async function copyFromDecember() {
    const id = bankPeriodDocId(bank.barangayId, bank.id, fiscalYear - 1, 12);
    try {
      const recon = await clientDataSource.get<{ status: string }>('bankReconciliations', id).catch(() => null);
      if (!recon) return notify(`There is no December ${fiscalYear - 1} reconciliation for this account.`, 'info');
      const items = await clientDataSource.listSub<ReconItemRecord>('bankReconciliations', id, 'items');
      setChecks(items.filter((i) => i.category === 'OUTSTANDING_CHECK').map((i) => ({ id: newId(), date: i.date, checkNumber: i.reference, payeeName: i.name, dvNumber: '', amount: i.amount })));
      setDeps(items.filter((i) => i.category === 'DEPOSIT_IN_TRANSIT').map((i) => ({ id: newId(), date: i.date, reference: i.reference, particulars: i.name, amount: i.amount })));
      setDirty(true);
      notify(`Copied from the December ${fiscalYear - 1} reconciliation (${recon.status}). Review and save.`, 'success');
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  }

  async function save() {
    setBusy(true);
    try {
      await bankApi.saveBankOpeningItems({
        barangayId: bank.barangayId,
        bankAccountId: bank.id,
        fiscalYear,
        bankBalance,
        outstandingChecks: checks.map((c) => ({ id: c.id, date: c.date, checkNumber: c.checkNumber.trim(), payeeName: c.payeeName.trim(), dvNumber: c.dvNumber.trim(), amount: (c.amount ?? 0) as Centavos })),
        depositsInTransit: deps.map((d) => ({ id: d.id, date: d.date, reference: d.reference.trim(), particulars: d.particulars.trim(), amount: (d.amount ?? 0) as Centavos })),
      });
      notify('Prior-year outstanding items saved.', 'success');
      setDirty(false);
      setLoadedFor(null);
      onChanged();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const proof = janBank === null || janBank === undefined ? null : janBank - book - (ocTotal - ditTotal);
  return (
    <div className="space-y-4">
      <section aria-labelledby="opening-head" className="card">
        <div className="card-header">
          <h2 id="opening-head" className="card-title">Outstanding as of January 1, {fiscalYear}</h2>
          {editable && <button type="button" className="btn-secondary btn-sm" onClick={() => void copyFromDecember()}><Icon name="calendar" /> Copy from December {fiscalYear - 1}</button>}
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <div><p className="label">Book balance, Jan 1 (opening entry)</p><p className="text-sm font-semibold tabular-nums"><Money value={book} dashZero={false} /></p></div>
          <Field label="Bank balance, Jan 1" hint={jan ? 'From the January statement' : 'Optional — for the cross-check'}>
            {(p) => (jan || !editable ? <p className="input num"><Money value={janBank ?? 0} dashZero={false} /></p> : <MoneyInput {...p} value={bankBalance} onChange={(v) => { setBankBalance(v); setDirty(true); }} />)}
          </Field>
          <div aria-live="polite">
            <p className="label">Proof: bank − book − (checks − deposits in transit)</p>
            <p className={`text-sm font-semibold tabular-nums ${proof === 0 ? 'text-emerald-700' : proof === null ? 'text-slate-600' : 'text-red-700'}`}>{proof === null ? 'Enter the bank balance' : `${formatPesos(proof as Centavos)}${proof === 0 ? ' ✓' : ''}`}</p>
          </div>
        </div>
        {locked && <p className="mx-4 mb-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">A reconciliation of FY {fiscalYear} has been submitted or finalized; the prior-year items are read-only.</p>}
      </section>

      <section aria-labelledby="opening-checks" className="card">
        <div className="card-header"><h2 id="opening-checks" className="card-title">Prior-year outstanding checks ({checks.length}) — {formatPesos(ocTotal as Centavos)}</h2></div>
        <LinesEditor<CheckRow>
          caption="Checks outstanding on January 1"
          rows={checks}
          min={0}
          max={500}
          disabled={!editable}
          addLabel="Add check"
          onChange={(r) => { setChecks(r); setDirty(true); }}
          blank={() => ({ id: newId(), date: `${fiscalYear - 1}-12-31`, checkNumber: '', payeeName: '', dvNumber: '', amount: null })}
          columns={[
            { label: 'Check date', required: true, render: (r, set, i) => <input type="date" aria-label={`Check ${i + 1} date`} className="input w-36" disabled={!editable} value={r.date} onChange={(e) => set({ date: e.target.value })} /> },
            { label: 'Check no.', required: true, render: (r, set, i) => <input aria-label={`Check ${i + 1} number`} className="input w-28 font-mono" disabled={!editable} value={r.checkNumber} onChange={(e) => set({ checkNumber: e.target.value })} /> },
            { label: 'Payee', render: (r, set, i) => <input aria-label={`Check ${i + 1} payee`} className="input min-w-[10rem]" disabled={!editable} value={r.payeeName} onChange={(e) => set({ payeeName: e.target.value })} /> },
            { label: 'DV no.', render: (r, set, i) => <input aria-label={`Check ${i + 1} DV number`} className="input w-28 font-mono" disabled={!editable} value={r.dvNumber} onChange={(e) => set({ dvNumber: e.target.value })} /> },
            { label: 'Amount', required: true, numeric: true, render: (r, set, i) => <MoneyInput aria-label={`Check ${i + 1} amount`} className="w-32" disabled={!editable} value={r.amount} onChange={(v) => set({ amount: v })} /> },
            { label: 'Status', render: (r) => { const s = cleared.get(r.id); return <span className="block pt-2 text-xs text-slate-700">{!s ? '—' : s.clearedDate ? `Encashed ${s.clearedDate}` : s.status === 'STALE' ? 'Stale' : 'Outstanding'}</span>; } },
          ]}
        />
      </section>

      <section aria-labelledby="opening-dit" className="card">
        <div className="card-header"><h2 id="opening-dit" className="card-title">Prior-year deposits in transit ({deps.length}) — {formatPesos(ditTotal as Centavos)}</h2></div>
        <LinesEditor<DepRow>
          caption="Deposits in transit on January 1"
          rows={deps}
          min={0}
          max={500}
          disabled={!editable}
          addLabel="Add deposit"
          onChange={(r) => { setDeps(r); setDirty(true); }}
          blank={() => ({ id: newId(), date: `${fiscalYear - 1}-12-31`, reference: '', particulars: '', amount: null })}
          columns={[
            { label: 'Date', required: true, render: (r, set, i) => <input type="date" aria-label={`Deposit ${i + 1} date`} className="input w-36" disabled={!editable} value={r.date} onChange={(e) => set({ date: e.target.value })} /> },
            { label: 'RCD / slip no.', render: (r, set, i) => <input aria-label={`Deposit ${i + 1} reference`} className="input w-32 font-mono" disabled={!editable} value={r.reference} onChange={(e) => set({ reference: e.target.value })} /> },
            { label: 'Particulars', render: (r, set, i) => <input aria-label={`Deposit ${i + 1} particulars`} className="input min-w-[10rem]" disabled={!editable} value={r.particulars} onChange={(e) => set({ particulars: e.target.value })} /> },
            { label: 'Amount', required: true, numeric: true, render: (r, set, i) => <MoneyInput aria-label={`Deposit ${i + 1} amount`} className="w-32" disabled={!editable} value={r.amount} onChange={(v) => set({ amount: v })} /> },
          ]}
        />
      </section>

      {errors.length > 0 && dirty && (
        <ul role="alert" className="list-disc pl-5 text-sm text-red-700">{errors.slice(0, 10).map((e) => <li key={e}>{e}.</li>)}</ul>
      )}
      {editable && (
        <div className="flex justify-end gap-2">
          {dirty && <span className="mr-auto self-center text-sm text-amber-800">Unsaved changes</span>}
          <button type="button" className="btn-primary" disabled={busy || !dirty || errors.length > 0} onClick={() => void save()}>{busy ? 'Saving…' : 'Save prior-year items'}</button>
        </div>
      )}
    </div>
  );
}
