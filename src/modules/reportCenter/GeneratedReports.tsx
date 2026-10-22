import { reportDefinition, type GeneratedReportRecord, type ReportModel } from '@bfms/shared';
import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ConfirmDialog, EmptyState, Icon, PageHeader, Spinner, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useCollection } from '../../hooks/useCollection';
import { useDocument } from '../../hooks/useDocument';
import { db } from '../../services/firebase/app';
import { api, errorMessage } from '../../services/functions/api';
import { exportReportXlsx } from '../../reports/exportXlsx';
import { ReportDocument } from '../../reports/ReportDocument';

const STATUSES = ['GENERATED', 'SUBMITTED', 'RETURNED', 'ACCEPTED', 'FINAL', 'ARCHIVED'];

/** Saved report versions (server snapshots) for the barangay and fiscal year. */
export function GeneratedReports() {
  const { barangayId, fiscalYear } = useBarangay();
  const [status, setStatus] = useState('');
  const [code, setCode] = useState('');
  const { rows, loading } = useCollection<GeneratedReportRecord>('generatedReports', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
  const list = rows
    .filter((r) => (!status || r.status === status) && (!code || r.reportCode === code))
    .sort((a, b) => (b.generatedAt?.seconds ?? 0) - (a.generatedAt?.seconds ?? 0));
  const codes = [...new Set(rows.map((r) => r.reportCode))].sort();
  return (
    <RegisterTable
      caption="Saved report versions"
      rows={list}
      loading={loading}
      toolbar={
        <>
          <StatusFilter value={status} onChange={setStatus} options={STATUSES} />
          <label className="label mb-0 ml-2" htmlFor="gr-code">Report</label>
          <select id="gr-code" className="input max-w-[12rem]" value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">All reports</option>
            {codes.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </>
      }
      empty={
        <EmptyState title="No saved versions yet">
          Open a report and choose <strong>Save version</strong>, or generate the monthly package on the Monthly Submission page.
        </EmptyState>
      }
      columns={[
        { label: 'Report', render: (r) => <Link className="link" to={`/reports/snapshot/${r.id}`}>{r.reportCode} — {r.title}</Link> },
        { label: 'Period', render: (r) => r.reportingPeriod?.label || r.periodKey },
        { label: 'Filter', className: 'max-w-[12rem] truncate text-xs', render: (r) => Object.entries(r.filters ?? {}).filter(([k]) => k !== 'documentId').map(([, v]) => v).join(' · ') },
        { label: 'Version', numeric: true, render: (r) => `v${r.version}` },
        { label: 'Validation', render: (r) => <StatusChip status={r.overall ?? 'PASSED'} /> },
        { label: 'Status', render: (r) => <span className="flex items-center gap-1"><StatusChip status={r.status} />{r.staleSource && <StatusChip status="STALE" />}</span> },
        { label: 'Generated', render: (r) => (r.generatedAt ? new Date(r.generatedAt.seconds * 1000).toLocaleString('en-PH') : '') },
      ]}
    />
  );
}

/** Load a snapshot's chunked payload. */
async function loadPayload(id: string): Promise<ReportModel> {
  const s = await getDocs(query(collection(db, 'generatedReports', id, 'payload'), orderBy('i')));
  return JSON.parse(s.docs.map((d) => d.get('data') as string).join('')) as ReportModel;
}

/** A stored version, rendered exactly as it was generated. */
export function SnapshotPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { notify } = useToast();
  const { data: meta, loading } = useDocument<GeneratedReportRecord>('generatedReports', id);
  const [model, setModel] = useState<ReportModel | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!meta) return;
    loadPayload(id).then(setModel).catch((e) => notify(errorMessage(e), 'error'));
  }, [id, meta?.dataHash]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <Spinner />;
  if (!meta) return <EmptyState title="Saved version not found" action={<Link className="btn-secondary" to="/reports/generated">Saved versions</Link>} />;
  const def = reportDefinition(meta.reportCode);
  const canFinalize = can('report.finalize', meta.barangayId) && !['FINAL', 'ARCHIVED'].includes(meta.status) && !meta.staleSource;

  async function finalize() {
    setBusy(true);
    try {
      await api.finalizeReport({ reportId: id });
      notify('Report finalized. This version is now frozen.', 'success');
      setConfirm(false);
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="no-print">
        <PageHeader
          title={`${meta.title} · v${meta.version}`}
          subtitle={`${meta.reportingPeriod?.label ?? meta.periodKey} · generated ${meta.generatedAt ? new Date(meta.generatedAt.seconds * 1000).toLocaleString('en-PH') : ''}`}
          breadcrumbs={['BFMS', 'Reports', 'Saved versions', meta.reportCode]}
          actions={
            <>
              <Link className="btn-ghost" to="/reports/generated">Saved versions</Link>
              <button type="button" className="btn-secondary" disabled={!model} onClick={() => window.print()}><Icon name="file" /> Print / PDF</button>
              <button type="button" className="btn-secondary" disabled={!model} onClick={() => model && void exportReportXlsx(model, `${meta.reportCode}_${meta.barangayId}_${meta.periodKey}_v${meta.version}`)}>Excel</button>
              {canFinalize && <button type="button" className="btn-primary" onClick={() => setConfirm(true)}>Finalize</button>}
            </>
          }
        />
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <StatusChip status={meta.status} />
          {meta.staleSource && (
            <span className="rounded-md border border-orange-300 bg-orange-50 px-2 py-1 text-orange-900">Superseded source data — the period was reopened. Regenerate after it is locked again.</span>
          )}
          <span className="font-mono text-xs text-slate-500" title="SHA-256 of the report content">#{meta.dataHash.slice(0, 12)}</span>
          {def && <span className="text-slate-600">{def.reportName}</span>}
        </div>
        {meta.validation.length > 0 && (
          <ul className="mb-4 space-y-1 text-sm">
            {meta.validation.map((v) => (
              <li key={v.id} className="flex items-center gap-2"><StatusChip status={v.result} /><span className="font-mono text-xs">{v.id}</span> {v.message}</li>
            ))}
          </ul>
        )}
      </div>
      {!model ? <Spinner label="Loading saved version…" /> : (
        <>
          <style>{`@page { size: ${model.paper.size === 'LEGAL' ? 'legal' : model.paper.size === 'LETTER' ? 'letter' : 'A4'} ${model.paper.orientation.toLowerCase()}; margin: 10mm; }`}</style>
          <ReportDocument model={model} />
        </>
      )}
      {confirm && (
        <ConfirmDialog
          open
          busy={busy}
          title="Finalize report"
          message="A FINAL version is frozen and cannot be overwritten; corrections need a new version after the period is reopened and locked again. The accounting period must be locked."
          confirmLabel="Finalize"
          onCancel={() => setConfirm(false)}
          onConfirm={() => void finalize()}
        />
      )}
    </>
  );
}
