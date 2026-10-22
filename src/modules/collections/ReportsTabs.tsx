import { RCD_MODULE, RCR_MODULE, formatPesos, lastDayOfMonth, manilaToday, type Centavos, type RcdRecord, type RcrDoc } from '@bfms/shared';
import { useState } from 'react';
import { InfoGrid, MoneyInput } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, PrintLink, ReturnBanner, WorkflowTrail, statusOptions, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { OfficerSelect, shortOfficer } from './common';

const monthStart = (d: string) => `${d.slice(0, 8)}01`;
const monthEnd = (d: string) => lastDayOfMonth(Number(d.slice(0, 4)), Number(d.slice(5, 7)));
const VALIDATION_TONE = { PASSED: 'text-emerald-800 bg-emerald-50 border-emerald-200', WARNING: 'text-amber-900 bg-amber-50 border-amber-200', FAILED: 'text-red-800 bg-red-50 border-red-200' } as const;

// ------------------------------------------------------------------ RCD

export function RcdTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const { rows, loading } = useCollection<RcdRecord>('rcdReports', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  if (!barangayId) return null;
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => b.dateTo.localeCompare(a.dateTo));
  return (
    <>
      <RegisterTable
        caption={`Reports of Collections and Deposits FY ${fiscalYear}`}
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter value={status} onChange={setStatus} options={statusOptions(RCD_MODULE)} />
            <div className="ml-auto">{can('treasury.encode', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> Prepare RCD</button>}</div>
          </>
        }
        empty={`No RCDs for FY ${fiscalYear}. Prepare one per accountable officer for the period (usually the month).`}
        columns={[
          { label: 'RCD no.', render: (r) => r.rcdNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Period', render: (r) => `${r.dateFrom} – ${r.dateTo}` },
          { label: 'Accountable officer', render: (r) => shortOfficer(r.accountableOfficerName) },
          { label: 'ORs', render: (r) => (r.orFrom ? `${r.orFrom}–${r.orTo}` : '—') },
          { label: 'Collections', numeric: true, render: (r) => <Money value={r.totalCollections} /> },
          { label: 'Deposits', numeric: true, render: (r) => <Money value={r.totalDeposits} /> },
          { label: 'Undeposited', numeric: true, render: (r) => <Money value={r.undeposited} /> },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <RcdEditor rec={open === 'new' ? null : rows.find((r) => r.id === open) ?? null} rows={rows} onClose={() => setOpen(null)} />}
    </>
  );
}

function RcdEditor({ rec: initial, rows, onClose }: { rec: (RcdRecord & { id: string }) | null; rows: Array<RcdRecord & { id: string }>; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const [id, setId] = useState(initial?.id ?? null);
  const rec = (id && rows.find((r) => r.id === id)) || initial;
  const today = manilaToday();
  const [f, setF] = useState({
    accountableOfficerId: rec?.accountableOfficerId ?? (null as string | null),
    dateFrom: rec?.dateFrom ?? monthStart(today),
    dateTo: rec?.dateTo ?? monthEnd(today),
    differenceExplanation: rec?.differenceExplanation ?? '',
  });
  const { save, busy } = useSaveSource(RCD_MODULE.key);
  if (!barangayId) return null;
  const editable = can('treasury.encode', barangayId) && (!rec || RCD_MODULE.editableStatuses.includes(rec.status));
  const valid = !!f.accountableOfficerId && f.dateFrom <= f.dateTo;
  async function onSave() {
    const nid = await save(barangayId!, { ...f, fundId: 'GF', differenceExplanation: f.differenceExplanation.trim() || null }, id ?? undefined);
    if (nid) setId(nid);
  }
  return (
    <Modal
      open
      wide
      title={rec?.rcdNumber ? `RCD ${rec.rcdNumber}` : rec ? 'Report of Collections and Deposits (draft)' : 'Prepare Report of Collections and Deposits'}
      onClose={onClose}
      footer={
        <>
          {rec && <ActionBar def={RCD_MODULE} record={rec} />}
          {rec && <PrintLink code="RCD" documentId={rec.id} fiscalYear={rec.fiscalYear ?? fiscalYear} label="Print RCD" />}
          <span className="mr-auto" />
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Computing…' : rec ? 'Save & recompute' : 'Prepare'}</button>}
        </>
      }
    >
      {rec && <div className="mb-3 flex items-center gap-2"><StatusChip status={rec.status} />{rec.rcdNumber && <span className="font-mono text-sm">{rec.rcdNumber}</span>}</div>}
      {rec && <ReturnBanner record={rec} />}
      <fieldset disabled={!editable} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Accountable officer" required className="sm:col-span-2">{(p) => <OfficerSelect {...p} barangayId={barangayId} value={f.accountableOfficerId} onChange={(v) => setF({ ...f, accountableOfficerId: v })} />}</Field>
          <Field label="From" required>{(p) => <input {...p} type="date" className="input" value={f.dateFrom} onChange={(e) => setF({ ...f, dateFrom: e.target.value })} />}</Field>
          <Field label="To" required>{(p) => <input {...p} type="date" className="input" value={f.dateTo} onChange={(e) => setF({ ...f, dateTo: e.target.value })} />}</Field>
        </div>
        <Field label="Explanation of undeposited collections" hint="Required when collections are not fully deposited (at least 10 characters).">
          {(p) => <textarea {...p} rows={2} className="input" value={f.differenceExplanation} onChange={(e) => setF({ ...f, differenceExplanation: e.target.value })} />}
        </Field>
      </fieldset>
      {rec && (
        <div className="mt-4 space-y-3">
          <InfoGrid
            columns={4}
            items={[
              ['Undeposited, last report', <Money key="b" value={rec.undepositedBeginning ?? 0} dashZero={false} />],
              ['Collections', <span key="c"><Money value={rec.totalCollections} dashZero={false} /> <span className="text-xs text-slate-600">({rec.collectionCount} OR{rec.cancelledCount ? `, ${rec.cancelledCount} cancelled` : ''})</span></span>],
              ['Deposits', <span key="d"><Money value={rec.totalDeposits} dashZero={false} /> <span className="text-xs text-slate-600">({rec.depositIds?.length ?? 0} slip)</span></span>],
              ['Undeposited, this report', <Money key="u" value={rec.undeposited} dashZero={false} />],
              ['OR nos.', rec.orFrom ? `${rec.orFrom} – ${rec.orTo}` : '—'],
              ['Remittances (RCR)', String(rec.rcrIds?.length ?? 0)],
              ['Journal entry', rec.jevId ? (rec as RcdRecord & { jevNumber?: string }).jevNumber ?? 'Draft JEV generated' : '—'],
            ]}
          />
          {rec.validationResult && <p role="status" className={`rounded-md border px-3 py-2 text-sm ${VALIDATION_TONE[rec.validationResult]}`}>{rec.validationResult}: {rec.validationMessage}</p>}
          {RCD_MODULE.editableStatuses.includes(rec.status) && <p className="text-xs text-slate-600">Totals are recomputed by the server when you save and again when you submit.</p>}
        </div>
      )}
      {rec && <WorkflowTrail barangayId={rec.barangayId} recordId={rec.id} />}
    </Modal>
  );
}

// ------------------------------------------------------------------ RCR

export function RcrTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const { rows, loading } = useCollection<RcrDoc>('rcrReports', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  if (!barangayId) return null;
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => b.remittanceDate.localeCompare(a.remittanceDate));
  return (
    <>
      <RegisterTable
        caption={`Reports of Collections and Remittances FY ${fiscalYear}`}
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter value={status} onChange={setStatus} options={statusOptions(RCR_MODULE).filter((s) => s !== 'POSTED')} />
            <div className="ml-auto">{can('treasury.encode', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New remittance (RCR)</button>}</div>
          </>
        }
        empty="No remittances. Deputized collectors remit their collections to the treasurer with an RCR."
        columns={[
          { label: 'RCR no.', render: (r) => r.rcrNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Remitted', render: (r) => r.remittanceDate },
          { label: 'Collector', render: (r) => shortOfficer(r.collectorName) },
          { label: 'To', render: (r) => shortOfficer(r.receivingOfficerName) },
          { label: 'ORs', render: (r) => (r.orFrom ? `${r.orFrom}–${r.orTo}` : '—') },
          { label: 'Amount remitted', numeric: true, render: (r) => <Money value={r.amountRemitted} /> },
          { label: 'In RCD', render: (r) => (r.rcdId ? <Icon name="check" className="h-4 w-4 text-emerald-700" /> : '') },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <RcrEditor rec={open === 'new' ? null : rows.find((r) => r.id === open) ?? null} rows={rows} onClose={() => setOpen(null)} />}
    </>
  );
}

function RcrEditor({ rec: initial, rows, onClose }: { rec: (RcrDoc & { id: string }) | null; rows: Array<RcrDoc & { id: string }>; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const [id, setId] = useState(initial?.id ?? null);
  const rec = (id && rows.find((r) => r.id === id)) || initial;
  const today = manilaToday();
  const [f, setF] = useState({
    collectorId: rec?.collectorId ?? (null as string | null),
    receivingOfficerId: rec?.receivingOfficerId ?? (null as string | null),
    dateFrom: rec?.dateFrom ?? today,
    dateTo: rec?.dateTo ?? today,
    remittanceDate: rec?.remittanceDate ?? today,
    amountRemitted: (rec?.amountRemitted ?? 0) as Centavos | null,
  });
  const { save, busy } = useSaveSource(RCR_MODULE.key);
  if (!barangayId) return null;
  const editable = can('treasury.encode', barangayId) && (!rec || RCR_MODULE.editableStatuses.includes(rec.status));
  const valid = !!f.collectorId && !!f.receivingOfficerId && f.collectorId !== f.receivingOfficerId && f.dateFrom <= f.dateTo && f.amountRemitted !== null;
  async function onSave() {
    const nid = await save(barangayId!, { ...f, fundId: 'GF', amountRemitted: f.amountRemitted ?? 0 }, id ?? undefined);
    if (nid) setId(nid);
  }
  const mismatch = rec && RCR_MODULE.editableStatuses.includes(rec.status) && rec.totalCollections !== rec.amountRemitted;
  return (
    <Modal
      open
      wide
      title={rec?.rcrNumber ? `RCR ${rec.rcrNumber}` : 'Report of Collections and Remittances'}
      onClose={onClose}
      footer={
        <>
          {rec && <ActionBar def={RCR_MODULE} record={rec} />}
          {rec && <PrintLink code="RCR" documentId={rec.id} fiscalYear={rec.fiscalYear ?? fiscalYear} label="Print RCR" />}
          <span className="mr-auto" />
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Computing…' : 'Save'}</button>}
        </>
      }
    >
      {rec && <div className="mb-3 flex items-center gap-2"><StatusChip status={rec.status} />{rec.rcrNumber && <span className="font-mono text-sm">{rec.rcrNumber}</span>}</div>}
      {rec && <ReturnBanner record={rec} />}
      <fieldset disabled={!editable} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Deputized collector" required>{(p) => <OfficerSelect {...p} barangayId={barangayId} value={f.collectorId} onChange={(v) => setF({ ...f, collectorId: v })} />}</Field>
          <Field label="Remitted to (treasurer)" required error={f.collectorId && f.collectorId === f.receivingOfficerId ? 'Choose a different officer.' : null}>{(p) => <OfficerSelect {...p} barangayId={barangayId} value={f.receivingOfficerId} onChange={(v) => setF({ ...f, receivingOfficerId: v })} />}</Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Collections from" required>{(p) => <input {...p} type="date" className="input" value={f.dateFrom} onChange={(e) => setF({ ...f, dateFrom: e.target.value })} />}</Field>
          <Field label="to" required>{(p) => <input {...p} type="date" className="input" value={f.dateTo} onChange={(e) => setF({ ...f, dateTo: e.target.value })} />}</Field>
          <Field label="Date remitted" required>{(p) => <input {...p} type="date" className="input" value={f.remittanceDate} onChange={(e) => setF({ ...f, remittanceDate: e.target.value })} />}</Field>
          <Field label="Amount remitted" required>{(p) => <MoneyInput {...p} value={f.amountRemitted} onChange={(v) => setF({ ...f, amountRemitted: v })} />}</Field>
        </div>
      </fieldset>
      {rec && (
        <div className="mt-4 space-y-2">
          <InfoGrid items={[['Collections', <Money key="c" value={rec.totalCollections} dashZero={false} />], ['ORs', rec.orFrom ? `${rec.orFrom} – ${rec.orTo} (${rec.collectionCount})` : '—'], ['Reported in RCD', rec.rcdId ? 'Yes' : 'Not yet']]} />
          {mismatch && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">The amount remitted must equal the collections (₱{formatPesos(rec.totalCollections, { dashZero: false })}) before the RCR can be submitted.</p>}
        </div>
      )}
      {rec && <WorkflowTrail barangayId={rec.barangayId} recordId={rec.id} />}
    </Modal>
  );
}
