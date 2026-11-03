import type { ModuleRoute } from '../types';
import { ImportPage } from './ImportPage';

/** Routes this module adds under the app shell: legacy workbook import (preview for accounting staff; import by the Municipal Accountant). */
export const ROUTES: ModuleRoute[] = [{ path: '/import/*', element: <ImportPage />, permission: 'jev.prepare' }];
