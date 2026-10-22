import { MONTH_NAMES, depreciationFor, yearMonth, type DepreciationRunDoc } from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RegisterTable } from '../../components/register';
import { reportHref } from '../../components/source';
import { Field, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';
import { propertyApi, useCall, usePpe } from './common';

/**
 * Monthly depreciation run (Municipal Accounting): one run per month, idempotent; it creates a DRAFT
 * GJ entry (Dr 5-04-01 / Cr 1-07-xx-xx1) that accounting approves and posts in Journal Entries.
 */
export function DepreciationTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const [month, setMonth] = useState(() => (new Date().getFullYear() === fiscalYear ? new Date().getMonth() + 1 : 12));
  const { run, busy } = useCall();
  const runs = useCollection<DepreciationRunDoc & { runNumber?: string }>('depreciationRuns', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
  const ppe = usePpe(barangayId).rows;
  if (!barangayId) return null;
  const period = yearMonth(fiscalYear, month);
  const preview = ppe.filter((p) => p.status === 'ACTIVE' && p.depreciationExpenseAccountCode).reduce((t, p) => t + depreciationFor(p, period), 0);
  const done = runs.rows.find((r) => r.month === month);
  const canRun = can('jev.prepare', barangayId);
  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-end gap-4 p-4">
        <Field label="Month">
          {(p) => (
            <select {...p} className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m} {fiscalYear}</option>)}
            </select>
          )}
        </Field>
        <div className="mb-5 text-sm">
          <div className="kpi-label">{done ? 'Recorded' : 'Estimated'} depreciation</div>
          <div className="text-lg font-semibold">₱<Money value={done ? done.totalDepreciation : preview} dashZero={false} /></div>
        </div>
        {canRun && (
          <button
            type="button"
            className="btn-primary mb-5"
            disabled={busy}
            onClick={() => void run(() => propertyApi.runMonthlyDepreciation({ barangayId, fiscalYear, month }), (r) => (r.alreadyRun ? 'This month was already run; nothing new to depreciate.' : `${r.supplementary ? 'Supplementary run' : 'Depreciation run'}: ${r.itemCount} asset(s), DRAFT JEV created for review.`))}
          >
            {done ? 'Re-run (adds newly accepted PPE only)' : 'Run depreciation'}
          </button>
        )}
        <Link className="btn-secondary mb-5" to={reportHref('PPE_DEPRECIATION', { fiscalYear })}>Depreciation schedule</Link>
        {!canRun && <p className="mb-5 text-sm text-slate-600">Municipal Accounting runs depreciation.</p>}
      </div>
      <RegisterTable
        caption={`Depreciation runs FY ${fiscalYear}`}
        rows={[...runs.rows].sort((a, b) => a.month - b.month)}
        loading={runs.loading}
        empty={`No depreciation runs for FY ${fiscalYear}.`}
        columns={[
          { label: 'Month', render: (r) => `${MONTH_NAMES[r.month - 1]} ${r.fiscalYear}` },
          { label: 'Run no.', render: (r) => r.runNumber ?? '' },
          { label: 'Assets', numeric: true, render: (r) => r.itemCount },
          { label: 'Depreciation', numeric: true, render: (r) => <Money value={r.totalDepreciation} /> },
          { label: 'JEV', render: (r) => (r.jevIds?.length ? <Link className="underline" to="/accounting">{r.jevIds.length} draft/posted JEV{r.jevIds.length > 1 ? 's' : ''}</Link> : '—') },
          { label: 'Status', render: (r) => <StatusChip status={(r as { jevNumber?: string }).jevNumber ? 'POSTED' : r.status} /> },
        ]}
      />
    </div>
  );
}
