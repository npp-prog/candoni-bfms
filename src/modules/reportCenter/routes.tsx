import type { ModuleRoute } from '../types';
import { MonthlySubmissionPage } from './MonthlySubmissionPage';
import { ReportCenterPage } from './ReportCenterPage';

/** Routes this module adds under the app shell. */
export const ROUTES: ModuleRoute[] = [
  { path: '/reports/*', element: <ReportCenterPage />, permission: 'report.generate' },
  { path: '/compliance/*', element: <MonthlySubmissionPage />, permission: 'report.generate' },
];
