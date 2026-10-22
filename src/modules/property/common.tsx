import type { BarangayId, BioMovementKind, InventoryItemRecord, PpeRecord, PropertySigner, WithId } from '@bfms/shared';
import { useState, type ReactNode } from 'react';
import { useCollection } from '../../hooks/useCollection';
import { useToast } from '../../contexts/ToastContext';
import { callFn, errorMessage } from '../../services/functions/api';

/** Phase 10 callables (functions/src/modules/property/callables.ts). */
export const propertyApi = {
  saveInventoryItem: callFn<{ id?: string; barangayId: BarangayId; stockNumber: string; description: string; unit: string; accountCode: string; itemClass: string; reorderPoint: number; active: boolean; opening?: { date: string; quantity: number; unitCost: number } | null }, { id: string }>('saveInventoryItem'),
  postStockAdjustment: callFn<{ barangayId: BarangayId; itemId: string; date: string; kind: 'ADJUSTMENT' | 'RETURN'; quantity: number; unitCost?: number | null; reference: string; office: string; remarks: string }, { quantityOnHand: number; unitCost: number }>('postStockAdjustment'),
  recordPhysicalCount: callFn<{ barangayId: BarangayId; target: 'ITEM' | 'PPE'; id: string; date: string; quantity?: number; found?: boolean; condition: string; remarks: string }, { ok: true }>('recordPhysicalCount'),
  runMonthlyDepreciation: callFn<{ barangayId: BarangayId; fiscalYear: number; month: number }, { runId: string; alreadyRun: boolean; supplementary: boolean; jevId: string | null; jevIds: string[]; itemCount: number; totalDepreciation: number }>('runMonthlyDepreciation'),
  recordBiologicalMovement: callFn<{ barangayId: BarangayId; assetId: string; date: string; kind: BioMovementKind; quantity: number; amount: number; reference: string; remarks: string }, { quantityOnHand: number; carryingAmount: number }>('recordBiologicalMovement'),
};

/** Run a callable with busy state and toast feedback. */
export function useCall() {
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  async function run<T>(fn: () => Promise<T>, ok: string | ((r: T) => string)): Promise<T | null> {
    setBusy(true);
    try {
      const r = await fn();
      notify(typeof ok === 'function' ? ok(r) : ok, 'success');
      return r;
    } catch (e) {
      notify(errorMessage(e), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { run, busy };
}

/** Stock cards and PPE of the barangay (multi-year masters: filtered by barangay only). */
export function useItems(barangayId: BarangayId | null) {
  return useCollection<InventoryItemRecord>('inventoryItems', barangayId ? [['barangayId', '==', barangayId]] : null);
}
export function usePpe(barangayId: BarangayId | null) {
  return useCollection<PpeRecord>('ppe', barangayId ? [['barangayId', '==', barangayId]] : null);
}

export function itemLabel(i: WithId<InventoryItemRecord>): string {
  return `${i.stockNumber} — ${i.description} (${i.quantityOnHand} ${i.unit} on hand)`;
}

/** Stock item picker. */
export function ItemSelect({ items, value, onChange, filter, id, disabled }: { items: Array<WithId<InventoryItemRecord>>; value: string | null; onChange(id: string | null): void; filter?(i: InventoryItemRecord): boolean; id?: string; disabled?: boolean }) {
  const list = items.filter((i) => (i.active && (!filter || filter(i))) || i.id === value).sort((a, b) => a.stockNumber.localeCompare(b.stockNumber));
  return (
    <select id={id} className="input" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">— select stock item —</option>
      {list.map((i) => <option key={i.id} value={i.id}>{itemLabel(i)}</option>)}
    </select>
  );
}

/** Pick several ACTIVE PPE records (checkbox list with a search box). */
export function PpePicker({ ppe, value, onChange, disabled, filter }: { ppe: Array<WithId<PpeRecord>>; value: string[]; onChange(ids: string[]): void; disabled?: boolean; filter?(p: PpeRecord): boolean }) {
  const [q, setQ] = useState('');
  const list = ppe
    .filter((p) => (p.status === 'ACTIVE' && (!filter || filter(p))) || value.includes(p.id))
    .filter((p) => !q || `${p.propertyNumber} ${p.description} ${p.accountablePerson}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.propertyNumber.localeCompare(b.propertyNumber));
  return (
    <fieldset disabled={disabled} className="rounded-md border border-slate-200">
      <legend className="sr-only">Property</legend>
      <div className="border-b border-slate-200 p-2">
        <label className="sr-only" htmlFor="ppe-search">Search property</label>
        <input id="ppe-search" className="input" placeholder="Search property no., description, accountable officer…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="max-h-60 divide-y divide-slate-100 overflow-y-auto">
        {list.length === 0 && <li className="px-3 py-2 text-sm text-slate-600">No active property matches.</li>}
        {list.map((p) => (
          <li key={p.id}>
            <label className="flex cursor-pointer items-start gap-2 px-3 py-2 text-sm hover:bg-slate-50">
              <input type="checkbox" className="mt-1" checked={value.includes(p.id)} onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))} />
              <span>
                <span className="font-mono text-xs">{p.propertyNumber || '(unnumbered)'}</span> {p.description}
                <span className="block text-xs text-slate-600">{[p.accountablePerson || 'Property office', p.location, p.parNumber].filter(Boolean).join(' · ')}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** Name / position / office of a person on a form (requested by, received by …). */
export function SignerInput({ label, value, onChange, office = false, required }: { label: string; value: PropertySigner; onChange(v: PropertySigner): void; office?: boolean; required?: boolean }) {
  const base = label.toLowerCase().replace(/\W+/g, '-');
  return (
    <div className={`grid gap-3 ${office ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
      <div>
        <label className={`label ${required ? 'required' : ''}`} htmlFor={`${base}-n`}>{label}</label>
        <input id={`${base}-n`} className="input" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor={`${base}-p`}>Position</label>
        <input id={`${base}-p`} className="input" value={value.position ?? ''} onChange={(e) => onChange({ ...value, position: e.target.value })} />
      </div>
      {office && (
        <div>
          <label className="label" htmlFor={`${base}-o`}>Office</label>
          <input id={`${base}-o`} className="input" value={value.office ?? ''} onChange={(e) => onChange({ ...value, office: e.target.value })} />
        </div>
      )}
    </div>
  );
}

export const emptySigner = (): PropertySigner => ({ name: '', position: '', office: '' });

/** Quantity input (up to 3 decimals). */
export function QtyInput({ value, onChange, id, disabled }: { value: number; onChange(v: number): void; id?: string; disabled?: boolean }) {
  return <input id={id} type="number" min={0} step="any" inputMode="decimal" disabled={disabled} className="input num w-28" value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(Number(e.target.value))} />;
}

/** A small titled panel. */
export function Panel({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card mt-4">
      <div className="card-header"><h3 className="font-semibold text-navy-800">{title}</h3>{actions}</div>
      <div className="p-4">{children}</div>
    </section>
  );
}
