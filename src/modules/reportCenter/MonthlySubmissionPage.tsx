import {
  MONTH_NAMES,
  REPORT_DEFINITIONS,
  dueDate,
  effectiveStatus,
  manilaToday,
  packageDefinitions,
  packageId,
  submissionId,
  type PackageItem,
  type ReportPackageDoc,
  type ReportSubmissionDoc,
} from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { reportHref } from '../../components/source';
import { ConfirmDialog, EmptyState, Icon, PageHeader, Spinner, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useCollection } from '../../hooks/useCollection';
import { useDocument } from '../../hooks/useDocument';
import { api, errorMessage } from '../../services/functions/api';

/**
 * Monthly Submission Package (docs 05 §11–12): the treasurer generates every required report for
 * the month (validated, versioned), fixes FAILED items and submits; Municipal Accounting accepts
 * or returns each item. The compliance matrix shows the whole year at a glance.
 */
export function MonthlySubmissionPage() {
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const today = manilaToday();
  const defaultMonth = Number(today.slice(0, 4)) === fiscalYear ? Math.max(1, Number(today.slice(5, 7)) - 1 || 1) : 12;
  const [month, setMonth] = useState(defaultMonth);
  if (!barangayId) return null;
  return (
    <>
      <PageHeader title="Monthly Submission" subtitle={`${barangayLabel} · FY ${fiscalYear}`} breadcrumbs={['BFMS', 'Reports', 'Monthly submission']} />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="label" htmlFor="ms-month">Month</label>
          <select id="ms-month" className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m} {fiscalYear}</option>)}
          </select>
        </div>
        <Link className="btn-ghost mb-0.5" to={reportHref('TRANSMITTAL', { fiscalYear, month })}>Transmittal letter</Link>
        <Link className="btn-ghost mb-0.5" to={reportHref('COMPLIANCE', { fiscalYear, month })}>Compliance report</Link>
      </div>
      <PackagePanel key={`${barangayId}-${fiscalYear}-${month}`} month={month} />
      <ComplianceMatrix onPick={setMonth} />
    </>
  );
}

function PackagePanel({ month }: { month: number }) {
  const { can } = useAuth();
  const { notify } = useToast();
  const { barangayId, fiscalYear } = useBarangay();
  const { data: pkg, loading } = useDocument<ReportPackageDoc>('reportPackages', barangayId ? packageId(barangayId, fiscalYear, month) : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [returning, setReturning] = useState<PackageItem | null>(null);
  const [reason, setReason] = useState('');
  if (!barangayId) return null;
  const canPrepare = can('report.submit', barangayId) || can('submission.review', barangayId);
  const canSubmit = can('report.submit', barangayId);
  const canReview = can('submission.review', barangayId);
  const canAccept = can('submission.accept', barangayId);
  const editable = !pkg || pkg.status === 'GENERATED' || pkg.status === 'RETURNED';
  const reviewing = pkg && (pkg.status === 'SUBMITTED' || pkg.status === 'RESUBMITTED');
  const blockers = pkg?.items.filter((i) => i.status === 'FAILED' || i.status === 'RETURNED') ?? [];

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      notify(ok, 'success');
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  }
  const base = { barangayId, fiscalYear, month };

  return (
    <section className="card mb-6" aria-labelledby="pkg-h">
      <div className="card-header">
        <div className="flex items-center gap-2">
          <h2 id="pkg-h" className="card-title">Package for {MONTH_NAMES[month - 1]} {fiscalYear}</h2>
          {pkg && <StatusChip status={pkg.status} />}
          {pkg && <StatusChip status={pkg.overall} />}
        </div>
        <div className="flex flex-wrap gap-2">
          {canPrepare && editable && (
            <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void run('gen', () => api.generateMonthlyPackage(base), 'Package generated.')}>
              {busy === 'gen' ? 'Generating… (this can take a minute)' : pkg ? 'Regenerate' : 'Generate package'}
            </button>
          )}
          {canSubmit && editable && pkg && (
            <button type="button" className="btn-primary" disabled={!!busy || blockers.length > 0} title={blockers.length ? `Resolve: ${blockers.map((b) => b.reportCode).join(', ')}` : undefined} onClick={() => void run('sub', () => api.submitMonthlyPackage(base), 'Package submitted to Municipal Accounting.')}>
              {busy === 'sub' ? 'Submitting…' : pkg.status === 'RETURNED' ? 'Resubmit' : 'Certify & submit'}
            </button>
          )}
        </div>
      </div>
      {loading ? <Spinner /> : !pkg ? (
        <div className="p-4">
          <EmptyState title="No package yet for this month">
            Generate the package to build every required report for the month. Reports without transactions are marked not applicable.
          </EmptyState>
        </div>
      ) : (
        <div className="overflow-x-auto">
          {blockers.length > 0 && editable && (
            <p role="alert" className="m-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <Icon name="alert" className="mt-0.5" /> Submission is blocked until these are fixed and the package is regenerated: {blockers.map((b) => b.reportCode).join(', ')}.
            </p>
          )}
          <table className="table-base">
            <caption className="sr-only">Package items</caption>
            <thead><tr><th scope="col">Report</th><th scope="col">Versions</th><th scope="col">Validation</th><th scope="col">Due</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {pkg.items.map((i) => (
                <tr key={i.reportCode}>
                  <td><span className="font-mono text-xs text-navy-700">{i.reportCode}</span> {i.reportName}{i.remarks && <div className="text-xs text-slate-600">{i.remarks}</div>}</td>
                  <td className="text-sm">
                    {i.reports.length === 0 ? '—' : (
                      <ul className="space-y-0.5">
                        {i.reports.map((r) => <li key={r.id}><Link className="link" to={`/reports/snapshot/${r.id}`}>{r.label} v{r.version}</Link></li>)}
                      </ul>
                    )}
                  </td>
                  <td>{i.overall ? <StatusChip status={i.overall} /> : '—'}</td>
                  <td className="whitespace-nowrap text-xs">{i.dueDate ?? '—'}</td>
                  <td><StatusChip status={i.status} /></td>
                  <td className="text-right">
                    {reviewing && i.status === 'GENERATED' && (
                      <div className="flex justify-end gap-1">
                        {canReview && <button type="button" className="btn-ghost btn-sm" onClick={() => { setReason(''); setReturning(i); }}>Return…</button>}
                        {canAccept && <button type="button" className="btn-secondary btn-sm" disabled={!!busy} onClick={() => void run(i.reportCode, () => api.reviewPackageItem({ ...base, reportCode: i.reportCode, decision: 'ACCEPT' }), `${i.reportCode} accepted.`)}>Accept</button>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {returning && (
        <ConfirmDialog
          open
          danger
          busy={!!busy}
          title={`Return ${returning.reportCode}`}
          message="The treasurer will see your reason, correct the source records, regenerate and resubmit."
          confirmLabel="Return"
          requireReason
          reason={reason}
          onReasonChange={setReason}
          onCancel={() => setReturning(null)}
          onConfirm={() => void run(returning.reportCode, () => api.reviewPackageItem({ ...base, reportCode: returning.reportCode, decision: 'RETURN', remarks: reason }), `${returning.reportCode} returned.`).then(() => setReturning(null))}
        />
      )}
    </section>
  );
}

/** Year view: required reports × months, from reportSubmissions cells and deadline rules. */
function ComplianceMatrix({ onPick }: { onPick(month: number): void }) {
  const { barangayId, fiscalYear } = useBarangay();
  const { rows, loading } = useCollection<ReportSubmissionDoc>('reportSubmissions', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
  if (!barangayId) return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const today = manilaToday();
  const defs = [...packageDefinitions(REPORT_DEFINITIONS), ...REPORT_DEFINITIONS.filter((d) => d.reportCode === 'TRANSMITTAL')];
  return (
    <section className="card" aria-labelledby="cm-h">
      <div className="card-header"><h2 id="cm-h" className="card-title">Compliance matrix · FY {fiscalYear}</h2></div>
      {loading ? <Spinner /> : (
        <div className="overflow-x-auto">
          <table className="table-base text-xs">
            <caption className="sr-only">Status of each required report per month</caption>
            <thead>
              <tr>
                <th scope="col">Report</th>
                {MONTH_NAMES.map((m, i) => <th key={m} scope="col" className="text-center"><button type="button" className="hover:underline" onClick={() => onPick(i + 1)}>{m.slice(0, 3)}</button></th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {defs.map((d) => (
                <tr key={d.reportCode}>
                  <th scope="row" className="whitespace-nowrap bg-white text-left font-normal normal-case tracking-normal text-slate-800"><span className="font-mono text-navy-700">{d.reportCode}</span></th>
                  {MONTH_NAMES.map((_, i) => {
                    const cell = byId.get(submissionId(barangayId, fiscalYear, i + 1, d.reportCode));
                    const due = dueDate(d.deadlineRule, fiscalYear, i + 1);
                    const st = effectiveStatus(cell?.status, due, today);
                    return (
                      <td key={i} className="text-center" title={`${d.reportName} · ${MONTH_NAMES[i]} · ${st.replace(/_/g, ' ')}${due ? ` · due ${due}` : ''}`}>
                        {st === 'NOT_STARTED' ? <span className="text-slate-300">·</span> : <CellDot status={st} />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 text-xs text-slate-600">Hover a cell for details; select a month name to open its package. Due dates are the seeded defaults and must be confirmed by the Municipal Accountant.</p>
        </div>
      )}
    </section>
  );
}

const DOT: Record<string, string> = {
  ACCEPTED: 'bg-emerald-600',
  SUBMITTED: 'bg-sky-500',
  RESUBMITTED: 'bg-sky-500',
  GENERATED: 'bg-slate-400',
  DRAFT: 'bg-slate-300',
  RETURNED: 'bg-orange-500',
  OVERDUE: 'bg-red-600',
  NOT_APPLICABLE: 'bg-slate-200',
};

const SHORT: Record<string, string> = {
  ACCEPTED: 'Accepted',
  SUBMITTED: 'Submitted',
  RESUBMITTED: 'Resubm.',
  GENERATED: 'Ready',
  DRAFT: 'Draft',
  RETURNED: 'Returned',
  OVERDUE: 'Overdue',
  NOT_APPLICABLE: 'N/A',
};

function CellDot({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[status] ?? 'bg-slate-300'}`} aria-hidden="true" />
      <span className="sr-only">{status.replace(/_/g, ' ')}</span>
      <span aria-hidden="true" className="hidden text-[10px] text-slate-600 xl:inline">{SHORT[status] ?? status.toLowerCase()}</span>
    </span>
  );
}
