import { type BarangayId } from '@bfms/shared';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon } from '../components/ui';
import { env } from '../config/env';
import { pathEnabled } from '../config/features';
import { CURRENT_PHASE, NAV } from '../config/navigation';
import { useAuth } from '../contexts/AuthContext';
import { useBarangay } from '../contexts/BarangayContext';

const GROUPS = ['Overview', 'Budget & Treasury', 'Accounting', 'Schedules', 'Property', 'Reports', 'Settings'] as const;

const headerSelect = 'h-7 rounded border-0 bg-transparent py-0 pl-1 pr-7 text-xs font-medium text-navy-900 focus:ring-0 disabled:opacity-80';

export function AppLayout() {
  const { profile, user, signOut, accessibleBarangays, can, isAllScope } = useAuth();
  const { barangayId, setBarangayId, fiscalYear, setFiscalYear } = useBarangay();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const scope = barangayId ?? 'ALL';
  const items = NAV.filter((n) => pathEnabled(n.path)).filter((n) => can(n.permission, scope) || (n.path === '/admin' && (can('admin.users.manage', 'ALL') || can('fiscalYear.manage', 'ALL'))));
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
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-navy-800 focus:shadow"
      >
        Skip to main content
      </a>
      {open && <div className="fixed inset-0 z-30 bg-navy-950/50 lg:hidden" aria-hidden="true" onClick={() => setOpen(false)} />}
      <aside id="main-nav" className={`${open ? 'flex' : 'hidden'} fixed inset-y-0 left-0 z-40 w-64 flex-col bg-navy-900 text-slate-300 shadow-raised lg:flex lg:w-60 lg:shadow-none`}>
        <div className="flex items-center gap-3 border-b border-navy-800 px-4 py-4">
          <img src="/seal.svg" alt="" className="h-11 w-11 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-snug text-white">Barangay Financial Management System</div>
            <div className="mt-0.5 text-2xs leading-snug text-slate-400">Municipality of Candoni</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Main">
          {GROUPS.map((g) => {
            const groupItems = items.filter((n) => n.group === g);
            if (!groupItems.length) return null;
            return (
              <div key={g} className="mb-3">
                {g !== 'Overview' && <h2 className="mb-1 px-3 text-2xs font-semibold uppercase tracking-wider text-slate-400">{g}</h2>}
                <ul className="space-y-0.5">
                  {groupItems.map((n) => {
                    const later = n.phase > CURRENT_PHASE;
                    return (
                      <li key={n.path}>
                        <NavLink
                          to={n.path}
                          className={({ isActive }) =>
                            `flex min-h-[2.25rem] items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm transition-colors ${isActive ? 'bg-brand-600 font-medium text-white' : `hover:bg-navy-800/60 hover:text-white ${later ? 'text-slate-500' : 'text-slate-300'}`}`
                          }
                        >
                          <span className="truncate">{n.label}</span>
                          {later && (
                            <span className="shrink-0 rounded bg-navy-800 px-1.5 py-px text-[10px] font-medium text-slate-400" title={`Scheduled for Phase ${n.phase}`}>
                              <span aria-hidden="true">P{n.phase}</span>
                              <span className="sr-only">, scheduled for phase {n.phase}</span>
                            </span>
                          )}
                        </NavLink>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="border-t border-navy-800 px-4 py-3 text-xs">
          <div className="truncate font-medium text-white">{profile?.displayName ?? user?.email}</div>
          {profile?.position && <div className="truncate text-slate-400">{profile.position}</div>}
        </div>
      </aside>
      <div className="lg:pl-60">
        {env.appEnv !== 'prod' && (
          <div className="no-print bg-amber-500 px-4 py-1 text-center text-2xs font-semibold uppercase tracking-wider text-amber-950">{env.appEnv} environment — not the official books</div>
        )}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-slate-200 bg-white px-2 sm:gap-3 sm:px-4 lg:px-8">
          <button
            type="button"
            className="btn-icon text-slate-500 hover:bg-slate-100 lg:hidden"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Close navigation' : 'Open navigation'}
            aria-expanded={open}
            aria-controls="main-nav"
          >
            <Icon name={open ? 'x' : 'menu'} className="h-5 w-5" />
          </button>
          <div className="min-w-0 text-sm font-semibold text-navy-900 lg:hidden">BFMS</div>
          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-1.5 rounded-md border border-slate-300 bg-slate-50 px-1.5 py-1">
              <label className="sr-only" htmlFor="brgy">
                Barangay
              </label>
              <select
                id="brgy"
                className={`${headerSelect} max-w-[7.5rem] sm:max-w-none`}
                value={barangayId ?? ''}
                onChange={(e) => setBarangayId(e.target.value as BarangayId)}
                disabled={accessibleBarangays.length <= 1}
                title={isAllScope ? 'Municipal Accounting: all barangays' : 'Your assigned barangay'}
              >
                {accessibleBarangays.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              <span className="text-slate-300" aria-hidden="true">
                |
              </span>
              <label className="sr-only" htmlFor="fy">
                Fiscal year
              </label>
              <select id="fy" className={headerSelect} value={fiscalYear} onChange={(e) => setFiscalYear(Number(e.target.value))}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    FY {y}
                  </option>
                ))}
              </select>
            </div>
            <div className="hidden items-center gap-2 xl:flex">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-navy-700 text-xs font-semibold text-white" aria-hidden="true">
                {(profile?.displayName ?? user?.email ?? '?')
                  .split(/\s+/)
                  .map((w) => w[0])
                  .slice(0, 2)
                  .join('')
                  .toUpperCase()}
              </span>
              <div className="max-w-[12rem] text-xs leading-tight">
                <div className="truncate font-medium text-navy-900">{profile?.displayName ?? user?.email}</div>
                <div className="truncate text-slate-500">{profile?.position}</div>
              </div>
            </div>
            <button type="button" className="btn btn-sm text-slate-600 hover:bg-slate-100" onClick={() => void signOut()} aria-label="Sign out">
              <Icon name="logout" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="min-w-0 px-4 py-6 focus:outline-none sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
