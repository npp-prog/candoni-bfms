import type { Centavos, IsoDate } from '../types/common';
import type { CollectionLine } from '../types/treasury';
import { BfmsError } from './errors';
import { sum } from './money';
import { validateRcd } from './cashbook';

/**
 * Phase 4 pure helpers: accountable-form serials (AF 51 ORs …), collection totals and RCD
 * accountability. Used by the callables (server recomputes), the UI previews and the report builders.
 */

/** OR statuses that do NOT count as official collections (contract shared with REAI and cashbooks). */
export const NON_COLLECTION_STATUSES = ['VOID', 'CANCELLED'] as const;
export function isCollectionCounted(status: string | undefined): boolean {
  return !!status && !(NON_COLLECTION_STATUSES as readonly string[]).includes(status);
}

/** Pre-printed serial → integer ("0012345" → 12345). Rejects anything that is not all digits. */
export function parseAfSerial(v: string | number): number {
  const s = String(v).trim();
  if (!/^\d{1,12}$/.test(s)) throw new BfmsError('VALIDATION_FAILED', `"${s}" is not a valid serial number (digits only).`);
  return Number(s);
}

/** Serial → printed number, zero-padded to the booklet's width (legacy ORs print 7 digits). */
export function formatAfSerial(n: number, width = 7): string {
  return String(n).padStart(width, '0');
}

export interface AfSerialRange {
  begin: number;
  end: number;
}

export function afRangeSize(r: AfSerialRange): number {
  return r.end >= r.begin ? r.end - r.begin + 1 : 0;
}

export function afRangesOverlap(a: AfSerialRange, b: AfSerialRange): boolean {
  return a.begin <= b.end && b.begin <= a.end;
}

/** A booklet/series must be a positive, bounded range (one receipt book is 50; allow a box of 5,000). */
export function assertAfSerialRange(r: AfSerialRange): void {
  if (!Number.isInteger(r.begin) || !Number.isInteger(r.end) || r.begin <= 0) throw new BfmsError('VALIDATION_FAILED', 'Serial numbers must be positive whole numbers.');
  if (r.end < r.begin) throw new BfmsError('VALIDATION_FAILED', 'The ending serial number cannot be lower than the beginning serial number.');
  if (afRangeSize(r) > 5000) throw new BfmsError('VALIDATION_FAILED', 'A series may hold at most 5,000 forms; record larger stocks as several series.');
}

/** One use of a serial (an issued OR or a cancelled/spoiled one). */
export interface AfSerialUse {
  serial: number;
  date: IsoDate;
  status: string;
}

export interface AfUsage {
  issued: number; // valid ORs
  cancelled: number; // CANCELLED/VOID (spoiled) — the number is consumed
  used: number; // issued + cancelled
  nextSerialNumber: number | null; // null when exhausted
  endingBalance: number;
  /** Serials below the highest used one that were never used (missing ORs). */
  gaps: number[];
  duplicates: number[];
  outOfRange: number[];
  exhausted: boolean;
}

/** Usage of a series from its uses (the authoritative source is the collections themselves). */
export function computeAfUsage(r: AfSerialRange, uses: readonly AfSerialUse[]): AfUsage {
  const seen = new Set<number>();
  const duplicates: number[] = [];
  const outOfRange: number[] = [];
  let issued = 0;
  let cancelled = 0;
  for (const u of uses) {
    if (u.serial < r.begin || u.serial > r.end) outOfRange.push(u.serial);
    if (seen.has(u.serial)) duplicates.push(u.serial);
    seen.add(u.serial);
    if (isCollectionCounted(u.status)) issued++;
    else cancelled++;
  }
  const inRange = [...seen].filter((s) => s >= r.begin && s <= r.end);
  const max = inRange.length ? Math.max(...inRange) : r.begin - 1;
  const gaps: number[] = [];
  for (let s = r.begin; s < max; s++) if (!seen.has(s)) gaps.push(s);
  const used = inRange.length;
  const endingBalance = afRangeSize(r) - used;
  // Next = first serial after the highest used one; gaps stay visible as gaps (not silently reissued).
  const next = max + 1 <= r.end ? max + 1 : null;
  return { issued, cancelled, used, nextSerialNumber: next, endingBalance, gaps, duplicates, outOfRange, exhausted: next === null };
}

/** AF_NO_GAPS message for one series ('' when clean). */
export function describeAfProblems(label: string, u: Pick<AfUsage, 'gaps' | 'duplicates' | 'outOfRange'>): string {
  const p: string[] = [];
  const show = (xs: number[]) => (xs.length > 6 ? `${xs.slice(0, 6).join(', ')} … (${xs.length})` : xs.join(', '));
  if (u.gaps.length) p.push(`missing ${show(u.gaps)}`);
  if (u.duplicates.length) p.push(`duplicated ${show(u.duplicates)}`);
  if (u.outOfRange.length) p.push(`outside the series ${show(u.outOfRange)}`);
  return p.length ? `${label}: ${p.join('; ')}` : '';
}

export interface AfQtyRange {
  qty: number;
  from: number | null;
  to: number | null;
}
const qr = (from: number, to: number): AfQtyRange => (to >= from ? { qty: to - from + 1, from, to } : { qty: 0, from: null, to: null });

export interface AfAccountability {
  beginning: AfQtyRange;
  receipts: AfQtyRange;
  issued: AfQtyRange;
  ending: AfQtyRange;
}

/**
 * RAAF / RCD section C for one series over a date range (Beginning + Receipts − Issued = Ending).
 * Booklets are used front to back, so balances are the contiguous block after the highest used
 * serial; out-of-order use shows up as gaps in the AF_NO_GAPS validator instead.
 * `receivedOn` is the date the series reached the officer (dateIssued, else dateReceived).
 */
export function afAccountability(r: AfSerialRange, receivedOn: IsoDate, uses: readonly AfSerialUse[], range: { from: IsoDate; to: IsoDate }): AfAccountability {
  const inSeries = uses.filter((u) => u.serial >= r.begin && u.serial <= r.end);
  const maxBefore = Math.max(r.begin - 1, ...inSeries.filter((u) => u.date < range.from).map((u) => u.serial));
  const during = inSeries.filter((u) => u.date >= range.from && u.date <= range.to);
  const maxThrough = Math.max(maxBefore, ...during.map((u) => u.serial));
  const received = receivedOn >= range.from && receivedOn <= range.to;
  const notYet = receivedOn > range.to;
  const beginning = received || notYet ? qr(1, 0) : qr(maxBefore + 1, r.end);
  const receipts = received ? qr(r.begin, r.end) : qr(1, 0);
  const issued = during.length ? qr(maxBefore + 1, maxThrough) : qr(1, 0);
  const ending = notYet ? qr(1, 0) : qr(maxThrough + 1, r.end);
  return { beginning, receipts, issued, ending };
}

// ------------------------------------------------------------------ collections

/** Header amount of an OR = Σ lines (server recomputes; never trust the browser total). */
export function collectionAmount(lines: readonly Pick<CollectionLine, 'amount'>[]): Centavos {
  return sum(lines.map((l) => l.amount));
}

export const MAX_COLLECTION_LINES = 20;

/** Accounts an OR line may credit: income (4-), liabilities incl. trust (2-), receivables/advances refunds (1-03), other assets returned. */
export function assertCollectionLines(lines: readonly CollectionLine[]): void {
  if (!lines.length) throw new BfmsError('VALIDATION_FAILED', 'An official receipt needs at least one line.');
  if (lines.length > MAX_COLLECTION_LINES) throw new BfmsError('TOO_MANY_LINES', `An official receipt may have at most ${MAX_COLLECTION_LINES} lines.`);
  lines.forEach((l, i) => {
    if (!Number.isInteger(l.amount) || l.amount <= 0) throw new BfmsError('INVALID_LINE', `Line ${i + 1}: amount must be greater than zero.`);
    if (l.accountCode.startsWith('1-01')) throw new BfmsError('INVALID_LINE', `Line ${i + 1}: an OR cannot credit a cash account (${l.accountCode}).`);
    if (/^5-/.test(l.accountCode) || /^3-/.test(l.accountCode)) throw new BfmsError('INVALID_LINE', `Line ${i + 1}: ${l.accountCode} is not a receipt account (use income 4-xx, liabilities/trust 2-xx or receivables 1-03).`);
  });
}

/** Σ by account (+ subsidiary) across ORs — RCD breakdown and JEV credits. */
export function orBreakdownByAccount(collections: ReadonlyArray<{ lines: readonly CollectionLine[] }>): Array<{ accountCode: string; subsidiaryId: string | null; amount: Centavos }> {
  const m = new Map<string, { accountCode: string; subsidiaryId: string | null; amount: number }>();
  for (const c of collections)
    for (const l of c.lines) {
      const k = `${l.accountCode}|${l.subsidiaryId ?? ''}`;
      const cur = m.get(k) ?? { accountCode: l.accountCode, subsidiaryId: l.subsidiaryId ?? null, amount: 0 };
      cur.amount += l.amount;
      m.set(k, cur);
    }
  return [...m.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode) || (a.subsidiaryId ?? '').localeCompare(b.subsidiaryId ?? '')) as Array<{ accountCode: string; subsidiaryId: string | null; amount: Centavos }>;
}

// ------------------------------------------------------------------ RCD

export interface RcdTotals {
  undepositedBeginning: Centavos;
  totalCollections: Centavos;
  totalDeposits: Centavos;
  /** Accountability still in the officer's hands at the end of the report. */
  undeposited: Centavos;
  result: 'PASSED' | 'WARNING' | 'FAILED';
  message: string;
}

/**
 * RCD section D (Summary): undeposited last report + collections − deposits = undeposited now.
 * Validation (RCD_COLLECTIONS_EQ_DEPOSITS) runs validateRcd on the whole accountability, so a deposit
 * of last report's undeposited cash does not fail this report.
 */
export function computeRcdTotals(undepositedBeginning: Centavos, collections: readonly Centavos[], deposits: readonly Centavos[], explanation: string | null): RcdTotals {
  const totalCollections = sum(collections);
  const totalDeposits = sum(deposits);
  const v = validateRcd((undepositedBeginning + totalCollections) as Centavos, totalDeposits, explanation);
  const message = v.result === 'PASSED' ? 'Collections are fully deposited.' : v.message ?? '';
  return { undepositedBeginning, totalCollections, totalDeposits, undeposited: v.undeposited, result: v.result, message };
}

/** Deposit slip vs the ORs it covers: the slip may not exceed them and must equal them. */
export function assertDepositMatches(depositAmount: Centavos, collectionsTotal: Centavos): void {
  if (depositAmount <= 0) throw new BfmsError('VALIDATION_FAILED', 'The deposit amount must be greater than zero.');
  if (depositAmount > collectionsTotal)
    throw new BfmsError('VALIDATION_FAILED', `Deposits exceed collections: the slip amount is greater than the selected official receipts.`, { depositAmount, collectionsTotal });
  if (depositAmount !== collectionsTotal)
    throw new BfmsError('VALIDATION_FAILED', 'The deposit slip amount must equal the total of the selected official receipts (deposit the rest on another slip or leave those ORs unselected).', { depositAmount, collectionsTotal });
}
