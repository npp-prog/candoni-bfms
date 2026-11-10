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

const headerSelect = 'h-7 rounded border-0 bg-transparent py-0 pl-1.5 pr-7 text-sm font-medium text-ink focus:ring-0 disabled:opacity-80';

/** Line icons in the DMS / PMS-IMS style (24px grid, 1.6 stroke). */
const NAV_ICON: Record<string, string> = {
  '/dashboard': 'M3 10.5 12 3l9 7.5M5 9.5V20h5v-6h4v6h5V9.5',
  '/accounting': 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM8 7h8M8 11h6',
  '/books': 'M3 3v18h18M7 15l4-4 3 3 5-6',
  '/bank-reconciliation': 'M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18',
  '/statements': 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5',
  '/ca-schedule': 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.5V12l3 2',
  '/ppe-schedule': 'M4 7h16v13H4zM9 7V4h6v3M4 12h16',
  '/reports': 'M7 9V3h10v6M3 9h18v8H3zM7 14h10v7H7z',
  '/compliance': 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  '/import': 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M12 18v-6M9 14.5l3-3 3 3',
  '/setup': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  '/admin': 'M9 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5.5 5.5 0 0 1 3.5 6',
};
const DEFAULT_ICON = 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6';

function NavIcon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0" aria-hidden="true">
      <path d={NAV_ICON[path] ?? DEFAULT_ICON} />
    </svg>
  );
}

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

  const initials = (profile?.displayName ?? user?.email ?? '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="flex min-h-screen bg-white">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink focus:shadow">
        Skip to main content
      </a>
      {open && <div className="fixed inset-0 z-30 bg-black/35 lg:hidden" aria-hidden="true" onClick={() => setOpen(false)} />}
      <aside
        id="main-nav"
        className={`${open ? 'flex' : 'hidden'} fixed inset-y-0 left-0 z-40 w-72 flex-col overflow-y-auto border-r border-line bg-white px-3.5 pb-5 pt-4 shadow-[8px_0_32px_rgba(0,0,0,.18)] lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-[17rem] lg:shrink-0 lg:bg-side lg:shadow-none`}
      >
        <div className="flex items-center gap-2.5 px-2 pb-4">
          <img src="/seal.svg" alt="" className="h-9 w-9 shrink-0" />
          <div className="min-w-0">
            <div className="text-[1.02rem] font-bold leading-tight tracking-[-.035em] text-ink">Barangay Financial Management System</div>
            <div className="mt-0.5 text-[.7rem] leading-snug text-muted">Municipal Government of Candoni</div>
          </div>
        </div>
        <nav className="flex-1" aria-label="Main">
          {GROUPS.map((g) => {
            const groupItems = items.filter((n) => n.group === g);
            if (!groupItems.length) return null;
            return (
              <div key={g}>
                {g !== 'Overview' && <h2 className="px-2.5 pb-1.5 pt-4 text-sm font-medium text-[#737373]">{g}</h2>}
                <ul className="space-y-px">
                  {groupItems.map((n) => {
                    const later = n.phase > CURRENT_PHASE;
                    return (
                      <li key={n.path}>
                        <NavLink
                          to={n.path}
                          className={({ isActive }) =>
                            `flex min-h-[2.5rem] items-center gap-3 rounded-md2 px-2.5 py-2 text-[.95rem] transition-colors ${isActive ? 'bg-[#ededed] font-medium text-ink' : `hover:bg-[#f0f0f0] ${later ? 'text-slate-400' : 'text-[#262626]'}`}`
                          }
                        >
                          <span className="text-[#44403c]"><NavIcon path={n.path} /></span>
                          <span className="min-w-0 flex-1 leading-snug">{n.label}</span>
                          {later && (
                            <span className="shrink-0 rounded-full bg-sunken px-1.5 text-[10px] font-semibold text-muted" title={`Scheduled for Phase ${n.phase}`}>
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
        <div className="mt-6 px-2.5 text-[.74rem] text-slate-400">Municipal Accounting Office · Candoni</div>
      </aside>
      <div className="min-w-0 flex-1">
        {env.appEnv !== 'prod' && (
          <div className="no-print bg-amber-50 px-4 py-1 text-center text-2xs font-semibold uppercase tracking-wider text-amber-800">
            {env.appEnv} environment — not the official books
          </div>
        )}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-line bg-white/90 px-3 backdrop-blur sm:gap-3 sm:px-6">
          <button
            type="button"
            className="btn-icon text-[#57534e] hover:bg-[#f4f4f4] lg:hidden"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Close navigation' : 'Open navigation'}
            aria-expanded={open}
            aria-controls="main-nav"
          >
            <Icon name={open ? 'x' : 'menu'} className="h-5 w-5" />
          </button>
          <div className="hidden min-w-0 truncate text-[1.05rem] font-medium text-ink sm:block">
            <span className="lg:hidden">BFMS</span>
            <span className="hidden lg:inline">{isAllScope ? 'Municipal Accounting' : barangayId ? `Barangay ${barangayId}` : 'BFMS'}</span>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-3">
            <div className="flex items-center gap-1 rounded-md2 border border-line-2 bg-white px-1.5 py-1 shadow-[0_1px_1px_rgba(15,23,42,.04)]">
              <label className="sr-only" htmlFor="brgy">Barangay</label>
              <select
                id="brgy"
                className={`${headerSelect} max-w-[6.5rem] sm:max-w-none`}
                value={barangayId ?? ''}
                onChange={(e) => setBarangayId(e.target.value as BarangayId)}
                disabled={accessibleBarangays.length <= 1}
                title={isAllScope ? 'Municipal Accounting: all barangays' : 'Your assigned barangay'}
              >
                {accessibleBarangays.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              <span className="h-5 w-px bg-line-2" aria-hidden="true" />
              <label className="sr-only" htmlFor="fy">Fiscal year</label>
              <select id="fy" className={headerSelect} value={fiscalYear} onChange={(e) => setFiscalYear(Number(e.target.value))}>
                {years.map((y) => (
                  <option key={y} value={y}>FY {y}</option>
                ))}
              </select>
            </div>
            <button type="button" className="btn btn-sm shrink-0 px-2 text-[#57534e] hover:bg-[#f4f4f4] sm:px-2.5" onClick={() => void signOut()} aria-label="Sign out">
              <Icon name="logout" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
            <span
              className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white ring-2 ring-white ring-offset-1 ring-offset-gold-200 sm:flex"
              title={`${profile?.displayName ?? user?.email ?? ''}${profile?.position ? ` · ${profile.position}` : ''}`}
            >
              {initials}
            </span>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="min-w-0 px-4 pb-14 pt-6 focus:outline-none sm:px-8 sm:pt-7">
          <div className="max-w-[92rem]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
