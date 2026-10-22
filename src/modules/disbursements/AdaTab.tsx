import type { AdaRecord, BankAccountDoc } from '@bfms/shared';
import { Link } from 'react-router-dom';
import { maskAccount } from '../../components/forms';
import { RegisterTable } from '../../components/register';
import { Money, StatusChip } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';

/** Advice to Debit Account register (ADAs are issued and released from their DV). */
export function AdaTab() {
  const { barangayId, fiscalYear } = useBarangay();
  const scope = barangayId ? ([['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] as const) : null;
  const { rows, loading } = useCollection<AdaRecord>('adas', scope);
  const banks = useCollection<BankAccountDoc>('bankAccounts', barangayId ? [['barangayId', '==', barangayId]] : null).rows;
  if (!barangayId) return null;
  const list = [...rows].sort((a, b) => b.adaDate.localeCompare(a.adaDate) || b.adaNumber.localeCompare(a.adaNumber));
  return (
    <RegisterTable
      caption={`Advices to Debit Account for FY ${fiscalYear}`}
      rows={list}
      loading={loading}
      empty={`No ADA issued in FY ${fiscalYear}. ADAs are issued from an approved DV whose mode of payment is ADA.`}
      columns={[
        { label: 'ADA no.', render: (r) => <span className="font-mono">{r.adaNumber}</span> },
        { label: 'Date', render: (r) => r.adaDate },
        { label: 'Bank', render: (r) => { const b = banks.find((x) => x.id === r.bankAccountId); return <span className="text-xs">{b ? `${b.bankName} ${maskAccount(b.accountNumber)}` : '—'}</span>; } },
        { label: 'DV no.', render: (r) => <Link className="text-navy-700 underline" to={`/disbursements/vouchers?open=${r.dvId}`}>{r.dvNumber ?? '—'}</Link> },
        { label: 'Payee', className: 'max-w-[14rem] truncate', render: (r) => r.payee?.name },
        { label: 'Amount', numeric: true, render: (r) => <Money value={r.amount} /> },
        { label: 'Released', render: (r) => r.releasedDate ?? '—' },
        { label: 'Status', render: (r) => <span title={r.cancelReason ?? undefined}><StatusChip status={r.status} /></span> },
      ]}
    />
  );
}
