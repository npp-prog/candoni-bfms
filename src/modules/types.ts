import type { Permission } from '@bfms/shared';
import type { ReactNode } from 'react';

export interface ModuleRoute {
  /** Route path including the wildcard for nested pages, e.g. '/collections/*'. */
  path: string;
  element: ReactNode;
  /** Required permission at the selected barangay (UI guard; the server enforces). */
  permission: Permission;
  /** Also allow users holding the permission at scope ALL. */
  anyScope?: boolean;
}
