import {
  DV_ACCT,
  PAYROLL_MAX_ENTRIES,
  PAYROLL_MODULE,
  PAYROLL_PAYMENT_METHODS,
  PAYROLL_TYPES,
  computePayroll,
  formatPesos,
  manilaToday,
  payrollDeductionColumns,
  type Centavos,
  type ObligationDoc,
  type PayrollDoc,
  type PayrollRecord,
  type WithId,
} from '@bfms/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AccountInput, BankAccountSelect, InfoGrid, MoneyInput, SubsidiarySelect } from '../../components/forms';
import { ActionBar, PrintLink, ReturnBanner, WorkflowTrail, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, Spinner, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useCollection } from '../../hooks/useCollection';
import { errorMessage } from '../../services/functions/api';
import { disbApi } from './api';

type Payroll = WithId<PayrollRecord>;
type DedCol = { description: string; accountCode: string };
type GridRow = { payeeName: string; position: string; gross: Centavos | null; deds: Array<Centavos | null>; signed: boolean };
const blankRow = (n: number): GridRow => ({ payeeName: '', position: '', gross: null, deds: Array.from({ length: n }, () => null), signed: false });

export function PayrollEditor({ id, rows, loading, onClose }: { id: string | null; rows: Payroll[]; loading: boolean; onClose(): void }) {
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  if (id && !rec)
    return (
      <Modal open title="Payroll" onClose={onClose}>
        {loading ? <Spinner /> : <p className="text-sm text-slate-700">This payroll is not in the selected barangay and fiscal year.</p>}
      </Modal>
    );
  return <PayrollForm rec={rec} rows={rows} onClose={onClose} />;
}

function PayrollForm({ rec, rows, onClose }: { rec: Payroll | null; rows: Payroll[]; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const [currentId, setCurrentId] = useState(rec?.id ?? null);
  const [h, setH] = useState({
    payrollDate: rec?.payrollDate ?? manilaToday(),
    payrollType: (rec?.payrollType ?? 'HONORARIA') as PayrollDoc['payrollType'],
    payPeriodFrom: rec?.payPeriodFrom ?? `${manilaToday().slice(0, 7)}-01`,
    payPeriodTo: rec?.payPeriodTo ?? manilaToday(),
    fundId: rec?.fundId ?? 'GF',
    particulars: rec?.particulars ?? '',
    obligationId: rec?.obligationId ?? '',
    expenseAccountCode: rec?.expenseAccountCode ?? '5-01-02-050',
    paymentMethod: (rec?.paymentMethod ?? 'CHECK') as PayrollDoc['paymentMethod'],
    disbursingOfficerId: rec?.disbursingOfficerId ?? null,
  });
  const initCols = payrollDeductionColumns(rec?.entries ?? []).map(({ description, accountCode }) => ({ description, accountCode }));
  const [cols, setCols] = useState<DedCol[]>(rec ? initCols : [{ description: 'W/Tax', accountCode: '2-02-01-010' }]);
  const [grid, setGrid] = useState<GridRow[]>(() =>
    rec
      ? rec.entries.map((e) => ({ payeeName: e.payeeName, position: e.position, gross: e.grossAmount, signed: e.signed, deds: initCols.map((c) => e.deductions.filter((d) => d.accountCode === c.accountCode && d.description === c.description).reduce((t, d) => t + d.amount, 0) || null) }))
      : Array.from({ length: 5 }, () => blankRow(1)),
  );
  const { save, busy } = useSaveSource(PAYROLL_MODULE.key);
  const obligations = useCollection<ObligationDoc & { dvId?: string | null }>('obligations', barangayId ? [['barangayId', '==', barangayId], ['status', '==', 'CERTIFIED']] : null).rows;
  // Spreadsheet-style Enter: move to the same column on the next row (adding one at the end).
  const tableRef = useRef<HTMLTableElement>(null);
  const pendingFocus = useRef<[number, number] | null>(null);
  useEffect(() => {
    if (!pendingFocus.current) return;
    const [r, c] = pendingFocus.current;
    pendingFocus.current = null;
    tableRef.current?.querySelector<HTMLInputElement>(`td[data-r="${r}"][data-c="${c}"] input`)?.focus();
  }, [grid.length]);
  if (!barangayId) return null;

  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('treasury.encode', barangayId) && (!live || PAYROLL_MODULE.editableStatuses.includes(live.status));
  const approved = live?.status === 'APPROVED';
  const obr = obligations.find((o) => o.id === h.obligationId);
  const obrOptions = obligations.filter((o) => o.accountCode.startsWith('5-') && (!o.dvId || o.id === h.obligationId));

  const entries = grid
    .filter((r) => r.payeeName.trim())
    .map((r) => ({ payeeName: r.payeeName.trim(), position: r.position.trim(), grossAmount: r.gross ?? 0, signed: r.signed, deductions: cols.map((c, j) => ({ description: c.description.trim(), accountCode: c.accountCode, amount: r.deds[j] ?? 0 })).filter((d) => d.amount > 0) }));
  let preview: ReturnType<typeof computePayroll> | null = null;
  let previewError: string | null = null;
  try {
    preview = computePayroll(entries);
  } catch (e) {
    previewError = errorMessage(e);
  }
  const overObr = !!obr && !!preview && preview.grossAmount > obr.amount;
  const colsOk = cols.every((c) => c.description.trim() && /^\d-\d{2}-\d{2}-\d{3}$/.test(c.accountCode));
  const valid = !!preview && colsOk && !overObr && (h.paymentMethod !== 'CASH_ADVANCE' || !!h.disbursingOfficerId) && h.payPeriodTo >= h.payPeriodFrom;

  const setRow = (i: number, patch: Partial<GridRow>) => setGrid((g) => g.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRows = (n: number) => setGrid((g) => (g.length + n > PAYROLL_MAX_ENTRIES ? g : [...g, ...Array.from({ length: n }, () => blankRow(cols.length))]));
  function onGridKey(e: KeyboardEvent<HTMLTableElement>) {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
    const td = e.target.closest('td');
    const r = Number(td?.dataset.r), c = Number(td?.dataset.c);
    if (Number.isNaN(r) || Number.isNaN(c)) return;
    e.preventDefault();
    if (r + 1 < grid.length) tableRef.current?.querySelector<HTMLInputElement>(`td[data-r="${r + 1}"][data-c="${c}"] input`)?.focus();
    else if (grid.length < PAYROLL_MAX_ENTRIES) {
      pendingFocus.current = [r + 1, c];
      addRows(1);
    }
  }

  async function onSave() {
    const newId = await save(barangayId!, { ...h, obligationId: h.obligationId || null, disbursingOfficerId: h.paymentMethod === 'CASH_ADVANCE' ? h.disbursingOfficerId : null, entries }, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  }

  return (
    <Modal
      open
      wide
      title={live?.payrollNumber ? `Payroll ${live.payrollNumber}` : live ? 'Payroll (draft)' : 'New payroll'}
      onClose={onClose}
      footer={
        <>
          {live && <ActionBar def={PAYROLL_MODULE} record={live} />}
          <span className="mr-auto" />
          {live && <PrintLink code="PAYROLL" documentId={live.id} fiscalYear={live.fiscalYear ?? fiscalYear} label="Print payroll" />}
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save draft'}</button>}
        </>
      }
    >
      {live && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <StatusChip status={live.status} />
          {live.payrollNumber && <span className="font-mono text-sm">{live.payrollNumber}</span>}
        </div>
      )}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Payroll date" required>{(p) => <input {...p} type="date" className="input" value={h.payrollDate} onChange={(e) => setH({ ...h, payrollDate: e.target.value })} />}</Field>
          <Field label="Type" required>
            {(p) => (
              <select {...p} className="input" value={h.payrollType} onChange={(e) => setH({ ...h, payrollType: e.target.value as typeof h.payrollType })}>
                {PAYROLL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Period from" required>{(p) => <input {...p} type="date" className="input" value={h.payPeriodFrom} onChange={(e) => setH({ ...h, payPeriodFrom: e.target.value })} />}</Field>
          <Field label="Period to" required error={h.payPeriodTo < h.payPeriodFrom ? 'Ends before it starts.' : null}>{(p) => <input {...p} type="date" className="input" value={h.payPeriodTo} onChange={(e) => setH({ ...h, payPeriodTo: e.target.value })} />}</Field>
          <Field label="Certified obligation (OBR)" className="sm:col-span-2" error={overObr ? `Gross exceeds the obligation (${formatPesos(obr!.amount, { symbol: true })}).` : null} hint={obr ? `Available: ${formatPesos(obr.amount, { symbol: true })}` : 'Required before the DV is paid by check / ADA.'}>
            {(p) => (
              <select {...p} className="input" value={h.obligationId} onChange={(e) => { const o = obligations.find((x) => x.id === e.target.value); setH({ ...h, obligationId: e.target.value, expenseAccountCode: o?.accountCode ?? h.expenseAccountCode }); }}>
                <option value="">— none yet —</option>
                {obrOptions.map((o) => <option key={o.id} value={o.id}>{o.obligationNumber} · {o.accountCode} · {o.particulars.slice(0, 40)} · {formatPesos(o.amount)}</option>)}
              </select>
            )}
          </Field>
          <Field label="Expense account" required className="sm:col-span-2">{(p) => <AccountInput {...p} value={h.expenseAccountCode} onChange={(expenseAccountCode) => setH({ ...h, expenseAccountCode })} prefixes={['5-01', '5-02']} />}</Field>
          <Field label="Mode of payment" required className="sm:col-span-2">
            {(p) => (
              <select {...p} className="input" value={h.paymentMethod} onChange={(e) => setH({ ...h, paymentMethod: e.target.value as typeof h.paymentMethod })}>
                {PAYROLL_PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            )}
          </Field>
          {h.paymentMethod === 'CASH_ADVANCE' && (
            <Field label="Disbursing officer (AO ledger)" required className="sm:col-span-2">
              {(p) => <SubsidiarySelect {...p} barangayId={barangayId} accountCode={DV_ACCT.ADVANCES_PAYROLL} value={h.disbursingOfficerId} onChange={(v) => setH({ ...h, disbursingOfficerId: v })} emptyLabel="— select —" />}
            </Field>
          )}
          <Field label="Particulars" className="sm:col-span-4">{(p) => <input {...p} className="input" value={h.particulars} onChange={(e) => setH({ ...h, particulars: e.target.value })} />}</Field>
        </div>

        <section aria-labelledby="dc-h">
          <h3 id="dc-h" className="mb-1 text-sm font-semibold text-navy-800">Deduction columns</h3>
          <div className="flex flex-wrap items-start gap-3">
            {cols.map((c, j) => (
              <div key={j} className="flex items-start gap-1 rounded-md border border-slate-200 p-2">
                <input aria-label={`Deduction column ${j + 1} title`} className="input w-28" value={c.description} onChange={(e) => setCols(cols.map((x, k) => (k === j ? { ...x, description: e.target.value } : x)))} />
                <div className="w-40"><AccountInput aria-label={`Deduction column ${j + 1} account`} value={c.accountCode} onChange={(accountCode) => setCols(cols.map((x, k) => (k === j ? { ...x, accountCode } : x)))} prefixes={['2-']} /></div>
                {editable && (
                  <button type="button" className="btn-ghost btn-icon" aria-label={`Remove deduction column ${c.description || j + 1}`} onClick={() => { setCols(cols.filter((_, k) => k !== j)); setGrid(grid.map((r) => ({ ...r, deds: r.deds.filter((_, k) => k !== j) }))); }}>
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            ))}
            {editable && cols.length < 10 && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => { setCols([...cols, { description: '', accountCode: '2-02-01-' }]); setGrid(grid.map((r) => ({ ...r, deds: [...r.deds, null] }))); }}>
                <Icon name="plus" /> Add deduction column
              </button>
            )}
          </div>
        </section>
      </fieldset>

      <section aria-labelledby="pe-h" className="mt-4">
        <h3 id="pe-h" className="mb-1 text-sm font-semibold text-navy-800">Payees <span className="font-normal text-slate-600">(Enter moves down; blank names are ignored; max {PAYROLL_MAX_ENTRIES})</span></h3>
        <div className="overflow-x-auto">
          <table ref={tableRef} className="table-base" onKeyDown={onGridKey}>
            <caption className="sr-only">Payroll entries</caption>
            <thead>
              <tr>
                <th scope="col" className="w-8">#</th>
                <th scope="col" className="required">Name</th>
                <th scope="col">Designation</th>
                <th scope="col" className="num required">Gross</th>
                {cols.map((c, j) => <th key={j} scope="col" className="num">{c.description || `Deduction ${j + 1}`}</th>)}
                <th scope="col" className="num">Net</th>
                {approved && <th scope="col">Signed</th>}
                {editable && <th scope="col"><span className="sr-only">Remove</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {grid.map((r, i) => {
                const net = (r.gross ?? 0) - r.deds.reduce<number>((t, d) => t + (d ?? 0), 0);
                return (
                  <tr key={i}>
                    <td className="pt-4 text-xs text-slate-500">{i + 1}</td>
                    <td data-r={i} data-c={0} className="min-w-[12rem]"><input aria-label={`Payee ${i + 1} name`} className="input" disabled={!editable} value={r.payeeName} onChange={(e) => setRow(i, { payeeName: e.target.value })} /></td>
                    <td data-r={i} data-c={1} className="min-w-[9rem]"><input aria-label={`Payee ${i + 1} designation`} className="input" disabled={!editable} value={r.position} onChange={(e) => setRow(i, { position: e.target.value })} /></td>
                    <td data-r={i} data-c={2} className="w-32"><MoneyInput aria-label={`Payee ${i + 1} gross`} disabled={!editable} value={r.gross} onChange={(gross) => setRow(i, { gross })} /></td>
                    {cols.map((c, j) => (
                      <td key={j} data-r={i} data-c={3 + j} className="w-28">
                        <MoneyInput aria-label={`Payee ${i + 1} ${c.description || `deduction ${j + 1}`}`} disabled={!editable} value={r.deds[j] ?? null} onChange={(v) => setRow(i, { deds: r.deds.map((d, k) => (k === j ? v : d)) })} />
                      </td>
                    ))}
                    <td className={`num pt-4 ${net < 0 ? 'text-red-700' : ''}`}>{r.payeeName.trim() ? formatPesos(net) : ''}</td>
                    {approved && (
                      <td className="pt-3 text-center">
                        <input type="checkbox" aria-label={`Payee ${i + 1} signed`} checked={r.signed} disabled={!can('treasury.encode', barangayId)} onChange={(e) => setRow(i, { signed: e.target.checked })} />
                      </td>
                    )}
                    {editable && (
                      <td>
                        {grid.length > 1 && (
                          <button type="button" className="btn-ghost btn-icon text-slate-500 hover:text-red-700" aria-label={`Remove payee row ${i + 1}`} onClick={() => setGrid(grid.filter((_, j) => j !== i))}>
                            <Icon name="trash" />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {editable && <button type="button" className="btn-ghost btn-sm" onClick={() => addRows(5)} disabled={grid.length >= PAYROLL_MAX_ENTRIES}><Icon name="plus" /> Add 5 rows</button>}
          {approved && live && <SignaturesButton payroll={live} signed={grid.filter((r) => r.payeeName.trim()).map((r) => r.signed)} />}
        </div>
      </section>

      <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3" aria-live="polite">
        {preview ? (
          <InfoGrid columns={4} items={[['Payees', String(preview.entryCount)], ['Gross', <Money key="g" value={preview.grossAmount} />], ['Deductions', <Money key="d" value={preview.totalDeductions} />], ['Net payroll', <strong key="n"><Money value={preview.netAmount} /></strong>]]} />
        ) : (
          <p className="text-sm text-slate-700">{previewError}</p>
        )}
      </div>

      {approved && live && <PayrollDvPanel payroll={live} />}
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}

function SignaturesButton({ payroll, signed }: { payroll: Payroll; signed: boolean[] }) {
  const { can } = useAuth();
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  if (!can('treasury.encode', payroll.barangayId)) return null;
  return (
    <button
      type="button"
      className="btn-secondary btn-sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await disbApi.setPayrollSignatures({ payrollId: payroll.id, signed });
          notify(`${r.signed} of ${signed.length} payees marked as signed.`, 'success');
        } catch (e) {
          notify(errorMessage(e), 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      Save signatures
    </button>
  );
}

/** "Create DV from payroll": PAYROLL DV, or CASH_ADVANCE DV to the disbursing officer. */
function PayrollDvPanel({ payroll }: { payroll: Payroll }) {
  const { can } = useAuth();
  const { notify } = useToast();
  const navigate = useNavigate();
  const [dvDate, setDvDate] = useState(manilaToday() < payroll.payrollDate ? payroll.payrollDate : manilaToday());
  const [method, setMethod] = useState<'CHECK' | 'ADA' | 'CASH'>(payroll.paymentMethod === 'ADA' ? 'ADA' : 'CHECK');
  const [bank, setBank] = useState<string | null>(null);
  const [cashSl, setCashSl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (payroll.dvId)
    return (
      <p className="mt-4 text-sm">
        DV: <Link className="text-navy-700 underline" to={`/disbursements/vouchers?open=${payroll.dvId}`}>{payroll.dvNumber ?? 'draft'} — open</Link>
        {payroll.cashAdvanceId && <span className="ml-2 text-slate-600">(cash advance of {payroll.disbursingOfficerName})</span>}
      </p>
    );
  if (!can('treasury.encode', payroll.barangayId)) return null;
  async function create() {
    setBusy(true);
    try {
      const r = await disbApi.createDvFromPayroll({ payrollId: payroll.id, dvDate, paymentMethod: method, bankAccountId: method === 'CASH' ? null : bank, cashOfficerId: method === 'CASH' ? cashSl : null });
      notify('Disbursement voucher created.', 'success');
      navigate(`/disbursements/vouchers?open=${r.dvId}`);
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="pdv-h" className="mt-4 rounded-md border border-slate-200 p-3">
      <h3 id="pdv-h" className="mb-2 text-sm font-semibold text-navy-800">
        Create DV {payroll.paymentMethod === 'CASH_ADVANCE' ? `(cash advance of ${payroll.disbursingOfficerName ?? 'the disbursing officer'})` : '(payroll)'}
      </h3>
      <div className="grid items-end gap-3 sm:grid-cols-4">
        <Field label="DV date" required>{(p) => <input {...p} type="date" className="input" value={dvDate} onChange={(e) => setDvDate(e.target.value)} />}</Field>
        <Field label="DV paid by" required>
          {(p) => (
            <select {...p} className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              <option value="CHECK">Check</option>
              <option value="ADA">ADA</option>
              <option value="CASH">Cash</option>
            </select>
          )}
        </Field>
        {method === 'CASH' ? (
          <Field label="Cash ledger (BT)" required>{(p) => <SubsidiarySelect {...p} barangayId={payroll.barangayId} accountCode={DV_ACCT.CASH_LOCAL_TREASURY} value={cashSl} onChange={setCashSl} emptyLabel="— select —" />}</Field>
        ) : (
          <Field label="Bank account">{(p) => <BankAccountSelect {...p} barangayId={payroll.barangayId} value={bank} onChange={(v) => setBank(v)} />}</Field>
        )}
        <button type="button" className="btn-primary" disabled={busy || (method === 'CASH' && !cashSl)} onClick={() => void create()}>{busy ? 'Creating…' : 'Create DV'}</button>
      </div>
    </section>
  );
}
