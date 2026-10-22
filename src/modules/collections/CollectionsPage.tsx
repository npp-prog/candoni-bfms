import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { ModuleTabs } from '../../components/register';
import { reportHref } from '../../components/source';
import { PageHeader } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { DepositsTab } from './DepositsTab';
import { ReceiptsTab } from './ReceiptsTab';
import { RcdTab, RcrTab } from './ReportsTabs';

/** Phase 4 — Collections: official receipts, deposits, RCD and RCR. */
export function CollectionsPage() {
  const { barangayLabel, fiscalYear } = useBarangay();
  const month = new Date().getFullYear() === fiscalYear ? new Date().getMonth() + 1 : 12;
  return (
    <>
      <PageHeader
        title="Collections"
        subtitle={`${barangayLabel} · FY ${fiscalYear}`}
        breadcrumbs={['BFMS', 'Collections']}
        actions={
          <>
            <Link className="btn-secondary" to={reportHref('CASHBOOK', { fiscalYear, month, variant: 'CASH_IN_TREASURY' })}>Cashbook (CLT)</Link>
            <Link className="btn-secondary" to={reportHref('CASHBOOK', { fiscalYear, month, variant: 'CASH_IN_BANK' })}>Cashbook (CIB)</Link>
            <Link className="btn-secondary" to={reportHref('RAAF', { fiscalYear, month })}>RAAF</Link>
            <Link className="btn-secondary" to={reportHref('REAI', { fiscalYear, month })}>REAI</Link>
          </>
        }
      />
      <ModuleTabs
        label="Collections sections"
        tabs={[
          { to: '/collections/receipts', label: 'Official receipts' },
          { to: '/collections/deposits', label: 'Deposits' },
          { to: '/collections/rcd', label: 'RCD' },
          { to: '/collections/rcr', label: 'RCR' },
        ]}
      />
      <Routes>
        <Route index element={<Navigate to="receipts" replace />} />
        <Route path="receipts" element={<ReceiptsTab />} />
        <Route path="deposits" element={<DepositsTab />} />
        <Route path="rcd" element={<RcdTab />} />
        <Route path="rcr" element={<RcrTab />} />
      </Routes>
    </>
  );
}
