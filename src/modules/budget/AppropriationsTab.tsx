import { APPROPRIATION_CLASSES, APPROPRIATION_MODULE, EXPENSE_CLASSES, manilaToday, type AppropriationDoc, type Centavos, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AccountInput, InfoGrid, MoneyInput } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, ReturnBanner, WorkflowTrail, reportHref, statusOptions, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';

type Appropriation = WithId<AppropriationDoc & { accountName?: string }>;

export function AppropriationsTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const { rows, loading } = useCollection<AppropriationDoc & { accountName?: string }>('appropriations', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
  if (!barangayId) return null;
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => a.appropriationClass.localeCompare(b.appropriationClass) || a.accountCode.localeCompare(b.accountCode));
  const active = rows.filter((r) => r.status === 'ACTIVE');
  const sum = (k: 'totalAppropriation' | 'obligations' | 'availableBalance') => active.reduce((t, r) => t + r[k], 0);
  const canEncode = can('budget.encode', barangayId);

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {([['Total appropriation (active)', sum('totalAppropriation')], ['Obligations', sum('obligations')], ['Unobligated balance', sum('availableBalance')]] as const).map(([l, v]) => (
          <div key={l} className="card p-4">
            <div className="kpi-label">{l}</div>
            <div className="kpi-value text-xl">₱<Money value={v} dashZero={false} /></div>
          </div>
        ))}
      </div>
      <RegisterTable
        caption={`Appropriations for FY ${fiscalYear}`}
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter value={status} onChange={setStatus} options={statusOptions(APPROPRIATION_MODULE).filter((s) => s !== 'POSTED')} />
            <div className="ml-auto">{canEncode && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New appropriation</button>}</div>
          </>
        }
        empty={`No appropriations encoded for FY ${fiscalYear}. Encode each item of the Appropriation Ordinance.`}
        columns={[
          { label: 'Account', render: (r) => <span><span className="font-mono text-xs">{r.accountCode}</span> {r.accountName}</span> },
          { label: 'Class', render: (r) => APPROPRIATION_CLASSES.find((c) => c.value === r.appropriationClass)?.label ?? r.appropriationClass },
          { label: 'Program / project', className: 'max-w-xs truncate', render: (r) => [r.program, r.project].filter(Boolean).join(' · ') || '—' },
          { label: 'Total', numeric: true, render: (r) => <Money value={r.totalAppropriation} /> },
          { label: 'Obligations', numeric: true, render: (r) => <Money value={r.obligations} /> },
          { label: 'Available', numeric: true, render: (r) => <Money value={r.availableBalance} /> },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <AppropriationEditor id={open === 'new' ? null : open} rows={rows} onClose={() => setOpen(null)} />}
    </>
  );
}

const blank = (fy: number) => ({
  fiscalYear: fy,
  appropriationOrdinanceNumber: '',
  appropriationOrdinanceDate: manilaToday(),
  fundId: 'GF',
  appropriationClass: 'REGULAR' as AppropriationDoc['appropriationClass'],
  expenseClass: undefined as AppropriationDoc['expenseClass'] | undefined,
  program: '',
  project: '',
  activity: '',
  accountCode: '',
  originalAppropriation: 0 as Centavos | null,
});

function AppropriationEditor({ id, rows, onClose }: { id: string | null; rows: Appropriation[]; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [f, setF] = useState(() => (rec ? { ...blank(fiscalYear), ...rec } : blank(fiscalYear)));
  const [currentId, setCurrentId] = useState(id);
  const { save, busy } = useSaveSource(APPROPRIATION_MODULE.key);
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('budget.encode', barangayId) && (!live || APPROPRIATION_MODULE.editableStatuses.includes(live.status));
  const valid = f.appropriationOrdinanceNumber.trim() && /^\d-\d{2}-\d{2}-\d{3}$/.test(f.accountCode) && (f.originalAppropriation ?? 0) > 0;

  async function onSave() {
    const newId = await save(barangayId!, { ...f, originalAppropriation: f.originalAppropriation ?? 0 }, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  }

  return (
    <Modal
      open
      wide
      title={live ? `Appropriation — ${live.accountCode}` : 'New appropriation'}
      onClose={onClose}
      footer={
        <>
          {live && <ActionBar def={APPROPRIATION_MODULE} record={live} />}
          <span className="mr-auto" />
          {live && <Link className="btn-ghost" to={reportHref('RAO', { fiscalYear: live.fiscalYear, variant: live.appropriationClass })}>View RAO</Link>}
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save draft'}</button>}
        </>
      }
    >
      {live && (
        <div className="mb-3 flex items-center gap-2"><StatusChip status={live.status} /></div>
      )}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-4">
        <Field label="Ordinance no." required>{(p) => <input {...p} className="input" value={f.appropriationOrdinanceNumber} onChange={(e) => setF({ ...f, appropriationOrdinanceNumber: e.target.value })} />}</Field>
        <Field label="Ordinance date" required>{(p) => <input {...p} type="date" className="input" value={f.appropriationOrdinanceDate} onChange={(e) => setF({ ...f, appropriationOrdinanceDate: e.target.value })} />}</Field>
        <Field label="Budget year" required>{(p) => <input {...p} type="number" className="input" value={f.fiscalYear} onChange={(e) => setF({ ...f, fiscalYear: Number(e.target.value) })} />}</Field>
        <Field label="Class" required>
          {(p) => (
            <select {...p} className="input" value={f.appropriationClass} onChange={(e) => setF({ ...f, appropriationClass: e.target.value as typeof f.appropriationClass })}>
              {APPROPRIATION_CLASSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Account (object of expenditure)" required className="sm:col-span-2" hint="Expense (5-…) or capital outlay (1-06/1-07/1-08) account.">
          {(p) => <AccountInput {...p} value={f.accountCode} prefixes={['5-', '1-06', '1-07', '1-08']} onChange={(v) => setF({ ...f, accountCode: v })} />}
        </Field>
        <Field label="Expense class" hint="Defaults from the account.">
          {(p) => (
            <select {...p} className="input" value={f.expenseClass ?? ''} onChange={(e) => setF({ ...f, expenseClass: (e.target.value || undefined) as typeof f.expenseClass })}>
              <option value="">Automatic</option>
              {EXPENSE_CLASSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Amount appropriated" required>{(p) => <MoneyInput {...p} value={f.originalAppropriation} onChange={(v) => setF({ ...f, originalAppropriation: v })} allowZero={false} />}</Field>
        <Field label="Program" className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.program} onChange={(e) => setF({ ...f, program: e.target.value })} />}</Field>
        <Field label="Project / activity" className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} />}</Field>
      </fieldset>
      {live && live.status !== 'DRAFT' && (
        <div className="mt-4 rounded-md border border-slate-200 p-3">
          <InfoGrid
            columns={4}
            items={[
              ['Original', <Money key="o" value={live.originalAppropriation} dashZero={false} />],
              ['Supplemental / adjustments', <Money key="s" value={(live.supplementalAppropriation + live.realignment + live.adjustments) as Centavos} dashZero={false} />],
              ['Obligations', <Money key="b" value={live.obligations} dashZero={false} />],
              ['Available balance', <strong key="a"><Money value={live.availableBalance} dashZero={false} /></strong>],
            ]}
          />
        </div>
      )}
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}
