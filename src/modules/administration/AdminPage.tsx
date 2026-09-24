import { COA_REVIEW_NOTES } from '@bfms/shared';
import { useState } from 'react';
import { PageHeader } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { api, errorMessage } from '../../services/functions/api';
import { CoaPanel } from './CoaPanel';
import { PeriodsPanel } from './PeriodsPanel';
import { UsersPanel } from './UsersPanel';

const TABS = ['Users & roles', 'Fiscal years & periods', 'Chart of Accounts', 'System'] as const;

export function AdminPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Fiscal years & periods');
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Administration" breadcrumbs={['BFMS', 'Administration']} />
      <div role="tablist" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.filter((t) => t !== 'Users & roles' || can('admin.users.manage', 'ALL')).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-4 py-2 text-sm ${tab === t ? 'border-gold-500 font-semibold text-navy-800' : 'border-transparent text-slate-600 hover:text-navy-700'}`}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'Users & roles' && <UsersPanel />}
      {tab === 'Fiscal years & periods' && <PeriodsPanel />}
      {tab === 'Chart of Accounts' && <CoaPanel />}
      {tab === 'System' && <SystemPanel />}
    </>
  );
}

function SystemPanel() {
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  return (
    <div className="card p-4">
      <h2 className="font-serif font-bold text-navy-800">Reference data</h2>
      <p className="mt-1 text-sm text-slate-600">
        Seeds the nine barangays, roles, the 274-account Chart of Accounts, the report catalog (50 prescribed forms and the supplementary schedules), compliance requirements and settings. It only creates documents that are missing and never overwrites the Chart of Accounts.
      </p>
      <button className="btn-primary mt-3" disabled={busy} onClick={async () => { setBusy(true); try { const r = await api.seedReferenceData({}); setResult(r.created); notify('Reference data seeded.', 'success'); } catch (e) { notify(errorMessage(e), 'error'); } finally { setBusy(false); } }}>
        {busy ? 'Seeding…' : 'Seed / verify reference data'}
      </button>
      {result && <pre className="mt-3 rounded bg-slate-50 p-3 text-xs">{JSON.stringify(result, null, 2)}</pre>}
      <h3 className="mt-6 font-semibold text-navy-800">Chart of Accounts items for Municipal Accountant review</h3>
      <ul className="mt-2 list-disc pl-5 text-sm text-slate-700">
        {COA_REVIEW_NOTES.map((n) => <li key={n.code}><code>{n.code}</code> {n.name}: {n.note}</li>)}
      </ul>
    </div>
  );
}
