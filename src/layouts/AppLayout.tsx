import { type BarangayId } from '@bfms/shared';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { env } from '../config/env';
import { NAV } from '../config/navigation';
import { useAuth } from '../contexts/AuthContext';
import { useBarangay } from '../contexts/BarangayContext';

export function AppLayout() {
  const { profile, user, signOut, accessibleBarangays, can, isAllScope } = useAuth();
  const { barangayId, setBarangayId, fiscalYear, setFiscalYear } = useBarangay();
  const [open, setOpen] = useState(false);
  const scope = barangayId ?? 'ALL';
  const items = NAV.filter((n) => can(n.permission, scope) || (n.path === '/admin' && (can('admin.users.manage', 'ALL') || can('fiscalYear.manage', 'ALL'))));
  const years = Array.from({ length: 6 }, (_, i) => new Date().getFullYear() + 1 - i);

  return (
    <div className="min-h-screen bg-slate-50">
      {env.appEnv !== 'prod' && (
        <div className="bg-gold-500 px-4 py-1 text-center text-xs font-semibold text-navy-900">
          {env.appEnv.toUpperCase()} ENVIRONMENT — not the official books
        </div>
      )}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-navy-900 bg-navy-800 px-4 text-white">
        <button className="rounded p-1.5 hover:bg-navy-700 lg:hidden" onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation">
          ☰
        </button>
        <img src="/seal.svg" alt="" className="h-8 w-8" />
        <div className="leading-tight">
          <div className="font-serif text-sm font-bold">Barangay Financial Management System</div>
          <div className="text-[11px] text-navy-200">Municipality of Candoni · Negros Occidental</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="sr-only" htmlFor="brgy">Barangay</label>
          <select
            id="brgy"
            className="rounded border border-navy-600 bg-navy-700 px-2 py-1 text-sm text-white"
            value={barangayId ?? ''}
            onChange={(e) => setBarangayId(e.target.value as BarangayId)}
            disabled={accessibleBarangays.length <= 1}
            title={isAllScope ? 'Municipal Accounting: all barangays' : 'Your assigned barangay'}
          >
            {accessibleBarangays.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <label className="sr-only" htmlFor="fy">Fiscal year</label>
          <select id="fy" className="rounded border border-navy-600 bg-navy-700 px-2 py-1 text-sm text-white" value={fiscalYear} onChange={(e) => setFiscalYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>FY {y}</option>
            ))}
          </select>
          <div className="hidden text-right text-xs sm:block">
            <div className="font-medium">{profile?.displayName ?? user?.email}</div>
            <div className="text-navy-200">{profile?.position}</div>
          </div>
          <button className="rounded px-2 py-1 text-xs text-gold-300 hover:bg-navy-700" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <div className="flex">
        <aside className={`${open ? 'block' : 'hidden'} fixed inset-y-14 left-0 z-20 w-60 overflow-y-auto border-r border-slate-200 bg-white lg:sticky lg:top-14 lg:block lg:h-[calc(100vh-3.5rem)]`}>
          <nav className="p-3" aria-label="Main">
            {items.map((n) => (
              <NavLink
                key={n.path}
                to={n.path}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  `mb-0.5 flex items-center justify-between rounded-md px-3 py-2 text-sm ${isActive ? 'border-l-4 border-gold-500 bg-navy-50 font-semibold text-navy-800' : 'text-slate-700 hover:bg-slate-100'}`
                }
              >
                {n.label}
                {n.phase > 1 && <span className="text-[10px] text-slate-400">P{n.phase}</span>}
              </NavLink>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
