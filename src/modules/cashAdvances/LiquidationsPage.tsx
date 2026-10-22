import { LIQUIDATION_MAX_ITEMS, LIQUIDATION_MODULE, manilaToday, type CashAdvanceRecord, type Centavos, type LiquidationRecord, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AccountInput, InfoGrid, LinesEditor, MoneyInput, SubsidiarySelect } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, PrintLink, ReturnBanner, WorkflowTrail, reportHref, statusOptions, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, PageHeader, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useChartOfAccounts } from '../../hooks/useChartOfAccounts';
import { useCollection } from '../../hooks/useCollection';
import { Cell, SumLine } from './common';

type Lr = WithId<LiquidationRecord>;
type Ca = WithId<CashAdvanceRecord>;
const OPEN = ['ACTIVE', 'PARTIALLY_LIQUIDATED', 'OVERDUE'];

/** Phase 6 — Liquidation Reports: register and editor (items grid, refund, live balance). */
export function LiquidationsPage() {
  const { can } = useAuth();
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(params.get('ca') ? 'new' : null);
  const { rows, loading } = useCollection<LiquidationRecord>('liquidations', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
  const cas = useCollection<CashAdvanceRecord>('cashAdvances', barangayId ? [['barangayId', '==', barangayId]] : null).rows;
  if (!barangayId) return null;
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => b.liquidationDate.localeCompare(a.liquidationDate) || (b.liquidationNumber ?? '').localeCompare(a.liquidationNumber ?? ''));
  const close = () => {
    setOpen(null);
    if (params.get('ca')) setParams({}, { replace: true });
  };
  return (
    <>
      <PageHeader
        title="Liquidations"
        subtitle={`${barangayLabel} · FY ${fiscalYear} · Liquidation Reports of cash advances`}
        breadcrumbs={['BFMS', 'Liquidations']}
        actions={
          <>
            <Link className="btn-secondary" to="/cash-advances">Cash advances</Link>
            <Link className="btn-secondary" to={reportHref('CASHBOOK_DO', { fiscalYear, month: Number(manilaToday().slice(5, 7)) })}>Cashbook (DO)</Link>
            {can('treasury.encode', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New liquidation report</button>}
          </>
        }
      />
      <RegisterTable
        caption={`Liquidation reports for FY ${fiscalYear}`}
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={<StatusFilter value={status} onChange={setStatus} options={statusOptions(LIQUIDATION_MODULE)} />}
        empty={`No liquidation reports for FY ${fiscalYear}.`}
        columns={[
          { label: 'LR no.', render: (r) => r.liquidationNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Date', render: (r) => r.liquidationDate },
          { label: 'Officer', render: (r) => r.accountableOfficerName },
          { label: 'CA (DV no.)', render: (r) => r.caDvNumber },
          { label: 'Supported', numeric: true, render: (r) => <Money value={r.totalSupported} /> },
          { label: 'Refunded', numeric: true, render: (r) => <Money value={r.cashRefunded} /> },
          { label: 'Balance left', numeric: true, render: (r) => <Money value={r.balanceRemaining} /> },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <LiquidationEditor id={open === 'new' ? null : open} initialCa={params.get('ca')} rows={rows} cas={cas} onClose={close} />}
    </>
  );
}

type Item = { date: string; supplier: string; officialReceiptNumber: string; invoiceNumber: string; particulars: string; accountCode: string; subsidiaryId: string | null; amount: Centavos | null };

function LiquidationEditor({ id, initialCa, rows, cas, onClose }: { id: string | null; initialCa: string | null; rows: Lr[]; cas: Ca[]; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const coa = useChartOfAccounts();
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [currentId, setCurrentId] = useState(id);
  const [f, setF] = useState(() => ({
    cashAdvanceId: rec?.cashAdvanceId ?? initialCa ?? '',
    liquidationDate: rec?.liquidationDate ?? manilaToday(),
    items: (rec?.items ?? []).map((i): Item => ({ ...i, officialReceiptNumber: i.officialReceiptNumber ?? '', invoiceNumber: i.invoiceNumber ?? '' })),
    cashRefunded: (rec?.cashRefunded ?? 0) as Centavos | null,
    refundOrNumber: rec?.refundOrNumber ?? '',
    refundOrDate: rec?.refundOrDate ?? '',
    refundCashSubsidiaryId: rec?.refundCashSubsidiaryId ?? (null as string | null),
    remarks: rec?.remarks ?? '',
  }));
  const { save, busy } = useSaveSource(LIQUIDATION_MODULE.key);
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('treasury.encode', barangayId) && (!live || LIQUIDATION_MODULE.editableStatuses.includes(live.status));
  const ca = cas.find((c) => c.id === f.cashAdvanceId);
  const choices = cas.filter((c) => OPEN.includes(c.status) || c.id === f.cashAdvanceId).sort((a, b) => a.grantDate.localeCompare(b.grantDate));
  // Before acceptance the balance is the advance's current outstanding; afterwards, the snapshot.
  const outstanding = live && !editable ? live.outstandingBefore : ca?.outstandingBalance ?? 0;
  const total = f.items.reduce((t, i) => t + (i.amount ?? 0), 0);
  const refund = f.cashRefunded ?? 0;
  const balance = outstanding - total - refund;
  const itemsOk = f.items.every((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.date) && i.date <= f.liquidationDate && i.particulars.trim().length >= 2 && coa?.get(i.accountCode) && (i.amount ?? 0) > 0 && (!coa.get(i.accountCode)?.requiresSubsidiaryLedger || i.subsidiaryId));
  const refundOk = refund === 0 || (f.refundOrNumber.trim() && f.refundCashSubsidiaryId);
  const valid = !!ca && (f.items.length > 0 || refund > 0) && itemsOk && refundOk && f.cashRefunded !== null && balance >= 0;
  const blank = (): Item => ({ date: f.liquidationDate, supplier: '', officialReceiptNumber: '', invoiceNumber: '', particulars: '', accountCode: '', subsidiaryId: null, amount: 0 as Centavos });

  async function onSave() {
    const data = {
      ...f,
      items: f.items.map((i) => ({ ...i, amount: i.amount ?? 0, officialReceiptNumber: i.officialReceiptNumber || null, invoiceNumber: i.invoiceNumber || null })),
      cashRefunded: refund,
      refundOrNumber: f.refundOrNumber || null,
      refundOrDate: refund ? f.refundOrDate || null : null,
      refundCashSubsidiaryId: refund ? f.refundCashSubsidiaryId : null,
    };
    const newId = await save(barangayId!, data, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  }

  return (
    <Modal
      open
      wide
      title={live?.liquidationNumber ? `Liquidation Report ${live.liquidationNumber}` : live ? 'Liquidation report (draft)' : 'New liquidation report'}
      onClose={onClose}
      footer={
        <>
          {live && <ActionBar def={LIQUIDATION_MODULE} record={live} />}
          <span className="mr-auto" />
          {live && <PrintLink code="LR" documentId={live.id} fiscalYear={live.fiscalYear} label="Print LR" />}
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save draft'}</button>}
        </>
      }
    >
      {live && <div className="mb-3 flex flex-wrap items-center gap-2"><StatusChip status={live.status} />{live.jevId && <span className="text-xs text-slate-600">Journal entry generated — see Journal Entries.</span>}</div>}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Cash advance" required className="sm:col-span-3" hint={ca ? `${ca.accountableOfficerName} · ${ca.purpose} · due ${ca.liquidationDueDate}` : 'Only unliquidated advances are listed.'}>
            {(p) => (
              <select {...p} className="input" value={f.cashAdvanceId} disabled={!!live || !editable} onChange={(e) => setF({ ...f, cashAdvanceId: e.target.value })}>
                <option value="">— select cash advance —</option>
                {choices.map((c) => <option key={c.id} value={c.id}>DV {c.dvNumber} · {c.grantDate} · {c.accountableOfficerName} · outstanding ₱{(c.outstandingBalance / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</option>)}
              </select>
            )}
          </Field>
          <Field label="Liquidation date" required>{(p) => <input {...p} type="date" className="input" value={f.liquidationDate} onChange={(e) => setF({ ...f, liquidationDate: e.target.value })} />}</Field>
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold text-slate-800">Supported expenditures <span className="font-normal text-slate-600">(per OR / invoice; up to {LIQUIDATION_MAX_ITEMS} items)</span></h3>
          <LinesEditor<Item>
            caption="Liquidation items"
            rows={f.items}
            onChange={(items) => setF({ ...f, items })}
            blank={blank}
            min={0}
            max={LIQUIDATION_MAX_ITEMS}
            disabled={!editable}
            addLabel="Add item"
            columns={[
              { label: 'Date', required: true, render: (r, set, i) => <Cell label={`Item ${i + 1} date`}>{(id) => <input id={id} type="date" className="input w-36" value={r.date} onChange={(e) => set({ date: e.target.value })} />}</Cell> },
              { label: 'Supplier', render: (r, set, i) => <Cell label={`Item ${i + 1} supplier`}>{(id) => <input id={id} className="input w-36" value={r.supplier} onChange={(e) => set({ supplier: e.target.value })} />}</Cell> },
              { label: 'OR no.', render: (r, set, i) => <Cell label={`Item ${i + 1} OR number`}>{(id) => <input id={id} className="input w-24" value={r.officialReceiptNumber} onChange={(e) => set({ officialReceiptNumber: e.target.value })} />}</Cell> },
              { label: 'Invoice no.', render: (r, set, i) => <Cell label={`Item ${i + 1} invoice number`}>{(id) => <input id={id} className="input w-24" value={r.invoiceNumber} onChange={(e) => set({ invoiceNumber: e.target.value })} />}</Cell> },
              { label: 'Particulars', required: true, render: (r, set, i) => <Cell label={`Item ${i + 1} particulars`}>{(id) => <input id={id} className="input min-w-[12rem]" value={r.particulars} onChange={(e) => set({ particulars: e.target.value })} />}</Cell> },
              {
                label: 'Account',
                required: true,
                render: (r, set, i) => (
                  <div className="w-44 space-y-1">
                    <Cell label={`Item ${i + 1} account`}>{(id) => <AccountInput id={id} value={r.accountCode} prefixes={['5-', '1-04', '1-05', '1-06', '1-07', '2-']} onChange={(v) => set({ accountCode: v, subsidiaryId: null })} />}</Cell>
                    {coa?.get(r.accountCode)?.requiresSubsidiaryLedger && <Cell label={`Item ${i + 1} subsidiary ledger`}>{(id) => <SubsidiarySelect id={id} barangayId={barangayId} accountCode={r.accountCode} value={r.subsidiaryId} onChange={(v) => set({ subsidiaryId: v })} emptyLabel="— ledger —" />}</Cell>}
                  </div>
                ),
              },
              { label: 'Amount', numeric: true, required: true, render: (r, set, i) => <Cell label={`Item ${i + 1} amount`}>{(id) => <MoneyInput id={id} className="w-32" value={r.amount} onChange={(v) => set({ amount: v })} allowZero={false} />}</Cell> },
            ]}
            footer={<span className="text-sm font-semibold">Total spent: ₱<Money value={total} dashZero={false} /></span>}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Cash refunded" hint="Unused cash returned under an OR.">{(p) => <MoneyInput {...p} value={f.cashRefunded} onChange={(v) => setF({ ...f, cashRefunded: v })} />}</Field>
          <Field label="Refund OR no." required={refund > 0}>{(p) => <input {...p} className="input" value={f.refundOrNumber} onChange={(e) => setF({ ...f, refundOrNumber: e.target.value })} disabled={!refund || !editable} />}</Field>
          <Field label="OR date">{(p) => <input {...p} type="date" className="input" value={f.refundOrDate} onChange={(e) => setF({ ...f, refundOrDate: e.target.value })} disabled={!refund || !editable} />}</Field>
          <Field label="Received by (collecting officer)" required={refund > 0}>
            {(p) => <SubsidiarySelect {...p} barangayId={barangayId} accountCode="1-01-01-010" value={f.refundCashSubsidiaryId} onChange={(v) => setF({ ...f, refundCashSubsidiaryId: v })} disabled={!refund || !editable} emptyLabel="— BT## —" />}
          </Field>
        </div>
        <Field label="Remarks">{(p) => <textarea {...p} rows={2} className="input" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />}</Field>
      </fieldset>
      <section aria-live="polite" className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 sm:ml-auto sm:max-w-md">
        <SumLine label="Outstanding cash advance" value={outstanding} />
        <SumLine label="Less: supported expenditures" value={total} />
        <SumLine label="Less: cash refunded" value={refund} />
        <div className="my-1 border-t border-slate-300" />
        <SumLine label="Balance remaining (unliquidated)" value={balance} strong danger={balance < 0} />
        {balance < 0 && <p className="mt-1 text-xs text-red-700">Expenditures and refund exceed the cash advance. The excess must be reimbursed through a separate DV.</p>}
      </section>
      {live && live.status !== 'DRAFT' && (
        <div className="mt-4"><InfoGrid columns={4} items={[['Cash advance (DV)', live.caDvNumber], ['Officer', live.accountableOfficerName], ['Granted', live.caGrantDate], ['Items', String(live.itemCount)]]} /></div>
      )}
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}
