import type { Centavos, IsoDate } from '../types/common';
import { BfmsError } from './errors';
import { depreciationForMonth } from './statements';

/**
 * Phase 10 — pure property helpers (PPE numbering and accounts, depreciation periods, moving-average
 * stock costing). Used by the server (authoritative) and the UI (previews), and unit-tested.
 */

/**
 * Capitalization threshold: ₱50,000 per item (COA Circular No. 2022-004, raising the former ₱15,000).
 * Items costing less are semi-expendable property (issued on ICS, tracked on stock/property cards);
 * items at or above it are PPE (issued on PAR, depreciated). Change here if COA revises it.
 */
export const CAPITALIZATION_THRESHOLD = 5_000_000 as Centavos;

/** Legacy barangay practice and COA guidance: residual value = 5% of cost unless stated. */
export const DEFAULT_RESIDUAL_RATE_BP = 500;

export function defaultResidualValue(cost: Centavos | number): Centavos {
  return Math.round((cost * DEFAULT_RESIDUAL_RATE_BP) / 10_000) as Centavos;
}

export function isCapitalizable(unitCost: Centavos | number): boolean {
  return unitCost >= CAPITALIZATION_THRESHOLD;
}

const PPE_CODE = /^1-07-(\d{2})-(\d{3})$/;

/** Depreciation expense account per PPE major group (5-04-01-xxx in the barangay Chart of Accounts). */
const DEPRECIATION_EXPENSE_BY_GROUP: Record<string, string> = {
  '02': '5-04-01-010', // land improvements
  '03': '5-04-01-020', // infrastructure assets
  '04': '5-04-01-030', // buildings and other structures
  '05': '5-04-01-040', // machinery and equipment
  '06': '5-04-01-050', // transportation equipment
  '07': '5-04-01-060', // furniture, fixtures and books
  '08': '5-04-01-070', // leased assets
  '09': '5-04-01-080', // leased assets improvements
  '99': '5-04-01-990', // other PPE
};

export interface PpeAccounts {
  accumulatedDepreciationAccountCode: string;
  depreciationExpenseAccountCode: string;
  /** Land (1-07-01) and construction in progress (1-07-10) are not depreciated. */
  depreciable: boolean;
}

/** Default contra and expense accounts of a PPE asset account: 1-07-05-020 → 1-07-05-021 / 5-04-01-040. */
export function ppeAccountsFor(accountCode: string): PpeAccounts {
  const m = PPE_CODE.exec(accountCode);
  if (!m) throw new BfmsError('INVALID_ACCOUNT', `${accountCode} is not a PPE account (1-07-xx-xxx).`);
  const [, group, sub] = m as unknown as [string, string, string];
  const expense = DEPRECIATION_EXPENSE_BY_GROUP[group];
  const depreciable = !!expense && Number(sub) % 10 === 0;
  return {
    accumulatedDepreciationAccountCode: depreciable ? `1-07-${group}-${String(Number(sub) + 1).padStart(3, '0')}` : '',
    depreciationExpenseAccountCode: depreciable ? expense : '',
    depreciable,
  };
}

/** PPE code used in the property number: 1-07-05-020 → "05-020". */
export function ppeGroupCode(accountCode: string): string {
  const m = PPE_CODE.exec(accountCode);
  if (!m) throw new BfmsError('INVALID_ACCOUNT', `${accountCode} is not a PPE account (1-07-xx-xxx).`);
  return `${m[1]}-${m[2]}`;
}

/** Property number `YYYY-{PPEcode}-NNNN` (docs 04 §18), e.g. 2026-05-020-0003. */
export function formatPropertyNumber(year: number, accountCode: string, n: number): string {
  if (!Number.isInteger(n) || n <= 0) throw new Error('sequence number must be a positive integer');
  return `${year}-${ppeGroupCode(accountCode)}-${String(n).padStart(4, '0')}`;
}

// ------------------------------------------------------------------ periods ("YYYY-MM")

export function yearMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function addYearMonths(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return yearMonth(Math.floor(idx / 12), (idx % 12) + 1);
}

/**
 * First month of depreciation: acquired on the 1st–15th → that month; on the 16th or later →
 * the following month (GAM for LGUs, Vol. I, Ch. 10: "nearest whole month").
 */
export function depreciationStartPeriod(acquisitionDate: IsoDate | string): string {
  const p = acquisitionDate.slice(0, 7);
  return Number(acquisitionDate.slice(8, 10)) <= 15 ? p : addYearMonths(p, 1);
}

export interface DepreciableAsset {
  acquisitionCost: Centavos;
  residualValue: Centavos;
  usefulLifeYears: number;
  depreciationStartPeriod: string;
  /** Last month already depreciated (opening balance as-of month, or the last run). */
  lastDepreciatedPeriod?: string | null;
  accumulatedDepreciation: Centavos;
}

/**
 * Depreciation of one asset for `period`. Zero before the start period, once fully depreciated,
 * or when the month is already depreciated (idempotency is also enforced by the run documents).
 */
export function depreciationFor(asset: DepreciableAsset, period: string): Centavos {
  if (period < asset.depreciationStartPeriod) return 0 as Centavos;
  if (asset.lastDepreciatedPeriod && asset.lastDepreciatedPeriod >= period) return 0 as Centavos;
  return depreciationForMonth(asset.acquisitionCost, asset.residualValue, asset.usefulLifeYears, asset.accumulatedDepreciation);
}

/** Was a month skipped? (the previous period should have been depreciated but was not). */
export function hasDepreciationGap(asset: DepreciableAsset, period: string): boolean {
  const prev = addYearMonths(period, -1);
  if (prev < asset.depreciationStartPeriod) return false;
  if (asset.accumulatedDepreciation >= Math.max(0, asset.acquisitionCost - asset.residualValue)) return false;
  return (asset.lastDepreciatedPeriod ?? '') < prev;
}


// ------------------------------------------------------------------ inventory (moving average)

export interface StockState {
  quantityOnHand: number;
  unitCost: Centavos;
}

/** Moving-average cost after a receipt (rounded to the centavo). */
export function stockAfterReceipt(s: StockState, quantity: number, unitCost: Centavos | number): StockState {
  if (!(quantity > 0)) throw new BfmsError('VALIDATION_FAILED', 'Received quantity must be positive.');
  const qty = s.quantityOnHand + quantity;
  const value = Math.max(0, s.quantityOnHand) * s.unitCost + quantity * unitCost;
  return { quantityOnHand: roundQty(qty), unitCost: Math.round(value / qty) as Centavos };
}

/** Issue at the current moving-average cost; never more than on hand. */
export function stockAfterIssue(s: StockState, quantity: number, label = 'item'): StockState & { issueCost: Centavos } {
  if (!(quantity > 0)) throw new BfmsError('VALIDATION_FAILED', 'Issued quantity must be positive.');
  if (quantity > s.quantityOnHand + 1e-9)
    throw new BfmsError('VALIDATION_FAILED', `Cannot issue ${quantity} of ${label}: only ${s.quantityOnHand} on hand.`, { onHand: s.quantityOnHand, requested: quantity });
  return { quantityOnHand: roundQty(s.quantityOnHand - quantity), unitCost: s.unitCost, issueCost: Math.round(quantity * s.unitCost) as Centavos };
}

/** Quantities may carry 3 decimals (kg, liters); avoid float drift. */
export function roundQty(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function extendedCost(quantity: number, unitCost: Centavos | number): Centavos {
  return Math.round(quantity * unitCost) as Centavos;
}

export interface StockMovement {
  date: string;
  seq?: number;
  quantity: number; // signed
  unitCost: Centavos | number;
}

/** Running balances of a stock card, oldest first (by date, then posting sequence). */
export function stockCardBalances<T extends StockMovement>(movements: readonly T[]): Array<T & { balance: number }> {
  let bal = 0;
  return [...movements]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.seq ?? 0) - (b.seq ?? 0))
    .map((m) => {
      bal = roundQty(bal + m.quantity);
      return { ...m, balance: bal };
    });
}

// ------------------------------------------------------------------ biological assets

export type BioMovementKind = 'ACQUISITION' | 'BIRTH' | 'DEATH' | 'DISPOSITION';
export const BIO_INCREASES: readonly BioMovementKind[] = ['ACQUISITION', 'BIRTH'];

/** Apply a biological-asset movement: decreases carry out the average carrying amount per unit. */
export function applyBioMovement(
  s: { quantityOnHand: number; carryingAmount: Centavos },
  kind: BioMovementKind,
  quantity: number,
  value: Centavos | number = 0,
): { quantityOnHand: number; carryingAmount: Centavos; amount: Centavos } {
  if (!(quantity > 0)) throw new BfmsError('VALIDATION_FAILED', 'Quantity must be positive.');
  if (BIO_INCREASES.includes(kind)) return { quantityOnHand: s.quantityOnHand + quantity, carryingAmount: (s.carryingAmount + value) as Centavos, amount: value as Centavos };
  if (quantity > s.quantityOnHand) throw new BfmsError('VALIDATION_FAILED', `Only ${s.quantityOnHand} on hand.`);
  const amount = (quantity === s.quantityOnHand ? s.carryingAmount : Math.round((s.carryingAmount * quantity) / s.quantityOnHand)) as Centavos;
  return { quantityOnHand: s.quantityOnHand - quantity, carryingAmount: (s.carryingAmount - amount) as Centavos, amount };
}
