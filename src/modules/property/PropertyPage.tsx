import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { ModuleTabs } from '../../components/register';
import { reportHref } from '../../components/source';
import { PageHeader } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { BiologicalTab } from './BiologicalTab';
import { CustodyTab } from './CustodyTab';
import { DepreciationTab } from './DepreciationTab';
import { PpeTab } from './PpeTab';
import { ProcurementTab } from './ProcurementTab';
import { RisTab } from './RisTab';
import { SuppliesTab } from './SuppliesTab';

/** Phase 10 — supplies inventory, procurement documents, PPE register and custody, depreciation, biological assets. */
export function PropertyPage() {
  const { barangayLabel, fiscalYear } = useBarangay();
  return (
    <>
      <PageHeader
        title="Property & Inventory"
        subtitle={`${barangayLabel} · FY ${fiscalYear}`}
        breadcrumbs={['BFMS', 'Property']}
        actions={
          <>
            <Link className="btn-secondary" to={reportHref('RSMI', { fiscalYear })}>RSMI</Link>
            <Link className="btn-secondary" to={reportHref('RPCI', { fiscalYear })}>RPCI</Link>
            <Link className="btn-secondary" to={reportHref('RPCPPE', { fiscalYear })}>RPCPPE</Link>
          </>
        }
      />
      <ModuleTabs
        label="Property sections"
        tabs={[
          { to: '/property/supplies', label: 'Supplies & stock' },
          { to: '/property/ris', label: 'RIS' },
          { to: '/property/procurement', label: 'Procurement (PR/PO/IAR)' },
          { to: '/property/ppe', label: 'PPE register' },
          { to: '/property/custody', label: 'ICS/PAR & transfers' },
          { to: '/property/depreciation', label: 'Depreciation' },
          { to: '/property/biological', label: 'Biological assets' },
        ]}
      />
      <Routes>
        <Route index element={<Navigate to="supplies" replace />} />
        <Route path="supplies" element={<SuppliesTab />} />
        <Route path="ris" element={<RisTab />} />
        <Route path="procurement" element={<ProcurementTab />} />
        <Route path="ppe" element={<PpeTab />} />
        <Route path="custody" element={<CustodyTab />} />
        <Route path="depreciation" element={<DepreciationTab />} />
        <Route path="biological" element={<BiologicalTab />} />
      </Routes>
    </>
  );
}
