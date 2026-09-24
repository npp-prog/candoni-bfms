import type { FinancialSummaryDoc } from '@bfms/shared';
import { doc, onSnapshot } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { Money, PageHeader, StatusChip } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { usePeriods } from '../../hooks/usePeriods';
import { db } from '../../services/firebase/app';

const MONTHS = ['Opening', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Closing'];

export function DashboardPage() {
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const { periods } = usePeriods(barangayId, fiscalYear);
  const [summary, setSummary] = useState<FinancialSummaryDoc | null>(null);
  useEffect(() => {
    if (!barangayId) return;
    return onSnapshot(doc(db, 'financialSummaries', `${barangayId}_${fiscalYear}`), (s) => setSummary(s.exists() ? (s.data() as FinancialSummaryDoc) : null), () => setSummary(null));
  }, [barangayId, fiscalYear]);

  const cards: Array<[string, number | undefined]> = [
    ['Cash in Local Treasury', summary?.cashInLocalTreasury],
    ['Cash in Bank', summary?.cashInBank],
    ['Total Appropriation', summary?.totalAppropriation],
    ['Total Obligations', summary?.totalObligations],
    ['Unliquidated Cash Advances', summary?.unliquidatedCashAdvances],
    ['Outstanding Checks', summary?.outstandingChecks],
  ];

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`${barangayLabel} · Fiscal Year ${fiscalYear}`} breadcrumbs={['BFMS', 'Dashboard']} />
      <section aria-label="Financial position" className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(([label, v]) => (
          <div key={label} className="card p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
            <div className="mt-2 text-2xl font-semibold text-navy-800">{v === undefined ? <span className="text-slate-300">—</span> : <>₱<Money value={v} dashZero={false} /></>}</div>
          </div>
        ))}
      </section>
      {!summary && <p className="-mt-4 mb-8 text-xs text-slate-500">The summary figures appear once transactions are posted. The server maintains them in financialSummaries (Phase 13).</p>}
      <section className="card">
        <h2 className="border-b border-slate-200 px-4 py-3 font-serif font-bold text-navy-800">Accounting periods</h2>
        {periods.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-600">No periods have been opened for FY {fiscalYear} yet. Municipal Accounting opens the fiscal year under Administration.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4 lg:grid-cols-7">
            {periods.map((p) => (
              <div key={p.id} className="rounded border border-slate-200 p-2 text-center">
                <div className="text-xs text-slate-500">{MONTHS[p.month]}</div>
                <StatusChip status={p.status} />
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
