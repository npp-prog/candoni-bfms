import type { ModuleRoute } from '../types';
import { CaSchedulePage } from './CaSchedulePage';
import { PpeSchedulePage } from './PpeSchedulePage';

/** The accountant's schedules: unliquidated cash advances and PPE depreciation (journal-driven). */
export const ROUTES: ModuleRoute[] = [
  { path: '/ca-schedule/*', element: <CaSchedulePage />, permission: 'read.transactions' },
  { path: '/ppe-schedule/*', element: <PpeSchedulePage />, permission: 'read.transactions' },
];
