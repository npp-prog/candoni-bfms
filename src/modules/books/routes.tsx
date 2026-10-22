import type { ModuleRoute } from '../types';
import { BooksPage } from './BooksPage';
import { StatementsPage } from './StatementsPage';

/** Routes this module adds under the app shell: Phase 8 books (/books) and Phase 11 statements (/statements). */
export const ROUTES: ModuleRoute[] = [
  { path: '/books/*', element: <BooksPage />, permission: 'read.transactions' },
  { path: '/statements/*', element: <StatementsPage />, permission: 'report.generate' },
];
