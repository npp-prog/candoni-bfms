import { PAYROLL_MODULE, PAYROLL_TYPES, type PayrollRecord } from '@bfms/shared';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RegisterTable, StatusFilter } from '../../components/register';
import { statusOptions } from '../../components/source';
import { Icon, Money, PageHeader, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { PayrollEditor } from './PayrollEditor';

/** Phase 5 — Payroll register (honoraria, wages, allowances) → DV. */
export function PayrollPage() {
  const { can } = useAuth();
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const scope = barangayId ? ([['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] as const) : null;
  const { rows, loading } = useCollection<PayrollRecord>('payrolls', scope);
  const open = params.get('open');
  const setOpen = (v: string | null) => setParams(v ? { open: v } : {}, { replace: true });
  const list = rows.filter((r) => !status || r.status === status).sort((a, b) => b.payrollDate.localeCompare(a.payrollDate));
  return (
    <>
      <PageHeader title="Payroll" subtitle={`${barangayLabel} · FY ${fiscalYear}`} breadcrumbs={['BFMS', 'Payroll']} actions={<Link className="btn-secondary" to="/disbursements/vouchers">Disbursement vouchers</Link>} />
      {barangayId && (
        <RegisterTable
          caption={`Payrolls for FY ${fiscalYear}`}
          rows={list}
          loading={loading}
          onOpen={(r) => setOpen(r.id)}
          toolbar={
            <>
              <StatusFilter value={status} onChange={setStatus} options={statusOptions(PAYROLL_MODULE).filter((s) => s !== 'POSTED')} />
              <div className="ml-auto">{can('treasury.encode', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New payroll</button>}</div>
            </>
          }
          empty={`No payrolls for FY ${fiscalYear}.`}
          columns={[
            { label: 'Payroll no.', render: (r) => r.payrollNumber ?? <span className="text-slate-500">draft</span> },
            { label: 'Date', render: (r) => r.payrollDate },
            { label: 'Type', render: (r) => <span className="text-xs">{PAYROLL_TYPES.find((t) => t.value === r.payrollType)?.label ?? r.payrollType}</span> },
            { label: 'Period', render: (r) => `${r.payPeriodFrom} – ${r.payPeriodTo}` },
            { label: 'Payees', numeric: true, render: (r) => r.entryCount },
            { label: 'Gross', numeric: true, render: (r) => <Money value={r.grossAmount} /> },
            { label: 'Net', numeric: true, render: (r) => <Money value={r.netAmount} /> },
            { label: 'DV', render: (r) => (r.dvId ? <Link className="text-navy-700 underline" to={`/disbursements/vouchers?open=${r.dvId}`} onClick={(e) => e.stopPropagation()}>{r.dvNumber ?? 'draft'}</Link> : '—') },
            { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
          ]}
        />
      )}
      {open && <PayrollEditor key={open} id={open === 'new' ? null : open} rows={rows} loading={loading} onClose={() => setOpen(null)} />}
    </>
  );
}
