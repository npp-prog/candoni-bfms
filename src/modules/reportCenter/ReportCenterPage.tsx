import { Navigate, Route, Routes } from 'react-router-dom';
import { ModuleTabs } from '../../components/register';
import { PageHeader } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { GeneratedReports, SnapshotPage } from './GeneratedReports';
import { ReportsCatalog } from './ReportsCatalog';

/** Phase 12 — Report Center: every COA form/report, and the saved (versioned) copies. */
export function ReportCenterPage() {
  const { barangayLabel, fiscalYear } = useBarangay();
  return (
    <Routes>
      <Route path="snapshot/:id" element={<SnapshotPage />} />
      <Route
        path="*"
        element={
          <>
            <PageHeader title="Report Center" subtitle={`${barangayLabel} · FY ${fiscalYear}`} breadcrumbs={['BFMS', 'Reports']} />
            <ModuleTabs label="Report Center sections" tabs={[{ to: '/reports/catalog', label: 'All reports' }, { to: '/reports/generated', label: 'Saved versions' }]} />
            <Routes>
              <Route index element={<Navigate to="catalog" replace />} />
              <Route path="catalog" element={<ReportsCatalog />} />
              <Route path="generated" element={<GeneratedReports />} />
            </Routes>
          </>
        }
      />
    </Routes>
  );
}
