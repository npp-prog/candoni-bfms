import {
  CAPITALIZATION_THRESHOLD,
  DONATION_MODULE,
  INSPECTION_MODULE,
  PURCHASE_ORDER_MODULE,
  PURCHASE_REQUEST_MODULE,
  extendedCost,
  formatPesos,
  manilaToday,
  ppeAccountsFor,
  type Centavos,
  type InspectionReportDoc,
  type PartyRef,
  type PropertySigner,
  type PurchaseOrderDoc,
  type PurchaseRequestDoc,
  type ReceiptLineKind,
  type SourceModuleDef,
  type WithId,
} from '@bfms/shared';
import { useState } from 'react';
import { AccountInput, LinesEditor, MoneyInput, PartyInput, emptyParty } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, PrintLink, ReturnBanner, WorkflowTrail, statusOptions, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, StatusChip, Tabs } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { ItemSelect, QtyInput, SignerInput, emptySigner, useItems } from './common';

const TABS = ['Purchase requests', 'Purchase orders', 'Inspection & acceptance / donations'] as const;

/** Procurement documents for printing and traceability (not a full BAC system): PR → PO → IAR. */
export function ProcurementTab() {
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  return (
    <>
      <Tabs<(typeof TABS)[number]> tabs={TABS} value={tab} onChange={setTab} label="Procurement documents" idPrefix="proc" />
      <div id="proc-panel" role="tabpanel">
        {tab === TABS[0] && <PrRegister />}
        {tab === TABS[1] && <PoRegister />}
        {tab === TABS[2] && <IarRegister />}
      </div>
    </>
  );
}

function useScoped<T>(col: string) {
  const { barangayId, fiscalYear } = useBarangay();
  return useCollection<T>(col, barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
}

function Toolbar({ def, status, setStatus, onNew, newLabel }: { def: SourceModuleDef; status: string; setStatus(v: string): void; onNew?(): void; newLabel: string }) {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  return (
    <>
      <StatusFilter id={`${def.key}-status`} value={status} onChange={setStatus} options={statusOptions(def).filter((s) => s !== 'POSTED')} />
      <div className="ml-auto flex gap-2">{barangayId && can('property.manage', barangayId) && onNew && <button type="button" className="btn-primary" onClick={onNew}><Icon name="plus" /> {newLabel}</button>}</div>
    </>
  );
}

/** Footer common to the document editors. */
function EditorFooter({ def, live, code, editable, busy, valid, onSave, onClose }: { def: SourceModuleDef; live: { id: string; barangayId: string; status: string; fiscalYear: number; createdBy?: string } | null; code: string; editable: boolean; busy: boolean; valid: boolean; onSave(): void; onClose(): void }) {
  return (
    <>
      {live && <ActionBar def={def} record={live} />}
      <span className="mr-auto" />
      {live && <PrintLink code={code} documentId={live.id} fiscalYear={live.fiscalYear} label={`Print ${code}`} className="btn-ghost" />}
      <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
      {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={onSave}>{busy ? 'Saving…' : 'Save draft'}</button>}
    </>
  );
}

// ------------------------------------------------------------------ PR

type PrLineIn = { itemId: string | null; stockNumber: string; unit: string; description: string; quantity: number; estimatedUnitCost: Centavos | null };

function PrRegister() {
  const { rows, loading } = useScoped<PurchaseRequestDoc>('purchaseRequests');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => b.prDate.localeCompare(a.prDate));
  return (
    <>
      <RegisterTable
        caption="Purchase requests"
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={<Toolbar def={PURCHASE_REQUEST_MODULE} status={status} setStatus={setStatus} onNew={() => setOpen('new')} newLabel="New PR" />}
        empty="No purchase requests this year."
        columns={[
          { label: 'PR no.', render: (r) => r.prNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Date', render: (r) => r.prDate },
          { label: 'Office', render: (r) => r.office },
          { label: 'Purpose', className: 'max-w-sm truncate', render: (r) => r.purpose },
          { label: 'Estimated cost', numeric: true, render: (r) => <Money value={r.totalEstimatedCost} /> },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <PrEditor id={open === 'new' ? null : open} rows={rows} onClose={() => setOpen(null)} />}
    </>
  );
}

function PrEditor({ id, rows, onClose }: { id: string | null; rows: Array<WithId<PurchaseRequestDoc>>; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const items = useItems(barangayId).rows;
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [currentId, setCurrentId] = useState(id);
  const [f, setF] = useState({
    prDate: rec?.prDate ?? manilaToday(),
    office: rec?.office ?? '',
    responsibilityCenterCode: rec?.responsibilityCenterCode ?? '',
    purpose: rec?.purpose ?? '',
    requestedBy: (rec?.requestedBy ?? emptySigner()) as PropertySigner,
    lines: (rec?.lines ?? [{ itemId: null, stockNumber: '', unit: 'piece', description: '', quantity: 1, estimatedUnitCost: 0 }]) as PrLineIn[],
  });
  const { save, busy } = useSaveSource(PURCHASE_REQUEST_MODULE.key);
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('property.manage', barangayId) && (!live || PURCHASE_REQUEST_MODULE.editableStatuses.includes(live.status));
  const total = f.lines.reduce((t, l) => t + extendedCost(l.quantity, l.estimatedUnitCost ?? 0), 0);
  const valid = f.purpose.trim().length >= 3 && f.lines.every((l) => l.description.trim().length >= 2 && l.unit.trim() && l.quantity > 0 && l.estimatedUnitCost !== null);
  const onSave = async () => {
    const newId = await save(barangayId, { ...f, lines: f.lines.map((l) => ({ ...l, estimatedUnitCost: l.estimatedUnitCost ?? 0 })) }, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  };
  return (
    <Modal open wide title={live?.prNumber ? `Purchase request ${live.prNumber}` : 'Purchase request'} onClose={onClose} footer={<EditorFooter def={PURCHASE_REQUEST_MODULE} live={live} code="PR" editable={editable} busy={busy} valid={valid} onSave={() => void onSave()} onClose={onClose} />}>
      {live && <div className="mb-3"><StatusChip status={live.status} /></div>}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Date" required>{(p) => <input {...p} type="date" className="input" value={f.prDate} onChange={(e) => setF({ ...f, prDate: e.target.value })} />}</Field>
          <Field label="Office / section" className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.office} onChange={(e) => setF({ ...f, office: e.target.value })} />}</Field>
          <Field label="Responsibility center code">{(p) => <input {...p} className="input" value={f.responsibilityCenterCode} onChange={(e) => setF({ ...f, responsibilityCenterCode: e.target.value })} />}</Field>
        </div>
        <Field label="Purpose" required>{(p) => <textarea {...p} rows={2} className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} />}</Field>
        <SignerInput label="Requested by" value={f.requestedBy} onChange={(requestedBy) => setF({ ...f, requestedBy })} />
        <LinesEditor<PrLineIn>
          caption="Items"
          rows={f.lines}
          onChange={(lines) => setF({ ...f, lines })}
          blank={() => ({ itemId: null, stockNumber: '', unit: 'piece', description: '', quantity: 1, estimatedUnitCost: 0 as Centavos })}
          disabled={!editable}
          footer={<span className="text-sm font-semibold">Total: ₱{formatPesos(total as Centavos)}</span>}
          columns={[
            { label: 'Stock item (optional)', className: 'min-w-[14rem]', render: (r, set) => <ItemSelect items={items} value={r.itemId} onChange={(itemId) => { const it = items.find((i) => i.id === itemId); set({ itemId, ...(it ? { unit: it.unit, description: r.description || it.description } : {}) }); }} /> },
            { label: 'Unit', required: true, render: (r, set) => <input className="input w-24" value={r.unit} onChange={(e) => set({ unit: e.target.value })} /> },
            { label: 'Item description', required: true, className: 'min-w-[16rem]', render: (r, set) => <input className="input" value={r.description} onChange={(e) => set({ description: e.target.value })} /> },
            { label: 'Qty', numeric: true, required: true, render: (r, set) => <QtyInput value={r.quantity} onChange={(quantity) => set({ quantity })} /> },
            { label: 'Est. unit cost', numeric: true, render: (r, set) => <MoneyInput value={r.estimatedUnitCost} onChange={(estimatedUnitCost) => set({ estimatedUnitCost })} /> },
          ]}
        />
      </fieldset>
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}

// ------------------------------------------------------------------ PO

type PoLineIn = { prLineNo: number | null; itemId: string | null; stockNumber: string; unit: string; description: string; quantity: number; unitCost: Centavos | null };

function PoRegister() {
  const { rows, loading } = useScoped<PurchaseOrderDoc>('purchaseOrders');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => b.poDate.localeCompare(a.poDate));
  return (
    <>
      <RegisterTable
        caption="Purchase orders"
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={<Toolbar def={PURCHASE_ORDER_MODULE} status={status} setStatus={setStatus} onNew={() => setOpen('new')} newLabel="New PO" />}
        empty="No purchase orders this year. Approve a purchase request first."
        columns={[
          { label: 'PO no.', render: (r) => r.poNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Date', render: (r) => r.poDate },
          { label: 'Supplier', render: (r) => r.supplier?.name },
          { label: 'PR', render: (r) => r.prNumber },
          { label: 'Amount', numeric: true, render: (r) => <Money value={r.totalAmount} /> },
          { label: 'Delivery', render: (r) => <StatusChip status={r.deliveryStatus} /> },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <PoEditor id={open === 'new' ? null : open} rows={rows} onClose={() => setOpen(null)} />}
    </>
  );
}

function PoEditor({ id, rows, onClose }: { id: string | null; rows: Array<WithId<PurchaseOrderDoc>>; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const prs = useScoped<PurchaseRequestDoc>('purchaseRequests').rows;
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [currentId, setCurrentId] = useState(id);
  const [f, setF] = useState({
    poDate: rec?.poDate ?? manilaToday(),
    purchaseRequestId: rec?.purchaseRequestId ?? '',
    supplier: (rec?.supplier ?? emptyParty()) as PartyRef,
    modeOfProcurement: rec?.modeOfProcurement ?? 'Small Value Procurement',
    placeOfDelivery: rec?.placeOfDelivery ?? 'Barangay Hall',
    dateOfDelivery: rec?.dateOfDelivery ?? '',
    deliveryTerm: rec?.deliveryTerm ?? '',
    paymentTerm: rec?.paymentTerm ?? '',
    lines: (rec?.lines ?? []) as PoLineIn[],
  });
  const { save, busy } = useSaveSource(PURCHASE_ORDER_MODULE.key);
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('property.manage', barangayId) && (!live || PURCHASE_ORDER_MODULE.editableStatuses.includes(live.status));
  const approvedPrs = prs.filter((p) => p.status === 'APPROVED' || p.id === f.purchaseRequestId);
  const pr = prs.find((p) => p.id === f.purchaseRequestId);
  const total = f.lines.reduce((t, l) => t + extendedCost(l.quantity, l.unitCost ?? 0), 0);
  const valid = !!f.purchaseRequestId && f.supplier.name.trim().length >= 2 && f.lines.length > 0 && f.lines.every((l) => l.description.trim().length >= 2 && l.quantity > 0 && l.unitCost !== null);
  const pickPr = (prId: string) => {
    const p = prs.find((x) => x.id === prId);
    setF({ ...f, purchaseRequestId: prId, lines: p ? p.lines.map((l, i) => ({ prLineNo: i + 1, itemId: l.itemId, stockNumber: l.stockNumber, unit: l.unit, description: l.description, quantity: l.quantity, unitCost: l.estimatedUnitCost })) : [] });
  };
  const onSave = async () => {
    const newId = await save(barangayId, { ...f, dateOfDelivery: f.dateOfDelivery || null, supplier: { ...f.supplier, id: f.supplier.id ?? null }, lines: f.lines.map((l) => ({ ...l, unitCost: l.unitCost ?? 0 })) }, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  };
  return (
    <Modal open wide title={live?.poNumber ? `Purchase order ${live.poNumber}` : 'Purchase order'} onClose={onClose} footer={<EditorFooter def={PURCHASE_ORDER_MODULE} live={live} code="PO" editable={editable} busy={busy} valid={valid} onSave={() => void onSave()} onClose={onClose} />}>
      {live && <div className="mb-3 flex gap-2"><StatusChip status={live.status} /><StatusChip status={live.deliveryStatus} /></div>}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Date" required>{(p) => <input {...p} type="date" className="input" value={f.poDate} onChange={(e) => setF({ ...f, poDate: e.target.value })} />}</Field>
          <Field label="Purchase request" required className="sm:col-span-3" hint="Choosing a PR copies its items; adjust quantities and costs as awarded.">
            {(p) => (
              <select {...p} className="input" value={f.purchaseRequestId} onChange={(e) => pickPr(e.target.value)}>
                <option value="">— select an approved PR —</option>
                {approvedPrs.map((x) => <option key={x.id} value={x.id}>{x.prNumber} · {x.prDate} · {x.purpose.slice(0, 60)}</option>)}
              </select>
            )}
          </Field>
        </div>
        <PartyInput label="Supplier" value={f.supplier} onChange={(supplier) => setF({ ...f, supplier })} />
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Mode of procurement">{(p) => <input {...p} className="input" value={f.modeOfProcurement} onChange={(e) => setF({ ...f, modeOfProcurement: e.target.value })} />}</Field>
          <Field label="Place of delivery">{(p) => <input {...p} className="input" value={f.placeOfDelivery} onChange={(e) => setF({ ...f, placeOfDelivery: e.target.value })} />}</Field>
          <Field label="Date of delivery">{(p) => <input {...p} type="date" className="input" value={f.dateOfDelivery ?? ''} onChange={(e) => setF({ ...f, dateOfDelivery: e.target.value })} />}</Field>
          <Field label="Delivery term">{(p) => <input {...p} className="input" value={f.deliveryTerm} onChange={(e) => setF({ ...f, deliveryTerm: e.target.value })} />}</Field>
          <Field label="Payment term">{(p) => <input {...p} className="input" value={f.paymentTerm} onChange={(e) => setF({ ...f, paymentTerm: e.target.value })} />}</Field>
        </div>
        {f.lines.length > 0 && (
          <LinesEditor<PoLineIn>
            caption="Items ordered"
            rows={f.lines}
            onChange={(lines) => setF({ ...f, lines })}
            blank={() => ({ prLineNo: null, itemId: null, stockNumber: '', unit: 'piece', description: '', quantity: 1, unitCost: 0 as Centavos })}
            disabled={!editable}
            footer={<span className="text-sm font-semibold">Total: ₱{formatPesos(total as Centavos)}</span>}
            columns={[
              { label: 'PR line', render: (r) => <span className="text-xs text-slate-600">{r.prLineNo ?? '—'}</span> },
              { label: 'Unit', render: (r, set) => <input className="input w-24" value={r.unit} onChange={(e) => set({ unit: e.target.value })} /> },
              { label: 'Description', required: true, className: 'min-w-[16rem]', render: (r, set) => <input className="input" value={r.description} onChange={(e) => set({ description: e.target.value })} /> },
              { label: 'Qty', numeric: true, render: (r, set) => <QtyInput value={r.quantity} onChange={(quantity) => set({ quantity })} /> },
              { label: 'Unit cost', numeric: true, render: (r, set) => <MoneyInput value={r.unitCost} onChange={(unitCost) => set({ unitCost })} /> },
            ]}
          />
        )}
        {pr && <p className="text-xs text-slate-600">PR estimate: ₱{formatPesos(pr.totalEstimatedCost)}</p>}
      </fieldset>
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}

// ------------------------------------------------------------------ IAR / ARDSM

type RecLineIn = { poLineNo: number | null; kind: ReceiptLineKind; itemId: string | null; description: string; unit: string; quantity: number; unitCost: Centavos | null; accountCode: string; usefulLifeYears: number; location: string; accountablePerson: string };

function IarRegister() {
  const { rows, loading } = useScoped<InspectionReportDoc>('inspectionReports');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<{ id: string | null; donation: boolean } | null>(null);
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => b.iarDate.localeCompare(a.iarDate));
  return (
    <>
      <RegisterTable
        caption="Inspection and acceptance reports and donations"
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen({ id: r.id, donation: r.receiptType === 'DONATION' })}
        toolbar={
          <>
            <StatusFilter id="iar-status" value={status} onChange={setStatus} options={statusOptions(INSPECTION_MODULE).filter((s) => s !== 'POSTED')} />
            {barangayId && can('property.manage', barangayId) && (
              <div className="ml-auto flex gap-2">
                <button type="button" className="btn-secondary" onClick={() => setOpen({ id: null, donation: true })}><Icon name="plus" /> Donation (ARDSM)</button>
                <button type="button" className="btn-primary" onClick={() => setOpen({ id: null, donation: false })}><Icon name="plus" /> New IAR</button>
              </div>
            )}
          </>
        }
        empty="No deliveries received this year."
        columns={[
          { label: 'No.', render: (r) => r.documentNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Type', render: (r) => (r.receiptType === 'DONATION' ? 'Donation' : 'Purchase') },
          { label: 'Date', render: (r) => r.iarDate },
          { label: 'Supplier / donor', render: (r) => r.supplier?.name },
          { label: 'PO', render: (r) => r.poNumber ?? '—' },
          { label: 'Amount', numeric: true, render: (r) => <Money value={r.totalAmount} /> },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <IarEditor id={open.id} donation={open.donation} rows={rows} onClose={() => setOpen(null)} />}
    </>
  );
}

function IarEditor({ id, donation, rows, onClose }: { id: string | null; donation: boolean; rows: Array<WithId<InspectionReportDoc>>; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const items = useItems(barangayId).rows;
  const pos = useScoped<PurchaseOrderDoc>('purchaseOrders').rows;
  const def = donation ? DONATION_MODULE : INSPECTION_MODULE;
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [currentId, setCurrentId] = useState(id);
  const toLine = (l: InspectionReportDoc['lines'][number]): RecLineIn => ({ poLineNo: l.poLineNo, kind: l.kind, itemId: l.itemId, description: l.description, unit: l.unit, quantity: l.quantity, unitCost: l.unitCost, accountCode: l.ppe?.accountCode ?? '1-07-05-020', usefulLifeYears: l.ppe?.usefulLifeYears ?? 5, location: l.ppe?.location ?? '', accountablePerson: l.ppe?.accountablePerson ?? '' });
  const blank = (): RecLineIn => ({ poLineNo: null, kind: 'SUPPLY', itemId: null, description: '', unit: 'piece', quantity: 1, unitCost: 0 as Centavos, accountCode: '1-07-05-020', usefulLifeYears: 5, location: '', accountablePerson: '' });
  const [f, setF] = useState({
    iarDate: rec?.iarDate ?? manilaToday(),
    purchaseOrderId: rec?.purchaseOrderId ?? '',
    supplier: (rec?.supplier ?? emptyParty()) as PartyRef,
    invoiceNumber: rec?.invoiceNumber ?? '',
    invoiceDate: rec?.invoiceDate ?? '',
    requisitioningOffice: rec?.requisitioningOffice ?? '',
    inspectionDate: rec?.inspectionDate ?? '',
    inspectedBy: rec?.inspectedBy ?? '',
    remarks: rec?.remarks ?? '',
    lines: (rec?.lines.map(toLine) ?? (donation ? [blank()] : [])) as RecLineIn[],
  });
  const { save, busy } = useSaveSource(def.key);
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('property.manage', barangayId) && (!live || def.editableStatuses.includes(live.status));
  const openPos = pos.filter((p) => (p.status === 'APPROVED' && p.deliveryStatus !== 'COMPLETE') || p.id === f.purchaseOrderId);
  const pickPo = (poId: string) => {
    const p = pos.find((x) => x.id === poId);
    setF({
      ...f,
      purchaseOrderId: poId,
      lines: p
        ? p.lines
            .map((l, i) => ({ l, i }))
            .filter(({ l }) => l.quantityReceived < l.quantity)
            .map(({ l, i }) => ({ ...blank(), poLineNo: i + 1, kind: l.unitCost >= CAPITALIZATION_THRESHOLD ? 'PPE' : 'SUPPLY', itemId: l.itemId, description: l.description, unit: l.unit, quantity: l.quantity - l.quantityReceived, unitCost: l.unitCost }))
        : [],
    });
  };
  const lineOk = (l: RecLineIn) => l.quantity > 0 && l.unitCost !== null && (l.kind === 'SUPPLY' ? !!l.itemId && l.unitCost < CAPITALIZATION_THRESHOLD : l.unitCost >= CAPITALIZATION_THRESHOLD && /^1-07-\d{2}-\d{3}$/.test(l.accountCode) && l.description.trim().length >= 2);
  const valid = (donation ? f.supplier.name.trim().length >= 2 : !!f.purchaseOrderId) && f.lines.length > 0 && f.lines.every(lineOk);
  const onSave = async () => {
    const data = {
      ...f,
      purchaseOrderId: donation ? null : f.purchaseOrderId,
      supplier: donation ? { ...f.supplier, id: f.supplier.id ?? null } : undefined,
      invoiceDate: f.invoiceDate || null,
      inspectionDate: f.inspectionDate || null,
      lines: f.lines.map((l) => ({ poLineNo: l.poLineNo, kind: l.kind, itemId: l.kind === 'SUPPLY' ? l.itemId : null, description: l.description, unit: l.unit, quantity: l.quantity, unitCost: l.unitCost ?? 0, ppe: l.kind === 'PPE' ? { accountCode: l.accountCode, usefulLifeYears: l.usefulLifeYears, residualValue: null, location: l.location, accountablePerson: l.accountablePerson } : null })),
    };
    const newId = await save(barangayId, data, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  };
  return (
    <Modal open wide title={`${donation ? 'Donation receipt (ARDSM)' : 'Inspection and acceptance report'}${live?.documentNumber ? ` ${live.documentNumber}` : ''}`} onClose={onClose} footer={<EditorFooter def={def} live={live} code={donation ? 'ARDSM' : 'AIR'} editable={editable} busy={busy} valid={valid} onSave={() => void onSave()} onClose={onClose} />}>
      {live && <div className="mb-3"><StatusChip status={live.status} /></div>}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Date received" required>{(p) => <input {...p} type="date" className="input" value={f.iarDate} onChange={(e) => setF({ ...f, iarDate: e.target.value })} />}</Field>
          {!donation && (
            <Field label="Purchase order" required className="sm:col-span-3" hint="Choosing a PO copies the undelivered items.">
              {(p) => (
                <select {...p} className="input" value={f.purchaseOrderId} onChange={(e) => pickPo(e.target.value)}>
                  <option value="">— select an approved PO —</option>
                  {openPos.map((x) => <option key={x.id} value={x.id}>{x.poNumber} · {x.supplier?.name} · {formatPesos(x.totalAmount)}</option>)}
                </select>
              )}
            </Field>
          )}
        </div>
        {donation && <PartyInput label="Donor" value={f.supplier} onChange={(supplier) => setF({ ...f, supplier })} />}
        <div className="grid gap-3 sm:grid-cols-4">
          {!donation && <Field label="Invoice no.">{(p) => <input {...p} className="input" value={f.invoiceNumber} onChange={(e) => setF({ ...f, invoiceNumber: e.target.value })} />}</Field>}
          {!donation && <Field label="Invoice date">{(p) => <input {...p} type="date" className="input" value={f.invoiceDate ?? ''} onChange={(e) => setF({ ...f, invoiceDate: e.target.value })} />}</Field>}
          <Field label="Requisitioning office">{(p) => <input {...p} className="input" value={f.requisitioningOffice} onChange={(e) => setF({ ...f, requisitioningOffice: e.target.value })} />}</Field>
          <Field label="Date inspected">{(p) => <input {...p} type="date" className="input" value={f.inspectionDate ?? ''} onChange={(e) => setF({ ...f, inspectionDate: e.target.value })} />}</Field>
          <Field label="Inspection officer / committee" className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.inspectedBy} onChange={(e) => setF({ ...f, inspectedBy: e.target.value })} />}</Field>
          <Field label="Remarks" className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />}</Field>
        </div>
        <p className="text-xs text-slate-600">Items of ₱{formatPesos(CAPITALIZATION_THRESHOLD)} or more per unit are PPE (one property number each); cheaper items are received on a stock card.</p>
        <LinesEditor<RecLineIn>
          caption="Items delivered"
          rows={f.lines}
          onChange={(lines) => setF({ ...f, lines })}
          blank={blank}
          disabled={!editable}
          columns={[
            { label: 'Kind', render: (r, set) => <select className="input w-28" value={r.kind} onChange={(e) => set({ kind: e.target.value as ReceiptLineKind })}><option value="SUPPLY">Stock</option><option value="PPE">PPE</option></select> },
            {
              label: 'Item / PPE details',
              className: 'min-w-[22rem]',
              render: (r, set) =>
                r.kind === 'SUPPLY' ? (
                  <ItemSelect items={items} value={r.itemId} onChange={(itemId) => set({ itemId })} />
                ) : (
                  <div className="space-y-2">
                    <input className="input" placeholder="Description, brand, model, serial no." value={r.description} onChange={(e) => set({ description: e.target.value })} aria-label="PPE description" />
                    <div className="grid grid-cols-2 gap-2">
                      <AccountInput value={r.accountCode} prefixes={['1-07']} onChange={(accountCode) => set({ accountCode })} aria-describedby={undefined} />
                      <input type="number" min={1} className="input num" aria-label="Useful life (years)" title="Useful life (years)" value={r.usefulLifeYears} onChange={(e) => set({ usefulLifeYears: Number(e.target.value) })} />
                      <input className="input" placeholder="Location" aria-label="Location" value={r.location} onChange={(e) => set({ location: e.target.value })} />
                      <input className="input" placeholder="Accountable person" aria-label="Accountable person" value={r.accountablePerson} onChange={(e) => set({ accountablePerson: e.target.value })} />
                    </div>
                    <p className="text-[11px] text-slate-600">{(() => { try { const a = ppeAccountsFor(r.accountCode); return a.depreciable ? `Depreciation: ${a.depreciationExpenseAccountCode} / ${a.accumulatedDepreciationAccountCode}` : 'Not depreciated'; } catch { return 'Enter a 1-07 PPE account'; } })()}</p>
                  </div>
                ),
            },
            { label: 'Qty', numeric: true, render: (r, set) => <QtyInput value={r.quantity} onChange={(quantity) => set({ quantity })} /> },
            { label: 'Unit cost', numeric: true, render: (r, set) => <MoneyInput value={r.unitCost} onChange={(unitCost) => set({ unitCost })} /> },
            { label: 'Check', render: (r) => (lineOk(r) ? <span className="text-xs text-emerald-700">OK</span> : <span className="text-xs text-red-700">{r.kind === 'SUPPLY' && (r.unitCost ?? 0) >= CAPITALIZATION_THRESHOLD ? 'Capitalize as PPE' : r.kind === 'PPE' && (r.unitCost ?? 0) < CAPITALIZATION_THRESHOLD ? 'Below threshold' : 'Incomplete'}</span>) },
          ]}
        />
      </fieldset>
      {live?.status === 'ACCEPTED' && live.lines.some((l) => l.propertyNumbers?.length) && (
        <p className="mt-3 text-sm text-emerald-800">PPE created: {live.lines.flatMap((l) => l.propertyNumbers ?? []).join(', ')}</p>
      )}
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}

