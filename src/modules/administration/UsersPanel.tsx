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
import { EmptyState, Field, Modal, Pager, Spinner, StatusChip, TableSkeleton } from '../../components/ui';
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
      <div className="card-header">
        <h2 className="card-title">Users</h2>
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>New user</button>
      </div>
      {page.loading && <TableSkeleton label="Loading users…" />}
      {!page.loading && page.rows.length === 0 && <div className="p-4"><EmptyState title="No users yet" /></div>}
      {page.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="table-base table-hover">
            <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Position</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {page.rows.map((u) => (
                <tr key={u.id}>
                  <td className="font-medium">{u.displayName}</td>
                  <td>{u.email}</td>
                  <td>{u.position}</td>
                  <td>{u.active ? <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-200">Active</span> : <StatusChip status="DISABLED" />}</td>
                  <td className="text-right"><button type="button" className="btn-ghost btn-sm" onClick={() => setAssigning(u)} aria-label={`Manage roles for ${u.displayName}`}>Roles…</button></td>
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
  const [touched, setTouched] = useState(false);
  const errors = {
    displayName: f.displayName.trim().length < 3 ? 'Enter the full name (at least 3 characters).' : null,
    email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim()) ? 'Enter a valid email address.' : null,
    position: null,
  };
  const valid = !errors.displayName && !errors.email;
  async function save() {
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    try {
      await api.createUserAccount({ ...f, defaultBarangayId: null });
      await sendPasswordResetEmail(auth, f.email);
      setF({ email: '', displayName: '', position: '' });
      setTouched(false);
      onCreated();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} title="New user" onClose={onClose} footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={busy || (touched && !valid)} onClick={() => void save()}>{busy ? 'Creating…' : 'Create user'}</button></>}>
      <form className="space-y-3" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Full name" required error={touched ? errors.displayName : null}>
          {(p) => <input {...p} className="input" autoComplete="off" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} onBlur={() => f.displayName && setTouched(true)} />}
        </Field>
        <Field label="Email" required error={touched ? errors.email : null} hint="The password-setup link is sent here.">
          {(p) => <input {...p} type="email" className="input" autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} onBlur={() => f.email && setTouched(true)} />}
        </Field>
        <Field label="Position" hint="e.g. Barangay Treasurer">
          {(p) => <input {...p} className="input" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} />}
        </Field>
        <p className="text-xs text-slate-600">No password is set here. The user receives an email to create their own password.</p>
        <button type="submit" hidden />
      </form>
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
    <Modal open title={`Roles — ${user.displayName}`} onClose={onClose} footer={<><button className="btn-secondary" onClick={onClose}>Close</button><button type="button" className="btn-primary" disabled={busy || roles.length === 0} title={roles.length === 0 ? 'Select at least one role' : undefined} onClick={() => void save()}>{busy ? 'Saving…' : 'Save assignment'}</button></>}>
      <h3 className="label">Current assignments</h3>
      {!current ? <Spinner /> : current.length === 0 ? <p className="mb-4 text-sm text-slate-600">None.</p> : (
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
            <label key={r} className="flex min-h-[2.25rem] cursor-pointer items-center gap-2 rounded px-1 text-sm hover:bg-slate-50">
              <input className="h-4 w-4 accent-navy-700" type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />
              {ROLES[r].label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-3 text-xs text-slate-600">Saving replaces this user’s roles at the selected scope. Only a Super Admin can grant the Super Admin, Municipal Accountant or Accounting Reviewer roles. The server enforces this.</p>
    </Modal>
  );
}
