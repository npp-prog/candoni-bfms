import { ADJUSTMENT_TYPES, APPROPRIATION_ADJUSTMENT_MODULE, formatPesos, manilaToday, type AppropriationAdjustmentDoc, type AppropriationDoc, type Centavos, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { MoneyInput } from '../../components/forms';
import { RegisterTable } from '../../components/register';
import { ActionBar, ReturnBanner, WorkflowTrail, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';

type Adjustment = WithId<AppropriationAdjustmentDoc>;
type Appropriation = WithId<AppropriationDoc & { accountName?: string }>;

export function AdjustmentsTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const scope = barangayId ? ([['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] as const) : null;
  const { rows, loading } = useCollection<AppropriationAdjustmentDoc>('appropriationAdjustments', scope);
  const apps = useCollection<AppropriationDoc & { accountName?: string }>('appropriations', scope).rows;
  if (!barangayId) return null;
  const byId = new Map(apps.map((a) => [a.id, a]));
  return (
    <>
      <RegisterTable
        caption="Appropriation adjustments"
        rows={[...rows].sort((a, b) => b.ordinanceDate.localeCompare(a.ordinanceDate))}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={<div className="ml-auto">{can('budget.encode', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New adjustment</button>}</div>}
        empty="No supplemental appropriations, realignments or augmentations this year."
        columns={[
          { label: 'Ordinance', render: (r) => r.ordinanceNumber },
          { label: 'Date', render: (r) => r.ordinanceDate },
          { label: 'Type', render: (r) => ADJUSTMENT_TYPES.find((t) => t.value === r.adjustmentType)?.label ?? r.adjustmentType },
          { label: 'Appropriation', render: (r) => <span className="font-mono text-xs">{byId.get(r.appropriationId)?.accountCode ?? '—'}</span> },
          { label: 'Amount', numeric: true, render: (r) => <Money value={r.amount} /> },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <AdjustmentEditor id={open === 'new' ? null : open} rows={rows} apps={apps} onClose={() => setOpen(null)} />}
    </>
  );
}

function AdjustmentEditor({ id, rows, apps, onClose }: { id: string | null; rows: Adjustment[]; apps: Appropriation[]; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [currentId, setCurrentId] = useState(id);
  const [f, setF] = useState({
    appropriationId: rec?.appropriationId ?? '',
    adjustmentType: (rec?.adjustmentType ?? 'SUPPLEMENTAL') as AppropriationAdjustmentDoc['adjustmentType'],
    ordinanceNumber: rec?.ordinanceNumber ?? '',
    ordinanceDate: rec?.ordinanceDate ?? manilaToday(),
    amount: (rec?.amount ?? 0) as Centavos | null,
    remarks: rec?.remarks ?? '',
  });
  const { save, busy } = useSaveSource(APPROPRIATION_ADJUSTMENT_MODULE.key);
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('budget.encode', barangayId) && (!live || APPROPRIATION_ADJUSTMENT_MODULE.editableStatuses.includes(live.status));
  const valid = f.appropriationId && f.ordinanceNumber.trim() && (f.amount ?? 0) > 0;
  return (
    <Modal
      open
      title={live ? `Adjustment — Ord. ${live.ordinanceNumber}` : 'New appropriation adjustment'}
      onClose={onClose}
      footer={
        <>
          {live && <ActionBar def={APPROPRIATION_ADJUSTMENT_MODULE} record={live} />}
          <span className="mr-auto" />
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && (
            <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void save(barangayId, { ...f, amount: f.amount ?? 0, counterpartAppropriationId: null }, currentId ?? undefined).then((x) => x && setCurrentId(x))}>
              {busy ? 'Saving…' : 'Save draft'}
            </button>
          )}
        </>
      }
    >
      {live && <div className="mb-3"><StatusChip status={live.status} /></div>}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-2">
        <Field label="Appropriation" required className="sm:col-span-2">
          {(p) => (
            <select {...p} className="input" value={f.appropriationId} onChange={(e) => setF({ ...f, appropriationId: e.target.value })}>
              <option value="">— select —</option>
              {apps.filter((a) => a.status === 'ACTIVE' || a.id === f.appropriationId).map((a) => (
                <option key={a.id} value={a.id}>{a.accountCode} {a.accountName ?? ''} · total {formatPesos(a.totalAppropriation)} · avail. {formatPesos(a.availableBalance)}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Type" required>
          {(p) => (
            <select {...p} className="input" value={f.adjustmentType} onChange={(e) => setF({ ...f, adjustmentType: e.target.value as typeof f.adjustmentType })}>
              {ADJUSTMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Amount" required>{(p) => <MoneyInput {...p} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} allowZero={false} />}</Field>
        <Field label="Ordinance no." required>{(p) => <input {...p} className="input" value={f.ordinanceNumber} onChange={(e) => setF({ ...f, ordinanceNumber: e.target.value })} />}</Field>
        <Field label="Ordinance date" required>{(p) => <input {...p} type="date" className="input" value={f.ordinanceDate} onChange={(e) => setF({ ...f, ordinanceDate: e.target.value })} />}</Field>
        <Field label="Remarks" className="sm:col-span-2">{(p) => <textarea {...p} rows={2} className="input" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />}</Field>
      </fieldset>
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}
