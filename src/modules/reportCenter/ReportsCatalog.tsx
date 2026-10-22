import { REPORT_DEFINITIONS, reportBuilder, type ReportCategory } from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { reportHref } from '../../components/source';
import { useBarangay } from '../../contexts/BarangayContext';

const CATEGORY_LABEL: Record<ReportCategory, string> = {
  BUDGET: 'Appropriations and obligations',
  COLLECTIONS_DEPOSITS: 'Collections, deposits and cashbooks',
  ACCOUNTABLE_FORMS: 'Accountable forms',
  DISBURSEMENTS: 'Disbursements and payroll',
  CASH_ADVANCES: 'Cash advances and liquidations',
  PETTY_CASH: 'Petty cash',
  REGISTRIES: 'Registries',
  BANK: 'Bank',
  BOOKS: 'Books of accounts',
  SCHEDULES: 'Schedules',
  FINANCIAL_STATEMENTS: 'Financial statements',
  PROPERTY: 'Supplies, property and equipment',
  COMPLIANCE: 'Compliance',
};
const ORDER: ReportCategory[] = ['BUDGET', 'COLLECTIONS_DEPOSITS', 'ACCOUNTABLE_FORMS', 'DISBURSEMENTS', 'CASH_ADVANCES', 'PETTY_CASH', 'REGISTRIES', 'BANK', 'BOOKS', 'SCHEDULES', 'FINANCIAL_STATEMENTS', 'PROPERTY', 'COMPLIANCE'];

const OFFICE_LABEL: Record<string, string> = {
  BARANGAY_TREASURER: 'Treasurer',
  COMMITTEE_ON_APPROPRIATIONS: 'Appropriations',
  PUNONG_BARANGAY: 'Punong Barangay',
  PROPERTY_OFFICE: 'Property',
  MUNICIPAL_ACCOUNTING: 'Accounting',
  BAC_OR_PROCUREMENT: 'Procurement',
  INSPECTION_COMMITTEE: 'Inspection',
};

/** Catalog of all COA forms and reports, grouped by category, with search and office filter. */
export function ReportsCatalog() {
  const { fiscalYear } = useBarangay();
  const [q, setQ] = useState('');
  const [office, setOffice] = useState('');
  const match = (r: (typeof REPORT_DEFINITIONS)[number]) =>
    (!office || r.responsibleOffice === office) && (!q || `${r.reportCode} ${r.reportName}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-6">
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-[16rem] flex-1">
          <label className="label" htmlFor="rq">Search</label>
          <input id="rq" type="search" className="input" placeholder="e.g. cashbook, RCD, trial balance" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="ro">Responsible office</label>
          <select id="ro" className="input" value={office} onChange={(e) => setOffice(e.target.value)}>
            <option value="">All offices</option>
            {Object.entries(OFFICE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>
      {ORDER.map((cat) => {
        const defs = REPORT_DEFINITIONS.filter((r) => r.category === cat && match(r));
        if (!defs.length) return null;
        return (
          <section key={cat} aria-labelledby={`cat-${cat}`}>
            <h2 id={`cat-${cat}`} className="mb-2 font-serif text-lg font-bold text-navy-800">{CATEGORY_LABEL[cat]}</h2>
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {defs.map((r) => {
                const available = !!reportBuilder(r.reportCode);
                return (
                  <li key={r.reportCode}>
                    {available ? (
                      <Link to={reportHref(r.reportCode, { fiscalYear })} className="card flex h-full flex-col gap-1 p-3 transition-colors hover:border-navy-300 hover:bg-navy-50/50">
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-semibold text-navy-700">{r.reportCode}{r.formNumber ? ` · Form ${r.formNumber}` : ''}</span>
                          {r.inMonthlyPackage && <span className="rounded bg-gold-50 px-1.5 py-0.5 text-[10px] font-semibold text-gold-700">Monthly package</span>}
                        </span>
                        <span className="text-sm font-medium text-slate-900">{r.reportName}</span>
                        <span className="text-xs text-slate-600">{OFFICE_LABEL[r.responsibleOffice]} · {r.frequency.replace('_', ' ').toLowerCase()} · {r.paperSize} {r.orientation.toLowerCase()}</span>
                      </Link>
                    ) : (
                      <div className="card flex h-full flex-col gap-1 p-3 opacity-60">
                        <span className="font-mono text-xs font-semibold">{r.reportCode}</span>
                        <span className="text-sm">{r.reportName}</span>
                        <span className="text-xs">Not available yet</span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
