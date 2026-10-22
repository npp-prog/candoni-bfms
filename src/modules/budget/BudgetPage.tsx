import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { ModuleTabs } from '../../components/register';
import { reportHref } from '../../components/source';
import { PageHeader } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { AdjustmentsTab } from './AdjustmentsTab';
import { AppropriationsTab } from './AppropriationsTab';
import { IncomeEstimatesTab } from './IncomeEstimatesTab';
import { ObligationsTab } from './ObligationsTab';

/** Phase 3 — Budget: appropriations, adjustments, obligations (OBR) and REAI estimates. */
export function BudgetPage() {
  const { barangayLabel, fiscalYear } = useBarangay();
  return (
    <>
      <PageHeader
        title="Budget"
        subtitle={`${barangayLabel} · FY ${fiscalYear}`}
        breadcrumbs={['BFMS', 'Budget']}
        actions={
          <>
            <Link className="btn-secondary" to={reportHref('RAO', { fiscalYear })}>RAO</Link>
            <Link className="btn-secondary" to={reportHref('SAOB', { fiscalYear })}>SAOB</Link>
            <Link className="btn-secondary" to={reportHref('REAI', { fiscalYear })}>REAI</Link>
          </>
        }
      />
      <ModuleTabs
        label="Budget sections"
        tabs={[
          { to: '/budget/appropriations', label: 'Appropriations' },
          { to: '/budget/obligations', label: 'Obligations (OBR)' },
          { to: '/budget/adjustments', label: 'Adjustments' },
          { to: '/budget/income', label: 'Income estimates' },
        ]}
      />
      <Routes>
        <Route index element={<Navigate to="appropriations" replace />} />
        <Route path="appropriations" element={<AppropriationsTab />} />
        <Route path="obligations" element={<ObligationsTab />} />
        <Route path="adjustments" element={<AdjustmentsTab />} />
        <Route path="income" element={<IncomeEstimatesTab />} />
      </Routes>
    </>
  );
}
