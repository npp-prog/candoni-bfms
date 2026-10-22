import { PPE_MODULE, defaultResidualValue, depreciationStartPeriod, manilaToday, monthlyDepreciation, ppeAccountsFor, type Centavos, type PpeRecord, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AccountInput, InfoGrid, MoneyInput } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, ReturnBanner, WorkflowTrail, reportHref, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { Panel, propertyApi, useCall, usePpe } from './common';

const STATUSES = ['DRAFT', 'SUBMITTED', 'RETURNED', 'ACTIVE', 'UNSERVICEABLE', 'DISPOSED', 'VOID'];

/** PPE register: records created by IAR acceptance, plus existing PPE encoded with its opening depreciation. */
export function PpeTab() {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const [status, setStatus] = useState('ACTIVE');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const { rows, loading } = usePpe(barangayId);
  if (!barangayId) return null;
  const list = rows
    .filter((r) => (!status || r.status === status) && (!q || `${r.propertyNumber} ${r.description} ${r.accountablePerson} ${r.location}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode) || (a.propertyNumber ?? '').localeCompare(b.propertyNumber ?? ''));
  const active = rows.filter((r) => r.status === 'ACTIVE');
  const sum = (k: 'acquisitionCost' | 'accumulatedDepreciation' | 'netBookValue') => active.reduce((t, r) => t + r[k], 0);
  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {([['Cost (active)', sum('acquisitionCost')], ['Accumulated depreciation', sum('accumulatedDepreciation')], ['Net book value', sum('netBookValue')]] as const).map(([l, v]) => (
          <div key={l} className="card p-4"><div className="kpi-label">{l}</div><div className="kpi-value text-xl">₱<Money value={v} dashZero={false} /></div></div>
        ))}
      </div>
      <RegisterTable
        caption="PPE register"
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter id="ppe-status" value={status} onChange={setStatus} options={STATUSES} />
            <label className="label mb-0" htmlFor="ppe-q">Search</label>
            <input id="ppe-q" className="input max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Property no., description, officer" />
            <div className="ml-auto">{can('property.manage', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> Encode existing PPE</button>}</div>
          </>
        }
        empty="No PPE in this status. Equipment is added when an IAR is accepted, or encode existing PPE."
        columns={[
          { label: 'Property no.', render: (r) => <span className="font-mono text-xs">{r.propertyNumber || 'unnumbered'}</span> },
          { label: 'Description', className: 'max-w-xs truncate', render: (r) => r.description },
          { label: 'Account', render: (r) => <span className="font-mono text-xs">{r.accountCode}</span> },
          { label: 'Acquired', render: (r) => r.acquisitionDate },
          { label: 'Cost', numeric: true, render: (r) => <Money value={r.acquisitionCost} /> },
          { label: 'Accum. dep.', numeric: true, render: (r) => <Money value={r.accumulatedDepreciation} /> },
          { label: 'NBV', numeric: true, render: (r) => <Money value={r.netBookValue} /> },
          { label: 'Accountable / location', className: 'max-w-xs truncate', render: (r) => [r.accountablePerson || 'Property office', r.location].filter(Boolean).join(' · ') },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <PpeEditor id={open === 'new' ? null : open} rows={rows} onClose={() => setOpen(null)} />}
    </>
  );
}

function PpeEditor({ id, rows, onClose }: { id: string | null; rows: Array<WithId<PpeRecord>>; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [currentId, setCurrentId] = useState(id);
  const [f, setF] = useState({
    description: rec?.description ?? '',
    unit: rec?.unit ?? 'unit',
    accountCode: rec?.accountCode ?? '1-07-05-020',
    acquisitionDate: rec?.acquisitionDate ?? manilaToday(),
    acquisitionCost: (rec?.acquisitionCost ?? 0) as Centavos | null,
    residualValue: (rec?.residualValue ?? null) as Centavos | null,
    usefulLifeYears: rec?.usefulLifeYears ?? 5,
    location: rec?.location ?? '',
    accountablePerson: rec?.accountablePerson ?? '',
    supplierName: rec?.supplierName ?? '',
    openingAccumulatedDepreciation: (rec?.openingAccumulatedDepreciation ?? 0) as Centavos | null,
    openingAsOfPeriod: rec?.openingAsOfPeriod ?? `${fiscalYear - 1}-12`,
    remarks: rec?.remarks ?? '',
  });
  const { save, busy } = useSaveSource(PPE_MODULE.key);
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('property.manage', barangayId) && (!live || PPE_MODULE.editableStatuses.includes(live.status));
  let accts: ReturnType<typeof ppeAccountsFor> | null = null;
  try { accts = ppeAccountsFor(f.accountCode); } catch { accts = null; }
  const cost = f.acquisitionCost ?? 0;
  const residual = f.residualValue ?? defaultResidualValue(cost);
  const valid = f.description.trim().length >= 2 && !!accts && cost > 0 && f.usefulLifeYears > 0 && f.openingAccumulatedDepreciation !== null;
  const onSave = async () => {
    const newId = await save(barangayId, { ...f, acquisitionCost: cost, residualValue: f.residualValue, openingAccumulatedDepreciation: f.openingAccumulatedDepreciation ?? 0, openingAsOfPeriod: (f.openingAccumulatedDepreciation ?? 0) > 0 ? f.openingAsOfPeriod : null }, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  };
  return (
    <Modal
      open
      wide
      title={live?.propertyNumber ? `PPE ${live.propertyNumber}` : live ? 'PPE record (draft)' : 'Encode existing PPE'}
      onClose={onClose}
      footer={
        <>
          {live && <ActionBar def={PPE_MODULE} record={live} />}
          <span className="mr-auto" />
          {live?.propertyNumber && <Link className="btn-ghost" to={reportHref('PEC', { fiscalYear, itemId: live.id })}><Icon name="file" /> PEC</Link>}
          {live?.propertyNumber && <Link className="btn-ghost" to={reportHref('PELC', { fiscalYear, itemId: live.id })}><Icon name="file" /> PELC</Link>}
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save draft'}</button>}
        </>
      }
    >
      {live && <div className="mb-3 flex items-center gap-2"><StatusChip status={live.status} />{live.parNumber && <span className="text-sm">PAR {live.parNumber}</span>}</div>}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-4">
        <Field label="Description (brand, model, serial no.)" required className="sm:col-span-3">{(p) => <input {...p} className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <Field label="Unit">{(p) => <input {...p} className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />}</Field>
        <Field label="PPE account" required className="sm:col-span-2" hint={accts ? (accts.depreciable ? `Depreciation: Dr ${accts.depreciationExpenseAccountCode} / Cr ${accts.accumulatedDepreciationAccountCode}` : 'Not depreciated (land / construction in progress).') : 'Use a 1-07 account.'}>
          {(p) => <AccountInput {...p} value={f.accountCode} prefixes={['1-07']} onChange={(v) => setF({ ...f, accountCode: v })} />}
        </Field>
        <Field label="Date acquired" required>{(p) => <input {...p} type="date" className="input" value={f.acquisitionDate} onChange={(e) => setF({ ...f, acquisitionDate: e.target.value })} />}</Field>
        <Field label="Acquisition cost" required>{(p) => <MoneyInput {...p} value={f.acquisitionCost} onChange={(v) => setF({ ...f, acquisitionCost: v })} allowZero={false} />}</Field>
        <Field label="Residual value" hint={`Blank = 5% (₱${(residual / 100).toFixed(2)})`}>{(p) => <MoneyInput {...p} value={f.residualValue} onChange={(v) => setF({ ...f, residualValue: v || null })} />}</Field>
        <Field label="Useful life (years)" required>{(p) => <input {...p} type="number" min={1} className="input num" value={f.usefulLifeYears} onChange={(e) => setF({ ...f, usefulLifeYears: Number(e.target.value) })} />}</Field>
        <Field label="Location">{(p) => <input {...p} className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />}</Field>
        <Field label="Accountable person">{(p) => <input {...p} className="input" value={f.accountablePerson} onChange={(e) => setF({ ...f, accountablePerson: e.target.value })} />}</Field>
        <Field label="Opening accumulated depreciation" hint="For PPE acquired before BFMS.">{(p) => <MoneyInput {...p} value={f.openingAccumulatedDepreciation} onChange={(v) => setF({ ...f, openingAccumulatedDepreciation: v })} />}</Field>
        <Field label="…as of month">{(p) => <input {...p} type="month" className="input" value={f.openingAsOfPeriod ?? ''} onChange={(e) => setF({ ...f, openingAsOfPeriod: e.target.value })} />}</Field>
        <Field label="Supplier / source">{(p) => <input {...p} className="input" value={f.supplierName} onChange={(e) => setF({ ...f, supplierName: e.target.value })} />}</Field>
        <Field label="Remarks" className="sm:col-span-3">{(p) => <input {...p} className="input" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />}</Field>
      </fieldset>
      <p className="mt-2 text-xs text-slate-600">Monthly depreciation ₱{(monthlyDepreciation(cost as Centavos, residual, f.usefulLifeYears) / 100).toFixed(2)} from {depreciationStartPeriod(f.acquisitionDate)} (straight line).</p>
      {live && live.status !== 'DRAFT' && <PpeDetail p={live} />}
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}

function PpeDetail({ p }: { p: WithId<PpeRecord> }) {
  const { can } = useAuth();
  const { run, busy } = useCall();
  const [c, setC] = useState({ date: manilaToday(), found: true, condition: 'Serviceable', remarks: '' });
  return (
    <>
      <div className="mt-4 rounded-md border border-slate-200 p-3">
        <InfoGrid columns={4} items={[['Accumulated depreciation', <Money key="a" value={p.accumulatedDepreciation} dashZero={false} />], ['Net book value', <Money key="n" value={p.netBookValue} dashZero={false} />], ['Last depreciated', p.lastDepreciatedPeriod ?? '—'], ['Last count', p.lastCount ? `${p.lastCount.found ? 'Found' : 'Not found'} · ${p.lastCount.date}` : '—']]} />
      </div>
      {(p.movements ?? []).length > 0 && (
        <Panel title="Custody history">
          <ol className="space-y-1 text-sm">
            {[...p.movements].sort((a, b) => a.date.localeCompare(b.date)).map((m, i) => (
              <li key={i} className="flex flex-wrap gap-2"><span className="tabular-nums text-slate-600">{m.date}</span><StatusChip status={m.type} /><span>{m.reference}</span><span className="text-slate-600">{[m.person, m.location, m.remarks].filter(Boolean).join(' · ')}</span></li>
            ))}
          </ol>
        </Panel>
      )}
      {can('property.manage', p.barangayId) && ['ACTIVE', 'UNSERVICEABLE'].includes(p.status) && (
        <Panel title="Physical count (for the RPCPPE)">
          <form className="grid gap-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void run(() => propertyApi.recordPhysicalCount({ barangayId: p.barangayId, target: 'PPE', id: p.id, date: c.date, found: c.found, condition: c.condition, remarks: c.remarks }), 'Count recorded.'); }}>
            <Field label="Count date">{(x) => <input {...x} type="date" className="input" value={c.date} onChange={(e) => setC({ ...c, date: e.target.value })} />}</Field>
            <Field label="Result">{(x) => <select {...x} className="input" value={c.found ? 'Y' : 'N'} onChange={(e) => setC({ ...c, found: e.target.value === 'Y' })}><option value="Y">Found</option><option value="N">Not found</option></select>}</Field>
            <Field label="Condition">{(x) => <input {...x} className="input" value={c.condition} onChange={(e) => setC({ ...c, condition: e.target.value })} />}</Field>
            <Field label="Remarks">{(x) => <input {...x} className="input" value={c.remarks} onChange={(e) => setC({ ...c, remarks: e.target.value })} />}</Field>
            <div><button type="submit" className="btn-secondary" disabled={busy}>Record count</button></div>
          </form>
        </Panel>
      )}
    </>
  );
}
