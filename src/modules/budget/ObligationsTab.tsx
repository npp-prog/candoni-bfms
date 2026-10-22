import { OBLIGATION_MODULE, formatPesos, manilaToday, type AppropriationDoc, type Centavos, type ObligationDoc, type PartyRef, type SpecialTrustFundDoc, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { emptyParty, InfoGrid, MoneyInput, PartyInput } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, ReturnBanner, WorkflowTrail, statusOptions, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';

type Obligation = WithId<ObligationDoc & { appropriationClass?: string }>;
type Appropriation = WithId<AppropriationDoc & { accountName?: string }>;

export function ObligationsTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const scope = barangayId ? ([['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] as const) : null;
  const { rows, loading } = useCollection<ObligationDoc>('obligations', scope);
  const apps = useCollection<AppropriationDoc & { accountName?: string }>('appropriations', scope).rows;
  if (!barangayId) return null;
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <RegisterTable
        caption={`Obligation requests for FY ${fiscalYear}`}
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter value={status} onChange={setStatus} options={statusOptions(OBLIGATION_MODULE).filter((s) => s !== 'POSTED')} />
            <div className="ml-auto">{can('obligation.encode', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New obligation</button>}</div>
          </>
        }
        empty={`No obligation requests for FY ${fiscalYear}.`}
        columns={[
          { label: 'OBR no.', render: (r) => r.obligationNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Date', render: (r) => r.date },
          { label: 'Payee', render: (r) => r.payee?.name },
          { label: 'Account', render: (r) => <span className="font-mono text-xs">{r.accountCode}</span> },
          { label: 'Particulars', className: 'max-w-sm truncate', render: (r) => r.particulars },
          { label: 'Amount', numeric: true, render: (r) => <Money value={r.amount} /> },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <ObligationEditor id={open === 'new' ? null : open} rows={rows} apps={apps} onClose={() => setOpen(null)} />}
    </>
  );
}

function ObligationEditor({ id, rows, apps, onClose }: { id: string | null; rows: Obligation[]; apps: Appropriation[]; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [currentId, setCurrentId] = useState(id);
  const [f, setF] = useState({
    date: rec?.date ?? manilaToday(),
    payee: (rec?.payee ?? emptyParty()) as PartyRef,
    appropriationId: rec?.appropriationId ?? '',
    specialTrustFundId: rec?.specialTrustFundId ?? '',
    particulars: rec?.particulars ?? '',
    amount: (rec?.amount ?? 0) as Centavos | null,
  });
  const { save, busy } = useSaveSource(OBLIGATION_MODULE.key);
  const stfs = useCollection<SpecialTrustFundDoc>('specialTrustFunds', barangayId ? [['barangayId', '==', barangayId]] : null).rows;
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('obligation.encode', barangayId) && (!live || OBLIGATION_MODULE.editableStatuses.includes(live.status));
  const active = apps.filter((a) => a.status === 'ACTIVE' || a.id === f.appropriationId);
  const app = apps.find((a) => a.id === f.appropriationId);
  const over = app && f.amount !== null && f.amount > app.availableBalance && editable;
  const valid = f.payee.name.trim().length >= 2 && f.appropriationId && f.particulars.trim().length >= 3 && (f.amount ?? 0) > 0;

  async function onSave() {
    const newId = await save(barangayId!, { ...f, specialTrustFundId: f.specialTrustFundId || null, amount: f.amount ?? 0, payee: { ...f.payee, id: f.payee.id ?? null } }, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  }

  return (
    <Modal
      open
      wide
      title={live?.obligationNumber ? `Obligation ${live.obligationNumber}` : live ? 'Obligation request (draft)' : 'New obligation request'}
      onClose={onClose}
      footer={
        <>
          {live && <ActionBar def={OBLIGATION_MODULE} record={live} />}
          <span className="mr-auto" />
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save draft'}</button>}
        </>
      }
    >
      {live && <div className="mb-3 flex items-center gap-2"><StatusChip status={live.status} />{live.obligationNumber && <span className="font-mono text-sm">{live.obligationNumber}</span>}</div>}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Date" required>{(p) => <input {...p} type="date" className="input" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
          <Field label="Charge to appropriation" required className="sm:col-span-3" hint={app ? `Available: ${formatPesos(app.availableBalance, { symbol: true })}` : 'Only ACTIVE appropriations can be charged.'}>
            {(p) => (
              <select {...p} className="input" value={f.appropriationId} onChange={(e) => setF({ ...f, appropriationId: e.target.value })}>
                <option value="">— select appropriation —</option>
                {active.map((a) => (
                  <option key={a.id} value={a.id}>{a.accountCode} {a.accountName ?? ''} · {a.program || a.appropriationClass} · avail. {formatPesos(a.availableBalance)}</option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <PartyInput value={f.payee} onChange={(payee) => setF({ ...f, payee })} />
        <Field label="Particulars" required>{(p) => <textarea {...p} rows={2} className="input" value={f.particulars} onChange={(e) => setF({ ...f, particulars: e.target.value })} />}</Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Amount" required error={over ? 'Exceeds the available appropriation; certification will be refused.' : null}>
            {(p) => <MoneyInput {...p} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} allowZero={false} />}
          </Field>
          <Field label="Special Trust Fund (if charged to one)" className="sm:col-span-2">
            {(p) => (
              <select {...p} className="input" value={f.specialTrustFundId} onChange={(e) => setF({ ...f, specialTrustFundId: e.target.value })}>
                <option value="">— none (General Fund) —</option>
                {stfs.map((s) => <option key={s.id} value={s.id}>{s.fundCode} {s.fundName} · bal. {formatPesos(s.balance)}</option>)}
              </select>
            )}
          </Field>
        </div>
      </fieldset>
      {live?.certifiedAt && (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <InfoGrid items={[['Certified', new Date(live.certifiedAt.seconds * 1000).toLocaleString('en-PH')], ['Account', live.accountCode], ['Fiscal year', String(fiscalYear)]]} />
        </div>
      )}
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}
