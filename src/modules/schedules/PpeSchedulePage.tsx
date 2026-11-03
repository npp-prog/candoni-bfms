import { MONTH_NAMES, formatPesos, type BarangayId, type Centavos, type PpeScheduleRow } from '@bfms/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
// The schedule functions are not re-exported from @bfms/shared's index (registry owned elsewhere).
import { computePpeSchedule, defaultPpeRow, depreciationJevLines, isDepreciablePpeAccount, ppeGlFigures } from '@bfms/shared';
import { loadPpeSchedule } from '@bfms/shared';
import { AccountInput, MoneyInput } from '../../components/forms';
import { reportHref } from '../../components/source';
import { EmptyState, Field, Icon, Modal, Money, PageHeader, TableSkeleton } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useChartOfAccounts } from '../../hooks/useChartOfAccounts';
import { useCollection } from '../../hooks/useCollection';
import { clientDataSource } from '../../services/datasource';
import { callFn, errorMessage } from '../../services/functions/api';
import { useLoad } from './useLoad';

const savePpe = callFn<{ barangayId: BarangayId; fiscalYear: number; rows: PpeScheduleRow[] }, { id: string }>('savePpeSchedule');
const generateJev = callFn<{ barangayId: BarangayId; fiscalYear: number; month: number | null; replace: boolean }, { jevId: string; totalDepreciation: number; lines: number; replaced: string | null }>('generateDepreciationJev');

interface RunDoc {
  period: string;
  month: number | null;
  jevId: string;
  jevNumber: string | null;
  jevDate: string;
  totalDepreciation: number;
  kind?: string;
}

/** PPE Depreciation Schedule — parameters per PPE account, computed from the GL; generates the depreciation JEV. */
export function PpeSchedulePage() {
  const { barangayId, fiscalYear } = useBarangay();
  const { can } = useAuth();
  const { notify } = useToast();
  const coa = useChartOfAccounts();
  const [month, setMonth] = useState<number | null>(null);
  const { data: view, error, loading, reload } = useLoad(barangayId ? () => loadPpeSchedule(clientDataSource, barangayId, fiscalYear, month) : null, [barangayId, fiscalYear, month]);
  const runs = useCollection<RunDoc>('depreciationRuns', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
  const [rows, setRows] = useState<PpeScheduleRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [replace, setReplace] = useState(false);
  const editable = !!barangayId && can('jev.prepare', barangayId);

  // Start from the saved rows merged with defaults for accounts that have a balance.
  useEffect(() => {
    if (view && !dirty) setRows(view.rows.map(({ accountCode, costOverride, residualRateBp, usefulLifeYears, accumulatedAccountCode, expenseAccountCode, remarks }) => ({ accountCode, costOverride, residualRateBp, usefulLifeYears, accumulatedAccountCode, expenseAccountCode, remarks })));
  }, [view, dirty]);

  const computed = useMemo(() => {
    if (!view) return [];
    const m = month ?? 12;
    const gl = ppeGlFigures(rows, view.balances.filter((b) => b.accountCode.startsWith('1-07-')), { costMonth: m, fromMonth: month ?? 1, toMonth: m });
    return computePpeSchedule(rows, gl, month ? 'MONTH' : 'YEAR');
  }, [rows, view, month]);
  const recap = depreciationJevLines(computed);
  const total = (k: 'cost' | 'residualValue' | 'depreciableAmount' | 'annualDepreciation' | 'monthlyDepreciation' | 'periodDepreciation' | 'accumulatedEnd' | 'netBookValue') => computed.reduce((t, r) => t + r[k], 0);
  const name = (c: string) => coa?.get(c)?.accountName ?? '';
  const periodLabel = month ? `${MONTH_NAMES[month - 1]} ${fiscalYear}` : `the year ${fiscalYear} (December 31)`;
  const runFor = runs.rows.find((r) => r.period === `${fiscalYear}-${month ? String(month).padStart(2, '0') : 'YR'}`);
  const recorded = view ? [...view.expenseRecorded.values()].reduce((t, v) => t + v, 0) : 0;

  if (!barangayId) return <EmptyState title="Select a barangay">The schedule is kept per barangay.</EmptyState>;

  const update = (i: number, patch: Partial<PpeScheduleRow>) => {
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const addRow = () => {
    if (!isDepreciablePpeAccount(newCode) || rows.some((r) => r.accountCode === newCode)) return;
    setRows((cur) => [...cur, defaultPpeRow(newCode)].sort((a, b) => a.accountCode.localeCompare(b.accountCode)));
    setNewCode('');
    setDirty(true);
  };

  async function onSave() {
    setBusy(true);
    try {
      await savePpe({ barangayId: barangayId!, fiscalYear, rows });
      notify('PPE schedule saved.', 'success');
      setDirty(false);
      reload();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  async function onGenerate() {
    setBusy(true);
    try {
      const r = await generateJev({ barangayId: barangayId!, fiscalYear, month, replace });
      notify(`Depreciation JEV drafted (${formatPesos(r.totalDepreciation as Centavos, { symbol: true })}, ${r.lines} lines)${r.replaced ? ', replacing the earlier draft' : ''}. Review and submit it in Journal Entries.`, 'success');
      setConfirm(false);
      setReplace(false);
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const invalid = rows.filter((r) => !coa?.get(r.accumulatedAccountCode) || !coa?.get(r.expenseAccountCode) || r.usefulLifeYears < 1);

  return (
    <div>
      <PageHeader
        title="PPE Depreciation Schedule"
        subtitle={`Straight-line depreciation per PPE account, cost per General Ledger · FY ${fiscalYear}`}
        breadcrumbs={['Schedules', 'PPE & depreciation']}
        actions={
          <>
            <Link className="btn-secondary" to={reportHref('PPE_DEPRECIATION', { fiscalYear })}><Icon name="file" /> Print schedule</Link>
            {editable && <button type="button" className="btn-primary" disabled={busy || !dirty || invalid.length > 0} onClick={onSave}>{busy ? 'Saving…' : dirty ? 'Save schedule' : 'Saved'}</button>}
          </>
        }
      />

      <section className="card mb-4 grid gap-3 p-4 sm:grid-cols-3" aria-label="Period">
        <Field label="Depreciation period" hint="The legacy books record one entry for the year on December 31.">
          {(p) => (
            <select {...p} className="input" value={month ?? ''} onChange={(e) => setMonth(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Year (December 31)</option>
              {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          )}
        </Field>
        <div className="text-sm">
          <p className="label">Depreciation for {month ? 'the month' : 'the year'}</p>
          <p className="text-lg font-semibold tabular-nums">{formatPesos(total('periodDepreciation') as Centavos, { symbol: true })}</p>
          <p className="text-xs text-slate-600">Recorded in the GL (5-04-01): {formatPesos(recorded as Centavos, { symbol: true })}</p>
        </div>
        <div className="text-sm">
          <p className="label">Depreciation entry</p>
          {runFor ? (
            <p>{runFor.jevNumber ? <>Posted, JEV <strong>{runFor.jevNumber}</strong></> : <>Draft generated {runFor.jevDate} — <Link className="link" to="/accounting">review in Journal Entries</Link></>}</p>
          ) : (
            <p className="text-slate-600">Not generated yet.</p>
          )}
          {editable && (
            <button type="button" className="btn-secondary btn-sm mt-2" disabled={busy || dirty || !recap.length || !!runFor?.jevNumber} onClick={() => { setReplace(!!runFor); setConfirm(true); }} title={dirty ? 'Save the schedule first' : undefined}>
              Generate depreciation JEV
            </button>
          )}
        </div>
      </section>

      {error && <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">Could not load the schedule: {error.message}</p>}

      <section className="card mb-4 overflow-x-auto" aria-labelledby="ppe-rows">
        <h2 id="ppe-rows" className="card-title px-4 pt-4">Depreciation schedule for {periodLabel}</h2>
        {loading && !view ? (
          <TableSkeleton rows={6} label="Loading the schedule…" />
        ) : rows.length === 0 ? (
          <div className="p-4"><EmptyState title="No PPE on the books">No depreciable PPE account (1-07-…) has a balance this year. Post the opening balances or acquisitions first, or add an account below.</EmptyState></div>
        ) : (
          <table className="table-base min-w-[90rem]">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col" className="text-right">Cost (GL)</th>
                <th scope="col">Cost override</th>
                <th scope="col">Residual %</th>
                <th scope="col" className="text-right">Residual value</th>
                <th scope="col" className="text-right">Depreciable</th>
                <th scope="col">Life (yrs)</th>
                <th scope="col" className="text-right">Annual</th>
                <th scope="col" className="text-right">Monthly</th>
                <th scope="col" className="text-right">This {month ? 'month' : 'year'}</th>
                <th scope="col" className="text-right">Accum. (GL)</th>
                <th scope="col" className="text-right">Net book value</th>
                <th scope="col">Accumulated / expense accounts</th>
                <th scope="col">Remarks</th>
                {editable && <th scope="col"><span className="sr-only">Remove</span></th>}
              </tr>
            </thead>
            <tbody>
              {computed.map((r, i) => (
                <tr key={r.accountCode}>
                  <td><span className="font-mono text-xs">{r.accountCode}</span><br /><span className="text-xs">{name(r.accountCode)}</span></td>
                  <td className="text-right"><Money value={r.glCost} /></td>
                  <td className="min-w-[9rem]">
                    {editable ? (
                      <MoneyInput aria-label={`Cost override ${r.accountCode}`} value={r.costOverride} onChange={(v) => update(i, { costOverride: v ? v : null })} />
                    ) : r.costOverride !== null ? <Money value={r.costOverride} /> : '—'}
                  </td>
                  <td>
                    <select aria-label={`Residual rate ${r.accountCode}`} className="input w-20" disabled={!editable} value={r.residualRateBp} onChange={(e) => update(i, { residualRateBp: Number(e.target.value) })}>
                      {[...new Set([0, 500, 1000, r.residualRateBp])].sort((a, b) => a - b).map((bp) => <option key={bp} value={bp}>{bp / 100}%</option>)}
                    </select>
                  </td>
                  <td className="text-right"><Money value={r.residualValue} /></td>
                  <td className="text-right"><Money value={r.depreciableAmount} /></td>
                  <td><input aria-label={`Useful life ${r.accountCode}`} type="number" min={1} max={100} className="input w-20" disabled={!editable} value={r.usefulLifeYears} onChange={(e) => update(i, { usefulLifeYears: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })} /></td>
                  <td className="text-right"><Money value={r.annualDepreciation} /></td>
                  <td className="text-right"><Money value={r.monthlyDepreciation} /></td>
                  <td className="text-right font-medium" title={r.capped ? 'Capped: the asset reaches its depreciable amount' : undefined}><Money value={r.periodDepreciation} />{r.capped && <span className="ml-1 text-[11px] text-amber-800">cap</span>}</td>
                  <td className="text-right"><Money value={r.accumulatedEnd} /></td>
                  <td className="text-right"><Money value={r.netBookValue} /></td>
                  <td className="min-w-[12rem]">
                    {editable ? (
                      <div className="grid gap-1">
                        <AccountInput aria-label={`Accumulated depreciation account ${r.accountCode}`} prefixes={['1-07-']} value={r.accumulatedAccountCode} onChange={(c) => update(i, { accumulatedAccountCode: c })} />
                        <AccountInput aria-label={`Depreciation expense account ${r.accountCode}`} prefixes={['5-04-01-']} value={r.expenseAccountCode} onChange={(c) => update(i, { expenseAccountCode: c })} />
                      </div>
                    ) : (
                      <span className="font-mono text-xs">{r.accumulatedAccountCode}<br />{r.expenseAccountCode}</span>
                    )}
                  </td>
                  <td><input aria-label={`Remarks ${r.accountCode}`} className="input min-w-[8rem]" disabled={!editable} value={r.remarks} onChange={(e) => update(i, { remarks: e.target.value })} /></td>
                  {editable && (
                    <td>
                      <button type="button" className="btn-ghost btn-icon" aria-label={`Remove ${r.accountCode}`} onClick={() => { setRows((cur) => cur.filter((_, j) => j !== i)); setDirty(true); }}><Icon name="trash" /></button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td>TOTAL</td>
                <td className="text-right"><Money value={computed.reduce((t, r) => t + r.glCost, 0)} /></td>
                <td />
                <td />
                <td className="text-right"><Money value={total('residualValue')} /></td>
                <td className="text-right"><Money value={total('depreciableAmount')} /></td>
                <td />
                <td className="text-right"><Money value={total('annualDepreciation')} /></td>
                <td className="text-right"><Money value={total('monthlyDepreciation')} /></td>
                <td className="text-right"><Money value={total('periodDepreciation')} /></td>
                <td className="text-right"><Money value={total('accumulatedEnd')} /></td>
                <td className="text-right"><Money value={total('netBookValue')} /></td>
                <td colSpan={editable ? 3 : 2} />
              </tr>
            </tfoot>
          </table>
        )}
        {invalid.length > 0 && <p role="alert" className="px-4 pt-2 text-sm text-red-700">Check the accumulated depreciation / expense accounts and useful life of {invalid.map((r) => r.accountCode).join(', ')}.</p>}
        {editable && (
          <div className="flex flex-wrap items-end gap-2 px-4 pb-4 pt-3">
            <Field label="Add PPE account" className="w-72">{(p) => <AccountInput {...p} prefixes={['1-07-']} value={newCode} onChange={setNewCode} />}</Field>
            <button type="button" className="btn-secondary mb-5" disabled={!isDepreciablePpeAccount(newCode) || rows.some((r) => r.accountCode === newCode)} onClick={addRow}><Icon name="plus" /> Add</button>
          </div>
        )}
        <p className="px-4 pb-4 text-xs text-slate-600">
          Defaults: infrastructure, land improvements and buildings — residual 0 %, 10 years; equipment, vehicles, furniture and books — residual 5 %, 5 years. Depreciation stops at the depreciable amount (accumulated per GL brought into the period). Land and construction in progress are not depreciated.
        </p>
      </section>

      <section className="card mb-4 overflow-x-auto" aria-labelledby="ppe-recap">
        <h2 id="ppe-recap" className="card-title px-4 pt-4">Journal entry — to record depreciation of PPE for {periodLabel}</h2>
        {recap.length === 0 ? (
          <p className="p-4 text-sm text-slate-600">Nothing to depreciate.</p>
        ) : (
          <table className="table-base">
            <thead><tr><th scope="col">Account</th><th scope="col">Title</th><th scope="col" className="text-right">Debit</th><th scope="col" className="text-right">Credit</th></tr></thead>
            <tbody>
              {recap.map((l) => (
                <tr key={l.accountCode}>
                  <td className="font-mono text-xs">{l.accountCode}</td>
                  <td className={l.credit ? 'pl-8' : undefined}>{name(l.accountCode)}</td>
                  <td className="text-right"><Money value={l.debit} /></td>
                  <td className="text-right"><Money value={l.credit} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal
        open={confirm}
        title="Generate depreciation JEV"
        onClose={() => setConfirm(false)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
            <button type="button" className="btn-primary" onClick={onGenerate} disabled={busy}>{busy ? 'Working…' : 'Generate draft JEV'}</button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          Draft a General Journal entry dated {month ? `the last day of ${MONTH_NAMES[month - 1]}` : `December 31, ${fiscalYear}`} for {formatPesos(total('periodDepreciation') as Centavos, { symbol: true })}: debit the depreciation expense accounts and credit the accumulated depreciation accounts. It goes through review and posting like any other entry.
        </p>
        {runFor && !runFor.jevNumber && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace the unposted entry generated earlier for this period
          </label>
        )}
      </Modal>
    </div>
  );
}
