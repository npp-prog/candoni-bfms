import { AF_FORM_TYPES, afFormLabel, computeAfUsage, describeAfProblems, formatAfSerial, manilaToday, type AccountableFormDoc } from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { InfoGrid } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { WorkflowTrail, reportHref } from '../../components/source';
import { Field, Icon, Modal, PageHeader, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useCollection } from '../../hooks/useCollection';
import { errorMessage } from '../../services/functions/api';
import { collectionsApi } from './api';
import { OfficerSelect, OrStatus, shortOfficer, useAfSeries, type AfSeries } from './common';

/** Phase 4 — Accountable forms registry: receive series, issue them to officers, balances. */
export function AccountableFormsPage() {
  const { can } = useAuth();
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const { rows, loading } = useAfSeries();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  if (!barangayId) return null;
  const manage = can('accountableForms.manage', barangayId);
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => a.formType.localeCompare(b.formType) || a.beginningSerialNumber - b.beginningSerialNumber);
  const month = new Date().getFullYear() === fiscalYear ? new Date().getMonth() + 1 : 12;
  return (
    <>
      <PageHeader
        title="Accountable Forms"
        subtitle={`${barangayLabel} · official receipts and other accountable forms`}
        breadcrumbs={['BFMS', 'Accountable Forms']}
        actions={<Link className="btn-secondary" to={reportHref('RAAF', { fiscalYear, month })}>RAAF</Link>}
      />
      <RegisterTable
        caption="Accountable form series"
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter value={status} onChange={setStatus} options={['DRAFT', 'ACTIVE', 'EXHAUSTED', 'RETURNED', 'VOID']} />
            <div className="ml-auto">{manage && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> Receive series</button>}</div>
          </>
        }
        empty="No accountable forms yet. Receive the booklets of official receipts (AF 51) and issue them to the treasurer and collectors."
        columns={[
          { label: 'Series', render: (r) => <span className="font-mono">{r.series}</span> },
          { label: 'Form', render: (r) => afFormLabel(r.formType).split(' — ')[0] },
          { label: 'Serials', render: (r) => <span className="font-mono text-xs">{formatAfSerial(r.beginningSerialNumber, r.serialWidth)}–{formatAfSerial(r.endingSerialNumber, r.serialWidth)}</span> },
          { label: 'Issued to', render: (r) => (r.accountableOfficerName ? shortOfficer(r.accountableOfficerName) : <span className="text-slate-500">in stock</span>) },
          { label: 'Received', numeric: true, render: (r) => r.quantityReceived },
          { label: 'Issued', numeric: true, render: (r) => r.quantityIssued },
          { label: 'Cancelled', numeric: true, render: (r) => r.quantityCancelled },
          { label: 'Balance', numeric: true, render: (r) => r.endingBalance },
          { label: 'Next no.', render: (r) => (r.status === 'ACTIVE' && r.nextSerialNumber <= r.endingSerialNumber ? <span className="font-mono">{formatAfSerial(r.nextSerialNumber, r.serialWidth)}</span> : '—') },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open === 'new' && <ReceiveModal onClose={() => setOpen(null)} />}
      {open && open !== 'new' && <SeriesModal rec={rows.find((r) => r.id === open) ?? null} manage={manage} onClose={() => setOpen(null)} />}
    </>
  );
}

function ReceiveModal({ onClose }: { onClose(): void }) {
  const { barangayId } = useBarangay();
  const { notify } = useToast();
  const [f, setF] = useState({ formType: 'AF51' as AccountableFormDoc['formType'], series: '', begin: '', end: '', dateReceived: manilaToday(), officer: null as string | null, dateIssued: manilaToday(), remarks: '' });
  const [busy, setBusy] = useState(false);
  if (!barangayId) return null;
  const qty = /^\d+$/.test(f.begin) && /^\d+$/.test(f.end) ? Number(f.end) - Number(f.begin) + 1 : 0;
  const valid = qty > 0 && qty <= 5000;
  async function save() {
    setBusy(true);
    try {
      await collectionsApi.receiveAccountableForm({ barangayId: barangayId!, formType: f.formType, series: f.series.trim(), beginningSerialNumber: f.begin, endingSerialNumber: f.end, dateReceived: f.dateReceived, accountableOfficerId: f.officer, dateIssued: f.officer ? f.dateIssued : null, remarks: f.remarks.trim() });
      notify(`Series ${f.begin}–${f.end} received (${qty} forms).`, 'success');
      onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open wide title="Receive accountable forms" onClose={onClose} footer={<><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={!valid || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Receive series'}</button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Form" required>
            {(p) => (
              <select {...p} className="input" value={f.formType} onChange={(e) => setF({ ...f, formType: e.target.value as AccountableFormDoc['formType'] })}>
                {AF_FORM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Beginning serial no." required>{(p) => <input {...p} className="input font-mono" inputMode="numeric" value={f.begin} onChange={(e) => setF({ ...f, begin: e.target.value.replace(/\D/g, '') })} />}</Field>
          <Field label="Ending serial no." required hint={qty > 0 ? `${qty} forms` : 'Digits as printed, including leading zeros.'} error={f.begin && f.end && qty <= 0 ? 'The ending number must not be lower than the beginning number.' : qty > 5000 ? 'At most 5,000 forms per series.' : null}>
            {(p) => <input {...p} className="input font-mono" inputMode="numeric" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value.replace(/\D/g, '') })} />}
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Series / stub label" hint="Defaults to the serial range.">{(p) => <input {...p} className="input" value={f.series} onChange={(e) => setF({ ...f, series: e.target.value })} />}</Field>
          <Field label="Date received" required>{(p) => <input {...p} type="date" className="input" value={f.dateReceived} onChange={(e) => setF({ ...f, dateReceived: e.target.value })} />}</Field>
        </div>
        <fieldset className="rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-semibold text-slate-800">Issue to an accountable officer now (optional)</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Accountable officer / collector" className="sm:col-span-2">{(p) => <OfficerSelect {...p} barangayId={barangayId} value={f.officer} onChange={(v) => setF({ ...f, officer: v })} emptyLabel="— keep in stock —" />}</Field>
            <Field label="Date issued">{(p) => <input {...p} type="date" className="input" value={f.dateIssued} disabled={!f.officer} onChange={(e) => setF({ ...f, dateIssued: e.target.value })} />}</Field>
          </div>
        </fieldset>
        <Field label="Remarks">{(p) => <input {...p} className="input" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}

function SeriesModal({ rec, manage, onClose }: { rec: AfSeries | null; manage: boolean; onClose(): void }) {
  const { notify } = useToast();
  const ors = useCollection<{ serialNumber: number; officialReceiptNumber: string; collectionDate: string; status: string; payor: { name: string } }>('collections', rec ? [['barangayId', '==', rec.barangayId], ['accountableFormId', '==', rec.id]] : null);
  const [officer, setOfficer] = useState<string | null>(rec?.accountableOfficerId || null);
  const [date, setDate] = useState(manilaToday());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!rec) return null;
  const usage = computeAfUsage({ begin: rec.beginningSerialNumber, end: rec.endingSerialNumber }, ors.rows.map((o) => ({ serial: o.serialNumber, date: o.collectionDate, status: o.status })));
  const problems = describeAfProblems('This series', usage);
  const canAssign = manage && (rec.status === 'DRAFT' || (rec.status === 'ACTIVE' && rec.quantityUsed === 0));
  const canClose = manage && ['DRAFT', 'ACTIVE'].includes(rec.status);
  async function run(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      notify(msg, 'success');
      onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open wide title={`${afFormLabel(rec.formType)} · ${rec.series}`} onClose={onClose} footer={<button type="button" className="btn-secondary" onClick={onClose}>Close</button>}>
      <div className="mb-3"><StatusChip status={rec.status} /></div>
      <InfoGrid
        columns={4}
        items={[
          ['Serials', `${formatAfSerial(rec.beginningSerialNumber, rec.serialWidth)} – ${formatAfSerial(rec.endingSerialNumber, rec.serialWidth)}`],
          ['Issued to', rec.accountableOfficerName ?? 'In stock'],
          ['Received / issued on', `${rec.dateReceived}${rec.dateIssued ? ` / ${rec.dateIssued}` : ''}`],
          ['Used (issued + cancelled)', `${rec.quantityUsed} (${rec.quantityIssued} + ${rec.quantityCancelled})`],
          ['Balance', String(rec.endingBalance)],
          ['Next OR no.', usage.nextSerialNumber ? formatAfSerial(usage.nextSerialNumber, rec.serialWidth) : 'exhausted'],
          ['Remarks', rec.remarks || null],
        ]}
      />
      <p role="status" className={`mt-3 rounded-md border px-3 py-2 text-sm ${problems ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{problems || 'No missing, duplicate or out-of-series numbers.'}</p>
      {canAssign && (
        <form className="mt-4 flex flex-wrap items-end gap-3 rounded-md border border-slate-200 p-3" onSubmit={(e) => { e.preventDefault(); if (officer) void run(() => collectionsApi.assignAccountableForm({ id: rec.id, accountableOfficerId: officer, dateIssued: date }), 'Series issued to the officer.'); }}>
          <Field label="Issue to" required className="min-w-[16rem] flex-1">{(p) => <OfficerSelect {...p} barangayId={rec.barangayId} value={officer} onChange={setOfficer} />}</Field>
          <Field label="Date issued" required>{(p) => <input {...p} type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <button type="submit" className="btn-primary mb-5" disabled={busy || !officer}>Issue series</button>
        </form>
      )}
      {canClose && (
        <div className="mt-4 rounded-md border border-slate-200 p-3">
          <Field label="Reason (return or void)" hint="Return the unused balance (e.g. officer leaves); void only a series encoded by mistake and never used.">{(p) => <input {...p} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" disabled={busy || reason.trim().length < 5} onClick={() => void run(() => collectionsApi.returnAccountableForm({ id: rec.id, date, reason: reason.trim() }), 'Unused balance returned.')}>Return balance</button>
            {rec.quantityUsed === 0 && <button type="button" className="btn-danger" disabled={busy || reason.trim().length < 5} onClick={() => void run(() => collectionsApi.voidAccountableForm({ id: rec.id, reason: reason.trim() }), 'Series voided.')}>Void series</button>}
          </div>
        </div>
      )}
      {ors.rows.length > 0 && (
        <div className="mt-4 max-h-64 overflow-auto rounded-md border border-slate-200">
          <table className="table-base">
            <caption className="sr-only">Serials used</caption>
            <thead><tr><th scope="col">OR no.</th><th scope="col">Date</th><th scope="col">Payor</th><th scope="col">Status</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {[...ors.rows].sort((a, b) => a.serialNumber - b.serialNumber).map((o) => (
                <tr key={o.id}><td className="font-mono">{o.officialReceiptNumber}</td><td>{o.collectionDate}</td><td>{o.payor?.name}</td><td><OrStatus status={o.status} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <WorkflowTrail barangayId={rec.barangayId} recordId={rec.id} />
    </Modal>
  );
}
