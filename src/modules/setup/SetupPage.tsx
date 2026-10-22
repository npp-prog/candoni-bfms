import { manilaToday, type BankAccountDoc, type OfficeDoc, type SignatoryDoc, type SignatoryRole, type SubsidiaryAccountDoc, type SubsidiaryType, type WithId } from '@bfms/shared';
import { useState, type FormEvent } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AccountInput, maskAccount } from '../../components/forms';
import { ModuleTabs, RegisterTable } from '../../components/register';
import { Field, Icon, Modal, PageHeader, StatusChip } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { useCollection } from '../../hooks/useCollection';
import { api, errorMessage } from '../../services/functions/api';

/** Barangay masters every module depends on (officials, bank accounts, subsidiary ledgers, offices). */
export function SetupPage() {
  const { barangayLabel } = useBarangay();
  return (
    <>
      <PageHeader title="Barangay Setup" subtitle={barangayLabel} breadcrumbs={['BFMS', 'Setup']} />
      <ModuleTabs
        label="Setup sections"
        tabs={[
          { to: '/setup/signatories', label: 'Officials & signatories' },
          { to: '/setup/bank-accounts', label: 'Bank accounts' },
          { to: '/setup/subsidiary-ledgers', label: 'Subsidiary ledgers' },
          { to: '/setup/offices', label: 'Offices' },
        ]}
      />
      <Routes>
        <Route index element={<Navigate to="signatories" replace />} />
        <Route path="signatories" element={<SignatoriesTab />} />
        <Route path="bank-accounts" element={<BankAccountsTab />} />
        <Route path="subsidiary-ledgers" element={<SubsidiaryTab />} />
        <Route path="offices" element={<OfficesTab />} />
      </Routes>
    </>
  );
}

function useRun() {
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>, ok: string): Promise<boolean> {
    setBusy(true);
    try {
      await fn();
      notify(ok, 'success');
      return true;
    } catch (e) {
      notify(errorMessage(e), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { run, busy };
}

const ROLES: Array<{ value: SignatoryRole; label: string }> = [
  { value: 'PUNONG_BARANGAY', label: 'Punong Barangay' },
  { value: 'BARANGAY_TREASURER', label: 'Barangay Treasurer' },
  { value: 'BARANGAY_SECRETARY', label: 'Barangay Secretary' },
  { value: 'APPROPRIATIONS_CHAIR', label: 'Chairperson, Committee on Appropriations' },
  { value: 'PROPERTY_OFFICER', label: 'Property / Inventory Officer' },
  { value: 'MUNICIPAL_ACCOUNTANT', label: 'Municipal Accountant' },
  { value: 'COA_AUDITOR', label: 'COA Auditor' },
];

function SignatoriesTab() {
  const { barangayId } = useBarangay();
  const { can } = useAuth();
  const { rows, loading } = useCollection<SignatoryDoc>('signatories', barangayId ? [['barangayId', '==', barangayId]] : null);
  const municipal = useCollection<SignatoryDoc>('signatories', [['barangayId', '==', 'MUNICIPAL']]).rows;
  const [edit, setEdit] = useState<WithId<SignatoryDoc> | 'new' | null>(null);
  if (!barangayId) return null;
  const all = [...rows, ...municipal].sort((a, b) => a.role.localeCompare(b.role) || b.validFrom.localeCompare(a.validFrom));
  return (
    <>
      <p className="mb-3 max-w-prose text-sm text-slate-600">Reports print the official holding each role <strong>on the report date</strong>, so add a new term when an official changes instead of editing the old one.</p>
      <RegisterTable
        caption="Signatories"
        rows={all}
        loading={loading}
        onOpen={(r) => (r.barangayId === 'MUNICIPAL' && !can('admin.config.manage', 'ALL') ? undefined : setEdit(r))}
        toolbar={<div className="ml-auto"><button type="button" className="btn-primary" onClick={() => setEdit('new')}><Icon name="plus" /> Add official</button></div>}
        empty="No officials recorded yet. Add the Punong Barangay, Treasurer and Committee on Appropriations chair."
        columns={[
          { label: 'Name', render: (r) => r.name },
          { label: 'Role', render: (r) => ROLES.find((x) => x.value === r.role)?.label ?? r.role },
          { label: 'Position (as printed)', render: (r) => r.position },
          { label: 'Term', render: (r) => `${r.validFrom} – ${r.validTo ?? 'present'}` },
          { label: 'Scope', render: (r) => (r.barangayId === 'MUNICIPAL' ? 'Municipal' : 'Barangay') },
          { label: 'Status', render: (r) => <StatusChip status={r.active ? 'ACTIVE' : 'CLOSED'} /> },
        ]}
      />
      {edit && <SignatoryEditor rec={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function SignatoryEditor({ rec, onClose }: { rec: WithId<SignatoryDoc> | null; onClose(): void }) {
  const { barangayId } = useBarangay();
  const { can } = useAuth();
  const { run, busy } = useRun();
  const [f, setF] = useState({
    scope: (rec?.barangayId === 'MUNICIPAL' ? 'MUNICIPAL' : 'BARANGAY') as 'MUNICIPAL' | 'BARANGAY',
    role: rec?.role ?? ('PUNONG_BARANGAY' as SignatoryRole),
    name: rec?.name ?? '',
    position: rec?.position ?? '',
    validFrom: rec?.validFrom ?? manilaToday(),
    validTo: rec?.validTo ?? '',
    active: rec?.active ?? true,
  });
  if (!barangayId) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(
      () => api.saveSignatory({ id: rec?.id, barangayId: f.scope === 'MUNICIPAL' ? 'MUNICIPAL' : barangayId, role: f.role, name: f.name, position: f.position || (ROLES.find((r) => r.value === f.role)?.label ?? ''), validFrom: f.validFrom, validTo: f.validTo || null, active: f.active }),
      'Official saved.',
    );
    if (ok) onClose();
  };
  return (
    <Modal open title={rec ? 'Edit official' : 'Add official'} onClose={onClose} footer={<><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="submit" form="sig-form" className="btn-primary" disabled={busy || f.name.trim().length < 3}>Save</button></>}>
      <form id="sig-form" className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <Field label="Role" required>
          {(p) => (
            <select {...p} className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as SignatoryRole, scope: ['MUNICIPAL_ACCOUNTANT', 'COA_AUDITOR'].includes(e.target.value) ? 'MUNICIPAL' : 'BARANGAY' })}>
              {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Applies to">
          {(p) => (
            <select {...p} className="input" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as 'MUNICIPAL' | 'BARANGAY' })}>
              <option value="BARANGAY">This barangay</option>
              {can('admin.config.manage', 'ALL') && <option value="MUNICIPAL">All barangays (municipal official)</option>}
            </select>
          )}
        </Field>
        <Field label="Full name (as printed)" required className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. JUAN D. DELA CRUZ" />}</Field>
        <Field label="Position (as printed)" className="sm:col-span-2" hint="Leave blank to use the role name.">{(p) => <input {...p} className="input" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} />}</Field>
        <Field label="Term starts" required>{(p) => <input {...p} type="date" className="input" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} />}</Field>
        <Field label="Term ends" hint="Blank = still in office.">{(p) => <input {...p} type="date" className="input" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} />}</Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-navy-700" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
      </form>
    </Modal>
  );
}

function BankAccountsTab() {
  const { barangayId } = useBarangay();
  const { rows, loading } = useCollection<BankAccountDoc & { subsidiaryCode?: string }>('bankAccounts', barangayId ? [['barangayId', '==', barangayId]] : null);
  const [edit, setEdit] = useState<WithId<BankAccountDoc & { subsidiaryCode?: string }> | 'new' | null>(null);
  if (!barangayId) return null;
  return (
    <>
      <RegisterTable
        caption="Bank accounts"
        rows={rows}
        loading={loading}
        onOpen={(r) => setEdit(r)}
        toolbar={<div className="ml-auto"><button type="button" className="btn-primary" onClick={() => setEdit('new')}><Icon name="plus" /> Add bank account</button></div>}
        empty="No bank accounts yet. Add the barangay's depository account; its Cash in Bank ledger (CIB01) is created with it."
        columns={[
          { label: 'Bank', render: (r) => `${r.bankName}${r.branch ? ` — ${r.branch}` : ''}` },
          { label: 'Account name', render: (r) => r.accountName },
          { label: 'Account no.', render: (r) => <span className="font-mono">{maskAccount(r.accountNumber)}</span> },
          { label: 'Type', render: (r) => r.accountType },
          { label: 'Ledger', render: (r) => <span className="font-mono text-xs">{r.subsidiaryCode ?? r.subsidiaryId}</span> },
          { label: 'Status', render: (r) => <StatusChip status={r.active ? 'ACTIVE' : 'CLOSED'} /> },
        ]}
      />
      {edit && <BankEditor rec={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function BankEditor({ rec, onClose }: { rec: WithId<BankAccountDoc & { subsidiaryCode?: string }> | null; onClose(): void }) {
  const { barangayId } = useBarangay();
  const { run, busy } = useRun();
  const [f, setF] = useState({
    bankName: rec?.bankName ?? 'Land Bank of the Philippines',
    branch: rec?.branch ?? '',
    accountName: rec?.accountName ?? '',
    accountNumber: rec?.accountNumber ?? '',
    accountType: rec?.accountType ?? ('CURRENT' as BankAccountDoc['accountType']),
    subsidiaryCode: rec?.subsidiaryCode ?? 'CIB01',
    active: rec?.active ?? true,
  });
  if (!barangayId) return null;
  return (
    <Modal open title={rec ? 'Edit bank account' : 'Add bank account'} onClose={onClose} footer={<><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={busy || !f.accountName || f.accountNumber.length < 4} onClick={() => void run(() => api.saveBankAccount({ id: rec?.id, barangayId, fundId: 'GF', ...f }), 'Bank account saved.').then((ok) => ok && onClose())}>Save</button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bank" required>{(p) => <input {...p} className="input" value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} />}</Field>
        <Field label="Branch">{(p) => <input {...p} className="input" value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })} />}</Field>
        <Field label="Account name" required className="sm:col-span-2">{(p) => <input {...p} className="input" value={f.accountName} onChange={(e) => setF({ ...f, accountName: e.target.value })} placeholder="e.g. AGBOY BRGY COUNCIL-CANDONI" />}</Field>
        <Field label="Account number" required>{(p) => <input {...p} className="input font-mono" value={f.accountNumber} onChange={(e) => setF({ ...f, accountNumber: e.target.value })} />}</Field>
        <Field label="Type">
          {(p) => (
            <select {...p} className="input" value={f.accountType} onChange={(e) => setF({ ...f, accountType: e.target.value as typeof f.accountType })}>
              <option value="CURRENT">Current</option>
              <option value="SAVINGS">Savings</option>
              <option value="TIME_DEPOSIT">Time deposit</option>
            </select>
          )}
        </Field>
        <Field label="Ledger code" required hint="Subsidiary of 1-01-02-010 Cash in Bank, e.g. CIB01.">{(p) => <input {...p} className="input font-mono" disabled={!!rec} value={f.subsidiaryCode} onChange={(e) => setF({ ...f, subsidiaryCode: e.target.value.toUpperCase() })} />}</Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-navy-700" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
      </div>
    </Modal>
  );
}

const SL_TYPES: Array<{ value: SubsidiaryType; label: string; account: string; hint: string }> = [
  { value: 'ACCOUNTABLE_OFFICER', label: 'Collecting officer (Cash – Local Treasury)', account: '1-01-01-010', hint: 'BT01' },
  { value: 'CASH_ADVANCE', label: 'Cash advance – payroll (Advances for Payroll)', account: '1-03-03-010', hint: 'AO01' },
  { value: 'EMPLOYEE', label: 'Cash advance – officers/employees', account: '1-03-03-020', hint: 'EO01' },
  { value: 'ACCOUNTABLE_OFFICER', label: 'Petty cash custodian (Petty Cash)', account: '1-01-01-020', hint: 'PC01' },
  { value: 'BIR', label: 'BIR (Due to BIR)', account: '2-02-01-010', hint: 'BIR01' },
  { value: 'SUPPLIER', label: 'Supplier / creditor (Accounts Payable)', account: '2-01-01-010', hint: 'AP01' },
  { value: 'OTHER', label: 'Other (any account)', account: '', hint: '' },
];

function SubsidiaryTab() {
  const { barangayId } = useBarangay();
  const { rows, loading } = useCollection<SubsidiaryAccountDoc>('subsidiaryAccounts', barangayId ? [['barangayId', '==', barangayId]] : null);
  const [open, setOpen] = useState(false);
  if (!barangayId) return null;
  return (
    <>
      <p className="mb-3 max-w-prose text-sm text-slate-600">Subsidiary ledgers keep the legacy codes (BT01, CIB01, AO02, EO05, BIR01). Collections need a collecting officer (BT##), cash advances need an AO/EO ledger for the accountable officer.</p>
      <RegisterTable
        caption="Subsidiary ledgers"
        rows={[...rows].sort((a, b) => a.accountCode.localeCompare(b.accountCode) || a.subsidiaryCode.localeCompare(b.subsidiaryCode))}
        loading={loading}
        toolbar={<div className="ml-auto"><button type="button" className="btn-primary" onClick={() => setOpen(true)}><Icon name="plus" /> Add ledger</button></div>}
        empty="No subsidiary ledgers yet."
        columns={[
          { label: 'Code', render: (r) => <span className="font-mono">{r.subsidiaryCode}</span> },
          { label: 'Name', render: (r) => r.subsidiaryName },
          { label: 'Controlling account', render: (r) => <span className="font-mono text-xs">{r.accountCode}</span> },
          { label: 'Type', render: (r) => r.type.replace(/_/g, ' ').toLowerCase() },
          { label: 'Status', render: (r) => <StatusChip status={r.active ? 'ACTIVE' : 'CLOSED'} /> },
        ]}
      />
      {open && <SubsidiaryEditor onClose={() => setOpen(false)} />}
    </>
  );
}

function SubsidiaryEditor({ onClose }: { onClose(): void }) {
  const { barangayId } = useBarangay();
  const { run, busy } = useRun();
  const [kind, setKind] = useState(0);
  const preset = SL_TYPES[kind]!;
  const [f, setF] = useState({ accountCode: preset.account, subsidiaryCode: preset.hint, subsidiaryName: '' });
  if (!barangayId) return null;
  return (
    <Modal open title="Add subsidiary ledger" onClose={onClose} footer={<><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={busy || !f.subsidiaryName || !f.subsidiaryCode || !f.accountCode} onClick={() => void run(() => api.saveSubsidiaryAccount({ barangayId, accountCode: f.accountCode, subsidiaryCode: f.subsidiaryCode, subsidiaryName: f.subsidiaryName, type: preset.value, active: true }), 'Ledger saved.').then((ok) => ok && onClose())}>Save</button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind" className="sm:col-span-2">
          {(p) => (
            <select {...p} className="input" value={kind} onChange={(e) => { const k = Number(e.target.value); setKind(k); setF({ ...f, accountCode: SL_TYPES[k]!.account, subsidiaryCode: SL_TYPES[k]!.hint }); }}>
              {SL_TYPES.map((t, i) => <option key={i} value={i}>{t.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Controlling account" required>{(p) => <AccountInput {...p} value={f.accountCode} onChange={(v) => setF({ ...f, accountCode: v })} />}</Field>
        <Field label="Ledger code" required>{(p) => <input {...p} className="input font-mono" value={f.subsidiaryCode} onChange={(e) => setF({ ...f, subsidiaryCode: e.target.value.toUpperCase() })} />}</Field>
        <Field label="Name" required className="sm:col-span-2" hint="Person, bank or agency, as it should appear on ledgers.">{(p) => <input {...p} className="input" value={f.subsidiaryName} onChange={(e) => setF({ ...f, subsidiaryName: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}

function OfficesTab() {
  const { barangayId } = useBarangay();
  const { rows, loading } = useCollection<OfficeDoc>('offices', barangayId ? [['barangayId', '==', barangayId]] : null);
  const { run, busy } = useRun();
  const [f, setF] = useState({ officeCode: '', officeName: '' });
  if (!barangayId) return null;
  return (
    <div className="space-y-4">
      <form className="card flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => { e.preventDefault(); void run(() => api.saveOffice({ barangayId, ...f, active: true }), 'Office saved.').then((ok) => ok && setF({ officeCode: '', officeName: '' })); }}>
        <Field label="Code" required>{(p) => <input {...p} className="input font-mono" value={f.officeCode} onChange={(e) => setF({ ...f, officeCode: e.target.value.toUpperCase() })} />}</Field>
        <Field label="Office / committee" required className="min-w-[16rem] flex-1">{(p) => <input {...p} className="input" value={f.officeName} onChange={(e) => setF({ ...f, officeName: e.target.value })} />}</Field>
        <button type="submit" className="btn-primary mb-5" disabled={busy || !f.officeCode || !f.officeName}>Add office</button>
      </form>
      <RegisterTable caption="Offices" rows={rows} loading={loading} empty="No offices yet." columns={[{ label: 'Code', render: (r) => <span className="font-mono">{r.officeCode}</span> }, { label: 'Name', render: (r) => r.officeName }]} />
    </div>
  );
}
