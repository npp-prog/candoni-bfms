import { type BarangayId } from '@bfms/shared';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon } from '../components/ui';
import { env } from '../config/env';
import { CURRENT_PHASE, NAV } from '../config/navigation';
import { useAuth } from '../contexts/AuthContext';
import { useBarangay } from '../contexts/BarangayContext';

const headerSelect = 'h-9 rounded-md border border-navy-600 bg-navy-700 px-2 text-sm text-white disabled:opacity-80';

export function AppLayout() {
  const { profile, user, signOut, accessibleBarangays, can, isAllScope } = useAuth();
  const { barangayId, setBarangayId, fiscalYear, setFiscalYear } = useBarangay();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const scope = barangayId ?? 'ALL';
  const items = NAV.filter((n) => can(n.permission, scope) || (n.path === '/admin' && (can('admin.users.manage', 'ALL') || can('fiscalYear.manage', 'ALL'))));
  const years = Array.from({ length: 6 }, (_, i) => new Date().getFullYear() + 1 - i);

  // Close the mobile drawer on navigation and on Escape.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="min-h-screen bg-slate-50">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-navy-800 focus:shadow">
        Skip to main content
      </a>
      {env.appEnv !== 'prod' && (
        <div className="bg-gold-500 px-4 py-1 text-center text-xs font-semibold text-navy-900">
          {env.appEnv.toUpperCase()} ENVIRONMENT — not the official books
        </div>
      )}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-navy-900 bg-navy-800 px-2 text-white sm:gap-3 sm:px-4">
        <button
          type="button"
          className="btn-icon text-white hover:bg-navy-700 lg:hidden"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Close navigation' : 'Open navigation'}
          aria-expanded={open}
          aria-controls="main-nav"
        >
          <Icon name={open ? 'x' : 'menu'} className="h-5 w-5" />
        </button>
        <img src="/seal.svg" alt="" className="hidden h-8 w-8 min-[400px]:block" />
        <div className="hidden min-w-0 leading-tight md:block">
          <div className="truncate font-serif text-sm font-bold">Barangay Financial Management System</div>
          <div className="truncate text-[11px] text-navy-200">Municipality of Candoni · Negros Occidental</div>
        </div>
        <div className="hidden font-serif text-sm font-bold sm:block md:hidden">BFMS</div>
        <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
          <label className="sr-only" htmlFor="brgy">Barangay</label>
          <select
            id="brgy"
            className={`${headerSelect} max-w-[7.5rem] sm:max-w-none`}
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
          <select id="fy" className={headerSelect} value={fiscalYear} onChange={(e) => setFiscalYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>FY {y}</option>
            ))}
          </select>
          <div className="hidden max-w-[12rem] text-right text-xs xl:block">
            <div className="truncate font-medium">{profile?.displayName ?? user?.email}</div>
            <div className="truncate text-navy-200">{profile?.position}</div>
          </div>
          <button type="button" className="btn btn-sm text-gold-300 hover:bg-navy-700" onClick={() => void signOut()} aria-label="Sign out">
            <Icon name="logout" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>
      <div className="flex">
        {open && <div className="fixed inset-0 top-14 z-10 bg-navy-900/40 lg:hidden" aria-hidden="true" onClick={() => setOpen(false)} />}
        <aside
          id="main-nav"
          className={`${open ? 'block' : 'hidden'} fixed bottom-0 left-0 top-14 z-20 w-64 overflow-y-auto border-r border-slate-200 bg-white shadow-lg lg:sticky lg:bottom-auto lg:top-14 lg:block lg:h-[calc(100vh-3.5rem)] lg:w-60 lg:shadow-none`}
        >
          <nav className="p-3" aria-label="Main">
            <ul className="space-y-0.5">
              {items.map((n) => {
                const later = n.phase > CURRENT_PHASE;
                return (
                  <li key={n.path}>
                    <NavLink
                      to={n.path}
                      className={({ isActive }) =>
                        `flex min-h-[2.5rem] items-center justify-between rounded-md border-l-4 px-3 py-2 text-sm transition-colors ${isActive ? 'border-gold-500 bg-navy-50 font-semibold text-navy-800' : `border-transparent hover:bg-slate-100 ${later ? 'text-slate-500' : 'text-slate-800'}`}`
                      }
                    >
                      {n.label}
                      {later && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600" title={`Scheduled for Phase ${n.phase}`}>
                          <span aria-hidden="true">P{n.phase}</span>
                          <span className="sr-only">, scheduled for phase {n.phase}</span>
                        </span>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="border-t border-slate-200 p-3 text-xs text-slate-600 xl:hidden">
            <div className="font-medium text-slate-800">{profile?.displayName ?? user?.email}</div>
            {profile?.position && <div>{profile.position}</div>}
          </div>
        </aside>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 focus:outline-none sm:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
