import { Link, useLocation } from 'react-router-dom';
import { NAV } from '../config/navigation';
import { EmptyState, PageHeader } from '../components/ui';

export function ModulePlaceholder() {
  const { pathname } = useLocation();
  const item = NAV.find((n) => pathname.startsWith(n.path));
  return (
    <>
      <PageHeader title={item?.label ?? 'Module'} breadcrumbs={['BFMS', item?.label ?? '']} />
      <EmptyState icon="calendar" title={`Scheduled for Phase ${item?.phase ?? '—'}`} action={<Link className="btn-secondary" to="/dashboard">Back to dashboard</Link>}>
        This module is designed in <code>docs/architecture</code>. It is built in the order the development roadmap sets:
        foundations and the posting engine come first, and source modules follow.
      </EmptyState>
    </>
  );
}

export function NotFound() {
  return (
    <EmptyState icon="alert" title="Page not found" action={<Link className="btn-secondary" to="/dashboard">Back to dashboard</Link>}>
      The address may be mistyped, or the page may have moved.
    </EmptyState>
  );
}

export function Forbidden() {
  return <EmptyState icon="alert" title="You do not have access to this page.">Ask the Municipal Accounting Office if you need access.</EmptyState>;
}
