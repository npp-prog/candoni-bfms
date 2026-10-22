import { type Centavos, type EstimatedIncomeDoc } from '@bfms/shared';
import { useState } from 'react';
import { AccountInput, MoneyInput } from '../../components/forms';
import { RegisterTable } from '../../components/register';
import { Field, Money } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useCollection } from '../../hooks/useCollection';
import { api, errorMessage } from '../../services/functions/api';

/** REAI estimates per income account. Actual collections come from issued ORs (see the REAI report). */
export function IncomeEstimatesTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const { notify } = useToast();
  const { rows, loading } = useCollection<EstimatedIncomeDoc & { accountName?: string }>('estimatedIncome', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState<Centavos | null>(0 as Centavos);
  const [busy, setBusy] = useState(false);
  if (!barangayId) return null;
  const editable = can('budget.encode', barangayId);

  async function save(accountCode: string, estimatedIncome: number) {
    setBusy(true);
    try {
      await api.saveEstimatedIncome({ barangayId: barangayId!, fiscalYear, fundId: 'GF', incomeAccountCode: accountCode, estimatedIncome });
      notify('Estimate saved.', 'success');
      setCode('');
      setAmount(0 as Centavos);
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const total = rows.reduce((t, r) => t + r.estimatedIncome, 0);
  return (
    <div className="space-y-4">
      {editable && (
        <form className="card flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => { e.preventDefault(); if (code && amount !== null) void save(code, amount); }}>
          <Field label="Income account" required className="min-w-[16rem] flex-1">{(p) => <AccountInput {...p} value={code} prefixes={['4-']} onChange={setCode} />}</Field>
          <Field label="Estimated income" required>{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
          <button type="submit" className="btn-primary mb-5" disabled={busy || !/^4-\d{2}-\d{2}-\d{3}$/.test(code) || amount === null}>Save estimate</button>
        </form>
      )}
      <RegisterTable
        caption={`Estimated income FY ${fiscalYear}`}
        rows={[...rows].sort((a, b) => a.incomeAccountCode.localeCompare(b.incomeAccountCode))}
        loading={loading}
        onOpen={editable ? (r) => { setCode(r.incomeAccountCode); setAmount(r.estimatedIncome); } : undefined}
        empty={`No income estimates for FY ${fiscalYear}. Enter the estimates from the approved annual budget.`}
        columns={[
          { label: 'Account', render: (r) => <span><span className="font-mono text-xs">{r.incomeAccountCode}</span> {r.accountName}</span> },
          { label: 'Estimated income', numeric: true, render: (r) => <Money value={r.estimatedIncome} /> },
        ]}
        footer={<div className="border-t border-slate-200 px-4 py-2 text-right text-sm font-semibold">Total: ₱<Money value={total} dashZero={false} /></div>}
      />
    </div>
  );
}
