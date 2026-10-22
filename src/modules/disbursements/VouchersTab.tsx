import { DV_CATEGORIES, DV_MODULE, type DvRecord } from '@bfms/shared';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RegisterTable, StatusFilter } from '../../components/register';
import { statusOptions } from '../../components/source';
import { Icon, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { DvEditor } from './DvEditor';

const PAY_LABEL: Record<string, string> = { UNPAID: 'Unpaid', ISSUED: 'Issued', RELEASED: 'Released' };

export function VouchersTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const scope = barangayId ? ([['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] as const) : null;
  const { rows, loading } = useCollection<DvRecord>('disbursementVouchers', scope);
  // `?open=<id>` deep link (e.g. from the payroll page) or 'new'.
  const open = params.get('open');
  const setOpen = (v: string | null) => setParams(v ? { open: v } : {}, { replace: true });
  if (!barangayId) return null;
  const list = rows
    .filter((r) => (!status || r.status === status) && (!category || r.dvCategory === category))
    .sort((a, b) => b.dvDate.localeCompare(a.dvDate) || (b.dvNumber ?? '~').localeCompare(a.dvNumber ?? '~'));
  return (
    <>
      <RegisterTable
        caption={`Disbursement vouchers for FY ${fiscalYear}`}
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter value={status} onChange={setStatus} options={statusOptions(DV_MODULE)} />
            <label className="label mb-0" htmlFor="dv-cat">Category</label>
            <select id="dv-cat" className="input max-w-[12rem]" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {DV_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.value.replace(/_/g, ' ')}</option>)}
            </select>
            <div className="ml-auto">{can('treasury.encode', barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New DV</button>}</div>
          </>
        }
        empty={`No disbursement vouchers for FY ${fiscalYear}.`}
        columns={[
          { label: 'DV no.', render: (r) => r.dvNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Date', render: (r) => r.dvDate },
          { label: 'Payee', className: 'max-w-[14rem] truncate', render: (r) => r.payee?.name },
          { label: 'Particulars', className: 'max-w-sm truncate', render: (r) => r.particulars },
          { label: 'Category', render: (r) => <span className="text-xs">{r.dvCategory.replace(/_/g, ' ')}</span> },
          { label: 'Net', numeric: true, render: (r) => <Money value={r.netAmount} /> },
          { label: 'Payment', render: (r) => <span className="text-xs">{r.paymentMethod}{r.checkNumber ? ` #${r.checkNumber}` : r.adaNumber ? ` ${r.adaNumber}` : ''} · {PAY_LABEL[r.paymentStatus] ?? r.paymentStatus}</span> },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <DvEditor key={open} id={open === 'new' ? null : open} rows={rows} loading={loading} onClose={() => setOpen(null)} />}
    </>
  );
}
