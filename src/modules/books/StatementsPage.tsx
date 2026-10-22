import { computeSfp, computeSfperf, formatPesos, netByAccount } from '@bfms/shared';
import { useMemo } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { ModuleTabs } from '../../components/register';
import { reportHref } from '../../components/source';
import { Icon, PageHeader, Spinner, StatusChip } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { useChartOfAccounts } from '../../hooks/useChartOfAccounts';
import { NfsEditor } from './NfsEditor';
import { useBalances } from './useBalances';

const STATEMENTS: Array<{ code: string; title: string; text: string }> = [
  { code: 'SFP', title: 'Statement of Financial Position', text: 'Assets, liabilities and net assets/equity as at December 31, with the prior-year comparative.' },
  { code: 'DSFP', title: 'Detailed Statement of Financial Position', text: 'Every account under its statement line, with account codes; contra accounts netted.' },
  { code: 'SFPERF', title: 'Statement of Financial Performance', text: 'Revenue, current operating expenses, transfers and the surplus (deficit) for the period.' },
  { code: 'DSFPERF', title: 'Detailed Statement of Financial Performance', text: 'Revenue and expense accounts under each line, with account codes.' },
  { code: 'SNAE', title: 'Statement of Net Assets/Equity', text: 'Equity accounts at year end and the movement for the year.' },
  { code: 'SCNAE', title: 'Statement of Changes in Net Assets/Equity', text: "Balance at January 1, prior years' adjustments, surplus (deficit), balance at December 31." },
  { code: 'SCF', title: 'Statement of Cash Flows', text: 'Direct method, classified by the counter-account of each posted cash entry; reconciled to cash.' },
  { code: 'SCBAA', title: 'Statement of Comparison of Budget and Actual Amounts', text: 'Estimated vs actual receipts; appropriations vs obligations by expense class.' },
  { code: 'NFS', title: 'Notes to Financial Statements', text: 'Narrative notes plus generated schedules: cash, receivables, PPE roll-forward, payables.' },
  { code: 'SMR', title: 'Statement of Management Responsibility', text: 'Standard statement signed by the Barangay Treasurer and the Punong Barangay.' },
];

/** Quick on-screen check of the year's figures (same pure mapping the statements use). */
function ChecksCard() {
  const { barangayId, fiscalYear } = useBarangay();
  const coa = useChartOfAccounts();
  const { rows, loading, error } = useBalances(barangayId, fiscalYear);
  const f = useMemo(() => (coa ? { sfp: computeSfp(netByAccount(rows, 0, 13), coa), perf: computeSfperf(netByAccount(rows, 1, 12), coa) } : null), [rows, coa]);
  const p = (v: number) => formatPesos(v, { symbol: true });
  return (
    <section className="card mb-4 p-4" aria-labelledby="fs-check" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="fs-check" className="card-title">FY {fiscalYear} at a glance</h2>
        {f && rows.length > 0 && <StatusChip status={f.sfp.balanced ? 'PASSED' : 'FAILED'} />}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">Could not load balances: {error.message}</p>
      ) : loading || !f ? (
        <Spinner label="Loading balances…" />
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">No posted balances for FY {fiscalYear} yet.</p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
          <div><dt className="text-xs text-slate-600">Total assets</dt><dd className="font-semibold tabular-nums">{p(f.sfp.totalAssets)}</dd></div>
          <div><dt className="text-xs text-slate-600">Total liabilities</dt><dd className="font-semibold tabular-nums">{p(f.sfp.totalLiabilities)}</dd></div>
          <div><dt className="text-xs text-slate-600">Net assets/equity</dt><dd className="font-semibold tabular-nums">{p(f.sfp.totalNetAssets)}</dd></div>
          <div><dt className="text-xs text-slate-600">Total revenue</dt><dd className="font-semibold tabular-nums">{p(f.perf.totalRevenue)}</dd></div>
          <div><dt className="text-xs text-slate-600">Surplus (deficit)</dt><dd className={`font-semibold tabular-nums ${f.perf.surplus < 0 ? 'text-red-700' : ''}`}>{p(f.perf.surplus)}</dd></div>
          <p className="col-span-full text-xs text-slate-600">
            {f.sfp.balanced ? 'Assets = Liabilities + Net Assets/Equity.' : <span className="font-medium text-red-700">Assets differ from liabilities + net assets by {p(f.sfp.difference)} — check the trial balance.</span>}
            {f.sfp.unclosedSurplus !== 0 && ' Closing entries are not yet posted; the surplus is shown in net assets/equity.'}
            {f.sfp.unmapped.length > 0 && <span className="text-amber-900"> {f.sfp.unmapped.length} account(s) have no statement classification.</span>}
          </p>
        </dl>
      )}
    </section>
  );
}

function Overview() {
  const { fiscalYear } = useBarangay();
  return (
    <>
      <ChecksCard />
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Financial statements">
        {STATEMENTS.map((s) => (
          <li key={s.code} className="card flex flex-col p-4">
            <div className="flex items-start justify-between gap-2">
              <h2 className="card-title">{s.title}</h2>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">{s.code}</span>
            </div>
            <p className="mt-1 flex-1 text-sm text-slate-600">{s.text}</p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {s.code === 'NFS' && <Link className="btn-secondary" to="/statements/notes">Edit narrative</Link>}
              <Link className="btn-primary" to={reportHref(s.code, { fiscalYear })} aria-label={`Open ${s.title}`}><Icon name="file" /> Open</Link>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Phase 11 — Financial statements and the Notes to Financial Statements narrative editor. */
export function StatementsPage() {
  const { barangayLabel, fiscalYear } = useBarangay();
  return (
    <>
      <PageHeader
        title="Financial Statements"
        subtitle={`${barangayLabel} · FY ${fiscalYear} · for the year ended December 31`}
        breadcrumbs={['BFMS', 'Accounting', 'Financial statements']}
        actions={<Link className="btn-secondary" to={reportHref('TB', { fiscalYear, month: 12, variant: 'PRE_CLOSING' })}>Pre-closing trial balance</Link>}
      />
      <ModuleTabs label="Financial statements" tabs={[{ to: '/statements', label: 'Statements', end: true }, { to: '/statements/notes', label: 'Notes (narrative)' }]} />
      <Routes>
        <Route index element={<Overview />} />
        <Route path="notes" element={<NfsEditor />} />
      </Routes>
    </>
  );
}
