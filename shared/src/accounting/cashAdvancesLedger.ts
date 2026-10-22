import type { CashAdvanceType } from '../types/treasury';
import type { Centavos, IsoDate } from '../types/common';
import { DEFAULT_AGING_BUCKETS } from './cashAdvance';
import { BfmsError } from './errors';
import { assertIsoDate } from './periods';

/**
 * Phases 6–7 pure helpers: cash-advance aging settings and as-of balances, the liquidation JEV
 * template, petty-cash cash-on-hand movements and the Special Trust Fund registry arithmetic.
 * Shared by the server (callables, engine hooks), the report builders and the UI previews.
 */

export type AgingBucket = { maxDays: number; label: string };

export interface CaAgingSettings {
  buckets: AgingBucket[];
  /** Days after the grant date the cash advance must be liquidated (systemSettings/aging). */
  liquidationDueDays: Record<CashAdvanceType, number>;
}

export const DEFAULT_LIQUIDATION_DUE_DAYS: Record<CashAdvanceType, number> = { PAYROLL: 5, OFFICIAL_TRAVEL: 30, SPECIAL_PURPOSE: 20, PETTY_CASH: 365, OTHER_AUTHORIZED: 30 };

/** Read `systemSettings/aging` defensively (Firestore cannot store Infinity: the seed uses 1,000,000). */
export function normalizeAgingSettings(raw: unknown): CaAgingSettings {
  const r = (raw ?? {}) as { buckets?: AgingBucket[]; liquidationDueDays?: Partial<Record<CashAdvanceType, number>> };
  const buckets = Array.isArray(r.buckets) && r.buckets.length
    ? [...r.buckets].sort((a, b) => a.maxDays - b.maxDays).map((b) => ({ label: String(b.label), maxDays: b.maxDays >= 1_000_000 ? Number.POSITIVE_INFINITY : Number(b.maxDays) }))
    : DEFAULT_AGING_BUCKETS.map((b) => ({ ...b }));
  return { buckets, liquidationDueDays: { ...DEFAULT_LIQUIDATION_DUE_DAYS, ...(r.liquidationDueDays ?? {}) } };
}

export function caAddDays(date: IsoDate, days: number): IsoDate {
  assertIsoDate(date);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function caLiquidationDueDate(grantDate: IsoDate, type: CashAdvanceType, settings: CaAgingSettings): IsoDate {
  return caAddDays(grantDate, settings.liquidationDueDays[type] ?? 30);
}

/** Index of the aging bucket for a number of days (for report columns). */
export function caBucketIndex(days: number, buckets: readonly AgingBucket[]): number {
  const i = buckets.findIndex((b) => days <= b.maxDays);
  return i < 0 ? buckets.length - 1 : i;
}

/** Effect of one accepted liquidation on its cash advance. */
export interface CaMovement {
  date: IsoDate;
  supported: Centavos;
  refunded: Centavos;
}

/**
 * Outstanding balance of a cash advance as of a date, from its grant, any opening (migrated)
 * liquidation and the liquidations dated on or before `asOf`. null when not yet granted.
 */
export function caOutstandingAsOf(
  ca: { amountGranted: Centavos; grantDate: IsoDate; openingLiquidated?: Centavos | null },
  movements: readonly CaMovement[],
  asOf: IsoDate,
): Centavos | null {
  if (ca.grantDate > asOf) return null;
  let bal = ca.amountGranted - (ca.openingLiquidated ?? 0);
  for (const m of movements) if (m.date <= asOf) bal -= m.supported + m.refunded;
  return bal as Centavos;
}

/** Liquidation statuses whose amounts have been applied to the cash advance (applied at ACCEPT). */
export const APPLIED_LIQUIDATION_STATUSES = ['ACCEPTED', 'POSTED'] as const;
/** Liquidations still in the pipeline (they reserve part of the outstanding balance). */
export const PENDING_LIQUIDATION_STATUSES = ['DRAFT', 'SUBMITTED', 'RESUBMITTED', 'RETURNED', 'APPROVED'] as const;

export interface LiquidationJevInput {
  items: ReadonlyArray<{ accountCode: string; subsidiaryId: string | null; amount: Centavos; particulars: string }>;
  cashRefunded: Centavos;
  /** Collecting officer's ledger (BT##) under 1-01-01-010 that received the refund. */
  refundCashSubsidiaryId: string | null;
  caAccountCode: string;
  officerSubsidiaryId: string;
}

/**
 * Liquidation journal entry (docs 04 §9, GJ): Dr the expenses of the items; Dr 1-01-01-010 (BT##)
 * for the cash refunded; Cr the cash-advance account with the accountable officer's ledger.
 */
export function liquidationJevLines(i: LiquidationJevInput) {
  const totalSupported = i.items.reduce((t, x) => t + x.amount, 0);
  if (i.cashRefunded > 0 && !i.refundCashSubsidiaryId) throw new BfmsError('SUBSIDIARY_REQUIRED', 'Select the collecting officer (BT##) who received the refund.');
  const lines = [
    ...i.items.map((x) => ({ accountCode: x.accountCode, subsidiaryId: x.subsidiaryId, debit: x.amount, credit: 0 as Centavos, lineDescription: x.particulars.slice(0, 200) })),
    ...(i.cashRefunded > 0 ? [{ accountCode: '1-01-01-010', subsidiaryId: i.refundCashSubsidiaryId, debit: i.cashRefunded, credit: 0 as Centavos, lineDescription: 'Refund of unused cash advance' }] : []),
    { accountCode: i.caAccountCode, subsidiaryId: i.officerSubsidiaryId, debit: 0 as Centavos, credit: (totalSupported + i.cashRefunded) as Centavos, lineDescription: 'Liquidation of cash advance' },
  ];
  return lines;
}

// ------------------------------------------------------------------ petty cash

export type PettyCashKind = 'ESTABLISH' | 'PAYMENT' | 'REPLENISH' | 'RETURN' | 'YEAR_END_CLOSE';

/**
 * Cash-on-hand effect of a petty cash transaction, or null when it has none (drafts, voided PCVs,
 * replenishments not yet paid). Replenishments count on the date the replenishment DV was paid.
 */
export function pettyCashEffect(t: { kind: PettyCashKind; status: string; date: IsoDate; amount: Centavos; replenishedDate?: IsoDate | null }): { date: IsoDate; receipt: Centavos; payment: Centavos } | null {
  const z = 0 as Centavos;
  switch (t.kind) {
    case 'ESTABLISH':
      return t.status === 'APPROVED' ? { date: t.date, receipt: t.amount, payment: z } : null;
    case 'PAYMENT':
      return t.status === 'APPROVED' ? { date: t.date, receipt: z, payment: t.amount } : null;
    case 'REPLENISH':
      return t.status === 'ACCEPTED' ? { date: t.replenishedDate ?? t.date, receipt: t.amount, payment: z } : null;
    case 'RETURN':
    case 'YEAR_END_CLOSE':
      return t.status === 'APPROVED' ? { date: t.date, receipt: z, payment: t.amount } : null;
    default:
      return null;
  }
}

/** Petty cash vouchers must not exceed the cash on hand (Section XXXIV). */
export function assertPettyCashAvailable(cashOnHand: Centavos, amount: Centavos): void {
  if (amount <= 0) throw new BfmsError('VALIDATION_FAILED', 'Amount must be greater than zero.');
  if (amount > cashOnHand)
    throw new BfmsError('VALIDATION_FAILED', 'The petty cash voucher exceeds the petty cash on hand. Request a replenishment first.', { cashOnHand, amount });
}

// ------------------------------------------------------------------ special trust funds

export type StfHistoryKind = 'RECEIPT' | 'ADDITIONAL_RECEIPT' | 'RETURN' | 'OTHER_INCREASE' | 'OTHER_DECREASE';

export interface StfHistoryEntry {
  date: IsoDate;
  kind: StfHistoryKind;
  /** Signed: receipts positive, returns/decreases negative. */
  amount: Centavos;
  reference: string;
  reason: string;
  by: string;
  at: string;
}

export const STF_ADJUSTMENT_KINDS: ReadonlyArray<{ value: Exclude<StfHistoryKind, 'RECEIPT'>; label: string; sign: 1 | -1 }> = [
  { value: 'ADDITIONAL_RECEIPT', label: 'Additional receipt / tranche', sign: 1 },
  { value: 'RETURN', label: 'Return of unused balance to source agency', sign: -1 },
  { value: 'OTHER_INCREASE', label: 'Other increase (e.g. interest)', sign: 1 },
  { value: 'OTHER_DECREASE', label: 'Other decrease', sign: -1 },
];

/** Status from the figures: FULLY_UTILIZED once nothing is left; RETURNED when the rest went back. */
export function stfStatusFor(balance: Centavos, current: string, lastKind?: StfHistoryKind): 'ACTIVE' | 'FULLY_UTILIZED' | 'RETURNED' | 'CLOSED' {
  if (current === 'CLOSED') return 'CLOSED';
  if (balance > 0) return 'ACTIVE';
  return lastKind === 'RETURN' ? 'RETURNED' : 'FULLY_UTILIZED';
}
