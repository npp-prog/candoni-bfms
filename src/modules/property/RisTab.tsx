import { REQUISITION_MODULE, manilaToday, type PropertySigner, type RequisitionDoc, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { LinesEditor } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, PrintLink, ReturnBanner, WorkflowTrail, statusOptions, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { ItemSelect, QtyInput, SignerInput, emptySigner, useItems } from './common';

type Ris = WithId<RequisitionDoc>;

/** Requisition and Issue Slips: request (PB approves) → issue (stock cards reduced at moving-average cost). */
export function RisTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const { rows, loading } = useCollection<RequisitionDoc>('requisitions', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
  if (!barangayId) return null;
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => b.risDate.localeCompare(a.risDate));
  return (
    <>
      <RegisterTable
        caption={`Requisition and issue slips FY ${fiscalYear}`}
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter value={status} onChange={setStatus} options={statusOptions(REQUISITION_MODULE).filter((s) => s !== 'POSTED')} />
            <div className="ml-auto">{can('property.manage', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New RIS</button>}</div>
          </>
        }
        empty={`No requisitions for FY ${fiscalYear}.`}
        columns={[
          { label: 'RIS no.', render: (r) => r.risNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Date', render: (r) => r.risDate },
          { label: 'Office', render: (r) => r.office },
          { label: 'Purpose', className: 'max-w-sm truncate', render: (r) => r.purpose },
          { label: 'Items', numeric: true, render: (r) => r.lines.length },
          { label: 'Issued cost', numeric: true, render: (r) => <Money value={r.totalIssuedCost} /> },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <RisEditor id={open === 'new' ? null : open} rows={rows} onClose={() => setOpen(null)} />}
    </>
  );
}

type Line = { itemId: string | null; quantityRequested: number; remarks: string };

function RisEditor({ id, rows, onClose }: { id: string | null; rows: Ris[]; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const items = useItems(barangayId).rows;
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [currentId, setCurrentId] = useState(id);
  const [f, setF] = useState({
    risDate: rec?.risDate ?? manilaToday(),
    office: rec?.office ?? '',
    responsibilityCenterCode: rec?.responsibilityCenterCode ?? '',
    purpose: rec?.purpose ?? '',
    requestedBy: (rec?.requestedBy ?? emptySigner()) as PropertySigner,
    receivedBy: (rec?.receivedBy ?? emptySigner()) as PropertySigner,
    lines: (rec?.lines.map((l) => ({ itemId: l.itemId, quantityRequested: l.quantityRequested, remarks: l.remarks })) ?? [{ itemId: null, quantityRequested: 1, remarks: '' }]) as Line[],
  });
  const [issue, setIssue] = useState<{ issueDate: string; qty: number[] }>({ issueDate: manilaToday(), qty: rec?.lines.map((l) => l.quantityRequested) ?? [] });
  const { save, busy } = useSaveSource(REQUISITION_MODULE.key);
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('property.manage', barangayId) && (!live || REQUISITION_MODULE.editableStatuses.includes(live.status));
  const valid = f.purpose.trim().length >= 3 && f.lines.length > 0 && f.lines.every((l) => l.itemId && l.quantityRequested > 0);

  async function onSave() {
    const newId = await save(barangayId!, { ...f, lines: f.lines.map((l) => ({ ...l, itemId: l.itemId! })) }, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  }

  return (
    <Modal
      open
      wide
      title={live?.risNumber ? `RIS ${live.risNumber}` : live ? 'Requisition (draft)' : 'New requisition and issue slip'}
      onClose={onClose}
      footer={
        <>
          {live && (
            <ActionBar
              def={REQUISITION_MODULE}
              record={live}
              payload={(a) => (a === 'ISSUE' ? { issueDate: issue.issueDate, issued: live.lines.map((_, i) => ({ line: i, quantityIssued: issue.qty[i] ?? live.lines[i]!.quantityRequested })), ...(f.receivedBy.name ? { receivedBy: f.receivedBy } : {}) } : undefined)}
            />
          )}
          <span className="mr-auto" />
          {live && <PrintLink code="RIS" documentId={live.id} fiscalYear={live.fiscalYear} label="Print RIS" className="btn-ghost" />}
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save draft'}</button>}
        </>
      }
    >
      {live && <div className="mb-3 flex items-center gap-2"><StatusChip status={live.status} />{live.risNumber && <span className="font-mono text-sm">{live.risNumber}</span>}</div>}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Date" required>{(p) => <input {...p} type="date" className="input" value={f.risDate} onChange={(e) => setF({ ...f, risDate: e.target.value })} />}</Field>
          <Field label="Division / office" className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.office} onChange={(e) => setF({ ...f, office: e.target.value })} />}</Field>
          <Field label="Responsibility center code">{(p) => <input {...p} className="input" value={f.responsibilityCenterCode} onChange={(e) => setF({ ...f, responsibilityCenterCode: e.target.value })} />}</Field>
        </div>
        <Field label="Purpose" required>{(p) => <textarea {...p} rows={2} className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} />}</Field>
        <SignerInput label="Requested by" value={f.requestedBy} onChange={(requestedBy) => setF({ ...f, requestedBy })} />
        <LinesEditor<Line>
          caption="Items requested"
          rows={f.lines}
          onChange={(lines) => setF({ ...f, lines })}
          blank={() => ({ itemId: null, quantityRequested: 1, remarks: '' })}
          disabled={!editable}
          columns={[
            { label: 'Stock item', required: true, className: 'min-w-[18rem]', render: (r, set) => <ItemSelect items={items} value={r.itemId} onChange={(itemId) => set({ itemId })} filter={(i) => i.itemClass === 'CONSUMABLE'} /> },
            { label: 'Qty requested', numeric: true, required: true, render: (r, set) => <QtyInput value={r.quantityRequested} onChange={(quantityRequested) => set({ quantityRequested })} /> },
            { label: 'Remarks', render: (r, set) => <input className="input" value={r.remarks} onChange={(e) => set({ remarks: e.target.value })} /> },
          ]}
        />
      </fieldset>
      {live && live.status === 'APPROVED' && can('property.manage', barangayId) && (
        <div className="mt-4 space-y-3 rounded-md border border-sky-200 bg-sky-50 p-3">
          <p className="text-sm font-semibold text-sky-900">Issue: quantities to release (default = requested)</p>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Issue date">{(p) => <input {...p} type="date" className="input" value={issue.issueDate} onChange={(e) => setIssue({ ...issue, issueDate: e.target.value })} />}</Field>
            {live.lines.map((l, i) => (
              <Field key={i} label={`${l.stockNumber} (req. ${l.quantityRequested})`}>{(p) => <QtyInput {...p} value={issue.qty[i] ?? l.quantityRequested} onChange={(v) => setIssue({ ...issue, qty: live.lines.map((x, j) => (j === i ? v : issue.qty[j] ?? x.quantityRequested)) })} />}</Field>
            ))}
          </div>
          <SignerInput label="Received by" value={f.receivedBy} onChange={(receivedBy) => setF({ ...f, receivedBy })} />
        </div>
      )}
      {live && live.status === 'ISSUED' && (
        <div className="mt-4 overflow-x-auto">
          <table className="table-base">
            <caption className="text-left text-sm font-semibold">Issued on {live.issueDate}</caption>
            <thead><tr><th scope="col">Stock no.</th><th scope="col">Description</th><th scope="col" className="num">Issued</th><th scope="col" className="num">Unit cost</th><th scope="col" className="num">Amount</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {live.lines.map((l, i) => <tr key={i}><td className="font-mono text-xs">{l.stockNumber}</td><td>{l.description}</td><td className="num">{l.quantityIssued} {l.unit}</td><td className="num"><Money value={l.unitCost} /></td><td className="num"><Money value={l.amount} /></td></tr>)}
            </tbody>
          </table>
        </div>
      )}
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}
