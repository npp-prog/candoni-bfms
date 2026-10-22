import { DEPOSIT_MODULE, formatPesos, isCollectionCounted, manilaToday, type Centavos, type DepositRecord, type RcrDoc } from '@bfms/shared';
import { useState } from 'react';
import { BankAccountSelect, InfoGrid, MoneyInput } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, WorkflowTrail, statusOptions } from '../../components/source';
import { Field, Icon, Modal, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useCollection } from '../../hooks/useCollection';
import { errorMessage } from '../../services/functions/api';
import { collectionsApi } from './api';
import { OfficerSelect, shortOfficer, useOrs, type Dep, type Or } from './common';

export function DepositsTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const { rows, loading } = useCollection<DepositRecord>('deposits', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
  const ors = useOrs().rows;
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  if (!barangayId) return null;
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => b.depositDate.localeCompare(a.depositDate));
  const undeposited = ors.filter((o) => isCollectionCounted(o.status) && !o.depositId);
  return (
    <>
      {undeposited.length > 0 && (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Undeposited collections: {undeposited.length} OR(s) totalling ₱{formatPesos(undeposited.reduce((t, o) => t + o.amount, 0) as Centavos, { dashZero: false })}.
        </p>
      )}
      <RegisterTable
        caption={`Deposits FY ${fiscalYear}`}
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter value={status} onChange={setStatus} options={statusOptions(DEPOSIT_MODULE).concat(['SUBMITTED', 'ACCEPTED']).filter((s) => s !== 'POSTED')} />
            <div className="ml-auto">{can('treasury.encode', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New deposit</button>}</div>
          </>
        }
        empty={`No deposits for FY ${fiscalYear}.`}
        columns={[
          { label: 'Deposit slip', render: (r) => <span className="font-mono">{r.depositSlipNumber}</span> },
          { label: 'Ref.', render: (r) => <span className="font-mono text-xs">{r.depositNumber}</span> },
          { label: 'Date', render: (r) => r.depositDate },
          { label: 'Bank', render: (r) => r.bankLabel },
          { label: 'Officer', render: (r) => shortOfficer(ors.find((o) => o.collectingOfficerId === r.accountableOfficerId)?.collectingOfficerName) || r.accountableOfficerId.split('_').at(-1) },
          { label: 'ORs', numeric: true, render: (r) => r.collectionIds.length },
          { label: 'Amount', numeric: true, render: (r) => <Money value={r.amount} /> },
          { label: 'Validated', numeric: true, render: (r) => (r.validatedAmount === null ? '—' : <Money value={r.validatedAmount} />) },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <DepositEditor rec={open === 'new' ? null : rows.find((r) => r.id === open) ?? null} ors={ors} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * Deposit slip: pick the officer, then tick the undeposited ORs in their custody (own ORs, and ORs
 * remitted to them through an RCR). The slip amount defaults to the ORs and must equal them.
 */
function DepositEditor({ rec, ors, onClose }: { rec: Dep | null; ors: Or[]; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const { notify } = useToast();
  const rcrs = useCollection<RcrDoc>('rcrReports', barangayId ? [['barangayId', '==', barangayId]] : null).rows;
  const [id, setId] = useState(rec?.id ?? null);
  const [f, setF] = useState({
    accountableOfficerId: rec?.accountableOfficerId ?? null as string | null,
    depositDate: rec?.depositDate ?? manilaToday(),
    bankAccountId: rec?.bankAccountId ?? null as string | null,
    depositSlipNumber: rec?.depositSlipNumber ?? '',
    collectionIds: rec?.collectionIds ?? ([] as string[]),
    amount: (rec?.amount ?? null) as Centavos | null,
    validatedAmount: (rec?.validatedAmount ?? null) as Centavos | null,
  });
  const [busy, setBusy] = useState(false);
  if (!barangayId) return null;
  const editable = can('treasury.encode', barangayId) && (!rec || rec.status === 'DRAFT');
  const custody = (o: Or) => o.collectingOfficerId === f.accountableOfficerId || (!!o.rcrId && rcrs.some((r) => r.id === o.rcrId && r.receivingOfficerId === f.accountableOfficerId && r.status !== 'VOID' && r.status !== 'RETURNED' && r.status !== 'DRAFT'));
  const candidates = ors
    .filter((o) => f.collectionIds.includes(o.id) || (isCollectionCounted(o.status) && !o.depositId && custody(o) && o.collectionDate <= f.depositDate))
    .sort((a, b) => a.collectionDate.localeCompare(b.collectionDate) || a.serialNumber - b.serialNumber);
  const selected = ors.filter((o) => f.collectionIds.includes(o.id));
  const orTotal = selected.reduce((t, o) => t + o.amount, 0);
  const amount = f.amount ?? orTotal;
  const valid = !!f.accountableOfficerId && !!f.bankAccountId && f.depositSlipNumber.trim() && f.collectionIds.length > 0 && amount === orTotal && amount > 0;
  const toggle = (oid: string) => setF({ ...f, collectionIds: f.collectionIds.includes(oid) ? f.collectionIds.filter((x) => x !== oid) : [...f.collectionIds, oid], amount: null });

  async function save() {
    setBusy(true);
    try {
      const r = await collectionsApi.saveDeposit({ id: id ?? undefined, barangayId: barangayId!, accountableOfficerId: f.accountableOfficerId!, depositDate: f.depositDate, bankAccountId: f.bankAccountId!, depositSlipNumber: f.depositSlipNumber.trim(), fundId: 'GF', collectionIds: f.collectionIds, amount, validatedAmount: f.validatedAmount });
      setId(r.id);
      notify('Deposit saved.', 'success');
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      title={rec ? `Deposit ${rec.depositSlipNumber}` : 'New deposit'}
      onClose={onClose}
      footer={
        <>
          {rec && <ActionBar def={DEPOSIT_MODULE} record={rec} onDone={onClose} />}
          <span className="mr-auto" />
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void save()}>{busy ? 'Saving…' : 'Save deposit'}</button>}
        </>
      }
    >
      {rec && <div className="mb-3 flex items-center gap-2"><StatusChip status={rec.status} /><span className="font-mono text-sm">{rec.depositNumber}</span></div>}
      <fieldset disabled={!editable} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Accountable officer" required className="sm:col-span-2">{(p) => <OfficerSelect {...p} barangayId={barangayId} value={f.accountableOfficerId} onChange={(v) => setF({ ...f, accountableOfficerId: v, collectionIds: [], amount: null })} />}</Field>
          <Field label="Deposit date" required>{(p) => <input {...p} type="date" className="input" value={f.depositDate} onChange={(e) => setF({ ...f, depositDate: e.target.value })} />}</Field>
          <Field label="Deposit slip no." required>{(p) => <input {...p} className="input font-mono" value={f.depositSlipNumber} onChange={(e) => setF({ ...f, depositSlipNumber: e.target.value })} />}</Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Depository bank account" required className="sm:col-span-2">{(p) => <BankAccountSelect {...p} barangayId={barangayId} value={f.bankAccountId} onChange={(v) => setF({ ...f, bankAccountId: v })} />}</Field>
          <Field label="Amount per slip" required error={amount !== orTotal ? `Must equal the selected ORs (₱${formatPesos(orTotal as Centavos, { dashZero: false })}).` : null}>{(p) => <MoneyInput {...p} value={amount} onChange={(v) => setF({ ...f, amount: v })} />}</Field>
          <Field label="Validated by bank" hint="Amount machine-validated on the slip.">{(p) => <MoneyInput {...p} value={f.validatedAmount} onChange={(v) => setF({ ...f, validatedAmount: v })} />}</Field>
        </div>
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="table-base">
            <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-800">Official receipts deposited ({selected.length} · ₱{formatPesos(orTotal as Centavos, { dashZero: false })})</caption>
            <thead><tr><th scope="col"><span className="sr-only">Include</span></th><th scope="col">OR no.</th><th scope="col">Date</th><th scope="col">Payor</th><th scope="col">Collector</th><th scope="col" className="num">Amount</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {!f.accountableOfficerId ? (
                <tr><td colSpan={6} className="p-3 text-sm text-slate-600">Select the accountable officer to list the undeposited ORs in their custody.</td></tr>
              ) : candidates.length === 0 ? (
                <tr><td colSpan={6} className="p-3 text-sm text-slate-600">No undeposited ORs dated on or before the deposit date.</td></tr>
              ) : (
                candidates.map((o) => (
                  <tr key={o.id}>
                    <td><input id={`dep-${o.id}`} type="checkbox" className="h-4 w-4" checked={f.collectionIds.includes(o.id)} onChange={() => toggle(o.id)} /></td>
                    <td><label htmlFor={`dep-${o.id}`} className="font-mono">{o.officialReceiptNumber}</label></td>
                    <td>{o.collectionDate}</td>
                    <td>{o.payor.name}</td>
                    <td>{shortOfficer(o.collectingOfficerName)}</td>
                    <td className="num"><Money value={o.amount} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </fieldset>
      {editable && candidates.length > 0 && (
        <button type="button" className="btn-ghost btn-sm mt-2" onClick={() => setF({ ...f, collectionIds: candidates.map((o) => o.id), amount: null })}>Select all listed</button>
      )}
      {rec && <div className="mt-4"><InfoGrid items={[['Reported in RCD', rec.rcdId ? 'Yes' : 'Not yet'], ['Validated amount', rec.validatedAmount === null ? '—' : formatPesos(rec.validatedAmount)], ['ORs', String(rec.collectionIds.length)]]} /></div>}
      {rec && <WorkflowTrail barangayId={rec.barangayId} recordId={rec.id} />}
    </Modal>
  );
}
