import type { BarangayId, IsoDate, PeriodKey, Ts } from './common';
import type { FiscalYearStatus, PeriodStatus } from '../constants/statuses';

/** fiscalYears/{fy} — municipality-wide calendar (Jan 1 – Dec 31). */
export interface FiscalYearDoc {
  fiscalYear: number;
  status: FiscalYearStatus;
  openingDate: IsoDate; // YYYY-01-01
  closingDate: IsoDate; // YYYY-12-31
  createdAt: Ts;
  createdBy: string;
  closedAt: Ts | null;
  closedBy: string | null;
}

/** barangayFiscalYears/{bid}_{fy} — per-barangay year status. */
export interface BarangayFiscalYearDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  status: FiscalYearStatus;
  openingBalancesPosted: boolean;
  openedAt: Ts | null;
  openedBy: string | null;
  closedAt: Ts | null;
  closedBy: string | null;
}

export interface PeriodHistoryEntry {
  from: PeriodStatus;
  to: PeriodStatus;
  by: string;
  at: Ts;
  reason: string | null;
}

/**
 * accountingPeriods/{bid}_{fy}_{mm}
 * month 0 = opening balances, 1–12 = calendar months, 13 = closing entries.
 */
export interface AccountingPeriodDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  month: number;
  periodCode: PeriodKey; // '2026-09'
  status: PeriodStatus;
  lockedAt: Ts | null;
  lockedBy: string | null;
  reopenedAt: Ts | null;
  reopenedBy: string | null;
  reopenReason: string | null;
  history: PeriodHistoryEntry[];
}
