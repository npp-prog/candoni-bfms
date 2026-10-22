import { ITEM_CLASSES, manilaToday, type Centavos, type InventoryItemRecord, type InventoryTxRecord, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { AccountInput, InfoGrid, MoneyInput } from '../../components/forms';
import { RegisterTable } from '../../components/register';
import { Link } from 'react-router-dom';
import { reportHref } from '../../components/source';
import { Field, Icon, Modal, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { Panel, QtyInput, propertyApi, useCall, useItems } from './common';

/** Item master (stock cards): on-hand quantities and moving-average costs are maintained by the server. */
export function SuppliesTab() {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const { rows, loading } = useItems(barangayId);
  if (!barangayId) return null;
  const list = rows
    .filter((r) => !q || `${r.stockNumber} ${r.description}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.stockNumber.localeCompare(b.stockNumber));
  const value = rows.reduce((t, r) => t + Math.round(r.quantityOnHand * r.unitCost), 0);
  const low = rows.filter((r) => r.active && r.quantityOnHand <= r.reorderPoint).length;
  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="card p-4"><div className="kpi-label">Stock items</div><div className="kpi-value text-xl">{rows.length}</div></div>
        <div className="card p-4"><div className="kpi-label">Inventory value (moving average)</div><div className="kpi-value text-xl">₱<Money value={value} dashZero={false} /></div></div>
        <div className="card p-4"><div className="kpi-label">At or below re-order point</div><div className={`kpi-value text-xl ${low ? 'text-amber-700' : ''}`}>{low}</div></div>
      </div>
      <RegisterTable
        caption="Stock cards"
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <label className="label mb-0" htmlFor="item-search">Search</label>
            <input id="item-search" className="input max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Stock no. or description" />
            <div className="ml-auto">{can('property.manage', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New stock item</button>}</div>
          </>
        }
        empty="No stock cards yet. Create one for each supply item, with its balance forwarded."
        columns={[
          { label: 'Stock no.', render: (r) => <span className="font-mono text-xs">{r.stockNumber}</span> },
          { label: 'Description', className: 'max-w-sm truncate', render: (r) => r.description },
          { label: 'Class', render: (r) => (r.itemClass === 'SEMI_EXPENDABLE' ? 'Semi-expendable' : 'Consumable') },
          { label: 'Account', render: (r) => <span className="font-mono text-xs">{r.accountCode}</span> },
          { label: 'On hand', numeric: true, render: (r) => <span className={r.active && r.quantityOnHand <= r.reorderPoint ? 'font-semibold text-amber-700' : ''}>{r.quantityOnHand} {r.unit}</span> },
          { label: 'Unit cost', numeric: true, render: (r) => <Money value={r.unitCost} /> },
          { label: 'Value', numeric: true, render: (r) => <Money value={Math.round(r.quantityOnHand * r.unitCost)} /> },
          { label: 'Status', render: (r) => <StatusChip status={r.active ? 'ACTIVE' : 'INACTIVE'} /> },
        ]}
      />
      {open && <ItemEditor id={open === 'new' ? null : open} rows={rows} onClose={() => setOpen(null)} />}
    </>
  );
}

function ItemEditor({ id, rows, onClose }: { id: string | null; rows: Array<WithId<InventoryItemRecord>>; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [f, setF] = useState({
    stockNumber: rec?.stockNumber ?? '',
    description: rec?.description ?? '',
    unit: rec?.unit ?? 'piece',
    accountCode: rec?.accountCode ?? '1-04-03-010',
    itemClass: (rec?.itemClass ?? 'CONSUMABLE') as InventoryItemRecord['itemClass'],
    reorderPoint: rec?.reorderPoint ?? 0,
    active: rec?.active ?? true,
  });
  const [opening, setOpening] = useState({ date: `${fiscalYear}-01-01`, quantity: 0, unitCost: 0 as Centavos | null });
  const { run, busy } = useCall();
  if (!barangayId) return null;
  const editable = can('property.manage', barangayId);
  const valid = f.stockNumber.trim() && f.description.trim().length >= 2 && f.unit.trim() && /^1-04-\d{2}-\d{3}$/.test(f.accountCode);

  async function save() {
    const r = await run(
      () => propertyApi.saveInventoryItem({ id: id ?? undefined, barangayId: barangayId!, ...f, opening: !id && opening.quantity > 0 ? { date: opening.date, quantity: opening.quantity, unitCost: opening.unitCost ?? 0 } : null }),
      'Stock card saved.',
    );
    if (r && !id) onClose();
  }

  return (
    <Modal
      open
      wide
      title={rec ? `Stock card ${rec.stockNumber}` : 'New stock item'}
      onClose={onClose}
      footer={
        <>
          {rec && <Link className="btn-ghost" to={reportHref('STOCK_CARD', { fiscalYear, itemId: rec.id })}><Icon name="file" /> Stock card</Link>}
          <span className="mr-auto" />
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>}
        </>
      }
    >
      <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-4">
        <Field label="Stock no." required hint={rec ? 'Fixed once created.' : 'Unique in this barangay.'}>{(p) => <input {...p} className="input font-mono" disabled={!!rec} value={f.stockNumber} onChange={(e) => setF({ ...f, stockNumber: e.target.value })} />}</Field>
        <Field label="Description" required className="sm:col-span-3">{(p) => <input {...p} className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <Field label="Unit of measure" required>{(p) => <input {...p} className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />}</Field>
        <Field label="Class" required hint="Semi-expendable items (below ₱50,000) are issued on an ICS.">
          {(p) => (
            <select {...p} className="input" value={f.itemClass} onChange={(e) => setF({ ...f, itemClass: e.target.value as typeof f.itemClass })}>
              {ITEM_CLASSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Inventory account" required className="sm:col-span-2">{(p) => <AccountInput {...p} value={f.accountCode} prefixes={['1-04']} onChange={(v) => setF({ ...f, accountCode: v })} />}</Field>
        <Field label="Re-order point">{(p) => <input {...p} type="number" min={0} className="input num" value={f.reorderPoint} onChange={(e) => setF({ ...f, reorderPoint: Number(e.target.value) })} />}</Field>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
        </div>
      </fieldset>
      {!rec && editable && (
        <fieldset className="mt-4 grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-semibold text-slate-700">Balance forwarded (optional)</legend>
          <Field label="As of">{(p) => <input {...p} type="date" className="input" value={opening.date} onChange={(e) => setOpening({ ...opening, date: e.target.value })} />}</Field>
          <Field label="Quantity">{(p) => <QtyInput {...p} value={opening.quantity} onChange={(v) => setOpening({ ...opening, quantity: v })} />}</Field>
          <Field label="Unit cost">{(p) => <MoneyInput {...p} value={opening.unitCost} onChange={(v) => setOpening({ ...opening, unitCost: v })} />}</Field>
        </fieldset>
      )}
      {rec && (
        <>
          <div className="mt-4 rounded-md border border-slate-200 p-3">
            <InfoGrid columns={4} items={[['On hand', `${rec.quantityOnHand} ${rec.unit}`], ['Moving-average cost', <Money key="u" value={rec.unitCost} dashZero={false} />], ['Value', <Money key="v" value={Math.round(rec.quantityOnHand * rec.unitCost)} dashZero={false} />], ['Last count', rec.lastCount ? `${rec.lastCount.quantity} on ${rec.lastCount.date}` : 'none']]} />
          </div>
          {editable && <StockActions item={rec} />}
          <StockLines itemId={rec.id} />
        </>
      )}
    </Modal>
  );
}

function StockActions({ item }: { item: WithId<InventoryItemRecord> }) {
  const { barangayId } = useBarangay();
  const { run, busy } = useCall();
  const [a, setA] = useState({ date: manilaToday(), kind: 'ADJUSTMENT' as 'ADJUSTMENT' | 'RETURN', quantity: 0, reference: '', office: '', remarks: '' });
  const [c, setC] = useState({ date: manilaToday(), quantity: item.quantityOnHand, remarks: '' });
  if (!barangayId) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Adjustment / return of supplies">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => propertyApi.postStockAdjustment({ barangayId, itemId: item.id, ...a }), (r) => `Posted. On hand: ${r.quantityOnHand}.`); }}>
          <Field label="Kind">{(p) => <select {...p} className="input" value={a.kind} onChange={(e) => setA({ ...a, kind: e.target.value as typeof a.kind })}><option value="ADJUSTMENT">Adjustment (+/−)</option><option value="RETURN">Return of unused supplies</option></select>}</Field>
          <Field label="Date">{(p) => <input {...p} type="date" className="input" value={a.date} onChange={(e) => setA({ ...a, date: e.target.value })} />}</Field>
          <Field label="Quantity" hint={a.kind === 'ADJUSTMENT' ? 'Negative to reduce stock.' : 'Quantity returned.'}>{(p) => <input {...p} type="number" step="any" className="input num" value={a.quantity} onChange={(e) => setA({ ...a, quantity: Number(e.target.value) })} />}</Field>
          <Field label="Reference">{(p) => <input {...p} className="input" value={a.reference} onChange={(e) => setA({ ...a, reference: e.target.value })} />}</Field>
          <Field label="Reason" required className="sm:col-span-2">{(p) => <input {...p} className="input" value={a.remarks} onChange={(e) => setA({ ...a, remarks: e.target.value })} />}</Field>
          <div className="sm:col-span-2"><button type="submit" className="btn-primary" disabled={busy || !a.quantity || a.remarks.trim().length < 5}>Post to stock card</button></div>
        </form>
      </Panel>
      <Panel title="Physical count (for the RPCI)">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => propertyApi.recordPhysicalCount({ barangayId, target: 'ITEM', id: item.id, date: c.date, quantity: c.quantity, condition: '', remarks: c.remarks }), 'Count recorded.'); }}>
          <Field label="Count date">{(p) => <input {...p} type="date" className="input" value={c.date} onChange={(e) => setC({ ...c, date: e.target.value })} />}</Field>
          <Field label="Quantity counted">{(p) => <QtyInput {...p} value={c.quantity} onChange={(v) => setC({ ...c, quantity: v })} />}</Field>
          <Field label="Remarks" className="sm:col-span-2">{(p) => <input {...p} className="input" value={c.remarks} onChange={(e) => setC({ ...c, remarks: e.target.value })} />}</Field>
          <div className="sm:col-span-2"><button type="submit" className="btn-secondary" disabled={busy}>Record count</button></div>
        </form>
      </Panel>
    </div>
  );
}

function StockLines({ itemId }: { itemId: string }) {
  const { barangayId } = useBarangay();
  const { rows, loading } = useCollection<InventoryTxRecord>('inventoryTransactions', barangayId ? [['barangayId', '==', barangayId], ['itemId', '==', itemId]] : null);
  const list = [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.seq - a.seq).slice(0, 50);
  return (
    <Panel title="Recent stock-card lines">
      {loading ? <p className="text-sm text-slate-600">Loading…</p> : list.length === 0 ? <p className="text-sm text-slate-600">No movements yet.</p> : (
        <div className="overflow-x-auto">
          <table className="table-base">
            <caption className="sr-only">Stock card lines</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Reference</th><th scope="col" className="num">Qty</th><th scope="col" className="num">Unit cost</th><th scope="col" className="num">Balance</th><th scope="col">Office / remarks</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((l) => (
                <tr key={l.id}>
                  <td>{l.date}</td>
                  <td>{l.referenceType} {l.referenceNumber}</td>
                  <td className={`num ${l.quantity < 0 ? 'text-red-700' : ''}`}>{l.quantity}</td>
                  <td className="num"><Money value={l.unitCost} /></td>
                  <td className="num">{l.balanceQuantity}</td>
                  <td className="max-w-xs truncate">{[l.office, l.remarks].filter(Boolean).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
