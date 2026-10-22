import { PETTY_CASH_REPLENISHMENT_MODULE, PETTY_CASH_VOUCHER_MODULE, manilaToday, type Centavos, type PartyRef, type PettyCashFundRecord, type PettyCashTxnRecord, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AccountInput, emptyParty, InfoGrid, MoneyInput, PartyInput, SubsidiarySelect } from '../../components/forms';
import { ModuleTabs, RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, PrintLink, ReturnBanner, WorkflowTrail, reportHref, statusOptions, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, PageHeader, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useChartOfAccounts } from '../../hooks/useChartOfAccounts';
import { useCollection } from '../../hooks/useCollection';
import { errorMessage } from '../../services/functions/api';
import { caApi } from './api';
import { SumLine } from './common';

type Fund = WithId<PettyCashFundRecord>;
type Txn = WithId<PettyCashTxnRecord>;

function usePettyCash() {
  const { barangayId, fiscalYear } = useBarangay();
  const funds = useCollection<PettyCashFundRecord>('pettyCashFunds', barangayId ? [['barangayId', '==', barangayId]] : null);
  const txns = useCollection<PettyCashTxnRecord>('pettyCashTransactions', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null);
  return { funds: funds.rows, txns: txns.rows, loading: funds.loading || txns.loading };
}

/** Phase 6 — petty cash: fund (imprest), petty cash vouchers, replenishment, return/close. */
export function PettyCashPage() {
  const { can } = useAuth();
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const { funds } = usePettyCash();
  const [establish, setEstablish] = useState(false);
  const [closing, setClosing] = useState<Fund | null>(null);
  if (!barangayId) return null;
  const month = Number(manilaToday().slice(5, 7));
  const shown = [...funds].sort((a, b) => (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1) || b.dateEstablished.localeCompare(a.dateEstablished)).slice(0, 4);
  return (
    <>
      <PageHeader
        title="Petty Cash"
        subtitle={`${barangayLabel} · FY ${fiscalYear}`}
        breadcrumbs={['BFMS', 'Petty Cash']}
        actions={
          <>
            <Link className="btn-secondary" to={reportHref('PCR', { fiscalYear, month })}>Petty Cash Record</Link>
            <Link className="btn-secondary" to={reportHref('SPCD', { fiscalYear, month })}>SPCD</Link>
            {can('treasury.encode', barangayId) && <button type="button" className="btn-primary" onClick={() => setEstablish(true)}><Icon name="plus" /> Establish fund</button>}
          </>
        }
      />
      <section aria-label="Petty cash funds" className="mb-4 grid gap-3 md:grid-cols-2">
        {shown.length === 0 && <div className="card p-4 text-sm text-slate-600 md:col-span-2">No petty cash fund yet. Establish one after the establishing DV (Dr 1-01-01-020 / Cr Cash in Bank) is paid.</div>}
        {shown.map((f) => (
          <div key={f.id} className="card p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold text-navy-800">{f.fundName}</h2>
                <p className="text-xs text-slate-600">{f.custodianCode} — {f.custodianName} · DV {f.establishedDvNumber} · {f.dateEstablished}</p>
              </div>
              <StatusChip status={f.status} />
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <div><dt className="kpi-label">Imprest</dt><dd className="tabular-nums">₱<Money value={f.fundAmount} dashZero={false} /></dd></div>
              <div><dt className="kpi-label">Cash on hand</dt><dd className="font-semibold tabular-nums">₱<Money value={f.cashOnHand} dashZero={false} /></dd></div>
              <div><dt className="kpi-label">Unreplenished</dt><dd className={`tabular-nums ${f.unreplenished ? 'text-orange-800' : ''}`}>₱<Money value={f.unreplenished} dashZero={false} /></dd></div>
            </dl>
            {f.status === 'ACTIVE' && f.fundAmount > 0 && (
              <div className="mt-2 h-2 overflow-hidden rounded bg-slate-100" role="img" aria-label={`Cash on hand ${Math.round((f.cashOnHand * 100) / f.fundAmount)}% of the imprest`}>
                <div className="h-full bg-navy-700" style={{ width: `${Math.min(100, (f.cashOnHand * 100) / f.fundAmount)}%` }} />
              </div>
            )}
            {f.status === 'ACTIVE' && can('treasury.submit', barangayId) && (
              <div className="mt-3 text-right"><button type="button" className="btn-ghost btn-sm" onClick={() => setClosing(f)}>Return / close fund…</button></div>
            )}
          </div>
        ))}
      </section>
      <ModuleTabs label="Petty cash sections" tabs={[{ to: '/petty-cash/vouchers', label: 'Petty cash vouchers' }, { to: '/petty-cash/replenishments', label: 'Replenishments' }, { to: '/petty-cash/ledger', label: 'Fund transactions' }]} />
      <Routes>
        <Route index element={<Navigate to="vouchers" replace />} />
        <Route path="vouchers" element={<VouchersTab />} />
        <Route path="replenishments" element={<ReplenishmentsTab />} />
        <Route path="ledger" element={<LedgerTab />} />
      </Routes>
      {establish && <EstablishFund onClose={() => setEstablish(false)} />}
      {closing && <CloseFund fund={closing} onClose={() => setClosing(null)} />}
    </>
  );
}

function VouchersTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const { funds, txns, loading } = usePettyCash();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  if (!barangayId) return null;
  const pcvs = txns.filter((t) => t.kind === 'PAYMENT');
  const list = pcvs.filter((r) => !status || r.status === status).sort((a, b) => b.date.localeCompare(a.date) || (b.pcvNumber ?? '').localeCompare(a.pcvNumber ?? ''));
  const active = funds.some((f) => f.status === 'ACTIVE');
  return (
    <>
      <RegisterTable
        caption={`Petty cash vouchers FY ${fiscalYear}`}
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter value={status} onChange={setStatus} options={statusOptions(PETTY_CASH_VOUCHER_MODULE).filter((s) => s !== 'POSTED')} />
            <div className="ml-auto">{can('treasury.encode', barangayId) && active && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New PCV</button>}</div>
          </>
        }
        empty={`No petty cash vouchers for FY ${fiscalYear}.`}
        columns={[
          { label: 'PCV no.', render: (r) => r.pcvNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Date', render: (r) => r.date },
          { label: 'Payee', render: (r) => r.payee?.name },
          { label: 'Particulars', className: 'max-w-xs truncate', render: (r) => r.particulars },
          { label: 'Account', render: (r) => <span className="font-mono text-xs">{r.accountCode}</span> },
          { label: 'Amount', numeric: true, render: (r) => <Money value={r.amount} /> },
          { label: 'Replenished', render: (r) => (r.status !== 'APPROVED' ? '—' : txns.find((x) => x.id === r.replenishmentId)?.status === 'ACCEPTED' ? 'Yes' : r.replenishmentId ? 'Requested' : 'No') },
          { label: 'Status', render: (r) => <StatusChip status={r.status === 'APPROVED' ? 'PAID' : r.status} /> },
        ]}
      />
      {open && <PcvEditor id={open === 'new' ? null : open} rows={pcvs} funds={funds} onClose={() => setOpen(null)} />}
    </>
  );
}

function PcvEditor({ id, rows, funds, onClose }: { id: string | null; rows: Txn[]; funds: Fund[]; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const coa = useChartOfAccounts();
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [currentId, setCurrentId] = useState(id);
  const activeFunds = funds.filter((f) => f.status === 'ACTIVE' || f.id === rec?.pettyCashFundId);
  const [f, setF] = useState({
    pettyCashFundId: rec?.pettyCashFundId ?? activeFunds[0]?.id ?? '',
    date: rec?.date ?? manilaToday(),
    payee: (rec?.payee ?? emptyParty()) as PartyRef,
    particulars: rec?.particulars ?? '',
    accountCode: rec?.accountCode ?? '',
    subsidiaryId: (rec as (Txn & { subsidiaryId?: string | null }) | null)?.subsidiaryId ?? (null as string | null),
    amount: (rec?.amount ?? 0) as Centavos | null,
  });
  const { save, busy } = useSaveSource(PETTY_CASH_VOUCHER_MODULE.key);
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('treasury.encode', barangayId) && (!live || PETTY_CASH_VOUCHER_MODULE.editableStatuses.includes(live.status));
  const fund = funds.find((x) => x.id === f.pettyCashFundId);
  const acct = coa?.get(f.accountCode);
  const over = editable && fund && (f.amount ?? 0) > fund.cashOnHand;
  const valid = fund && f.payee.name.trim().length >= 2 && f.particulars.trim().length >= 3 && acct && (!acct.requiresSubsidiaryLedger || f.subsidiaryId) && (f.amount ?? 0) > 0 && !over;

  async function onSave() {
    const newId = await save(barangayId!, { ...f, amount: f.amount ?? 0, payee: { ...f.payee, id: f.payee.id ?? null } }, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  }

  return (
    <Modal
      open
      wide
      title={live?.pcvNumber ? `Petty Cash Voucher ${live.pcvNumber}` : live ? 'Petty cash voucher (draft)' : 'New petty cash voucher'}
      onClose={onClose}
      footer={
        <>
          {live && <ActionBar def={PETTY_CASH_VOUCHER_MODULE} record={live} />}
          <span className="mr-auto" />
          {live?.pcvNumber && <PrintLink code="PCV" documentId={live.id} fiscalYear={live.fiscalYear} label="Print PCV" />}
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save draft'}</button>}
        </>
      }
    >
      {live && <div className="mb-3"><StatusChip status={live.status === 'APPROVED' ? 'PAID' : live.status} /></div>}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Petty cash fund" required className="sm:col-span-3" hint={fund ? `Cash on hand ₱${(fund.cashOnHand / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}` : undefined}>
            {(p) => (
              <select {...p} className="input" value={f.pettyCashFundId} onChange={(e) => setF({ ...f, pettyCashFundId: e.target.value })}>
                <option value="">— select fund —</option>
                {activeFunds.map((x) => <option key={x.id} value={x.id}>{x.fundName} — {x.custodianName}</option>)}
              </select>
            )}
          </Field>
          <Field label="Date" required>{(p) => <input {...p} type="date" className="input" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
        </div>
        <PartyInput value={f.payee} onChange={(payee) => setF({ ...f, payee })} disabled={!editable} />
        <Field label="Particulars" required>{(p) => <textarea {...p} rows={2} className="input" value={f.particulars} onChange={(e) => setF({ ...f, particulars: e.target.value })} />}</Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Account charged" required>{(p) => <AccountInput {...p} value={f.accountCode} prefixes={['5-', '1-04', '1-05']} onChange={(v) => setF({ ...f, accountCode: v, subsidiaryId: null })} />}</Field>
          {acct?.requiresSubsidiaryLedger ? (
            <Field label="Subsidiary ledger" required>{(p) => <SubsidiarySelect {...p} barangayId={barangayId} accountCode={f.accountCode} value={f.subsidiaryId} onChange={(v) => setF({ ...f, subsidiaryId: v })} />}</Field>
          ) : <span />}
          <Field label="Amount" required error={over ? 'Exceeds the petty cash on hand; request a replenishment first.' : null}>{(p) => <MoneyInput {...p} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} allowZero={false} />}</Field>
        </div>
      </fieldset>
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}

function ReplenishmentsTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const { funds, txns, loading } = usePettyCash();
  const [open, setOpen] = useState<string | 'new' | null>(null);
  if (!barangayId) return null;
  const reqs = txns.filter((t) => t.kind === 'REPLENISH').sort((a, b) => b.date.localeCompare(a.date));
  const fundName = (id: string) => funds.find((f) => f.id === id)?.fundName ?? '';
  return (
    <>
      <RegisterTable
        caption={`Replenishment requests FY ${fiscalYear}`}
        rows={reqs}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={<div className="ml-auto">{can('treasury.encode', barangayId) && funds.some((f) => f.status === 'ACTIVE' && f.unreplenished > 0) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> Request replenishment</button>}</div>}
        empty="No replenishment requests."
        columns={[
          { label: 'Request no.', render: (r) => r.replenishmentNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Date', render: (r) => r.date },
          { label: 'Fund', render: (r) => fundName(r.pettyCashFundId) },
          { label: 'PCVs', numeric: true, render: (r) => r.pcvIds?.length ?? 0 },
          { label: 'Amount', numeric: true, render: (r) => <Money value={r.amount} /> },
          { label: 'Replenishment DV', render: (r) => (r.replenishmentDvNumber ? `${r.replenishmentDvNumber} (${r.replenishedDate})` : '—') },
          { label: 'Status', render: (r) => <StatusChip status={r.status === 'ACCEPTED' ? 'REPLENISHED' : r.status} /> },
        ]}
      />
      {open && <ReplenishmentEditor id={open === 'new' ? null : open} rows={reqs} txns={txns} funds={funds} onClose={() => setOpen(null)} />}
    </>
  );
}

function ReplenishmentEditor({ id, rows, txns, funds, onClose }: { id: string | null; rows: Txn[]; txns: Txn[]; funds: Fund[]; onClose(): void }) {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const rec = id ? rows.find((r) => r.id === id) ?? null : null;
  const [currentId, setCurrentId] = useState(id);
  const active = funds.filter((f) => f.status === 'ACTIVE' || f.id === rec?.pettyCashFundId);
  const [f, setF] = useState({ pettyCashFundId: rec?.pettyCashFundId ?? active[0]?.id ?? '', date: rec?.date ?? manilaToday(), particulars: rec?.particulars ?? 'Replenishment of petty cash fund' });
  const [dv, setDv] = useState({ dvNumber: '', replenishedDate: manilaToday() });
  const { save, busy } = useSaveSource(PETTY_CASH_REPLENISHMENT_MODULE.key);
  if (!barangayId) return null;
  const live = currentId ? rows.find((r) => r.id === currentId) ?? rec : null;
  const editable = can('treasury.encode', barangayId) && (!live || PETTY_CASH_REPLENISHMENT_MODULE.editableStatuses.includes(live.status));
  // Before submission, preview the paid PCVs not yet in another request; afterwards, the snapshot.
  const pcvs = live && live.status !== 'DRAFT' && live.status !== 'RETURNED'
    ? txns.filter((t) => live.pcvIds?.includes(t.id))
    : txns.filter((t) => t.kind === 'PAYMENT' && t.status === 'APPROVED' && t.pettyCashFundId === f.pettyCashFundId && (!t.replenishmentId || t.replenishmentId === live?.id));
  const total = pcvs.reduce((s, t) => s + t.amount, 0);

  async function onSave() {
    const newId = await save(barangayId!, f, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  }

  return (
    <Modal
      open
      wide
      title={live?.replenishmentNumber ? `Replenishment ${live.replenishmentNumber}` : 'Petty cash replenishment request'}
      onClose={onClose}
      footer={
        <>
          {live && <ActionBar def={PETTY_CASH_REPLENISHMENT_MODULE} record={live} payload={(a) => (a === 'REPLENISH' ? dv : undefined)} />}
          <span className="mr-auto" />
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !f.pettyCashFundId || !pcvs.length} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save draft'}</button>}
        </>
      }
    >
      {live && <div className="mb-3"><StatusChip status={live.status === 'ACCEPTED' ? 'REPLENISHED' : live.status} /></div>}
      {live && <ReturnBanner record={live} />}
      <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-4">
        <Field label="Petty cash fund" required className="sm:col-span-2">
          {(p) => (
            <select {...p} className="input" value={f.pettyCashFundId} onChange={(e) => setF({ ...f, pettyCashFundId: e.target.value })}>
              {active.map((x) => <option key={x.id} value={x.id}>{x.fundName} — {x.custodianName}</option>)}
            </select>
          )}
        </Field>
        <Field label="Request date" required>{(p) => <input {...p} type="date" className="input" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
        <Field label="Particulars" className="sm:col-span-4">{(p) => <input {...p} className="input" value={f.particulars} onChange={(e) => setF({ ...f, particulars: e.target.value })} />}</Field>
      </fieldset>
      <h3 className="mb-1 mt-4 text-sm font-semibold text-slate-800">Paid petty cash vouchers covered {editable && <span className="font-normal text-slate-600">(final list is taken when the request is submitted)</span>}</h3>
      <div className="overflow-x-auto">
        <table className="table-base">
          <caption className="sr-only">Petty cash vouchers in this replenishment</caption>
          <thead><tr><th scope="col">PCV no.</th><th scope="col">Date</th><th scope="col">Payee</th><th scope="col">Account</th><th scope="col" className="num">Amount</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {pcvs.map((t) => <tr key={t.id}><td>{t.pcvNumber}</td><td>{t.date}</td><td>{t.payee?.name}</td><td className="font-mono text-xs">{t.accountCode}</td><td className="num"><Money value={t.amount} /></td></tr>)}
            {!pcvs.length && <tr><td colSpan={5} className="text-sm text-slate-600">No paid, unreplenished vouchers.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="mt-2 sm:ml-auto sm:max-w-sm"><SumLine label="Amount to replenish" value={total} strong /></div>
      {live?.status === 'APPROVED' && can('treasury.encode', barangayId) && (
        <div className="mt-4 grid gap-3 rounded-md border border-navy-100 bg-navy-50 p-3 sm:grid-cols-3">
          <p className="text-sm text-slate-700 sm:col-span-3">When the replenishment DV (Dr expenses / Cr Cash in Bank) has been paid, record it here, then use “Record replenishment DV”.</p>
          <Field label="Replenishment DV no." required>{(p) => <input {...p} className="input" value={dv.dvNumber} onChange={(e) => setDv({ ...dv, dvNumber: e.target.value })} />}</Field>
          <Field label="Date replenished" required>{(p) => <input {...p} type="date" className="input" value={dv.replenishedDate} onChange={(e) => setDv({ ...dv, replenishedDate: e.target.value })} />}</Field>
        </div>
      )}
      {live?.status === 'ACCEPTED' && <div className="mt-4"><InfoGrid items={[['Replenishment DV', live.replenishmentDvNumber ?? ''], ['Date replenished', live.replenishedDate ?? ''], ['Amount', <Money key="a" value={live.amount} dashZero={false} />]]} /></div>}
      {live && <WorkflowTrail barangayId={live.barangayId} recordId={live.id} />}
    </Modal>
  );
}

function LedgerTab() {
  const { fiscalYear } = useBarangay();
  const { funds, txns, loading } = usePettyCash();
  const fundName = (id: string) => funds.find((f) => f.id === id)?.fundName ?? '';
  const rows = txns.filter((t) => t.kind !== 'PAYMENT' && t.kind !== 'REPLENISH').sort((a, b) => b.date.localeCompare(a.date));
  return (
    <RegisterTable
      caption={`Fund establishment and returns FY ${fiscalYear}`}
      rows={rows}
      loading={loading}
      empty="No fund establishment or return this year."
      columns={[
        { label: 'Date', render: (r) => r.date },
        { label: 'Kind', render: (r) => r.kind.replace(/_/g, ' ') },
        { label: 'Fund', render: (r) => fundName(r.pettyCashFundId) },
        { label: 'Reference', render: (r) => (r.kind === 'ESTABLISH' ? `DV ${r.replenishmentDvNumber ?? ''}` : `OR ${r.refundOrNumber ?? ''}`) },
        { label: 'Particulars', className: 'max-w-sm truncate', render: (r) => r.particulars },
        { label: 'Amount', numeric: true, render: (r) => <Money value={r.amount} /> },
      ]}
    />
  );
}

function EstablishFund({ onClose }: { onClose(): void }) {
  const { notify } = useToast();
  const { barangayId } = useBarangay();
  const [f, setF] = useState({ custodianId: null as string | null, fundName: 'Petty Cash Fund', fundAmount: 0 as Centavos | null, dateEstablished: manilaToday(), establishedDvNumber: '' });
  const [busy, setBusy] = useState(false);
  if (!barangayId) return null;
  const valid = f.custodianId && f.fundName.trim().length >= 3 && (f.fundAmount ?? 0) > 0 && f.establishedDvNumber.trim();
  async function submit() {
    setBusy(true);
    try {
      await caApi.establishPettyCashFund({ barangayId: barangayId!, custodianId: f.custodianId!, fundName: f.fundName, fundAmount: f.fundAmount ?? 0, dateEstablished: f.dateEstablished, establishedDvNumber: f.establishedDvNumber });
      notify('Petty cash fund established.', 'success');
      onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open title="Establish petty cash fund" onClose={onClose} footer={<><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void submit()}>{busy ? 'Saving…' : 'Establish'}</button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Custodian (1-01-01-020 ledger)" required className="sm:col-span-2" hint="Add the custodian's Petty Cash ledger in Barangay Setup.">
          {(p) => <SubsidiarySelect {...p} barangayId={barangayId} accountCode="1-01-01-020" value={f.custodianId} onChange={(v) => setF({ ...f, custodianId: v })} emptyLabel="— select custodian —" />}
        </Field>
        <Field label="Fund name" required className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.fundName} onChange={(e) => setF({ ...f, fundName: e.target.value })} />}</Field>
        <Field label="Amount (imprest)" required>{(p) => <MoneyInput {...p} value={f.fundAmount} onChange={(v) => setF({ ...f, fundAmount: v })} allowZero={false} />}</Field>
        <Field label="Date established" required>{(p) => <input {...p} type="date" className="input" value={f.dateEstablished} onChange={(e) => setF({ ...f, dateEstablished: e.target.value })} />}</Field>
        <Field label="Establishing DV no." required className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.establishedDvNumber} onChange={(e) => setF({ ...f, establishedDvNumber: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}

function CloseFund({ fund, onClose }: { fund: Fund; onClose(): void }) {
  const { notify } = useToast();
  const [f, setF] = useState({ date: manilaToday(), kind: 'RETURN' as 'RETURN' | 'YEAR_END_CLOSE', refundOrNumber: '', cashSubsidiaryId: null as string | null, remarks: '' });
  const [busy, setBusy] = useState(false);
  const blocked = fund.unreplenished > 0;
  async function submit() {
    setBusy(true);
    try {
      const r = await caApi.closePettyCashFund({ fundId: fund.id, date: f.date, kind: f.kind, refundOrNumber: f.refundOrNumber, cashSubsidiaryId: f.cashSubsidiaryId!, remarks: f.remarks });
      notify(`Fund closed; ₱${(r.amount / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })} returned${r.jevId ? ' — draft journal entry created' : ''}.`, 'success');
      onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open title={`Return / close — ${fund.fundName}`} onClose={onClose} footer={<><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn-danger" disabled={busy || blocked || !f.refundOrNumber.trim() || !f.cashSubsidiaryId} onClick={() => void submit()}>{busy ? 'Closing…' : 'Return cash & close'}</button></>}>
      {blocked && <p role="alert" className="mb-3 rounded-md border border-orange-300 bg-orange-50 p-3 text-sm text-orange-900">₱<Money value={fund.unreplenished} dashZero={false} /> of paid vouchers is not yet replenished. Replenish them first.</p>}
      <p className="mb-3 text-sm text-slate-700">Cash to return: <strong>₱<Money value={fund.cashOnHand} dashZero={false} /></strong>. A draft entry Dr 1-01-01-010 / Cr 1-01-01-020 is generated for accounting.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind" required>
          {(p) => (
            <select {...p} className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })}>
              <option value="RETURN">Return / close the fund</option>
              <option value="YEAR_END_CLOSE">Year-end return</option>
            </select>
          )}
        </Field>
        <Field label="Date" required>{(p) => <input {...p} type="date" className="input" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
        <Field label="OR no. (cash returned)" required>{(p) => <input {...p} className="input" value={f.refundOrNumber} onChange={(e) => setF({ ...f, refundOrNumber: e.target.value })} />}</Field>
        <Field label="Received by (collecting officer)" required>{(p) => <SubsidiarySelect {...p} barangayId={fund.barangayId} accountCode="1-01-01-010" value={f.cashSubsidiaryId} onChange={(v) => setF({ ...f, cashSubsidiaryId: v })} emptyLabel="— BT## —" />}</Field>
        <Field label="Remarks" className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}
