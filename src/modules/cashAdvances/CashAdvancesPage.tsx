import { CASH_ADVANCE_TYPES, CA_ACCOUNTS, DEFAULT_AGING_BUCKETS, caTypeLabel, manilaToday, type CashAdvanceRecord, type CashAdvanceType, type Centavos, type LiquidationRecord, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { InfoGrid, MoneyInput, SubsidiarySelect } from '../../components/forms';
import { RegisterTable } from '../../components/register';
import { PrintLink, reportHref } from '../../components/source';
import { Field, Icon, Modal, Money, PageHeader, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useCollection } from '../../hooks/useCollection';
import { errorMessage } from '../../services/functions/api';
import { caApi } from './api';
import { Kpis } from './common';

type Ca = WithId<CashAdvanceRecord>;
const OPEN = ['ACTIVE', 'PARTIALLY_LIQUIDATED', 'OVERDUE'];
const CA_STATUSES = ['ACTIVE', 'PARTIALLY_LIQUIDATED', 'OVERDUE', 'FULLY_LIQUIDATED', 'CLOSED'];

/** Phase 6 — register of cash advances (all years: unliquidated advances carry over), aging, legacy entry. */
export function CashAdvancesPage() {
  const { can } = useAuth();
  const { notify } = useToast();
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const [status, setStatus] = useState('OPEN');
  const [open, setOpen] = useState<string | null>(null);
  const [legacy, setLegacy] = useState<Ca | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const { rows, loading } = useCollection<CashAdvanceRecord>('cashAdvances', barangayId ? [['barangayId', '==', barangayId]] : null);
  if (!barangayId) return null;
  const list = rows
    .filter((r) => (status === 'OPEN' ? OPEN.includes(r.status) : !status || r.status === status))
    .sort((a, b) => (OPEN.includes(b.status) ? 1 : 0) - (OPEN.includes(a.status) ? 1 : 0) || a.grantDate.localeCompare(b.grantDate));
  const openRows = rows.filter((r) => OPEN.includes(r.status));
  const overdue = openRows.filter((r) => r.status === 'OVERDUE');
  const sum = (l: Ca[]) => l.reduce((t, r) => t + r.outstandingBalance, 0);
  const buckets = DEFAULT_AGING_BUCKETS.map((b) => b.label);
  const byBucket = new Map<string, number>();
  for (const r of openRows) byBucket.set(r.agingCategory, (byBucket.get(r.agingCategory) ?? 0) + r.outstandingBalance);
  const labels = [...buckets.filter((b) => byBucket.has(b)), ...[...byBucket.keys()].filter((k) => !buckets.includes(k))];
  const asOf = openRows.map((r) => r.agingAsOf).filter(Boolean).sort().at(-1);

  async function refresh() {
    setBusy(true);
    try {
      const r = await caApi.recomputeCashAdvanceAging({ barangayId: barangayId! });
      notify(`Aging refreshed: ${r.updated} updated, ${r.overdue} overdue.`, 'success');
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Cash Advances"
        subtitle={`${barangayLabel} · unliquidated advances of accountable officers`}
        breadcrumbs={['BFMS', 'Cash Advances']}
        actions={
          <>
            <Link className="btn-secondary" to={reportHref('CA_AGING', { fiscalYear, asOf: manilaToday() })}>Aging report</Link>
            <Link className="btn-secondary" to={reportHref('CASHBOOK_DO', { fiscalYear, month: Number(manilaToday().slice(5, 7)) })}>Cashbook (DO)</Link>
            {can('submission.review', barangayId) && <button type="button" className="btn-secondary" disabled={busy} onClick={() => void refresh()}>{busy ? 'Refreshing…' : 'Refresh aging'}</button>}
            {can('jev.prepare', barangayId) && <button type="button" className="btn-primary" onClick={() => setLegacy('new')}><Icon name="plus" /> Legacy cash advance</button>}
          </>
        }
      />
      <Kpis
        items={[
          { label: 'Unliquidated balance', value: sum(openRows) },
          { label: 'Open advances', value: openRows.length, money: false },
          { label: 'Overdue balance', value: sum(overdue), tone: 'warn' },
          { label: 'Overdue advances', value: overdue.length, money: false, tone: 'warn' },
        ]}
      />
      {labels.length > 0 && (
        <section className="card mb-4 p-4" aria-labelledby="aging-h">
          <h2 id="aging-h" className="mb-2 text-sm font-semibold text-slate-800">Aging of unliquidated balances {asOf ? <span className="font-normal text-slate-600">(as of {asOf})</span> : null}</h2>
          <dl className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {labels.map((l) => (
              <div key={l} className="rounded-md bg-slate-50 px-3 py-2">
                <dt className="text-xs text-slate-600">{l}</dt>
                <dd className="text-sm font-semibold tabular-nums">₱<Money value={byBucket.get(l) ?? 0} dashZero={false} /></dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <RegisterTable
        caption="Cash advances"
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <label className="label mb-0" htmlFor="ca-status">Status</label>
            <select id="ca-status" className="input max-w-[14rem]" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="OPEN">Open (unliquidated)</option>
              <option value="">All statuses</option>
              {CA_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
          </>
        }
        empty={status === 'OPEN' ? 'No unliquidated cash advances.' : 'No cash advances. They are created when a cash-advance DV is approved.'}
        columns={[
          { label: 'DV no.', render: (r) => <span>{r.dvNumber}{r.isLegacy && <span className="ml-1 text-xs text-slate-500">(migrated)</span>}</span> },
          { label: 'Officer', render: (r) => r.accountableOfficerName },
          { label: 'Type', render: (r) => caTypeLabel(r.cashAdvanceType) },
          { label: 'Granted', render: (r) => r.grantDate },
          { label: 'Due', render: (r) => <span className={OPEN.includes(r.status) && r.liquidationDueDate < manilaToday() ? 'font-semibold text-red-700' : ''}>{r.liquidationDueDate}</span> },
          { label: 'Amount', numeric: true, render: (r) => <Money value={r.amountGranted} /> },
          { label: 'Outstanding', numeric: true, render: (r) => <Money value={r.outstandingBalance} /> },
          { label: 'Days', numeric: true, render: (r) => (OPEN.includes(r.status) ? r.daysOutstanding : '—') },
          { label: 'Aging', render: (r) => r.agingCategory },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <CashAdvanceDetail ca={rows.find((r) => r.id === open)!} onClose={() => setOpen(null)} onEdit={(c) => { setOpen(null); setLegacy(c); }} />}
      {legacy && <LegacyEditor rec={legacy === 'new' ? null : legacy} onClose={() => setLegacy(null)} />}
    </>
  );
}

function CashAdvanceDetail({ ca, onClose, onEdit }: { ca: Ca | undefined; onClose(): void; onEdit(c: Ca): void }) {
  const { can } = useAuth();
  const { rows } = useCollection<LiquidationRecord>('liquidations', ca ? [['barangayId', '==', ca.barangayId], ['cashAdvanceId', '==', ca.id]] : null);
  if (!ca) return null;
  const lrs = [...rows].sort((a, b) => a.liquidationDate.localeCompare(b.liquidationDate));
  const canLiquidate = OPEN.includes(ca.status) && can('treasury.encode', ca.barangayId);
  const editableLegacy = ca.isLegacy && ca.amountLiquidated === (ca.openingLiquidated ?? 0) && !ca.amountRefunded && can('jev.prepare', ca.barangayId);
  return (
    <Modal
      open
      wide
      title={`Cash advance — DV ${ca.dvNumber}`}
      onClose={onClose}
      footer={
        <>
          {editableLegacy && <button type="button" className="btn-secondary mr-auto" onClick={() => onEdit(ca)}>Edit migrated advance</button>}
          {canLiquidate && <Link className="btn-primary" to={`/liquidations?ca=${ca.id}`}><Icon name="plus" /> New liquidation report</Link>}
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2"><StatusChip status={ca.status} />{ca.isLegacy && <span className="text-xs text-slate-600">Migrated opening balance</span>}</div>
      <InfoGrid
        columns={4}
        items={[
          ['Accountable officer', ca.accountableOfficerName],
          ['Account', ca.accountCode],
          ['Type', caTypeLabel(ca.cashAdvanceType)],
          ['Purpose', ca.purpose],
          ['DV / check', [ca.dvNumber, ca.checkNumber && `Check ${ca.checkNumber}`].filter(Boolean).join(' · ')],
          ['Date granted', ca.grantDate],
          ['Liquidation due', ca.liquidationDueDate],
          ['Days outstanding', OPEN.includes(ca.status) ? `${ca.daysOutstanding} (${ca.agingCategory})` : '—'],
          ['Amount granted', <Money key="g" value={ca.amountGranted} dashZero={false} />],
          ['Liquidated', <Money key="l" value={ca.amountLiquidated} dashZero={false} />],
          ['Refunded', <Money key="r" value={ca.amountRefunded} dashZero={false} />],
          ['Outstanding', <strong key="o"><Money value={ca.outstandingBalance} dashZero={false} /></strong>],
        ]}
      />
      <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-800">Liquidations and refunds</h3>
      {lrs.length ? (
        <div className="overflow-x-auto">
          <table className="table-base">
            <caption className="sr-only">Liquidation reports of this cash advance</caption>
            <thead>
              <tr><th scope="col">LR no.</th><th scope="col">Date</th><th scope="col" className="num">Supported</th><th scope="col" className="num">Refunded</th><th scope="col">Refund OR</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Print</span></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lrs.map((l) => (
                <tr key={l.id}>
                  <td>{l.liquidationNumber ?? <span className="text-slate-500">draft</span>}</td>
                  <td>{l.liquidationDate}</td>
                  <td className="num"><Money value={l.totalSupported} /></td>
                  <td className="num"><Money value={l.cashRefunded} /></td>
                  <td>{l.refundOrNumber ?? '—'}</td>
                  <td><StatusChip status={l.status} /></td>
                  <td><PrintLink code="LR" documentId={l.id} fiscalYear={l.fiscalYear} className="btn-ghost btn-sm" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-600">No liquidation reports yet.</p>
      )}
    </Modal>
  );
}

function LegacyEditor({ rec, onClose }: { rec: Ca | null; onClose(): void }) {
  const { notify } = useToast();
  const { barangayId } = useBarangay();
  const [f, setF] = useState({
    accountCode: rec?.accountCode ?? '1-03-03-020',
    accountableOfficerId: rec?.accountableOfficerId ?? (null as string | null),
    cashAdvanceType: (rec?.cashAdvanceType ?? 'OFFICIAL_TRAVEL') as CashAdvanceType,
    purpose: rec?.purpose ?? '',
    grantDate: rec?.grantDate ?? '',
    dvNumber: rec?.dvNumber ?? '',
    checkNumber: rec?.checkNumber ?? '',
    amountGranted: (rec?.amountGranted ?? 0) as Centavos | null,
    openingLiquidated: (rec?.openingLiquidated ?? 0) as Centavos | null,
    liquidationDueDate: rec?.liquidationDueDate ?? '',
  });
  const [busy, setBusy] = useState(false);
  if (!barangayId) return null;
  const over = (f.openingLiquidated ?? 0) >= (f.amountGranted ?? 0) && (f.amountGranted ?? 0) > 0;
  const valid = f.accountableOfficerId && f.purpose.trim().length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(f.grantDate) && f.dvNumber.trim() && (f.amountGranted ?? 0) > 0 && f.openingLiquidated !== null && !over;

  async function onSave() {
    setBusy(true);
    try {
      await caApi.recordLegacyCashAdvance({
        id: rec?.id ?? null,
        barangayId: barangayId!,
        accountableOfficerId: f.accountableOfficerId!,
        cashAdvanceType: f.cashAdvanceType,
        purpose: f.purpose,
        grantDate: f.grantDate,
        dvNumber: f.dvNumber,
        checkNumber: f.checkNumber || null,
        amountGranted: f.amountGranted ?? 0,
        openingLiquidated: f.openingLiquidated ?? 0,
        liquidationDueDate: f.liquidationDueDate || null,
      });
      notify('Migrated cash advance saved.', 'success');
      onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      title={rec ? 'Edit migrated cash advance' : 'Record legacy (migrated) cash advance'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600">Opening balance of an advance granted before BFMS. Later liquidations go through the normal Liquidation Report workflow.</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Cash advance account" required className="sm:col-span-2">
          {(p) => (
            <select {...p} className="input" value={f.accountCode} onChange={(e) => setF({ ...f, accountCode: e.target.value, accountableOfficerId: null })}>
              {CA_ACCOUNTS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Accountable officer (ledger)" required className="sm:col-span-2" hint="Add AO## / EO## ledgers in Barangay Setup.">
          {(p) => <SubsidiarySelect {...p} barangayId={barangayId} accountCode={f.accountCode} value={f.accountableOfficerId} onChange={(v) => setF({ ...f, accountableOfficerId: v })} emptyLabel="— select officer —" />}
        </Field>
        <Field label="Type" required className="sm:col-span-2">
          {(p) => (
            <select {...p} className="input" value={f.cashAdvanceType} onChange={(e) => setF({ ...f, cashAdvanceType: e.target.value as CashAdvanceType })}>
              {CASH_ADVANCE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Purpose" required className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} />}</Field>
        <Field label="Date granted" required>{(p) => <input {...p} type="date" className="input" value={f.grantDate} onChange={(e) => setF({ ...f, grantDate: e.target.value })} />}</Field>
        <Field label="DV no." required>{(p) => <input {...p} className="input" value={f.dvNumber} onChange={(e) => setF({ ...f, dvNumber: e.target.value })} placeholder="2025-11-031" />}</Field>
        <Field label="Check no.">{(p) => <input {...p} className="input" value={f.checkNumber} onChange={(e) => setF({ ...f, checkNumber: e.target.value })} />}</Field>
        <Field label="Liquidation due" hint="Blank: from the aging settings.">{(p) => <input {...p} type="date" className="input" value={f.liquidationDueDate} onChange={(e) => setF({ ...f, liquidationDueDate: e.target.value })} />}</Field>
        <Field label="Amount granted" required>{(p) => <MoneyInput {...p} value={f.amountGranted} onChange={(v) => setF({ ...f, amountGranted: v })} allowZero={false} />}</Field>
        <Field label="Liquidated before migration" error={over ? 'Must be less than the amount granted.' : null}>{(p) => <MoneyInput {...p} value={f.openingLiquidated} onChange={(v) => setF({ ...f, openingLiquidated: v })} />}</Field>
        <div className="self-end pb-2 text-sm sm:col-span-2">Opening unliquidated balance: <strong>₱<Money value={Math.max(0, (f.amountGranted ?? 0) - (f.openingLiquidated ?? 0))} dashZero={false} /></strong></div>
      </div>
    </Modal>
  );
}
