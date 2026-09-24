import type { Permission } from '@bfms/shared';
import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Spinner } from './components/ui';
import { NAV } from './config/navigation';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { BarangayProvider, useBarangay } from './contexts/BarangayContext';
import { ToastProvider } from './contexts/ToastContext';
import { AppLayout } from './layouts/AppLayout';
import { JournalEntriesPage } from './modules/accounting/JournalEntriesPage';
import { AdminPage } from './modules/administration/AdminPage';
import { DashboardPage } from './modules/dashboard/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { Forbidden, ModulePlaceholder, NotFound } from './pages/SimplePages';

function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, user, assignments } = useAuth();
  if (loading) return <Spinner label="Checking your session…" />;
  if (!user) return <Navigate to="/login" replace />;
  if (assignments.length === 0)
    return <div className="p-8"><Forbidden /></div>;
  return <>{children}</>;
}

/** UI guard only — the server and Security Rules are the real enforcement. */
function Guard({ permission, children, anyScope }: { permission: Permission; children: ReactNode; anyScope?: boolean }) {
  const { can } = useAuth();
  const { barangayId } = useBarangay();
  const ok = anyScope ? can(permission, 'ALL') || (barangayId ? can(permission, barangayId) : false) : barangayId ? can(permission, barangayId) : false;
  return ok ? <>{children}</> : <Forbidden />;
}

export default function App() {
  const placeholders = NAV.filter((n) => n.phase > 1);
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth><BarangayProvider><AppLayout /></BarangayProvider></RequireAuth>}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/accounting/*" element={<Guard permission="read.transactions"><JournalEntriesPage /></Guard>} />
              <Route path="/admin/*" element={<Guard permission="fiscalYear.manage" anyScope><AdminPage /></Guard>} />
              {placeholders.map((n) => <Route key={n.path} path={`${n.path}/*`} element={<ModulePlaceholder />} />)}
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
