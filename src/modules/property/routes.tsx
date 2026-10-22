import type { ModuleRoute } from '../types';
import { PropertyPage } from './PropertyPage';

/** Routes this module adds under the app shell. */
export const ROUTES: ModuleRoute[] = [{ path: '/property/*', element: <PropertyPage />, permission: 'read.transactions' }];
