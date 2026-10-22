import { formatPesos, type Centavos, type FinancialSummaryDoc } from '@bfms/shared';
import { doc, onSnapshot } from 'firebase/firestore';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon, Money, PageHeader, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { usePeriods } from '../../hooks/usePeriods';
import { db } from '../../services/firebase/app';
import { MonthlyFlowChart } from './MonthlyFlowChart';

const MONTHS = ['Opening', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Closing'];

type Summary = FinancialSummaryDoc | null | undefined; // undefined = still loading

export function DashboardPage() {
  const { can } = useAuth();
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const { periods, loading: periodsLoading } = usePeriods(barangayId, fiscalYear);
  const [summary, setSummary] = useState<Summary>(undefined);
  useEffect(() => {
    if (!barangayId) return;
    setSummary(undefined);
    return onSnapshot(doc(db, 'financialSummaries', `${barangayId}_${fiscalYear}`), (s) => setSummary(s.exists() ? (s.data() as FinancialSummaryDoc) : null), () => setSummary(null));
  }, [barangayId, fiscalYear]);

  const loading = summary === undefined;
  const s = summary ?? null;
  const totalCash = s ? s.cashInLocalTreasury + s.cashInBank : undefined;
  const utilization = s && s.totalAppropriation > 0 ? s.totalObligations / s.totalAppropriation : null;
  const thisMonth = new Date().getFullYear() === fiscalYear ? new Date().getMonth() + 1 : null;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${barangayLabel} · Fiscal Year ${fiscalYear}`}
        breadcrumbs={['BFMS', 'Dashboard']}
        actions={
          barangayId && can('jev.prepare', barangayId) ? (
            <Link to="/accounting" className="btn-primary"><Icon name="plus" /> Journal entries</Link>
          ) : undefined
        }
      />

      {summary === null && (
        <div role="status" className="mb-6 flex items-start gap-3 rounded-lg border border-navy-100 bg-navy-50 px-4 py-3 text-sm text-navy-900">
          <Icon name="info" className="mt-0.5 h-4 w-4 text-navy-600" />
          <p>No posted transactions yet for FY {fiscalYear}. Summary figures appear here once entries are posted; the server keeps them up to date (Phase 13).</p>
        </div>
      )}

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <KpiGroup title="Cash position">
          <Kpi label="Total cash" value={totalCash} loading={loading} emphasis />
          <Kpi label="Cash in local treasury" value={s?.cashInLocalTreasury} loading={loading} />
          <Kpi label="Cash in bank" value={s?.cashInBank} loading={loading} />
        </KpiGroup>

        <KpiGroup title="Budget">
          <Kpi label="Total appropriation" value={s?.totalAppropriation} loading={loading} />
          <Kpi label="Total obligations" value={s?.totalObligations} loading={loading} />
          <div>
            <div className="flex items-baseline justify-between text-xs">
              <span className="kpi-label">Utilization</span>
              <span className="font-semibold tabular-nums text-navy-800">{utilization === null ? '—' : `${(utilization * 100).toFixed(1)}%`}</span>
            </div>
            <div
              className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-200"
              role="meter"
              aria-label="Budget utilization"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={utilization === null ? undefined : Math.round(utilization * 100)}
            >
              {utilization !== null && <div className={`h-full rounded-full ${utilization > 1 ? 'bg-red-700' : 'bg-navy-600'}`} style={{ width: `${Math.min(utilization, 1) * 100}%` }} />}
            </div>
            {s && s.totalAppropriation > 0 && (
              <p className="mt-1 text-xs text-slate-600">
                Unobligated balance: {formatPesos((s.totalAppropriation - s.totalObligations) as Centavos, { symbol: true })}
              </p>
            )}
          </div>
        </KpiGroup>

        <KpiGroup title="Needs attention">
          <Kpi label="Unliquidated cash advances" value={s?.unliquidatedCashAdvances} loading={loading} warn={!!s && s.overdueCashAdvances > 0} note={s && s.overdueCashAdvances > 0 ? <>{formatPesos(s.overdueCashAdvances, { symbol: true })} overdue</> : undefined} />
          <Kpi label="Outstanding checks" value={s?.outstandingChecks} loading={loading} />
          <div className="grid grid-cols-3 gap-2 text-center">
            <Count label="Reports due" value={s?.reportsDue} />
            <Count label="Pending review" value={s?.reportsPendingReview} />
            <Count label="Returned" value={s?.reportsReturned} warn={!!s && s.reportsReturned > 0} />
          </div>
        </KpiGroup>
      </div>

      <section className="card mb-6" aria-labelledby="flow-h">
        <div className="card-header">
          <h2 id="flow-h" className="card-title">Collections and disbursements by month</h2>
        </div>
        <div className="p-4">
          {loading ? <div className="skeleton h-56" aria-hidden="true" /> : s && s.monthly?.length ? <MonthlyFlowChart monthly={s.monthly} /> : <p className="py-8 text-center text-sm text-slate-600">Monthly figures appear once collections and disbursements are posted.</p>}
        </div>
      </section>

      <section className="card" aria-labelledby="periods-h">
        <div className="card-header">
          <h2 id="periods-h" className="card-title">Accounting periods</h2>
          {s?.lastSubmittedPeriod && <span className="text-xs text-slate-600">Last submitted: {s.lastSubmittedPeriod}</span>}
        </div>
        {periodsLoading ? (
          <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4 lg:grid-cols-7" aria-hidden="true">
            {Array.from({ length: 14 }, (_, i) => <div key={i} className="skeleton h-14" />)}
          </div>
        ) : periods.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-600">No periods have been opened for FY {fiscalYear} yet. Municipal Accounting opens the fiscal year under Administration.</p>
        ) : (
          <ol className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4 lg:grid-cols-7">
            {periods.map((p) => {
              const current = p.month === thisMonth;
              return (
                <li key={p.id} className={`rounded-md border p-2 text-center ${current ? 'border-gold-500 bg-gold-50' : 'border-slate-200'}`} aria-current={current ? 'date' : undefined}>
                  <div className={`mb-1 text-xs ${current ? 'font-semibold text-navy-800' : 'text-slate-600'}`}>
                    {MONTHS[p.month]}
                    {current && <span className="sr-only"> (current month)</span>}
                  </div>
                  <StatusChip status={p.status} />
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
}

function KpiGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card p-4" aria-label={title}>
      <h2 className="mb-3 font-serif text-sm font-bold text-navy-800">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Kpi({ label, value, loading, emphasis, warn, note }: { label: string; value: number | undefined; loading: boolean; emphasis?: boolean; warn?: boolean; note?: ReactNode }) {
  return (
    <div>
      <div className="kpi-label">{label}</div>
      {loading ? (
        <div className={`skeleton mt-1.5 ${emphasis ? 'h-8' : 'h-6'} w-40`} aria-hidden="true" />
      ) : (
        <div className={`mt-0.5 font-semibold tabular-nums text-navy-800 ${emphasis ? 'text-3xl' : 'text-xl'}`}>
          {value === undefined ? <span className="text-slate-400">—</span> : <>₱<Money value={value} dashZero={false} /></>}
        </div>
      )}
      {note && (
        <p className={`mt-0.5 flex items-center gap-1 text-xs ${warn ? 'font-medium text-red-700' : 'text-slate-600'}`}>
          {warn && <Icon name="alert" className="h-3.5 w-3.5" />}
          {note}
        </p>
      )}
    </div>
  );
}

function Count({ label, value, warn }: { label: string; value: number | undefined; warn?: boolean }) {
  return (
    <div className={`rounded-md border px-1 py-2 ${warn ? 'border-orange-300 bg-orange-50' : 'border-slate-200'}`}>
      <div className={`text-lg font-semibold tabular-nums ${warn ? 'text-orange-800' : 'text-navy-800'}`}>{value ?? '—'}</div>
      <div className="text-[11px] leading-tight text-slate-600">{label}</div>
    </div>
  );
}
