import {
  DV_ACCT,
  DV_CASH_ADVANCE_TYPES,
  DV_CATEGORIES,
  DV_MODULE,
  DV_PAYMENT_ACTIONS,
  DV_PAYMENT_METHODS,
  DV_TAX_TYPES,
  computeDvTotals,
  dvRequiresObligation,
  formatPesos,
  manilaToday,
  type CashAdvanceType,
  type Centavos,
  type DisbursementVoucherDoc,
  type DvPaymentMethod,
  type DvRecord,
  type DvTotals,
  type ObligationDoc,
  type PartyRef,
  type SourceModuleDef,
  type WithId,
} from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AccountInput, BankAccountSelect, InfoGrid, LinesEditor, MoneyInput, PartyInput, SubsidiarySelect, emptyParty } from '../../components/forms';
import { ActionBar, PrintLink, ReturnBanner, WorkflowTrail, useSaveSource } from '../../components/source';
import { ConfirmDialog, Field, Modal, Money, Spinner, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useChartOfAccounts } from '../../hooks/useChartOfAccounts';
import { useCollection } from '../../hooks/useCollection';
import { api, errorMessage } from '../../services/functions/api';

type Dv = WithId<DvRecord>;
type TaxType = DvRecord['taxDeductions'][number]['taxType'];
type Charge = { accountCode: string; subsidiaryId: string | null; amount: Centavos | null };
type Tax = { taxType: TaxType; ratePct: string; base: Centavos | null };
type Ded = { description: string; accountCode: string; subsidiaryId: string | null; amount: Centavos | null };
type Obligation = WithId<ObligationDoc & { dvId?: string | null }>;

/** Generic workflow buttons only; payments have their own panel (they need check no., dates …). */
const ACTION_DEF: SourceModuleDef = { ...DV_MODULE, transitions: DV_MODULE.transitions.filter((t) => !(DV_PAYMENT_ACTIONS as readonly string[]).includes(t.action)) };
const blankCharge = (): Charge => ({ accountCode: '', subsidiaryId: null, amount: null });

export function DvEditor({ id, rows, loading, onClose }: { id: string | null; rows: Dv[]; loading: boolean; onClose(): void }) {
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  if (id && !rec)
    return (
      <Modal open title="Disbursement voucher" onClose={onClose}>
        {loading ? <Spinner /> : <p className="text-sm text-slate-700">This voucher is not in the selected barangay and fiscal year.</p>}
      </Modal>
    );
  return <DvForm rec={rec} rows={rows} onClose={onClose} />;
}

function DvForm({ rec, rows, onClose }: { rec: Dv | null; rows: Dv[]; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const coa = useChartOfAccounts();
  const [currentId, setCurrentId] = useState(rec?.id ?? null);
  const recCa = rec?.dvCategory === 'CASH_ADVANCE';
  const [f, setF] = useState({
    dvDate: rec?.dvDate ?? manilaToday(),
    dvCategory: (rec?.dvCategory ?? 'REGULAR') as DisbursementVoucherDoc['dvCategory'],
    payee: (rec?.payee ?? emptyParty()) as PartyRef,
    particulars: rec?.particulars ?? '',
    fundId: rec?.fundId ?? 'GF',
    obligationId: rec?.obligationId ?? '',
    paymentMethod: (rec?.paymentMethod ?? 'CHECK') as DvPaymentMethod,
    cashOfficerId: rec?.cashOfficerId ?? null,
    bankAccountId: rec?.bankAccountId ?? null,
  });
  const [charges, setCharges] = useState<Charge[]>(rec && !recCa ? rec.charges.map((c) => ({ ...c })) : [blankCharge()]);
  const [taxes, setTaxes] = useState<Tax[]>((rec?.taxDeductions ?? []).map((t) => ({ taxType: t.taxType, ratePct: String(t.rateBp / 100), base: t.base === rec?.grossAmount ? null : t.base })));
  const [deds, setDeds] = useState<Ded[]>((rec?.otherDeductions ?? []).map((d) => ({ ...d })));
  const [ca, setCa] = useState({
    accountCode: rec?.cashAdvance?.accountCode ?? DV_ACCT.ADVANCES_OFFICERS,
    accountableOfficerId: rec?.cashAdvance?.accountableOfficerId ?? null,
    cashAdvanceType: (rec?.cashAdvance?.cashAdvanceType ?? 'OFFICIAL_TRAVEL') as CashAdvanceType,
    purpose: rec?.cashAdvance?.purpose ?? '',
    amount: (recCa ? rec!.grossAmount : null) as Centavos | null,
  });
  const { save, busy } = useSaveSource(DV_MODULE.key);
  const obligations = useCollection<ObligationDoc & { dvId?: string | null }>('obligations', barangayId ? [['barangayId', '==', barangayId], ['status', '==', 'CERTIFIED']] : null).rows as Obligation[];
  if (!barangayId) return null;

  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('treasury.encode', barangayId) && (!live || DV_MODULE.editableStatuses.includes(live.status));
  const isCa = f.dvCategory === 'CASH_ADVANCE';
  const obrOptions = obligations.filter((o) => !o.dvId || o.dvId === currentId || o.id === f.obligationId).sort((a, b) => (b.obligationNumber ?? '').localeCompare(a.obligationNumber ?? ''));
  const obr = obligations.find((o) => o.id === f.obligationId);

  const body = () => ({
    ...f,
    obligationId: f.obligationId || null,
    payee: { ...f.payee, id: f.payee.id ?? null },
    cashOfficerId: f.paymentMethod === 'CASH' ? f.cashOfficerId : null,
    bankAccountId: f.paymentMethod === 'CASH' ? null : f.bankAccountId,
    charges: isCa ? [{ accountCode: ca.accountCode, subsidiaryId: ca.accountableOfficerId, amount: ca.amount ?? 0 }] : charges.map((c) => ({ ...c, amount: c.amount ?? 0 })),
    taxDeductions: isCa ? [] : taxes.map((t) => ({ taxType: t.taxType, rateBp: Math.round(Number(t.ratePct) * 100), base: t.base })),
    otherDeductions: isCa ? [] : deds.map((d) => ({ ...d, amount: d.amount ?? 0 })),
    cashAdvance: isCa ? { accountableOfficerId: ca.accountableOfficerId ?? '', cashAdvanceType: ca.cashAdvanceType, purpose: ca.purpose } : null,
  });
  // Live preview with the same arithmetic the server uses.
  let totals: DvTotals | null = null;
  let totalsError: string | null = null;
  try {
    const b = body();
    totals = computeDvTotals({ charges: b.charges, taxes: b.taxDeductions, otherDeductions: b.otherDeductions });
  } catch (e) {
    totalsError = errorMessage(e);
  }
  const needsObr = !isCa && charges.some((c) => dvRequiresObligation(c.accountCode));
  const overObr = !!obr && !!totals && totals.grossAmount > obr.amount;
  const valid = f.payee.name.trim().length >= 2 && f.particulars.trim().length >= 3 && !!totals && (!needsObr || !!f.obligationId) && !overObr && (!isCa || (!!ca.accountableOfficerId && ca.purpose.trim().length >= 3)) && (f.paymentMethod !== 'CASH' || !!f.cashOfficerId);

  function pickObligation(id: string) {
    const o = obligations.find((x) => x.id === id);
    setF((cur) => ({ ...cur, obligationId: id, payee: o && !cur.payee.name.trim() ? { ...o.payee } : cur.payee, particulars: o && !cur.particulars.trim() ? o.particulars : cur.particulars }));
    // Prefill an untouched charge line from the obligation (account + certified amount).
    if (o && !isCa && charges.length === 1 && !charges[0]!.accountCode && !charges[0]!.amount) setCharges([{ accountCode: o.accountCode, subsidiaryId: null, amount: o.amount }]);
  }

  async function onSave() {
    const newId = await save(barangayId!, body(), currentId ?? undefined);
    if (newId) setCurrentId(newId);
  }

  const slField = (code: string, value: string | null, set: (v: string | null) => void, label: string) =>
    coa?.get(code)?.requiresSubsidiaryLedger ? (
      <SubsidiarySelect aria-label={label} barangayId={barangayId} accountCode={code} value={value} onChange={set} emptyLabel="— default ledger —" />
    ) : (
      <span className="block pt-2 text-xs text-slate-500">—</span>
    );

  return (
    <Modal
      open
      wide
      title={live?.dvNumber ? `DV ${live.dvNumber}` : live ? 'Disbursement voucher (draft)' : 'New disbursement voucher'}
      onClose={onClose}
      footer={
        <>
          {live && <ActionBar def={ACTION_DEF} record={live} />}
          <span className="mr-auto" />
          {live && <PrintLink code="DV" documentId={live.id} fiscalYear={live.fiscalYear ?? fiscalYear} label="Print DV" />}
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save draft'}</button>}
        </>
      }
    >
      {live && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <StatusChip status={live.status} />
          {live.dvNumber && <span className="font-mono text-sm">{live.dvNumber}</span>}
          {live.payrollId && <Link className="text-sm text-navy-700 underline" to="/payroll">From payroll</Link>}
          {live.jevNumber && <span className="text-sm text-slate-600">JEV {live.jevNumber}</span>}
        </div>
      )}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="DV date" required>{(p) => <input {...p} type="date" className="input" value={f.dvDate} onChange={(e) => setF({ ...f, dvDate: e.target.value })} />}</Field>
          <Field label="Category" required className="sm:col-span-2">
            {(p) => (
              <select {...p} className="input" value={f.dvCategory} onChange={(e) => setF({ ...f, dvCategory: e.target.value as typeof f.dvCategory })}>
                {DV_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Mode of payment" required>
            {(p) => (
              <select {...p} className="input" value={f.paymentMethod} onChange={(e) => setF({ ...f, paymentMethod: e.target.value as DvPaymentMethod })}>
                {DV_PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            )}
          </Field>
        </div>

        <Field
          label={`Certified obligation (OBR)${needsObr ? '' : ' — optional'}`}
          required={needsObr}
          error={overObr ? `The gross amount exceeds the certified obligation (${formatPesos(obr!.amount, { symbol: true })}).` : needsObr && !f.obligationId ? 'Expense and capital outlay charges need a certified obligation.' : null}
          hint={obr ? `Box B — certified ${obr.accountCode}; available for this DV: ${formatPesos(obr.amount, { symbol: true })}${obr.specialTrustFundId ? ' · charged to a Special Trust Fund' : ''}` : 'Only CERTIFIED obligations not yet paid by another DV are listed.'}
        >
          {(p) => (
            <select {...p} className="input" value={f.obligationId} onChange={(e) => pickObligation(e.target.value)}>
              <option value="">— none —</option>
              {obrOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.obligationNumber} · {o.payee?.name} · {o.accountCode} · {formatPesos(o.amount)}</option>
              ))}
            </select>
          )}
        </Field>

        <PartyInput value={f.payee} onChange={(payee) => setF({ ...f, payee })} disabled={!editable} />
        <Field label="Particulars (explanation)" required>{(p) => <textarea {...p} rows={2} className="input" value={f.particulars} onChange={(e) => setF({ ...f, particulars: e.target.value })} />}</Field>

        {isCa ? (
          <section aria-labelledby="ca-h" className="rounded-md border border-slate-200 p-3">
            <h3 id="ca-h" className="mb-2 text-sm font-semibold text-navy-800">Cash advance</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Advance account" required>
                {(p) => (
                  <select {...p} className="input" value={ca.accountCode} onChange={(e) => setCa({ ...ca, accountCode: e.target.value, accountableOfficerId: null })}>
                    <option value={DV_ACCT.ADVANCES_OFFICERS}>1-03-03-020 Advances to Officers and Employees (EO)</option>
                    <option value={DV_ACCT.ADVANCES_PAYROLL}>1-03-03-010 Advances for Payroll (AO)</option>
                  </select>
                )}
              </Field>
              <Field label="Accountable officer" required hint="Ledgers are kept under Setup → Subsidiary ledgers.">
                {(p) => <SubsidiarySelect {...p} barangayId={barangayId} accountCode={ca.accountCode} value={ca.accountableOfficerId} onChange={(v) => setCa({ ...ca, accountableOfficerId: v })} emptyLabel="— select officer —" />}
              </Field>
              <Field label="Type" required>
                {(p) => (
                  <select {...p} className="input" value={ca.cashAdvanceType} onChange={(e) => setCa({ ...ca, cashAdvanceType: e.target.value as CashAdvanceType })}>
                    {DV_CASH_ADVANCE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Purpose" required className="sm:col-span-2">{(p) => <input {...p} className="input" value={ca.purpose} onChange={(e) => setCa({ ...ca, purpose: e.target.value })} />}</Field>
              <Field label="Amount granted" required>{(p) => <MoneyInput {...p} value={ca.amount} onChange={(v) => setCa({ ...ca, amount: v })} allowZero={false} />}</Field>
            </div>
          </section>
        ) : (
          <>
            <section aria-labelledby="ch-h">
              <h3 id="ch-h" className="mb-1 text-sm font-semibold text-navy-800">Charges (accounting entry — debit)</h3>
              <LinesEditor<Charge>
                caption="Charges"
                rows={charges}
                onChange={setCharges}
                blank={blankCharge}
                max={30}
                disabled={!editable}
                columns={[
                  { label: 'Account', required: true, className: 'min-w-[12rem]', render: (r, set, i) => <AccountInput aria-label={`Charge ${i + 1} account`} value={r.accountCode} onChange={(accountCode) => set({ accountCode, subsidiaryId: null })} /> },
                  { label: 'Subsidiary ledger', className: 'min-w-[10rem]', render: (r, set, i) => slField(r.accountCode, r.subsidiaryId, (subsidiaryId) => set({ subsidiaryId }), `Charge ${i + 1} subsidiary ledger`) },
                  { label: 'Amount', numeric: true, required: true, className: 'w-40', render: (r, set, i) => <MoneyInput aria-label={`Charge ${i + 1} amount`} value={r.amount} onChange={(amount) => set({ amount })} allowZero={false} /> },
                ]}
              />
            </section>
            <section aria-labelledby="tx-h">
              <h3 id="tx-h" className="mb-1 text-sm font-semibold text-navy-800">Taxes withheld (credited to Due to BIR — BIR01)</h3>
              <LinesEditor<Tax>
                caption="Taxes withheld"
                rows={taxes}
                onChange={setTaxes}
                blank={() => ({ taxType: 'EWT', ratePct: '1', base: null })}
                min={0}
                max={6}
                addLabel="Add tax"
                disabled={!editable}
                columns={[
                  {
                    label: 'Tax',
                    render: (r, set, i) => (
                      <select aria-label={`Tax ${i + 1} type`} className="input" value={r.taxType} onChange={(e) => { const t = DV_TAX_TYPES.find((x) => x.value === e.target.value)!; set({ taxType: t.value, ratePct: String(t.defaultBp / 100) }); }}>
                        {DV_TAX_TYPES.map((t) => <option key={t.value} value={t.value}>{t.value} — {t.label}</option>)}
                      </select>
                    ),
                  },
                  { label: 'Rate %', className: 'w-24', render: (r, set, i) => <input aria-label={`Tax ${i + 1} rate in percent`} className="input num" inputMode="decimal" value={r.ratePct} onChange={(e) => set({ ratePct: e.target.value })} /> },
                  { label: 'Taxable base (blank = gross)', numeric: true, className: 'w-44', render: (r, set, i) => <MoneyInput aria-label={`Tax ${i + 1} taxable base`} value={r.base} onChange={(base) => set({ base: base || null })} /> },
                  { label: 'Amount', numeric: true, render: (_r, _s, i) => <span className="block pt-2 text-right tabular-nums">{totals ? formatPesos(totals.taxDeductions[i]?.amount ?? 0) : '—'}</span> },
                ]}
              />
            </section>
            <section aria-labelledby="od-h">
              <h3 id="od-h" className="mb-1 text-sm font-semibold text-navy-800">Other deductions</h3>
              <LinesEditor<Ded>
                caption="Other deductions"
                rows={deds}
                onChange={setDeds}
                blank={() => ({ description: '', accountCode: '', subsidiaryId: null, amount: null })}
                min={0}
                max={20}
                addLabel="Add deduction"
                disabled={!editable}
                columns={[
                  { label: 'Description', render: (r, set, i) => <input aria-label={`Deduction ${i + 1} description`} className="input" value={r.description} onChange={(e) => set({ description: e.target.value })} /> },
                  { label: 'Account', className: 'min-w-[11rem]', render: (r, set, i) => <AccountInput aria-label={`Deduction ${i + 1} account`} value={r.accountCode} onChange={(accountCode) => set({ accountCode, subsidiaryId: null })} prefixes={['2-', '1-03', '4-']} /> },
                  { label: 'Subsidiary ledger', className: 'min-w-[10rem]', render: (r, set, i) => slField(r.accountCode, r.subsidiaryId, (subsidiaryId) => set({ subsidiaryId }), `Deduction ${i + 1} subsidiary ledger`) },
                  { label: 'Amount', numeric: true, className: 'w-40', render: (r, set, i) => <MoneyInput aria-label={`Deduction ${i + 1} amount`} value={r.amount} onChange={(amount) => set({ amount })} allowZero={false} /> },
                ]}
              />
            </section>
          </>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          {f.paymentMethod === 'CASH' ? (
            <Field label="Cash paid from (BT ledger)" required>
              {(p) => <SubsidiarySelect {...p} barangayId={barangayId} accountCode={DV_ACCT.CASH_LOCAL_TREASURY} value={f.cashOfficerId} onChange={(v) => setF({ ...f, cashOfficerId: v })} emptyLabel="— select —" />}
            </Field>
          ) : (
            <Field label="Bank account (preferred)" hint="The account is fixed when the check / ADA is issued.">
              {(p) => <BankAccountSelect {...p} barangayId={barangayId} value={f.bankAccountId} onChange={(v) => setF({ ...f, bankAccountId: v })} />}
            </Field>
          )}
        </div>
      </fieldset>

      <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3" aria-live="polite">
        {totals ? (
          <InfoGrid
            columns={4}
            items={[
              ['Gross amount', <Money key="g" value={totals.grossAmount} />],
              ['Taxes withheld', <Money key="t" value={totals.totalTaxes} />],
              ['Other deductions', <Money key="o" value={totals.totalOtherDeductions} />],
              ['Net amount (amount due)', <strong key="n" className="text-base"><Money value={totals.netAmount} /></strong>],
            ]}
          />
        ) : (
          <p className="text-sm text-slate-700">{totalsError}</p>
        )}
      </div>

      {live && ['APPROVED', 'ACCEPTED', 'POSTED'].includes(live.status) && <PaymentPanel dv={live} />}
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}

/** Check / ADA / cash payment of an approved DV, release, and cancellation (number retained). */
function PaymentPanel({ dv }: { dv: Dv }) {
  const { can } = useAuth();
  const { notify } = useToast();
  const today = manilaToday();
  const dflt = today < dv.dvDate ? dv.dvDate : today;
  const [bank, setBank] = useState<string | null>(dv.bankAccountId);
  const [checkNo, setCheckNo] = useState('');
  const [date, setDate] = useState(dflt);
  const [releaseDate, setReleaseDate] = useState(dflt);
  const [cancel, setCancel] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelAs, setCancelAs] = useState<'CANCELLED' | 'VOID'>('CANCELLED');
  const [busy, setBusy] = useState(false);
  const canPay = dv.status === 'APPROVED' && can('treasury.submit', dv.barangayId);
  const what = dv.paymentMethod === 'CHECK' ? 'check' : dv.paymentMethod === 'ADA' ? 'ADA' : 'cash';

  async function run(action: string, payload: Record<string, unknown>, remarks?: string) {
    setBusy(true);
    try {
      await api.sourceAction({ module: DV_MODULE.key, id: dv.id, action, payload, remarks });
      notify(`DV ${dv.dvNumber}: ${action.replace(/_/g, ' ').toLowerCase()} done.`, 'success');
      setCancel(false);
      setReason('');
      setCheckNo('');
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="pay-h" className="mt-4 rounded-md border border-slate-200 p-3">
      <h3 id="pay-h" className="mb-2 text-sm font-semibold text-navy-800">Payment</h3>
      <InfoGrid
        columns={4}
        items={[
          ['Mode', dv.paymentMethod],
          ['Status', dv.paymentStatus],
          [dv.paymentMethod === 'ADA' ? 'ADA no.' : 'Check no.', dv.checkNumber ?? dv.adaNumber ?? '—'],
          ['Date / released', `${dv.paymentDate ?? '—'} / ${dv.releasedDate ?? '—'}`],
        ]}
      />
      {!!dv.cancelledPayments?.length && (
        <p className="mt-2 text-xs text-slate-600">Cancelled: {dv.cancelledPayments.map((c) => `${c.kind} ${c.number} (${c.status.toLowerCase()} ${c.date}: ${c.reason})`).join('; ')}</p>
      )}
      {canPay && dv.paymentStatus === 'UNPAID' && dv.paymentMethod !== 'CASH' && (
        <div className="mt-3 grid items-end gap-3 sm:grid-cols-4">
          <Field label="Bank account" required className="sm:col-span-2">{(p) => <BankAccountSelect {...p} barangayId={dv.barangayId} value={bank} onChange={(v) => setBank(v)} />}</Field>
          {dv.paymentMethod === 'CHECK' && <Field label="Check no." required>{(p) => <input {...p} className="input font-mono" inputMode="numeric" value={checkNo} onChange={(e) => setCheckNo(e.target.value.replace(/\D/g, ''))} />}</Field>}
          <Field label={`${what === 'check' ? 'Check' : 'ADA'} date`} required>{(p) => <input {...p} type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <div className="sm:col-span-4">
            {dv.paymentMethod === 'CHECK' ? (
              <button type="button" className="btn-primary" disabled={busy || !bank || checkNo.length < 4} onClick={() => void run('ISSUE_CHECK', { bankAccountId: bank, checkNumber: checkNo, checkDate: date })}>Issue check for {formatPesos(dv.netAmount, { symbol: true })}</button>
            ) : (
              <button type="button" className="btn-primary" disabled={busy || !bank} onClick={() => void run('ISSUE_ADA', { bankAccountId: bank, adaDate: date })}>Issue ADA for {formatPesos(dv.netAmount, { symbol: true })}</button>
            )}
          </div>
        </div>
      )}
      {canPay && ((dv.paymentStatus === 'ISSUED' && dv.paymentMethod !== 'CASH') || (dv.paymentStatus === 'UNPAID' && dv.paymentMethod === 'CASH')) && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={dv.paymentMethod === 'CASH' ? 'Date paid' : 'Release date'} required>{(p) => <input {...p} type="date" className="input" value={releaseDate} onChange={(e) => setReleaseDate(e.target.value)} />}</Field>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void run('RELEASE', { releasedDate: releaseDate })}>{dv.paymentMethod === 'CASH' ? 'Record cash payment' : `Release ${what}`}</button>
        </div>
      )}
      {canPay && dv.paymentStatus !== 'UNPAID' && dv.paymentMethod !== 'CASH' && (
        <div className="mt-3">
          <button type="button" className="btn-danger" disabled={busy} onClick={() => setCancel(true)}>Cancel {what}…</button>
        </div>
      )}
      {cancel && (
        <ConfirmDialog
          open
          danger
          busy={busy}
          title={`Cancel ${what} ${dv.checkNumber ?? dv.adaNumber ?? ''}`}
          message={
            <div className="space-y-3">
              <p>The {what} keeps its number in the register with the status below and cannot be reused. You can then issue a new {what} for this DV.</p>
              <div>
                <label className="label" htmlFor="cancel-as">Record as</label>
                <select id="cancel-as" className="input" value={cancelAs} onChange={(e) => setCancelAs(e.target.value as 'CANCELLED' | 'VOID')}>
                  <option value="CANCELLED">Cancelled (spoiled / not released)</option>
                  <option value="VOID">Void (released but not to be honored)</option>
                </select>
              </div>
            </div>
          }
          confirmLabel={`Cancel ${what}`}
          requireReason
          reason={reason}
          onReasonChange={setReason}
          onCancel={() => setCancel(false)}
          onConfirm={() => void run('CANCEL_PAYMENT', { status: cancelAs, cancelledDate: today }, reason.trim())}
        />
      )}
    </section>
  );
}
