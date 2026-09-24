import {
  BARANGAY_IDS,
  ROLE_CODES,
  ROLES,
  isRoleAllowedAtScope,
  type BarangayScope,
  type RoleCode,
  type UserAssignmentDoc,
  type UserDoc,
} from '@bfms/shared';
import { sendPasswordResetEmail } from 'firebase/auth';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState, Modal, Pager, Spinner, StatusChip } from '../../components/ui';
import { useToast } from '../../contexts/ToastContext';
import { usePaginatedQuery } from '../../hooks/usePaginatedQuery';
import { auth, db } from '../../services/firebase/app';
import { api, errorMessage } from '../../services/functions/api';

export function UsersPanel() {
  const { notify } = useToast();
  const base = useMemo(() => query(collection(db, 'users'), orderBy('displayName')), []);
  const page = usePaginatedQuery<UserDoc>(base, 25);
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState<(UserDoc & { id: string }) | null>(null);

  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="font-serif font-bold text-navy-800">Users</h2>
        <button className="btn-primary" onClick={() => setCreating(true)}>New user</button>
      </div>
      {page.loading && <Spinner />}
      {!page.loading && page.rows.length === 0 && <div className="p-4"><EmptyState title="No users yet" /></div>}
      {page.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>Name</th><th>Email</th><th>Position</th><th>Status</th><th /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {page.rows.map((u) => (
                <tr key={u.id}>
                  <td className="font-medium">{u.displayName}</td>
                  <td>{u.email}</td>
                  <td>{u.position}</td>
                  <td><StatusChip status={u.active ? 'OPEN' : 'CLOSED'} /></td>
                  <td className="text-right"><button className="btn-ghost px-2 py-1" onClick={() => setAssigning(u)}>Roles…</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page.page} hasPrev={page.hasPrev} hasNext={page.hasNext} onPrev={() => void page.prev()} onNext={() => void page.next()} loading={page.loading} />
      <CreateUserModal open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void page.reload(); notify('User created. A password-setup email was sent.', 'success'); }} />
      {assigning && <AssignRolesModal user={assigning} onClose={() => setAssigning(null)} />}
    </div>
  );
}

function CreateUserModal({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(): void }) {
  const { notify } = useToast();
  const [f, setF] = useState({ email: '', displayName: '', position: '' });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.createUserAccount({ ...f, defaultBarangayId: null });
      await sendPasswordResetEmail(auth, f.email);
      setF({ email: '', displayName: '', position: '' });
      onCreated();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} title="New user" onClose={onClose} footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !f.email || f.displayName.length < 3} onClick={() => void save()}>{busy ? 'Creating…' : 'Create'}</button></>}>
      <div className="space-y-3">
        {(['displayName', 'email', 'position'] as const).map((k) => (
          <div key={k}>
            <label className="label" htmlFor={`u-${k}`}>{k === 'displayName' ? 'Full name' : k}</label>
            <input id={`u-${k}`} className="input" type={k === 'email' ? 'email' : 'text'} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </div>
        ))}
        <p className="text-xs text-slate-500">No password is set here. The user receives an email to create their own password.</p>
      </div>
    </Modal>
  );
}

function AssignRolesModal({ user, onClose }: { user: UserDoc & { id: string }; onClose(): void }) {
  const { notify } = useToast();
  const [scope, setScope] = useState<BarangayScope>('AGBOY');
  const [roles, setRoles] = useState<RoleCode[]>([]);
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<Array<UserAssignmentDoc & { id: string }> | null>(null);

  useEffect(() => {
    void getDocs(query(collection(db, 'userAssignments'), where('uid', '==', user.id), where('active', '==', true))).then((s) =>
      setCurrent(s.docs.map((d) => ({ id: d.id, ...(d.data() as UserAssignmentDoc) }))),
    );
  }, [user.id]);

  const allowed = ROLE_CODES.filter((r) => isRoleAllowedAtScope(r, scope));
  async function save() {
    setBusy(true);
    try {
      await api.setUserAssignment({ uid: user.id, barangayId: scope, roles, remarks });
      notify('Roles saved. They apply at the user’s next token refresh (automatic).', 'success');
      onClose();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open title={`Roles — ${user.displayName}`} onClose={onClose} footer={<><button className="btn-secondary" onClick={onClose}>Close</button><button className="btn-primary" disabled={busy || roles.length === 0} onClick={() => void save()}>{busy ? 'Saving…' : 'Save assignment'}</button></>}>
      <h3 className="label">Current assignments</h3>
      {!current ? <Spinner /> : current.length === 0 ? <p className="mb-4 text-sm text-slate-500">None.</p> : (
        <ul className="mb-4 space-y-1 text-sm">
          {current.map((a) => <li key={a.id}><strong>{a.barangayId}</strong>: {a.roles.map((r) => ROLES[r].label).join(', ')}</li>)}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="scope">Scope</label>
          <select id="scope" className="input" value={scope} onChange={(e) => { setScope(e.target.value as BarangayScope); setRoles([]); }}>
            <option value="ALL">ALL (Municipal Accounting)</option>
            {BARANGAY_IDS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="remarks">Remarks / basis</label>
          <input id="remarks" className="input" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. Designation order no." />
        </div>
      </div>
      <fieldset className="mt-4">
        <legend className="label">Roles at {scope}</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {allowed.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />
              {ROLES[r].label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-3 text-xs text-slate-500">Saving replaces this user’s roles at the selected scope. Only a Super Admin can grant the Super Admin, Municipal Accountant or Accounting Reviewer roles. The server enforces this.</p>
    </Modal>
  );
}
