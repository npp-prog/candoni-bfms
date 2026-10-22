import type { ModuleRoute } from '../types';
import { SetupPage } from './SetupPage';

/** Routes this module adds under the app shell. */
export const ROUTES: ModuleRoute[] = [{ path: '/setup/*', element: <SetupPage />, permission: 'barangay.setup' }];
