import { formatPesos, manilaToday, type BarangayId, type Centavos, type LegacyCashAdvanceDoc, type WithId } from '@bfms/shared';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
// The schedule functions are not re-exported from @bfms/shared's index (registry owned elsewhere).
import type { CaScheduleItem, CaSlSchedule } from '../../../shared/src/accounting/schedules';
import { loadCaSchedule } from '../../../shared/src/accounting/schedulesData';
import { MoneyInput, SubsidiarySelect } from '../../components/forms';
import { reportHref } from '../../components/source';
import { ConfirmDialog, EmptyState, Field, Icon, Modal, Money, PageHeader, TableSkeleton } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { clientDataSource } from '../../services/datasource';
import { callFn, errorMessage } from '../../services/functions/api';
import { useLoad } from './useLoad';

const CA_ACCOUNT_OPTIONS = [
  ['1-03-03-010', 'Advances for Payroll'],
  ['1-03-03-020', 'Advances to Officers and Employees'],
  ['1-03-04-020', 'Due from Officers and Employees'],
  ['1-03-04-010', 'Receivables - Disallowances/Charges'],
] as const;

type LegacyInput = {
  id?: string | null;
  barangayId: BarangayId;
  fiscalYear: number;
  accountCode: string;
  subsidiaryId: string | null;
  officerName: string;
  date: string;
  checkNumber: string | null;
  dvNumber: string | null;
  particulars: string;
  amount: number;
};
const saveLegacy = callFn<LegacyInput, { id: string }>('saveLegacyCashAdvance');
const deleteLegacy = callFn<{ id: string; reason?: string }, { ok: true }>('deleteLegacyCashAdvance');

const peso = (v: number) => formatPesos(v as Centavos, { symbol: true });

/** List / Aging of Unliquidated Cash Advances — from the posted journal plus the legacy items. */
export function CaSchedulePage() {
  const { barangayId, fiscalYear } = useBarangay();
  const { can } = useAuth();
  const defaultAsOf = manilaToday().startsWith(String(fiscalYear)) ? manilaToday() : `${fiscalYear}-12-31`;
  const [asOf, setAsOf] = useState(defaultAsOf);
  const [officer, setOfficer] = useState('');
  const [editing, setEditing] = useState<LegacyInput | null>(null);
  const [deleting, setDeleting] = useState<WithId<LegacyCashAdvanceDoc> | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const { notify } = useToast();
  const validAsOf = /^\d{4}-\d{2}-\d{2}$/.test(asOf) && asOf.startsWith(String(fiscalYear));
  const { data: s, error, loading, reload } = useLoad(barangayId && validAsOf ? () => loadCaSchedule(clientDataSource, barangayId, fiscalYear, asOf) : null, [barangayId, fiscalYear, asOf]);
  const editable = !!barangayId && can('jev.prepare', barangayId);

  const officers = useMemo(() => (s ? s.officers.filter((g) => !officer || g.officerName === officer) : []), [s, officer]);
  const total = officers.reduce((t, g) => t + g.total, 0);
  const buckets = s ? s.buckets.map((b, i) => ({ label: b.label, value: officers.reduce((t, g) => t + g.bucketTotals[i]!, 0) })) : [];
  const legacyById = new Map((s?.legacyDocs ?? []).map((d) => [d.id, d]));

  if (!barangayId) return <EmptyState title="Select a barangay">The schedule is kept per barangay.</EmptyState>;

  const blank = (): LegacyInput => ({ barangayId, fiscalYear, accountCode: '1-03-03-010', subsidiaryId: null, officerName: '', date: `${fiscalYear - 1}-12-31`, checkNumber: null, dvNumber: null, particulars: '', amount: 0 });
  const edit = (d: WithId<LegacyCashAdvanceDoc>) => setEditing({ id: d.id, barangayId, fiscalYear, accountCode: d.accountCode, subsidiaryId: d.subsidiaryId, officerName: d.officerName, date: d.date, checkNumber: d.checkNumber, dvNumber: d.dvNumber, particulars: d.particulars, amount: d.amount });

  async function onSave(v: LegacyInput) {
    setBusy(true);
    try {
      await saveLegacy(v);
      notify('Legacy advance saved.', 'success');
      setEditing(null);
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  async function onDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await deleteLegacy({ id: deleting.id, reason: reason.trim() || undefined });
      notify('Legacy advance deleted.', 'success');
      setDeleting(null);
      setReason('');
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Unliquidated Cash Advances"
        subtitle={`List and aging of cash advances per accountable officer, from the posted journal and the advances carried from prior years · FY ${fiscalYear}`}
        breadcrumbs={['Schedules', 'Cash advances']}
        actions={
          <>
            {editable && (
              <button type="button" className="btn-secondary" onClick={() => setEditing(blank())}>
                <Icon name="plus" /> Add prior-year advance
              </button>
            )}
            <Link className="btn-primary" to={reportHref('CA_AGING', { fiscalYear, asOf })}><Icon name="file" /> Print list</Link>
          </>
        }
      />

      <section className="card mb-4 grid gap-3 p-4 sm:grid-cols-3" aria-label="Schedule filters">
        <Field label="As of" error={validAsOf ? null : `Pick a date in ${fiscalYear}.`}>{(p) => <input {...p} type="date" className="input" value={asOf} min={`${fiscalYear}-01-01`} max={`${fiscalYear}-12-31`} onChange={(e) => setAsOf(e.target.value)} />}</Field>
        <Field label="Accountable officer">
          {(p) => (
            <select {...p} className="input" value={officer} onChange={(e) => setOfficer(e.target.value)}>
              <option value="">All officers</option>
              {(s?.officers ?? []).map((g) => <option key={g.officerName} value={g.officerName}>{g.officerName}</option>)}
            </select>
          )}
        </Field>
      </section>

      {error && <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">Could not load the schedule: {error.message}</p>}

      <section aria-label="Aging summary" aria-live="polite" className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <div className="card p-3">
          <p className="text-xs text-slate-600">Total unliquidated</p>
          <p className="text-lg font-semibold tabular-nums">{peso(total)}</p>
        </div>
        {buckets.map((b) => (
          <div key={b.label} className="card p-3">
            <p className="text-xs text-slate-600">{b.label}</p>
            <p className={`text-lg font-semibold tabular-nums ${b.value && /year|365/.test(b.label) ? 'text-red-700' : ''}`}>{peso(b.value)}</p>
          </div>
        ))}
      </section>

      <section className="card mb-4 overflow-x-auto" aria-labelledby="ca-list">
        <h2 id="ca-list" className="card-title px-4 pt-4">List of unliquidated cash advances as of {asOf}</h2>
        {loading && !s ? (
          <TableSkeleton rows={6} label="Loading the schedule…" />
        ) : !officers.length ? (
          <div className="p-4"><EmptyState title="No unliquidated cash advances">No advance on 1-03-03-010 / 1-03-03-020 / 1-03-04-0xx is outstanding as of this date.</EmptyState></div>
        ) : (
          <table className="table-base min-w-[64rem]">
            <thead>
              <tr>
                <th scope="col">Check No.</th>
                <th scope="col">Date</th>
                <th scope="col">DV No.</th>
                <th scope="col">Account</th>
                <th scope="col">Particulars</th>
                <th scope="col" className="text-right">Amount</th>
                <th scope="col" className="text-right">Liquidated</th>
                <th scope="col" className="text-right">Outstanding</th>
                <th scope="col" className="text-right">Days</th>
                <th scope="col">Aging</th>
                {editable && <th scope="col"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            {officers.map((g) => (
              <tbody key={g.officerName}>
                <tr className="bg-slate-50">
                  <th scope="rowgroup" colSpan={editable ? 11 : 10} className="text-left font-semibold text-navy-800">{g.officerName}</th>
                </tr>
                {g.items.map((i) => (
                  <ItemRow key={i.id} i={i} legacy={legacyById.get(i.id)} editable={editable} onEdit={edit} onDelete={setDeleting} />
                ))}
                <tr className="font-semibold">
                  <td colSpan={7} className="text-right">Sub-total — {g.officerName}</td>
                  <td className="text-right"><Money value={g.total} /></td>
                  <td colSpan={editable ? 3 : 2} />
                </tr>
              </tbody>
            ))}
            <tfoot>
              <tr className="font-bold">
                <td colSpan={7} className="text-right">GRAND TOTAL</td>
                <td className="text-right"><Money value={total} /></td>
                <td colSpan={editable ? 3 : 2} />
              </tr>
            </tfoot>
          </table>
        )}
        <p className="px-4 pb-4 pt-2 text-xs text-slate-600">
          Liquidations and refunds (credits to the advance account of the officer) are applied to the advance whose check no. or DV no. is written in the entry's reference or line description; otherwise to the oldest open advance first.
        </p>
      </section>

      {s && <Reconciliation sls={s.sls} />}

      {s && (
        <section className="card mb-4 overflow-x-auto" aria-labelledby="ca-legacy">
          <h2 id="ca-legacy" className="card-title px-4 pt-4">Advances carried from prior years ({s.legacyDocs.length})</h2>
          <p className="px-4 text-sm text-slate-600">These make up the opening balance of the advance accounts; liquidations posted this year are applied to them.</p>
          {s.legacyDocs.length === 0 ? (
            <p className="p-4 text-sm text-slate-600">None recorded for FY {fiscalYear}.</p>
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th scope="col">Officer</th><th scope="col">Account</th><th scope="col">Date</th><th scope="col">Check No.</th><th scope="col">DV No.</th><th scope="col">Particulars</th><th scope="col" className="text-right">Amount</th>
                  {editable && <th scope="col"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {[...s.legacyDocs].sort((a, b) => a.officerName.localeCompare(b.officerName) || a.date.localeCompare(b.date)).map((d) => (
                  <tr key={d.id}>
                    <td>{d.officerName}</td><td className="font-mono text-xs">{d.accountCode}</td><td>{d.date}</td><td>{d.checkNumber}</td><td>{d.dvNumber}</td><td>{d.particulars}</td>
                    <td className="text-right"><Money value={d.amount} dashZero={false} /></td>
                    {editable && (
                      <td className="whitespace-nowrap text-right">
                        <button type="button" className="btn-ghost btn-sm" onClick={() => edit(d)}>Edit</button>
                        <button type="button" className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(d)}>Delete</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {editing && <LegacyEditor value={editing} busy={busy} onCancel={() => setEditing(null)} onSave={onSave} />}
      <ConfirmDialog
        open={!!deleting}
        title="Delete prior-year advance"
        danger
        busy={busy}
        confirmLabel="Delete"
        message={deleting && <>Delete the advance of <strong>{deleting.officerName}</strong> dated {deleting.date} ({peso(deleting.amount)})? The schedule will no longer list it.</>}
        optionalReason="Why it is removed (recorded in the audit trail)."
        reason={reason}
        onReasonChange={setReason}
        onConfirm={onDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function ItemRow({ i, legacy, editable, onEdit, onDelete }: { i: CaScheduleItem; legacy?: WithId<LegacyCashAdvanceDoc>; editable: boolean; onEdit(d: WithId<LegacyCashAdvanceDoc>): void; onDelete(d: WithId<LegacyCashAdvanceDoc>): void }) {
  const tag = i.source === 'LEGACY' ? 'prior year' : i.source === 'BALANCE_FORWARD' ? 'no detail' : i.source === 'UNAPPLIED_CREDIT' ? 'over-liquidated' : i.jevNumber ? `JEV ${i.jevNumber}` : '';
  return (
    <tr className={i.outstanding < 0 ? 'text-red-800' : undefined}>
      <td>{i.checkNumber}</td>
      <td className="whitespace-nowrap">{i.date}</td>
      <td>{i.dvNumber}</td>
      <td className="font-mono text-xs">{i.accountCode}</td>
      <td>
        {i.particulars}
        {tag && <span className="ml-1 rounded bg-slate-100 px-1 text-[11px] text-slate-600">{tag}</span>}
      </td>
      <td className="text-right"><Money value={i.amount} dashZero={false} /></td>
      <td className="text-right" title={i.applications.map((a) => `${a.date} ${a.jevNumber ?? ''} ${formatPesos(a.amount)}${a.targeted ? ' (named)' : ''}`).join('\n') || undefined}><Money value={i.applied} /></td>
      <td className="text-right font-medium"><Money value={i.outstanding} dashZero={false} /></td>
      <td className="text-right tabular-nums">{i.days}</td>
      <td className="whitespace-nowrap text-xs">{i.bucket}</td>
      {editable && (
        <td className="whitespace-nowrap text-right">
          {legacy && (
            <>
              <button type="button" className="btn-ghost btn-sm" onClick={() => onEdit(legacy)} aria-label={`Edit advance ${i.checkNumber ?? i.date}`}>Edit</button>
              <button type="button" className="btn-ghost btn-sm text-red-700" onClick={() => onDelete(legacy)} aria-label={`Delete advance ${i.checkNumber ?? i.date}`}>Delete</button>
            </>
          )}
        </td>
      )}
    </tr>
  );
}

function Reconciliation({ sls }: { sls: CaSlSchedule[] }) {
  const list = sls.filter((x) => x.scheduleBalance !== 0 || x.ledgerBalance !== 0);
  const bad = list.filter((x) => x.difference !== 0);
  return (
    <section className="card mb-4 overflow-x-auto" aria-labelledby="ca-recon">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
        <h2 id="ca-recon" className="card-title">Reconciliation with the ledgers</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${bad.length ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}`}>{bad.length ? `${bad.length} difference(s)` : 'Agrees with GL/SL'}</span>
      </div>
      {list.length === 0 ? (
        <p className="p-4 text-sm text-slate-600">No balances on the advance accounts.</p>
      ) : (
        <table className="table-base">
          <thead>
            <tr><th scope="col">Account</th><th scope="col">SL</th><th scope="col">Officer</th><th scope="col" className="text-right">Per schedule</th><th scope="col" className="text-right">Per GL / SL</th><th scope="col" className="text-right">Difference</th><th scope="col">Note</th></tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.key} className={x.difference ? 'bg-red-50' : undefined}>
                <td className="font-mono text-xs">{x.accountCode}</td>
                <td>{x.slCode || '—'}</td>
                <td>{x.officerName}</td>
                <td className="text-right"><Money value={x.scheduleBalance} dashZero={false} /></td>
                <td className="text-right"><Money value={x.ledgerBalance} dashZero={false} /></td>
                <td className={`text-right ${x.difference ? 'font-semibold text-red-800' : ''}`}><Money value={x.difference} /></td>
                <td className="text-xs text-slate-600">
                  {x.difference !== 0 && x.openingDetail !== x.openingLedger ? `Prior-year items total ${peso(x.openingDetail)}; opening balance per ledger ${peso(x.openingLedger)}.` : ''}
                  {x.ledgerBalance < 0 ? ' Credit (negative) balance in the ledger.' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function LegacyEditor({ value, busy, onCancel, onSave }: { value: LegacyInput; busy: boolean; onCancel(): void; onSave(v: LegacyInput): void }) {
  const [v, setV] = useState(value);
  const [negative, setNegative] = useState(value.amount < 0);
  const [amount, setAmount] = useState<Centavos | null>(Math.abs(value.amount) as Centavos);
  const set = <K extends keyof LegacyInput>(k: K, x: LegacyInput[K]) => setV((cur) => ({ ...cur, [k]: x }));
  const errors = {
    date: /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? null : 'Enter the date granted.',
    officer: v.subsidiaryId || v.officerName.trim().length >= 2 ? null : 'Pick the ledger or type the officer’s name.',
    particulars: v.particulars.trim().length >= 2 ? null : 'Enter the purpose of the advance.',
    amount: amount && amount > 0 ? null : 'Enter the outstanding amount.',
  };
  const ok = Object.values(errors).every((e) => !e);
  return (
    <Modal
      open
      title={v.id ? 'Edit prior-year advance' : 'Add prior-year advance'}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" disabled={!ok || busy} onClick={() => onSave({ ...v, amount: (negative ? -1 : 1) * (amount ?? 0) })}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Account" required className="sm:col-span-2">
          {(p) => (
            <select {...p} className="input" value={v.accountCode} onChange={(e) => setV((c) => ({ ...c, accountCode: e.target.value, subsidiaryId: null }))}>
              {CA_ACCOUNT_OPTIONS.map(([c, n]) => <option key={c} value={c}>{c} {n}</option>)}
            </select>
          )}
        </Field>
        <Field label="Subsidiary ledger (AO / EO)" hint="Links the advance to the officer’s ledger for the reconciliation.">
          {(p) => <SubsidiarySelect {...p} barangayId={v.barangayId} accountCode={v.accountCode} value={v.subsidiaryId} onChange={(id) => set('subsidiaryId', id)} />}
        </Field>
        <Field label="Accountable officer" error={errors.officer} hint="Defaults to the ledger name.">{(p) => <input {...p} className="input" value={v.officerName} onChange={(e) => set('officerName', e.target.value)} />}</Field>
        <Field label="Date granted" required error={errors.date}>{(p) => <input {...p} type="date" className="input" value={v.date} onChange={(e) => set('date', e.target.value)} />}</Field>
        <Field label="Check No.">{(p) => <input {...p} className="input" value={v.checkNumber ?? ''} onChange={(e) => set('checkNumber', e.target.value || null)} />}</Field>
        <Field label="DV No.">{(p) => <input {...p} className="input" value={v.dvNumber ?? ''} onChange={(e) => set('dvNumber', e.target.value || null)} />}</Field>
        <Field label="Outstanding amount" required error={errors.amount}>{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} allowZero={false} />}</Field>
        <Field label="Particulars" required error={errors.particulars} className="sm:col-span-2">{(p) => <input {...p} className="input" value={v.particulars} onChange={(e) => set('particulars', e.target.value)} />}</Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={negative} onChange={(e) => setNegative(e.target.checked)} /> Over-liquidated (record as a negative balance)
        </label>
      </div>
    </Modal>
  );
}
