import { STF_ADJUSTMENT_KINDS, manilaToday, type Centavos, type DisbursementVoucherDoc, type ObligationDoc, type SpecialTrustFundRecord, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BankAccountSelect, InfoGrid, MoneyInput } from '../../components/forms';
import { RegisterTable } from '../../components/register';
import { reportHref } from '../../components/source';
import { Field, Icon, Modal, Money, PageHeader, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useCollection } from '../../hooks/useCollection';
import { errorMessage } from '../../services/functions/api';
import { caApi } from './api';
import { Kpis } from './common';

type Stf = WithId<SpecialTrustFundRecord>;
const SOURCES = ['DOH', 'DILG', 'DSWD', 'POPCOM', 'PNO', 'DA', 'DepEd', 'LGU (Municipal)', 'LGU (Provincial)', 'Other'];

/** Phase 7 — Special Trust Funds registry: receipts, adjustments, obligations charged and utilization. */
export function TrustFundsPage() {
  const { can } = useAuth();
  const { notify } = useToast();
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const [open, setOpen] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  const { rows, loading } = useCollection<SpecialTrustFundRecord>('specialTrustFunds', barangayId ? [['barangayId', '==', barangayId]] : null);
  if (!barangayId) return null;
  const list = [...rows].sort((a, b) => (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1) || a.fundCode.localeCompare(b.fundCode));
  const tot = (k: 'amountReceived' | 'adjustments' | 'amountObligated' | 'amountDisbursed' | 'balance') => rows.reduce((t, r) => t + (r[k] ?? 0), 0);

  async function refresh() {
    setBusy(true);
    try {
      const r = await caApi.refreshSpecialTrustFunds({ barangayId: barangayId! });
      notify(`Utilization refreshed (${r.updated} of ${r.funds} funds changed).`, 'success');
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Special Trust Funds"
        subtitle={`${barangayLabel} · funds received for specific purposes (Trust Liabilities 2-03-01-010)`}
        breadcrumbs={['BFMS', 'Trust Funds']}
        actions={
          <>
            <Link className="btn-secondary" to={reportHref('RSTF', { fiscalYear, month: Number(manilaToday().slice(5, 7)) })}>Registry (RSTF)</Link>
            {(can('treasury.encode', barangayId) || can('submission.review', barangayId)) && <button type="button" className="btn-secondary" disabled={busy} onClick={() => void refresh()}>{busy ? 'Refreshing…' : 'Refresh utilization'}</button>}
            {can('treasury.encode', barangayId) && <button type="button" className="btn-primary" onClick={() => setRegistering(true)}><Icon name="plus" /> Register trust fund</button>}
          </>
        }
      />
      <Kpis
        items={[
          { label: 'Received (incl. adjustments)', value: tot('amountReceived') + tot('adjustments') },
          { label: 'Obligated', value: tot('amountObligated') },
          { label: 'Disbursed', value: tot('amountDisbursed') },
          { label: 'Unobligated balance', value: tot('balance') },
        ]}
      />
      <RegisterTable
        caption="Special Trust Funds"
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        empty="No Special Trust Funds registered. Register each fund received from DOH, DILG, POPCOM and other agencies."
        columns={[
          { label: 'Fund code', render: (r) => <span className="font-mono text-xs">{r.fundCode}</span> },
          { label: 'Fund', render: (r) => r.fundName },
          { label: 'Source', render: (r) => r.source },
          { label: 'Received', render: (r) => r.dateReceived },
          { label: 'Amount received', numeric: true, render: (r) => <Money value={r.amountReceived + r.adjustments} /> },
          { label: 'Obligated', numeric: true, render: (r) => <Money value={r.amountObligated} /> },
          { label: 'Disbursed', numeric: true, render: (r) => <Money value={r.amountDisbursed} /> },
          { label: 'Balance', numeric: true, render: (r) => <Money value={r.balance} /> },
          { label: 'Status', render: (r) => <StatusChip status={r.status} /> },
        ]}
      />
      {open && <StfDetail stf={rows.find((r) => r.id === open)} onClose={() => setOpen(null)} />}
      {registering && <RegisterStf onClose={() => setRegistering(false)} />}
    </>
  );
}

function StfDetail({ stf, onClose }: { stf: Stf | undefined; onClose(): void }) {
  const { can } = useAuth();
  const { notify } = useToast();
  const obls = useCollection<ObligationDoc & { dvId?: string | null }>('obligations', stf ? [['barangayId', '==', stf.barangayId], ['specialTrustFundId', '==', stf.id]] : null).rows;
  const dvs = useCollection<DisbursementVoucherDoc>('disbursementVouchers', stf && obls.some((o) => o.dvId) ? [['barangayId', '==', stf.barangayId]] : null).rows;
  const [adj, setAdj] = useState({ date: manilaToday(), kind: 'ADDITIONAL_RECEIPT', amount: 0 as Centavos | null, reference: '', reason: '' });
  const [busy, setBusy] = useState(false);
  if (!stf) return null;
  const canAdjust = can('treasury.encode', stf.barangayId) && stf.status !== 'CLOSED';
  const charged = [...obls].filter((o) => o.obligationNumber).sort((a, b) => a.date.localeCompare(b.date));
  const dvOf = (id?: string | null) => (id ? dvs.find((d) => d.id === id) : undefined);

  async function submit() {
    setBusy(true);
    try {
      const r = await caApi.adjustSpecialTrustFund({ stfId: stf!.id, date: adj.date, kind: adj.kind, amount: adj.amount ?? 0, reference: adj.reference, reason: adj.reason });
      notify(`Adjustment recorded. Balance ₱${(r.balance / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}.`, 'success');
      setAdj({ ...adj, amount: 0 as Centavos, reference: '', reason: '' });
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open wide title={`${stf.fundCode} — ${stf.fundName}`} onClose={onClose} footer={<button type="button" className="btn-secondary" onClick={onClose}>Close</button>}>
      <div className="mb-3 flex items-center gap-2"><StatusChip status={stf.status} /><span className="text-xs text-slate-600">Fund {stf.fundId} · ledger 2-03-01-010 / {stf.fundCode}</span></div>
      <InfoGrid
        columns={4}
        items={[
          ['Source agency', stf.source],
          ['Date received', stf.dateReceived],
          ['Purpose', stf.purpose],
          ['Receipt entry', stf.jevId ? 'Draft JEV generated' : 'Not journalized here'],
          ['Received', <Money key="r" value={stf.amountReceived} dashZero={false} />],
          ['Adjustments', <Money key="a" value={stf.adjustments} dashZero={false} />],
          ['Obligated', <Money key="o" value={stf.amountObligated} dashZero={false} />],
          ['Unobligated balance', <strong key="b"><Money value={stf.balance} dashZero={false} /></strong>],
        ]}
      />
      <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-800">Receipts and adjustments</h3>
      <div className="overflow-x-auto">
        <table className="table-base">
          <caption className="sr-only">Receipts and adjustments of the fund</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Kind</th><th scope="col">Reference</th><th scope="col">Reason</th><th scope="col" className="num">Amount</th><th scope="col">By</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {(stf.history ?? []).map((h, i) => (
              <tr key={i}><td>{h.date}</td><td>{h.kind.replace(/_/g, ' ')}</td><td>{h.reference || '—'}</td><td className="max-w-xs truncate">{h.reason}</td><td className="num"><Money value={h.amount} /></td><td className="text-xs">{h.by}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {canAdjust && (
        <form className="mt-3 grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="Adjustment" required className="sm:col-span-2">
            {(p) => (
              <select {...p} className="input" value={adj.kind} onChange={(e) => setAdj({ ...adj, kind: e.target.value })}>
                {STF_ADJUSTMENT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Date" required>{(p) => <input {...p} type="date" className="input" value={adj.date} onChange={(e) => setAdj({ ...adj, date: e.target.value })} />}</Field>
          <Field label="Amount" required>{(p) => <MoneyInput {...p} value={adj.amount} onChange={(v) => setAdj({ ...adj, amount: v })} allowZero={false} />}</Field>
          <Field label="Reference">{(p) => <input {...p} className="input" value={adj.reference} onChange={(e) => setAdj({ ...adj, reference: e.target.value })} placeholder="OR / CM no." />}</Field>
          <Field label="Reason" required className="sm:col-span-4">{(p) => <input {...p} className="input" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} />}</Field>
          <div className="self-end pb-5"><button type="submit" className="btn-primary w-full" disabled={busy || !(adj.amount ?? 0) || adj.reason.trim().length < 5}>{busy ? 'Saving…' : 'Record'}</button></div>
        </form>
      )}
      <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-800">Utilization — obligations charged to this fund</h3>
      {charged.length ? (
        <div className="overflow-x-auto">
          <table className="table-base">
            <caption className="sr-only">Obligations charged to the fund and their disbursement vouchers</caption>
            <thead><tr><th scope="col">OBR no.</th><th scope="col">Date</th><th scope="col">Payee</th><th scope="col">Particulars</th><th scope="col" className="num">Obligated</th><th scope="col">DV</th><th scope="col" className="num">Disbursed</th><th scope="col">Status</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {charged.map((o) => {
                const dv = dvOf(o.dvId);
                return (
                  <tr key={o.id}>
                    <td>{o.obligationNumber}</td>
                    <td>{o.date}</td>
                    <td>{o.payee?.name}</td>
                    <td className="max-w-xs truncate">{o.particulars}</td>
                    <td className="num"><Money value={o.amount} /></td>
                    <td>{dv ? `${dv.dvNumber ?? 'draft'} (${dv.status})` : '—'}</td>
                    <td className="num">{dv && ['APPROVED', 'ACCEPTED', 'POSTED'].includes(dv.status) ? <Money value={dv.grossAmount} /> : '—'}</td>
                    <td><StatusChip status={o.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-600">No obligations charged yet. Obligations name the fund in Budget → Obligations.</p>
      )}
    </Modal>
  );
}

function RegisterStf({ onClose }: { onClose(): void }) {
  const { notify } = useToast();
  const { barangayId } = useBarangay();
  const [f, setF] = useState({ fundCode: '', fundName: '', source: 'DOH', purpose: '', dateReceived: manilaToday(), amountReceived: 0 as Centavos | null, reference: '', bankAccountId: null as string | null });
  const [busy, setBusy] = useState(false);
  if (!barangayId) return null;
  const valid = /^[A-Za-z0-9-]{2,20}$/.test(f.fundCode.trim()) && f.fundName.trim().length >= 3 && f.source.trim().length >= 2 && f.purpose.trim().length >= 3 && (f.amountReceived ?? 0) > 0;
  async function submit() {
    setBusy(true);
    try {
      const r = await caApi.registerSpecialTrustFund({ barangayId: barangayId!, ...f, fundCode: f.fundCode.trim().toUpperCase(), amountReceived: f.amountReceived ?? 0 });
      notify(`Trust fund ${r.id.split('_').at(-1)} registered${r.jevId ? ' — draft receipt entry created' : ''}.`, 'success');
      onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open wide title="Register Special Trust Fund" onClose={onClose} footer={<><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void submit()}>{busy ? 'Saving…' : 'Register'}</button></>}>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Fund code" required hint="e.g. TRUST106">{(p) => <input {...p} className="input font-mono uppercase" value={f.fundCode} onChange={(e) => setF({ ...f, fundCode: e.target.value })} />}</Field>
        <Field label="Fund name" required className="sm:col-span-3">{(p) => <input {...p} className="input" value={f.fundName} onChange={(e) => setF({ ...f, fundName: e.target.value })} />}</Field>
        <Field label="Source agency" required>
          {(p) => (
            <>
              <input {...p} className="input" list="stf-sources" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} />
              <datalist id="stf-sources">{SOURCES.map((s) => <option key={s} value={s} />)}</datalist>
            </>
          )}
        </Field>
        <Field label="Purpose" required className="sm:col-span-3">{(p) => <input {...p} className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} />}</Field>
        <Field label="Date received" required>{(p) => <input {...p} type="date" className="input" value={f.dateReceived} onChange={(e) => setF({ ...f, dateReceived: e.target.value })} />}</Field>
        <Field label="Amount received" required>{(p) => <MoneyInput {...p} value={f.amountReceived} onChange={(v) => setF({ ...f, amountReceived: v })} allowZero={false} />}</Field>
        <Field label="Reference (OR / credit memo)">{(p) => <input {...p} className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}</Field>
        <Field label="Deposited to bank account" hint="Optional: generates a draft entry Dr Cash in Bank / Cr Trust Liabilities.">{(p) => <BankAccountSelect {...p} barangayId={barangayId} value={f.bankAccountId} onChange={(v) => setF({ ...f, bankAccountId: v })} />}</Field>
      </div>
    </Modal>
  );
}
