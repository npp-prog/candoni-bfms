import { BANK_MEMO_MODULE, MEMO_CATEGORIES, defaultMemoAccount, lastDayOfMonth, periodKey, type BankMemoRecord, type Centavos, type MemoCategory, type WithId } from '@bfms/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AccountInput, InfoGrid, MoneyInput } from '../../components/forms';
import { RegisterTable, StatusFilter } from '../../components/register';
import { ActionBar, WorkflowTrail, reportHref, statusOptions, useSaveSource } from '../../components/source';
import { Field, Icon, Modal, Money, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useCollection } from '../../hooks/useCollection';
import type { BankPeriod } from './BankPage';

type Memo = WithId<BankMemoRecord>;

/** Bank debit / credit memos (RBDCM): register, entry, and "Generate JEV" (draft JCT). */
export function MemosTab({ period }: { period: BankPeriod }) {
  const { can } = useAuth();
  const { bank, month, fiscalYear } = period;
  const [status, setStatus] = useState('');
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const { rows, loading } = useCollection<BankMemoRecord>('bankMemos', [['barangayId', '==', bank.barangayId], ['bankAccountId', '==', bank.id]]);
  const key = periodKey(fiscalYear, month);
  const list = rows
    .filter((r) => r.fiscalYear === fiscalYear && (all || r.accountingPeriod === key) && (!status || (status === 'POSTED' ? !!r.jevNumber : r.status === status)))
    .sort((a, b) => b.memoDate.localeCompare(a.memoDate) || (b.memoNumber ?? '').localeCompare(a.memoNumber ?? ''));
  const total = (t: 'DEBIT' | 'CREDIT') => list.filter((m) => m.memoType === t && m.status !== 'VOID').reduce((s, m) => s + m.amount, 0);
  return (
    <>
      <RegisterTable
        caption={`Bank memos ${all ? `FY ${fiscalYear}` : key}`}
        rows={list}
        loading={loading}
        onOpen={(r) => setOpen(r.id)}
        toolbar={
          <>
            <StatusFilter value={status} onChange={setStatus} options={statusOptions(BANK_MEMO_MODULE)} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Whole year</label>
            <div className="ml-auto flex gap-2">
              <Link className="btn-secondary" to={reportHref('RBDCM', { fiscalYear, month })}><Icon name="file" /> RBDCM</Link>
              {can('recon.prepare', bank.barangayId) && <button type="button" className="btn-primary" onClick={() => setOpen('new')}><Icon name="plus" /> New memo</button>}
            </div>
          </>
        }
        empty={`No bank memos for ${all ? `FY ${fiscalYear}` : key}. Memos are also recorded from the reconciliation workspace.`}
        columns={[
          { label: 'Memo no.', render: (r) => r.memoNumber ?? <span className="text-slate-500">draft</span> },
          { label: 'Date', render: (r) => r.memoDate },
          { label: 'Type', render: (r) => (r.memoType === 'DEBIT' ? 'Debit' : 'Credit') },
          { label: 'Particulars', className: 'max-w-sm truncate', render: (r) => r.particulars },
          { label: 'Account', render: (r) => <span className="font-mono text-xs">{r.classificationAccountCode ?? '—'}</span> },
          { label: 'Amount', numeric: true, render: (r) => <Money value={r.amount} /> },
          { label: 'JEV', render: (r) => (r.jevNumber ? <span className="font-mono text-xs">{r.jevNumber}</span> : r.jevId ? <span className="text-xs text-amber-800">draft JEV</span> : '—') },
          { label: 'Status', render: (r) => <StatusChip status={r.jevNumber ? 'POSTED' : r.status} /> },
        ]}
        footer={<div className="border-t border-slate-200 px-4 py-2 text-right text-sm">Debit memos <strong className="tabular-nums"><Money value={total('DEBIT')} dashZero={false} /></strong> · Credit memos <strong className="tabular-nums"><Money value={total('CREDIT')} dashZero={false} /></strong></div>}
      />
      {open && <MemoEditor id={open === 'new' ? null : open} rows={rows} period={period} onClose={() => setOpen(null)} />}
    </>
  );
}

function MemoEditor({ id, rows, period, onClose }: { id: string | null; rows: Memo[]; period: BankPeriod; onClose(): void }) {
  const { can } = useAuth();
  const { bank, month, fiscalYear } = period;
  const [currentId, setCurrentId] = useState(id);
  const rec = currentId ? rows.find((r) => r.id === currentId) ?? null : null;
  const [f, setF] = useState({
    memoType: rec?.memoType ?? ('DEBIT' as 'DEBIT' | 'CREDIT'),
    category: rec?.category ?? ('BANK_CHARGES' as MemoCategory),
    memoDate: rec?.memoDate ?? lastDayOfMonth(fiscalYear, month),
    bankReference: rec?.bankReference ?? '',
    particulars: rec?.particulars ?? '',
    amount: (rec?.amount ?? 0) as Centavos | null,
    classificationAccountCode: rec?.classificationAccountCode ?? defaultMemoAccount('DEBIT', 'BANK_CHARGES') ?? '',
  });
  const { save, busy } = useSaveSource(BANK_MEMO_MODULE.key);
  const editable = can('recon.prepare', bank.barangayId) && (!rec || BANK_MEMO_MODULE.editableStatuses.includes(rec.status));
  const accounting = can('jev.prepare', bank.barangayId);
  const categories = MEMO_CATEGORIES.filter((c) => c.value === 'OTHER' || (c.value === 'BANK_CHARGES') === (f.memoType === 'DEBIT'));
  const valid = f.particulars.trim().length >= 3 && (f.amount ?? 0) > 0 && (!f.classificationAccountCode || /^\d-\d{2}-\d{2}-\d{3}$/.test(f.classificationAccountCode));
  const setType = (memoType: 'DEBIT' | 'CREDIT') => {
    const category: MemoCategory = memoType === 'DEBIT' ? 'BANK_CHARGES' : 'INTEREST_INCOME';
    setF({ ...f, memoType, category, classificationAccountCode: defaultMemoAccount(memoType, category) ?? '' });
  };

  async function onSave() {
    const newId = await save(bank.barangayId, {
      bankAccountId: bank.id,
      memoType: f.memoType,
      category: f.category,
      memoDate: f.memoDate,
      bankReference: f.bankReference,
      particulars: f.particulars,
      amount: f.amount ?? 0,
      classificationAccountCode: f.classificationAccountCode || null,
      statementId: rec?.statementId ?? null,
      statementLineId: rec?.statementLineId ?? null,
    }, currentId ?? undefined);
    if (newId) setCurrentId(newId);
  }

  return (
    <Modal
      open
      wide
      title={rec?.memoNumber ? `Bank memo ${rec.memoNumber}` : rec ? 'Bank memo (draft)' : 'New bank memo'}
      onClose={onClose}
      footer={
        <>
          {rec && <ActionBar def={BANK_MEMO_MODULE} record={rec} />}
          <span className="mr-auto" />
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {editable && <button type="button" className="btn-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? 'Saving…' : 'Save draft'}</button>}
        </>
      }
    >
      {rec && <div className="mb-3 flex items-center gap-2"><StatusChip status={rec.jevNumber ? 'POSTED' : rec.status} />{rec.memoNumber && <span className="font-mono text-sm">{rec.memoNumber}</span>}</div>}
      <fieldset disabled={!editable} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Memo type" required>
            {(p) => (
              <select {...p} className="input" value={f.memoType} onChange={(e) => setType(e.target.value as 'DEBIT' | 'CREDIT')}>
                <option value="DEBIT">Debit memo (bank deducted)</option>
                <option value="CREDIT">Credit memo (bank added)</option>
              </select>
            )}
          </Field>
          <Field label="Nature" required>
            {(p) => (
              <select {...p} className="input" value={f.category} onChange={(e) => { const category = e.target.value as MemoCategory; setF({ ...f, category, classificationAccountCode: defaultMemoAccount(f.memoType, category) ?? f.classificationAccountCode }); }}>
                {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Date" required>{(p) => <input {...p} type="date" className="input" value={f.memoDate} onChange={(e) => setF({ ...f, memoDate: e.target.value })} />}</Field>
          <Field label="Bank reference">{(p) => <input {...p} className="input" value={f.bankReference} onChange={(e) => setF({ ...f, bankReference: e.target.value })} />}</Field>
        </div>
        <Field label="Particulars" required>{(p) => <textarea {...p} rows={2} className="input" value={f.particulars} onChange={(e) => setF({ ...f, particulars: e.target.value })} />}</Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Amount" required>{(p) => <MoneyInput {...p} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} allowZero={false} />}</Field>
          <Field label="Classification account" className="sm:col-span-2" hint={accounting ? (f.memoType === 'DEBIT' ? 'Debited; Cash in Bank is credited.' : 'Credited; Cash in Bank is debited.') : 'Set by Municipal Accounting before the JEV is generated.'}>
            {(p) => <AccountInput {...p} disabled={!accounting || !editable} value={f.classificationAccountCode} prefixes={f.memoType === 'DEBIT' ? ['5-', '1-', '2-'] : ['4-', '1-', '2-']} onChange={(v) => setF({ ...f, classificationAccountCode: v })} />}
          </Field>
        </div>
      </fieldset>
      {rec && (
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <InfoGrid items={[['Bank', `${bank.bankName} ${bank.accountNumber}`], ['JEV', rec.jevNumber ?? (rec.jevId ? 'Draft — awaiting approval and posting' : 'Not generated')], ['From statement line', rec.statementLineId ? 'Yes' : 'No']]} />
        </div>
      )}
      {rec && <WorkflowTrail barangayId={rec.barangayId} recordId={rec.id} />}
    </Modal>
  );
}
