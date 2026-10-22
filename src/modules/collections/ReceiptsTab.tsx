import { COLLECTION_MODULE, PAYMENT_METHODS, formatPesos, isCollectionCounted, manilaToday, type Centavos, type PartyRef, type PaymentMethod } from '@bfms/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AccountInput, InfoGrid, LinesEditor, MoneyInput, SubsidiarySelect, emptyParty } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, WorkflowTrail, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useChartOfAccounts } from '../../hooks/useChartOfAccounts';
import { errorMessage } from '../../services/functions/api';
import { collectionsApi, type OrLineInput } from './api';
import { OfficerSelect, OrStatus, nextOrFor, shortOfficer, useAfSeries, useOrs, type Or } from './common';

const RECEIPT_PREFIXES = ['4-', '2-', '1-03', '1-05', '1-99'] as const;
const blankLine = (): OrLineInput => ({ accountCode: '', subsidiaryId: null, natureOfCollection: '', amount: 0 });
const OFFICER_KEY = 'bfms.or.officer';

function readOfficer(): string | null {
  try {
    return localStorage.getItem(OFFICER_KEY);
  } catch {
    return null;
  }
}

/** Official receipts register + fast OR entry. */
export function ReceiptsTab() {
  const { can } = useAuth();
  const { barangayId, fiscalYear } = useBarangay();
  const { rows, loading } = useOrs();
  const [status, setStatus] = useState('');
  const [officer, setOfficer] = useState<string | null>(null);
  const [mode, setMode] = useState<'issue' | 'spoil' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (!barangayId) return null;
  const encode = can('treasury.encode', barangayId);
  const list = rows
    .filter((r) => (!status || r.status === status) && (!officer || r.collectingOfficerId === officer))
    .sort((a, b) => b.collectionDate.localeCompare(a.collectionDate) || b.serialNumber - a.serialNumber);
  const total = list.filter((r) => isCollectionCounted(r.status)).reduce((t, r) => t + r.amount, 0);
  return (
    <>
      <RegisterTable
        caption={`Official receipts FY ${fiscalYear}`}
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter value={status} onChange={setStatus} options={['DRAFT', 'SUBMITTED', 'ACCEPTED', 'CANCELLED']} />
            <label className="label mb-0" htmlFor="or-officer">Officer</label>
            <OfficerSelect id="or-officer" barangayId={barangayId} value={officer} onChange={setOfficer} emptyLabel="All officers" />
            <div className="ml-auto flex flex-wrap gap-2">
              {encode && <button type="button" className="btn-secondary" onClick={() => setMode('spoil')}>Record spoiled OR</button>}
              {encode && <button type="button" className="btn-primary" onClick={() => setMode('issue')}><Icon name="plus" /> Issue OR</button>}
            </div>
          </>
        }
        empty={`No official receipts for FY ${fiscalYear}. Receive an accountable form series first, then issue ORs.`}
        columns={[
          { label: 'OR no.', render: (r) => <span className="font-mono">{r.officialReceiptNumber}</span> },
          { label: 'Date', render: (r) => r.collectionDate },
          { label: 'Payor', render: (r) => r.payor?.name },
          { label: 'Nature of collection', className: 'max-w-xs truncate', render: (r) => [...new Set(r.lines.map((l) => l.natureOfCollection))].join('; ') || r.cancelReason },
          { label: 'Officer', render: (r) => shortOfficer(r.collectingOfficerName) },
          { label: 'Amount', numeric: true, render: (r) => (isCollectionCounted(r.status) ? <Money value={r.amount} /> : '—') },
          { label: 'Deposited', render: (r) => (r.depositId ? <Icon name="check" className="h-4 w-4 text-emerald-700" /> : '') },
          { label: 'Status', render: (r) => <OrStatus status={r.status} /> },
        ]}
        footer={<div className="border-t border-slate-200 px-4 py-2 text-right text-sm font-semibold">{list.length} OR(s) · Collections ₱<Money value={total} dashZero={false} /></div>}
      />
      {mode === 'issue' && <IssueOrModal onClose={() => setMode(null)} />}
      {mode === 'spoil' && <SpoiledOrModal onClose={() => setMode(null)} />}
      {open && <OrEditor rec={rows.find((r) => r.id === open) ?? null} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Lines of an OR: account (+ ledger when required), nature, amount; running total in the footer. */
function OrLines({ lines, onChange, disabled, onKeyDown }: { lines: OrLineInput[]; onChange(l: OrLineInput[]): void; disabled?: boolean; onKeyDown?(e: KeyboardEvent): void }) {
  const { barangayId } = useBarangay();
  const coa = useChartOfAccounts();
  const total = lines.reduce((t, l) => t + (l.amount || 0), 0);
  return (
    <div onKeyDown={onKeyDown}>
      <LinesEditor
        caption="Official receipt lines"
        rows={lines}
        onChange={onChange}
        blank={blankLine}
        max={20}
        disabled={disabled}
        addLabel="Add line"
        columns={[
          { label: 'Account', required: true, className: 'min-w-[12rem]', render: (r, set, i) => <><label className="sr-only" htmlFor={`orl-${i}-a`}>Line {i + 1} account</label><AccountInput id={`orl-${i}-a`} value={r.accountCode} prefixes={RECEIPT_PREFIXES} onChange={(accountCode) => set({ accountCode, subsidiaryId: null, natureOfCollection: r.natureOfCollection || coa?.get(accountCode)?.accountName || '' })} disabled={disabled} /></> },
          {
            label: 'Ledger',
            className: 'min-w-[9rem]',
            render: (r, set, i) => (coa?.get(r.accountCode)?.requiresSubsidiaryLedger && barangayId ? <><label className="sr-only" htmlFor={`orl-${i}-s`}>Line {i + 1} subsidiary ledger</label><SubsidiarySelect id={`orl-${i}-s`} barangayId={barangayId} accountCode={r.accountCode} value={r.subsidiaryId} onChange={(subsidiaryId) => set({ subsidiaryId })} allowEmpty emptyLabel="— required —" disabled={disabled} /></> : <span className="text-xs text-slate-400">n/a</span>),
          },
          { label: 'Nature of collection', className: 'min-w-[12rem]', render: (r, set, i) => <input aria-label={`Line ${i + 1} nature of collection`} className="input" value={r.natureOfCollection} onChange={(e) => set({ natureOfCollection: e.target.value })} disabled={disabled} /> },
          { label: 'Amount', numeric: true, required: true, className: 'w-36', render: (r, set, i) => <><label className="sr-only" htmlFor={`orl-${i}-m`}>Line {i + 1} amount</label><MoneyInput id={`orl-${i}-m`} value={r.amount} onChange={(v) => set({ amount: v ?? 0 })} allowZero={false} disabled={disabled} /></> },
        ]}
        footer={<p className="text-sm font-semibold" aria-live="polite">Total: <span className="tabular-nums">₱{formatPesos(total as Centavos, { dashZero: false })}</span></p>}
      />
    </div>
  );
}

function linesValid(lines: OrLineInput[], requiresSl: (code: string) => boolean) {
  return lines.length > 0 && lines.every((l) => /^\d-\d{2}-\d{2}-\d{3}$/.test(l.accountCode) && l.amount > 0 && (!requiresSl(l.accountCode) || !!l.subsidiaryId));
}

/**
 * Fast OR entry: the officer's next serial is filled in, Ctrl+Enter issues and moves to the next
 * number, the officer and date stay, payor and amounts reset (the accounts stay for repeat fees).
 */
function IssueOrModal({ onClose }: { onClose(): void }) {
  const { barangayId } = useBarangay();
  const { notify } = useToast();
  const coa = useChartOfAccounts();
  const series = useAfSeries().rows;
  const [officer, setOfficer] = useState<string | null>(readOfficer());
  const [orNo, setOrNo] = useState('');
  const [date, setDate] = useState(manilaToday());
  const [payor, setPayor] = useState<PartyRef>(emptyParty());
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [check, setCheck] = useState({ bank: '', checkNumber: '', checkDate: manilaToday() });
  const [lines, setLines] = useState<OrLineInput[]>([blankLine()]);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<Array<{ or: string; payor: string; amount: number }>>([]);
  const payorRef = useRef<HTMLInputElement>(null);
  const suggestion = nextOrFor(series, officer);
  // Fill the next serial when the officer changes or the series loads (do not overwrite typing).
  useEffect(() => {
    if (suggestion && !orNo) setOrNo(suggestion.next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion?.next, officer]);
  if (!barangayId) return null;
  const requiresSl = (c: string) => !!coa?.get(c)?.requiresSubsidiaryLedger;
  const total = lines.reduce((t, l) => t + l.amount, 0);
  const valid = !!officer && /^\d{1,12}$/.test(orNo) && payor.name.trim().length >= 2 && linesValid(lines, requiresSl) && (method !== 'CHECK' || (check.bank.trim().length >= 2 && !!check.checkNumber.trim()));

  async function issue(andNext: boolean) {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const r = await collectionsApi.issueOfficialReceipt({
        barangayId: barangayId!,
        collectingOfficerId: officer!,
        officialReceiptNumber: orNo,
        collectionDate: date,
        fundId: 'GF',
        payor: { ...payor, id: null },
        paymentMethod: method,
        checkDetails: method === 'CHECK' ? check : null,
        lines: lines.map((l) => ({ ...l, natureOfCollection: l.natureOfCollection.trim() })),
      });
      try {
        localStorage.setItem(OFFICER_KEY, officer!);
      } catch {
        /* private mode */
      }
      notify(`OR ${r.officialReceiptNumber} issued — ₱${formatPesos(r.amount as Centavos)}.`, 'success');
      setIssued((x) => [{ or: r.officialReceiptNumber, payor: payor.name, amount: r.amount }, ...x]);
      if (!andNext) return onClose();
      setOrNo(r.nextSerialNumber ?? '');
      if (!r.nextSerialNumber) notify('That was the last OR of the series. Receive or assign a new series.', 'info');
      setPayor(emptyParty());
      setMethod('CASH');
      setLines(lines.map((l) => ({ ...l, amount: 0 })));
      payorRef.current?.focus();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void issue(true);
    }
  };

  return (
    <Modal
      open
      wide
      title="Issue official receipt"
      onClose={onClose}
      footer={
        <>
          <p className="mr-auto text-xs text-slate-600">Ctrl+Enter issues and moves to the next OR.</p>
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          <button type="button" className="btn-secondary" disabled={!valid || busy} onClick={() => void issue(false)}>Issue &amp; close</button>
          <button type="button" className="btn-primary" disabled={!valid || busy} onClick={() => void issue(true)}>{busy ? 'Issuing…' : 'Issue & next'}</button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void issue(true); }} onKeyDown={onKeyDown} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Collecting officer" required className="sm:col-span-2" hint={suggestion ? `Series ${suggestion.form.series} · ${suggestion.form.endingBalance} left` : officer ? 'No ACTIVE series with forms left for this officer.' : undefined}>
            {(p) => <OfficerSelect {...p} barangayId={barangayId} value={officer} onChange={(v) => { setOfficer(v); setOrNo(''); }} />}
          </Field>
          <Field label="OR no." required>{(p) => <input {...p} className="input font-mono" inputMode="numeric" value={orNo} onChange={(e) => setOrNo(e.target.value.replace(/\D/g, ''))} />}</Field>
          <Field label="Date" required>{(p) => <input {...p} type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Payor" required className="sm:col-span-2">{(p) => <input {...p} ref={payorRef} autoFocus className="input" value={payor.name} onChange={(e) => setPayor({ ...payor, name: e.target.value })} />}</Field>
          <Field label="Address">{(p) => <input {...p} className="input" value={payor.address ?? ''} onChange={(e) => setPayor({ ...payor, address: e.target.value })} />}</Field>
          <Field label="Payment">
            {(p) => (
              <select {...p} className="input" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            )}
          </Field>
        </div>
        {method === 'CHECK' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Drawee bank" required>{(p) => <input {...p} className="input" value={check.bank} onChange={(e) => setCheck({ ...check, bank: e.target.value })} />}</Field>
            <Field label="Check no." required>{(p) => <input {...p} className="input" value={check.checkNumber} onChange={(e) => setCheck({ ...check, checkNumber: e.target.value })} />}</Field>
            <Field label="Check date" required>{(p) => <input {...p} type="date" className="input" value={check.checkDate} onChange={(e) => setCheck({ ...check, checkDate: e.target.value })} />}</Field>
          </div>
        )}
        <OrLines lines={lines} onChange={setLines} />
        <button type="submit" className="sr-only">Issue and next</button>
      </form>
      {issued.length > 0 && (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p className="font-semibold text-emerald-900">Issued in this session: {issued.length} OR(s) · ₱{formatPesos(issued.reduce((t, x) => t + x.amount, 0) as Centavos, { dashZero: false })}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-emerald-900">
            {issued.slice(0, 5).map((x) => <li key={x.or}><span className="font-mono">{x.or}</span> · {x.payor} · ₱{formatPesos(x.amount as Centavos)}</li>)}
          </ul>
        </div>
      )}
      <p className="sr-only" aria-live="polite">Total {formatPesos(total as Centavos, { dashZero: false })}</p>
    </Modal>
  );
}

/** A pre-printed OR spoiled before use: recorded as CANCELLED so the series has no gap. */
function SpoiledOrModal({ onClose }: { onClose(): void }) {
  const { barangayId } = useBarangay();
  const { notify } = useToast();
  const series = useAfSeries().rows;
  const [officer, setOfficer] = useState<string | null>(readOfficer());
  const [orNo, setOrNo] = useState('');
  const [date, setDate] = useState(manilaToday());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const suggestion = nextOrFor(series, officer);
  if (!barangayId) return null;
  const valid = !!officer && /^\d{1,12}$/.test(orNo) && reason.trim().length >= 5;
  async function save() {
    setBusy(true);
    try {
      await collectionsApi.recordSpoiledReceipt({ barangayId: barangayId!, collectingOfficerId: officer!, officialReceiptNumber: orNo, date, reason: reason.trim() });
      notify(`OR ${orNo} recorded as cancelled.`, 'success');
      onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open title="Record a spoiled (cancelled) OR" onClose={onClose} footer={<><button type="button" className="btn-secondary" onClick={onClose}>Close</button><button type="button" className="btn-danger" disabled={!valid || busy} onClick={() => void save()}>Record as cancelled</button></>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-700">Use this for a pre-printed OR that was spoiled before it was issued. Keep the original and all copies; the number is reported as cancelled in the RAAF.</p>
        <Field label="Collecting officer" required>{(p) => <OfficerSelect {...p} barangayId={barangayId} value={officer} onChange={setOfficer} />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="OR no." required hint={suggestion ? `Next unused: ${suggestion.next}` : undefined}>{(p) => <input {...p} className="input font-mono" inputMode="numeric" value={orNo} onChange={(e) => setOrNo(e.target.value.replace(/\D/g, ''))} />}</Field>
          <Field label="Date" required>{(p) => <input {...p} type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        <Field label="Reason" required>{(p) => <textarea {...p} rows={2} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

/** View / correct an issued OR (not its number), cancel it, print. */
function OrEditor({ rec, onClose }: { rec: Or | null; onClose(): void }) {
  const { can } = useAuth();
  const coa = useChartOfAccounts();
  const [f, setF] = useState(() => ({
    collectionDate: rec?.collectionDate ?? manilaToday(),
    payor: (rec?.payor ?? emptyParty()) as PartyRef,
    paymentMethod: (rec?.paymentMethod ?? 'CASH') as PaymentMethod,
    checkDetails: rec?.checkDetails ?? null,
    lines: (rec?.lines ?? []).map((l) => ({ ...l })) as OrLineInput[],
  }));
  const { save, busy } = useSaveSource(COLLECTION_MODULE.key);
  if (!rec) return null;
  const editable = can('treasury.encode', rec.barangayId) && COLLECTION_MODULE.editableStatuses.includes(rec.status) && !rec.depositId;
  const valid = f.payor.name.trim().length >= 2 && linesValid(f.lines, (c) => !!coa?.get(c)?.requiresSubsidiaryLedger);
  return (
    <Modal
      open
      wide
      title={`Official receipt ${rec.officialReceiptNumber}`}
      onClose={onClose}
      footer={
        <>
          <ActionBar def={COLLECTION_MODULE} record={rec} onDone={onClose} />
          <span className="mr-auto" />
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void save(rec.barangayId, { ...f, fundId: rec.fundId || 'GF', payor: { ...f.payor, id: f.payor.id ?? null } }, rec.id)}>{busy ? 'Saving…' : 'Save corrections'}</button>}
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2"><OrStatus status={rec.status} />{rec.depositId && <span className="text-xs text-slate-600">On a deposit slip — edit or void the deposit to correct this OR.</span>}</div>
      <InfoGrid columns={4} items={[['Series', `${rec.accountableFormType} ${rec.accountableFormSeries}`], ['Collecting officer', rec.collectingOfficerName], ['Amount', <Money key="a" value={rec.amount} dashZero={false} />], ['Cancel reason', rec.cancelReason ?? null]]} />
      {rec.status !== 'CANCELLED' && (
        <fieldset disabled={!editable} className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Date" required>{(p) => <input {...p} type="date" className="input" value={f.collectionDate} onChange={(e) => setF({ ...f, collectionDate: e.target.value })} />}</Field>
            <Field label="Payor" required>{(p) => <input {...p} className="input" value={f.payor.name} onChange={(e) => setF({ ...f, payor: { ...f.payor, name: e.target.value } })} />}</Field>
            <Field label="Payment">
              {(p) => (
                <select {...p} className="input" value={f.paymentMethod} onChange={(e) => setF({ ...f, paymentMethod: e.target.value as PaymentMethod, checkDetails: e.target.value === 'CHECK' ? f.checkDetails ?? { bank: '', checkNumber: '', checkDate: f.collectionDate } : null })}>
                  {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              )}
            </Field>
          </div>
          {f.paymentMethod === 'CHECK' && f.checkDetails && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Drawee bank" required>{(p) => <input {...p} className="input" value={f.checkDetails!.bank} onChange={(e) => setF({ ...f, checkDetails: { ...f.checkDetails!, bank: e.target.value } })} />}</Field>
              <Field label="Check no." required>{(p) => <input {...p} className="input" value={f.checkDetails!.checkNumber} onChange={(e) => setF({ ...f, checkDetails: { ...f.checkDetails!, checkNumber: e.target.value } })} />}</Field>
              <Field label="Check date" required>{(p) => <input {...p} type="date" className="input" value={f.checkDetails!.checkDate} onChange={(e) => setF({ ...f, checkDetails: { ...f.checkDetails!, checkDate: e.target.value } })} />}</Field>
            </div>
          )}
          <OrLines lines={f.lines} onChange={(lines) => setF({ ...f, lines })} disabled={!editable} />
        </fieldset>
      )}
      <WorkflowTrail barangayId={rec.barangayId} recordId={rec.id} />
    </Modal>
  );
}
