import { DISPOSAL_MODES, PROPERTY_DOC_MODULES, TRANSFER_TYPES, manilaToday, type Centavos, type PropertyDocumentDoc, type PropertyDocumentType, type PropertySigner, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { LinesEditor, MoneyInput } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, PrintLink, ReturnBanner, WorkflowTrail, statusOptions, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, StatusChip, Tabs } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { ItemSelect, PpePicker, QtyInput, SignerInput, emptySigner, useItems, usePpe } from './common';

const TYPES: Array<{ type: PropertyDocumentType; tab: string; title: string; print: string | null; hint: string }> = [
  { type: 'ICS', tab: 'ICS', title: 'Inventory Custodian Slip', print: 'ICS', hint: 'Semi-expendable items (below ₱50,000) issued to an end user; deducted from stock on issue.' },
  { type: 'PAR', tab: 'PAR', title: 'Property Acknowledgement Receipt', print: 'PAR', hint: 'PPE issued to an accountable officer.' },
  { type: 'PTR', tab: 'Transfers (PTR)', title: 'Property Transfer Report', print: null, hint: 'Moves PPE to another accountable officer or location.' },
  { type: 'RRPE', tab: 'Returns (RRPE)', title: 'Receipt of Returned Property', print: 'RRPE', hint: 'PPE returned to the property office.' },
  { type: 'IIRUP', tab: 'Unserviceable (IIRUP)', title: 'Inventory and Inspection Report of Unserviceable Property', print: null, hint: 'PB approval makes the property UNSERVICEABLE; disposal then removes it from the books.' },
];
type TabName = (typeof TYPES)[number]['tab'];

/** ICS, PAR, transfers, returns and unserviceable property (propertyDocuments). */
export function CustodyTab() {
  const [tab, setTab] = useState<TabName>('ICS');
  const t = TYPES.find((x) => x.tab === tab)!;
  return (
    <>
      <Tabs tabs={TYPES.map((x) => x.tab)} value={tab} onChange={setTab} label="Property documents" idPrefix="custody" />
      <div id="custody-panel" role="tabpanel">
        <p className="mb-3 text-sm text-slate-600">{t.hint}</p>
        <DocRegister key={t.type} type={t.type} />
      </div>
    </>
  );
}

function DocRegister({ type }: { type: PropertyDocumentType }) {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const def = PROPERTY_DOC_MODULES[type];
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const { rows, loading } = useCollection<PropertyDocumentDoc>('propertyDocuments', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear], ['documentType', '==', type]] : null);
  if (!barangayId) return null;
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <RegisterTable
        caption={`${type} documents FY ${fiscalYear}`}
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter id={`${type}-status`} value={status} onChange={setStatus} options={statusOptions(def).filter((s) => s !== 'POSTED')} />
            <div className="ml-auto">{can('property.manage', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New {type}</button>}</div>
          </>
        }
        empty={`No ${type} documents for FY ${fiscalYear}.`}
        columns={[
          { label: 'No.', render: (r) => r.documentNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Date', render: (r) => r.date },
          { label: type === 'IIRUP' ? 'Accountable' : type === 'RRPE' ? 'Returned by' : 'Received by', render: (r) => (type === 'IIRUP' ? r.fromAccountable : r.receivedBy?.name) },
          { label: 'Items', numeric: true, render: (r) => r.lines.length },
          { label: 'Amount', numeric: true, render: (r) => <Money value={r.totalAmount} /> },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <DocEditor type={type} id={open === 'new' ? null : open} rows={rows} onClose={() => setOpen(null)} />}
    </>
  );
}

type IcsLine = { itemId: string | null; quantity: number; estimatedUsefulLife: number | null; inventoryItemNo: string; remarks: string };
type PpeLineIn = { ppeId: string; condition: 'SERVICEABLE' | 'UNSERVICEABLE'; disposalMode: 'SALE' | 'TRANSFER' | 'DESTRUCTION' | 'OTHERS'; appraisedValue: Centavos | null; remarks: string };

function DocEditor({ type, id, rows, onClose }: { type: PropertyDocumentType; id: string | null; rows: Array<WithId<PropertyDocumentDoc>>; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const def = PROPERTY_DOC_MODULES[type];
  const meta = TYPES.find((t) => t.type === type)!;
  const items = useItems(barangayId).rows;
  const ppe = usePpe(barangayId).rows;
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [currentId, setCurrentId] = useState(id);
  const [f, setF] = useState({
    date: rec?.date ?? manilaToday(),
    receivedBy: (rec?.receivedBy ?? emptySigner()) as PropertySigner,
    transferType: rec?.transferType || TRANSFER_TYPES[0],
    toLocation: rec?.toLocation || (type === 'RRPE' ? 'Property / Supply Office' : ''),
    reason: rec?.reason ?? '',
    remarks: rec?.remarks ?? '',
    icsLines: (rec && type === 'ICS' ? rec.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, estimatedUsefulLife: l.estimatedUsefulLife, inventoryItemNo: l.propertyNumber, remarks: l.remarks })) : [{ itemId: null, quantity: 1, estimatedUsefulLife: 3, inventoryItemNo: '', remarks: '' }]) as IcsLine[],
    ppeLines: (rec && type !== 'ICS' ? rec.lines.map((l) => ({ ppeId: l.ppeId!, condition: (l.condition ?? 'SERVICEABLE') as PpeLineIn['condition'], disposalMode: l.disposalMode ?? 'DESTRUCTION', appraisedValue: (l.appraisedValue ?? 0) as Centavos, remarks: l.remarks })) : []) as PpeLineIn[],
  });
  const [dispose, setDispose] = useState({ disposalDate: manilaToday(), disposalReference: '', disposalAmount: 0 as Centavos | null });
  const { save, busy } = useSaveSource(def.key);
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('property.manage', barangayId) && (!live || def.editableStatuses.includes(live.status));
  const ppeIds = f.ppeLines.map((l) => l.ppeId);
  const setPpeIds = (ids: string[]) => setF({ ...f, ppeLines: ids.map((pid) => f.ppeLines.find((l) => l.ppeId === pid) ?? { ppeId: pid, condition: 'SERVICEABLE', disposalMode: 'DESTRUCTION', appraisedValue: 0 as Centavos, remarks: '' }) });
  const needsReceiver = type !== 'IIRUP';
  const valid =
    (!needsReceiver || f.receivedBy.name.trim().length >= 2) &&
    (type === 'ICS' ? f.icsLines.length > 0 && f.icsLines.every((l) => l.itemId && l.quantity > 0) : ppeIds.length > 0) &&
    ((type !== 'PTR' && type !== 'RRPE') || f.reason.trim().length >= 3);

  function payload() {
    const base = { date: f.date, remarks: f.remarks };
    switch (type) {
      case 'ICS': return { ...base, receivedBy: f.receivedBy, lines: f.icsLines.map((l) => ({ ...l, itemId: l.itemId! })) };
      case 'PAR': return { ...base, receivedBy: f.receivedBy, ppeIds };
      case 'PTR': return { ...base, receivedBy: f.receivedBy, transferType: f.transferType, toLocation: f.toLocation, reason: f.reason, ppeIds };
      case 'RRPE': return { ...base, receivedBy: f.receivedBy, toLocation: f.toLocation, reason: f.reason, lines: f.ppeLines.map((l) => ({ ppeId: l.ppeId, condition: l.condition, remarks: l.remarks })) };
      case 'IIRUP': return { ...base, lines: f.ppeLines.map((l) => ({ ppeId: l.ppeId, disposalMode: l.disposalMode, appraisedValue: l.appraisedValue ?? 0, remarks: l.remarks })) };
    }
  }
  const onSave = async () => {
    const newId = await save(barangayId, payload(), currentId ?? undefined);
    if (newId) setCurrentId(newId);
  };
  const ppeOf = (pid: string) => ppe.find((p) => p.id === pid);

  return (
    <Modal
      open
      wide
      title={`${meta.title}${live?.documentNumber ? ` ${live.documentNumber}` : live ? ' (draft)' : ''}`}
      onClose={onClose}
      footer={
        <>
          {live && <ActionBar def={def} record={live} payload={(a) => (a === 'DISPOSE' ? { ...dispose, disposalAmount: dispose.disposalAmount ?? 0 } : undefined)} />}
          <span className="mr-auto" />
          {live && meta.print && <PrintLink code={meta.print} documentId={live.id} fiscalYear={live.fiscalYear} label={`Print ${meta.print}`} className="btn-ghost" />}
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save draft'}</button>}
        </>
      }
    >
      {live && <div className="mb-3 flex items-center gap-2"><StatusChip status={live.status} />{live.documentNumber && <span className="font-mono text-sm">{live.documentNumber}</span>}</div>}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Date" required>{(p) => <input {...p} type="date" className="input" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
          {type === 'PTR' && (
            <Field label="Transfer type">{(p) => <select {...p} className="input" value={f.transferType} onChange={(e) => setF({ ...f, transferType: e.target.value })}>{TRANSFER_TYPES.map((t) => <option key={t}>{t}</option>)}</select>}</Field>
          )}
          {(type === 'PTR' || type === 'RRPE') && <Field label={type === 'PTR' ? 'New location' : 'Returned to (location)'}>{(p) => <input {...p} className="input" value={f.toLocation} onChange={(e) => setF({ ...f, toLocation: e.target.value })} />}</Field>}
        </div>
        {needsReceiver && <SignerInput label={type === 'RRPE' ? 'Returned by' : type === 'PTR' ? 'New accountable officer' : 'Received by'} value={f.receivedBy} onChange={(receivedBy) => setF({ ...f, receivedBy })} office required />}
        {(type === 'PTR' || type === 'RRPE') && <Field label="Reason" required>{(p) => <input {...p} className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>}
        {type === 'ICS' ? (
          <LinesEditor<IcsLine>
            caption="Semi-expendable items"
            rows={f.icsLines}
            onChange={(icsLines) => setF({ ...f, icsLines })}
            blank={() => ({ itemId: null, quantity: 1, estimatedUsefulLife: 3, inventoryItemNo: '', remarks: '' })}
            disabled={!editable}
            columns={[
              { label: 'Stock item', required: true, className: 'min-w-[18rem]', render: (r, set) => <ItemSelect items={items} value={r.itemId} onChange={(itemId) => set({ itemId })} filter={(i) => i.itemClass === 'SEMI_EXPENDABLE'} /> },
              { label: 'Qty', numeric: true, render: (r, set) => <QtyInput value={r.quantity} onChange={(quantity) => set({ quantity })} /> },
              { label: 'Inventory item no.', render: (r, set) => <input className="input w-32" value={r.inventoryItemNo} onChange={(e) => set({ inventoryItemNo: e.target.value })} /> },
              { label: 'Est. useful life (yrs)', render: (r, set) => <input type="number" min={1} max={20} className="input num w-20" value={r.estimatedUsefulLife ?? ''} onChange={(e) => set({ estimatedUsefulLife: e.target.value ? Number(e.target.value) : null })} /> },
            ]}
          />
        ) : (
          <>
            {editable && <PpePicker ppe={ppe} value={ppeIds} onChange={setPpeIds} filter={type === 'PAR' ? (p) => !p.parId : undefined} />}
            {f.ppeLines.length > 0 && (
              <div className="overflow-x-auto">
                <table className="table-base">
                  <caption className="sr-only">Property on this document</caption>
                  <thead>
                    <tr>
                      <th scope="col">Property no.</th><th scope="col">Description</th><th scope="col" className="num">Cost</th>
                      {type === 'RRPE' && <th scope="col">Condition</th>}
                      {type === 'IIRUP' && <><th scope="col">Disposal</th><th scope="col" className="num">Appraised value</th></>}
                      {(type === 'RRPE' || type === 'IIRUP') && <th scope="col">Remarks</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {f.ppeLines.map((l, i) => {
                      const p = ppeOf(l.ppeId);
                      const set = (patch: Partial<PpeLineIn>) => setF({ ...f, ppeLines: f.ppeLines.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                      return (
                        <tr key={l.ppeId}>
                          <td className="font-mono text-xs">{p?.propertyNumber}</td>
                          <td>{p?.description}</td>
                          <td className="num"><Money value={p?.acquisitionCost ?? 0} /></td>
                          {type === 'RRPE' && <td><select className="input" aria-label="Condition" value={l.condition} onChange={(e) => set({ condition: e.target.value as PpeLineIn['condition'] })}><option value="SERVICEABLE">Serviceable</option><option value="UNSERVICEABLE">Unserviceable</option></select></td>}
                          {type === 'IIRUP' && (
                            <>
                              <td><select className="input" aria-label="Disposal mode" value={l.disposalMode} onChange={(e) => set({ disposalMode: e.target.value as PpeLineIn['disposalMode'] })}>{DISPOSAL_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></td>
                              <td><MoneyInput value={l.appraisedValue} onChange={(appraisedValue) => set({ appraisedValue })} aria-describedby={undefined} /></td>
                            </>
                          )}
                          {(type === 'RRPE' || type === 'IIRUP') && <td><input className="input" aria-label="Remarks" value={l.remarks} onChange={(e) => set({ remarks: e.target.value })} /></td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <Field label="Remarks">{(p) => <input {...p} className="input" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />}</Field>
      </fieldset>
      {live && type === 'IIRUP' && live.status === 'APPROVED' && can('property.manage', barangayId) && (
        <div className="mt-4 grid gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 sm:grid-cols-3">
          <p className="text-sm font-semibold text-amber-900 sm:col-span-3">Disposal details (used by “Record disposal”)</p>
          <Field label="Disposal date">{(p) => <input {...p} type="date" className="input" value={dispose.disposalDate} onChange={(e) => setDispose({ ...dispose, disposalDate: e.target.value })} />}</Field>
          <Field label="Reference (OR no. / witness report)">{(p) => <input {...p} className="input" value={dispose.disposalReference} onChange={(e) => setDispose({ ...dispose, disposalReference: e.target.value })} />}</Field>
          <Field label="Sale proceeds">{(p) => <MoneyInput {...p} value={dispose.disposalAmount} onChange={(v) => setDispose({ ...dispose, disposalAmount: v })} />}</Field>
        </div>
      )}
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}
