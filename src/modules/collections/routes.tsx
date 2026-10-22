import type { ModuleRoute } from '../types';
import { AccountableFormsPage } from './AccountableFormsPage';
import { CollectionsPage } from './CollectionsPage';

/** Routes this module adds under the app shell. */
export const ROUTES: ModuleRoute[] = [
  { path: '/collections/*', element: <CollectionsPage />, permission: 'read.transactions' },
  { path: '/accountable-forms/*', element: <AccountableFormsPage />, permission: 'read.transactions' },
];
