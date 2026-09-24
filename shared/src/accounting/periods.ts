import type { PeriodStatus } from '../constants/statuses';
import type { EntryType } from '../types/accounting';
import type { BarangayId, IsoDate, PeriodKey } from '../types/common';
import { BfmsError } from './errors';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function assertIsoDate(d: string, field = 'date'): IsoDate {
  const m = ISO_DATE.exec(d);
  if (!m) throw new BfmsError('VALIDATION_FAILED', `${field} must be YYYY-MM-DD.`);
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, da));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da)
    throw new BfmsError('VALIDATION_FAILED', `${field} is not a real calendar date.`);
  return d;
}

export function periodKey(fiscalYear: number, month: number): PeriodKey {
  if (!Number.isInteger(month) || month < 0 || month > 13) throw new BfmsError('VALIDATION_FAILED', 'month must be 0–13');
  return `${fiscalYear}-${String(month).padStart(2, '0')}`;
}

export function parsePeriodKey(key: PeriodKey): { fiscalYear: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) throw new BfmsError('VALIDATION_FAILED', `Invalid period key ${key}`);
  return { fiscalYear: Number(m[1]), month: Number(m[2]) };
}

/** The accounting period is derived from the ACCOUNTING DATE, never "today". */
export function periodOfDate(date: IsoDate): { fiscalYear: number; month: number; key: PeriodKey } {
  assertIsoDate(date);
  const fiscalYear = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return { fiscalYear, month, key: periodKey(fiscalYear, month) };
}

export function periodDocId(barangayId: BarangayId, fiscalYear: number, month: number): string {
  return `${barangayId}_${fiscalYear}_${String(month).padStart(2, '0')}`;
}

/** Today's date in Asia/Manila as YYYY-MM-DD. */
export function manilaToday(now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function lastDayOfMonth(fiscalYear: number, month: number): IsoDate {
  const d = new Date(Date.UTC(fiscalYear, month, 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Posting gate (docs/architecture/04-accounting-engine.md §19).
 * OPEN: all entries. REVIEW: all entries (month-end adjustments). LOCKED/CLOSED: none.
 */
export function assertPeriodAllowsPosting(status: PeriodStatus | undefined, entryType: EntryType): void {
  if (!status) throw new BfmsError('PERIOD_NOT_OPEN', 'Accounting period has not been opened.');
  if (status === 'OPEN' || status === 'REVIEW') return;
  if (status === 'CLOSED' && entryType === 'CLOSING') return; // closing entries post while year is CLOSING
  throw new BfmsError('PERIOD_NOT_OPEN', `Cannot post to a ${status} accounting period.`, { status });
}

/** Encoding/submission gate for barangay source documents. */
export function assertPeriodAllowsEncoding(status: PeriodStatus | undefined): void {
  if (status === 'OPEN' || status === 'REVIEW') return;
  throw new BfmsError('PERIOD_NOT_OPEN', `The accounting period is ${status ?? 'not open'}; transactions cannot be submitted.`);
}

export const PERIOD_TRANSITIONS: Record<PeriodStatus, readonly PeriodStatus[]> = {
  OPEN: ['REVIEW', 'LOCKED'],
  REVIEW: ['OPEN', 'LOCKED'],
  LOCKED: ['OPEN', 'CLOSED'],
  CLOSED: [],
};

export function assertPeriodTransition(from: PeriodStatus, to: PeriodStatus, reason?: string | null): void {
  if (!PERIOD_TRANSITIONS[from].includes(to))
    throw new BfmsError('INVALID_STATUS', `Period cannot move from ${from} to ${to}.`);
  if (from === 'LOCKED' && to === 'OPEN' && (!reason || reason.trim().length < 10))
    throw new BfmsError('VALIDATION_FAILED', 'Reopening a locked period requires a justification of at least 10 characters.');
}
