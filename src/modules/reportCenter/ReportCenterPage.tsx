import { Navigate, Route, Routes } from 'react-router-dom';
import { ModuleTabs } from '../../components/register';
import { PageHeader } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { ReportsCatalog } from './ReportsCatalog';

/** Phase 12 — Report Center. */
export function ReportCenterPage() {
  const { barangayLabel, fiscalYear } = useBarangay();
  return (
    <>
      <PageHeader title="Report Center" subtitle={`${barangayLabel} · FY ${fiscalYear}`} breadcrumbs={['BFMS', 'Reports']} />
      <ModuleTabs label="Report Center sections" tabs={[{ to: '/reports/catalog', label: 'All reports' }]} />
      <Routes>
        <Route index element={<Navigate to="catalog" replace />} />
        <Route path="catalog" element={<ReportsCatalog />} />
      </Routes>
    </>
  );
}
