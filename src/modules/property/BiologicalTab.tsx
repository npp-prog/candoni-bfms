import { BIOLOGICAL_ASSET_MODULE, BIO_KINDS, manilaToday, type BioMovementKind, type BiologicalAssetDoc, type Centavos, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MoneyInput } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, ReturnBanner, WorkflowTrail, reportHref, statusOptions, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { Panel, propertyApi, useCall } from './common';

/** Biological assets (livestock, trees): register, PB approval, then births/deaths/dispositions as movements. */
export function BiologicalTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const { rows, loading } = useCollection<BiologicalAssetDoc>('biologicalAssets', barangayId ? [['barangayId', '==', barangayId]] : null);
  if (!barangayId) return null;
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => (a.assetNumber ?? '').localeCompare(b.assetNumber ?? ''));
  return (
    <>
      <RegisterTable
        caption="Biological assets"
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter id="bio-status" value={status} onChange={setStatus} options={statusOptions(BIOLOGICAL_ASSET_MODULE).filter((s) => s !== 'POSTED')} />
            <Link className="btn-secondary" to={reportHref('QRBA', { fiscalYear })}>QRBA</Link>
            <Link className="btn-secondary" to={reportHref('BAPC', { fiscalYear })}>Property cards (BAPC)</Link>
            <div className="ml-auto">{can('property.manage', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New biological asset</button>}</div>
          </>
        }
        empty="No biological assets registered."
        columns={[
          { label: 'Card no.', render: (r) => r.assetNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Kind', render: (r) => r.kind },
          { label: 'Description', className: 'max-w-xs truncate', render: (r) => r.description },
          { label: 'On hand', numeric: true, render: (r) => `${r.quantityOnHand} ${r.unit}` },
          { label: 'Carrying amount', numeric: true, render: (r) => <Money value={r.carryingAmount} /> },
          { label: 'Custodian', render: (r) => r.custodian },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <BioEditor id={open === 'new' ? null : open} rows={rows} onClose={() => setOpen(null)} />}
    </>
  );
}

function BioEditor({ id, rows, onClose }: { id: string | null; rows: Array<WithId<BiologicalAssetDoc>>; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [currentId, setCurrentId] = useState(id);
  const [f, setF] = useState({
    kind: rec?.kind ?? '',
    description: rec?.description ?? '',
    unit: rec?.unit ?? 'head',
    accountCode: rec?.accountCode ?? '1-08-01-010',
    acquisitionDate: rec?.acquisitionDate ?? manilaToday(),
    quantity: rec?.quantity ?? 1,
    unitCost: (rec?.unitCost ?? 0) as Centavos | null,
    fairValue: (rec?.fairValue ?? null) as Centavos | null,
    location: rec?.location ?? '',
    custodian: rec?.custodian ?? '',
    remarks: rec?.remarks ?? '',
  });
  const { save, busy } = useSaveSource(BIOLOGICAL_ASSET_MODULE.key);
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('property.manage', barangayId) && (!live || BIOLOGICAL_ASSET_MODULE.editableStatuses.includes(live.status));
  const valid = f.kind.trim().length >= 2 && f.quantity > 0 && Number.isInteger(f.quantity) && f.unitCost !== null;
  const onSave = async () => {
    const newId = await save(barangayId, { ...f, unitCost: f.unitCost ?? 0, fairValue: f.fairValue || null }, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  };
  return (
    <Modal
      open
      wide
      title={live?.assetNumber ? `Biological asset ${live.assetNumber}` : 'Biological asset'}
      onClose={onClose}
      footer={
        <>
          {live && <ActionBar def={BIOLOGICAL_ASSET_MODULE} record={live} />}
          <span className="mr-auto" />
          {live?.assetNumber && <Link className="btn-ghost" to={reportHref('BAPC', { fiscalYear, documentId: live.id })}><Icon name="file" /> BAPC</Link>}
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save draft'}</button>}
        </>
      }
    >
      {live && <div className="mb-3"><StatusChip status={live.status} /></div>}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-4">
        <Field label="Kind (e.g. Carabao, Goat)" required>{(p) => <input {...p} className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} />}</Field>
        <Field label="Description" className="sm:col-span-3">{(p) => <input {...p} className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <Field label="Date acquired" required>{(p) => <input {...p} type="date" className="input" value={f.acquisitionDate} onChange={(e) => setF({ ...f, acquisitionDate: e.target.value })} />}</Field>
        <Field label="Quantity" required>{(p) => <input {...p} type="number" min={1} step={1} className="input num" value={f.quantity} onChange={(e) => setF({ ...f, quantity: Number(e.target.value) })} />}</Field>
        <Field label="Unit">{(p) => <input {...p} className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />}</Field>
        <Field label="Unit cost" required>{(p) => <MoneyInput {...p} value={f.unitCost} onChange={(v) => setF({ ...f, unitCost: v })} />}</Field>
        <Field label="Fair value per unit" hint="If measured at fair value less costs to sell.">{(p) => <MoneyInput {...p} value={f.fairValue} onChange={(v) => setF({ ...f, fairValue: v })} />}</Field>
        <Field label="Location">{(p) => <input {...p} className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />}</Field>
        <Field label="Custodian / caretaker" className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.custodian} onChange={(e) => setF({ ...f, custodian: e.target.value })} />}</Field>
      </fieldset>
      {live && live.status === 'ACTIVE' && <BioMovements asset={live} />}
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}

function BioMovements({ asset }: { asset: WithId<BiologicalAssetDoc> }) {
  const { can } = useAuth();
  const { run, busy } = useCall();
  const [m, setM] = useState({ date: manilaToday(), kind: 'BIRTH' as BioMovementKind, quantity: 1, amount: 0 as Centavos | null, reference: '', remarks: '' });
  const increase = m.kind === 'BIRTH' || m.kind === 'ACQUISITION';
  return (
    <Panel title={`Movements · ${asset.quantityOnHand} ${asset.unit} on hand · ₱${(asset.carryingAmount / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`}>
      <ol className="mb-3 space-y-1 text-sm">
        {(asset.movements ?? []).map((x) => (
          <li key={x.seq} className="flex flex-wrap gap-2"><span className="tabular-nums text-slate-600">{x.date}</span><StatusChip status={x.kind} /><span>{x.quantity}</span><span className="text-slate-600">{[x.reference, x.remarks].filter(Boolean).join(' · ')}</span><span className="ml-auto tabular-nums">bal. {x.balanceQuantity}</span></li>
        ))}
      </ol>
      {can('property.manage', asset.barangayId) && (
        <form className="grid gap-3 sm:grid-cols-6" onSubmit={(e) => { e.preventDefault(); void run(() => propertyApi.recordBiologicalMovement({ barangayId: asset.barangayId, assetId: asset.id, ...m, amount: increase ? m.amount ?? 0 : 0 }), 'Movement recorded.'); }}>
          <Field label="Date">{(p) => <input {...p} type="date" className="input" value={m.date} onChange={(e) => setM({ ...m, date: e.target.value })} />}</Field>
          <Field label="Movement">{(p) => <select {...p} className="input" value={m.kind} onChange={(e) => setM({ ...m, kind: e.target.value as BioMovementKind })}>{BIO_KINDS.map((k) => <option key={k} value={k}>{k.charAt(0) + k.slice(1).toLowerCase()}</option>)}</select>}</Field>
          <Field label="Quantity">{(p) => <input {...p} type="number" min={1} step={1} className="input num" value={m.quantity} onChange={(e) => setM({ ...m, quantity: Number(e.target.value) })} />}</Field>
          {increase && <Field label="Value added">{(p) => <MoneyInput {...p} value={m.amount} onChange={(v) => setM({ ...m, amount: v })} />}</Field>}
          <Field label="Reference">{(p) => <input {...p} className="input" value={m.reference} onChange={(e) => setM({ ...m, reference: e.target.value })} />}</Field>
          <div className="flex items-end pb-5"><button type="submit" className="btn-primary" disabled={busy || m.quantity < 1}>Record</button></div>
        </form>
      )}
    </Panel>
  );
}
