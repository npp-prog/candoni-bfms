import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { ModuleTabs } from '../../components/register';
import { reportHref } from '../../components/source';
import { PageHeader } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { AdaTab } from './AdaTab';
import { ChecksTab } from './ChecksTab';
import { VouchersTab } from './VouchersTab';

/** Phase 5 — Disbursement vouchers, checks register and ADA. */
export function DisbursementsPage() {
  const { barangayLabel, fiscalYear } = useBarangay();
  return (
    <>
      <PageHeader
        title="Disbursements"
        subtitle={`${barangayLabel} · FY ${fiscalYear}`}
        breadcrumbs={['BFMS', 'Disbursements']}
        actions={
          <>
            <Link className="btn-secondary" to={reportHref('CHECKS_ISSUED', { fiscalYear })}>Checks issued</Link>
            <Link className="btn-secondary" to={reportHref('CANCELLED_CHECKS', { fiscalYear })}>Cancelled checks</Link>
            <Link className="btn-secondary" to="/payroll">Payroll</Link>
          </>
        }
      />
      <ModuleTabs
        label="Disbursement sections"
        tabs={[
          { to: '/disbursements/vouchers', label: 'Vouchers (DV)' },
          { to: '/disbursements/checks', label: 'Checks' },
          { to: '/disbursements/ada', label: 'ADA' },
        ]}
      />
      <Routes>
        <Route index element={<Navigate to="vouchers" replace />} />
        <Route path="vouchers" element={<VouchersTab />} />
        <Route path="checks" element={<ChecksTab />} />
        <Route path="ada" element={<AdaTab />} />
      </Routes>
    </>
  );
}
