import { COA_REVIEW_NOTES } from '@bfms/shared';
import { useState } from 'react';
import { PageHeader, Tabs } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useDocument } from '../../hooks/useDocument';
import { api, errorMessage } from '../../services/functions/api';
import { CoaPanel } from './CoaPanel';
import { PeriodsPanel } from './PeriodsPanel';
import { UsersPanel } from './UsersPanel';

const TABS = ['Users & roles', 'Fiscal years & periods', 'Chart of Accounts', 'System'] as const;

export function AdminPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Fiscal years & periods');
  const { can } = useAuth();
  const visible = TABS.filter((t) => t !== 'Users & roles' || can('admin.users.manage', 'ALL'));
  return (
    <>
      <PageHeader title="Administration" breadcrumbs={['BFMS', 'Administration']} />
      <Tabs<(typeof TABS)[number]> tabs={visible} value={tab} onChange={setTab} label="Administration sections" idPrefix="admin" />
      <div id="admin-panel" role="tabpanel" aria-labelledby={`admin-tab-${visible.indexOf(tab)}`}>
        {tab === 'Users & roles' && <UsersPanel />}
        {tab === 'Fiscal years & periods' && <PeriodsPanel />}
        {tab === 'Chart of Accounts' && <CoaPanel />}
        {tab === 'System' && <SystemPanel />}
      </div>
    </>
  );
}

function SystemPanel() {
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  return (
    <div className="card p-4">
      <h2 className="card-title">Reference data</h2>
      <p className="mt-1 text-sm text-slate-600">
        Seeds the nine barangays, roles, the 274-account Chart of Accounts, the report catalog (50 prescribed forms and the supplementary schedules), compliance requirements and settings. It only creates documents that are missing and never overwrites the Chart of Accounts.
      </p>
      <button className="btn-primary mt-3" disabled={busy} onClick={async () => { setBusy(true); try { const r = await api.seedReferenceData({}); setResult(r.created); notify('Reference data seeded.', 'success'); } catch (e) { notify(errorMessage(e), 'error'); } finally { setBusy(false); } }}>
        {busy ? 'Seeding…' : 'Seed / verify reference data'}
      </button>
      {result && <pre className="mt-3 rounded bg-slate-50 p-3 text-xs">{JSON.stringify(result, null, 2)}</pre>}
      <SelfPostSetting />
      <h3 className="mt-6 font-semibold text-navy-800">Chart of Accounts items for Municipal Accountant review</h3>
      <ul className="mt-2 list-disc pl-5 text-sm text-slate-700">
        {COA_REVIEW_NOTES.map((n) => <li key={n.code}><code>{n.code}</code> {n.name}: {n.note}</li>)}
      </ul>
    </div>
  );
}

/** Self-posting switch (segregation of duties); audited server-side with the stated reason. */
function SelfPostSetting() {
  const { can } = useAuth();
  const { notify } = useToast();
  const settings = useDocument<{ allowSelfPost?: boolean }>('systemSettings', 'global').data;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const on = settings?.allowSelfPost === true;
  if (!can('admin.config.manage', 'ALL')) return null;
  return (
    <div className="mt-6 border-t border-slate-200 pt-4">
      <h3 className="font-semibold text-navy-800">Posting by the encoder</h3>
      <p className="mt-1 max-w-prose text-sm text-slate-600">
        {on ? 'Self-posting is ON: the person who encoded an entry may also post it.' : 'Self-posting is OFF: another accounting user must post what someone encoded (recommended).'} Turn it on only where one person keeps the books alone.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-[18rem] flex-1">
          <label className="label" htmlFor="sp-reason">Reason for the change</label>
          <input id="sp-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Only one accounting staff assigned to these barangays" />
        </div>
        <button
          type="button"
          className={on ? 'btn-secondary' : 'btn-danger'}
          disabled={busy || reason.trim().length < 10}
          onClick={async () => {
            setBusy(true);
            try {
              await api.setAllowSelfPost({ allow: !on, reason });
              notify(`Self-posting turned ${on ? 'off' : 'on'}.`, 'success');
              setReason('');
            } catch (e) {
              notify(errorMessage(e), 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          {on ? 'Turn self-posting off' : 'Allow self-posting'}
        </button>
      </div>
    </div>
  );
}
