import type { Centavos, IsoDate } from '../types/common';
import type { PpeScheduleRow } from '../types/accountingSchedules';
import { DEFAULT_AGING_BUCKETS, daysBetween } from './cashAdvance';

/**
 * The two schedules the Municipal Accountant keeps beside each barangay's books, computed from
 * the JOURNAL (posted lines) plus the schedule documents (legacyCashAdvances, ppeSchedules):
 *   1. List / Aging of Unliquidated Cash Advances (legacy "List of Unliquidated Advances")
 *   2. PPE Depreciation Schedule (legacy "PPE Depreciation Schedule" / "PPE Depr")
 * Pure functions — used by the report builders (CA_AGING, PPE_DEPRECIATION), the schedule pages
 * and the generateDepreciationJev callable. Money is integer centavos.
 */

// =================================================================== 1. Cash advances

/** Advances for Payroll, Advances to Officers and Employees, and the 1-03-04-0xx receivables from officers. */
export const CA_SCHEDULE_ACCOUNTS = ['1-03-03-010', '1-03-03-020'] as const;

export function isCaScheduleAccount(code: string): boolean {
  return (CA_SCHEDULE_ACCOUNTS as readonly string[]).includes(code) || /^1-03-04-0\d\d$/.test(code);
}

/** A posted journal line on a CA account, with the header fields the schedule prints. */
export interface CaLedgerLine {
  jevId: string;
  jevNumber: string | null;
  jevDate: IsoDate;
  /** OPENING lines carry the balance brought forward; the legacy items detail it. */
  entryType: string;
  accountCode: string;
  subsidiaryId: string | null;
  debit: Centavos;
  credit: Centavos;
  primaryReference: string | null; // check no.
  secondaryReference: string | null; // DV no.
  lineDescription: string;
  particulars: string; // JEV header particulars (falls back to the line description)
  payeeName: string | null;
}

export interface CaLegacyItem {
  id: string;
  accountCode: string;
  subsidiaryId: string | null;
  officerName: string;
  date: IsoDate;
  checkNumber: string | null;
  dvNumber: string | null;
  particulars: string;
  amount: Centavos;
}

export interface CaOfficerInfo {
  name: string;
  code: string; // AO01 / EO05
}

export type CaItemSource = 'LEGACY' | 'JOURNAL' | 'BALANCE_FORWARD' | 'UNAPPLIED_CREDIT';

export interface CaApplication {
  jevId: string;
  jevNumber: string | null;
  date: IsoDate;
  amount: Centavos;
  targeted: boolean;
}

export interface CaScheduleItem {
  id: string;
  source: CaItemSource;
  accountCode: string;
  subsidiaryId: string | null;
  officerName: string;
  date: IsoDate;
  checkNumber: string | null;
  dvNumber: string | null;
  jevNumber: string | null;
  particulars: string;
  amount: Centavos;
  applied: Centavos;
  outstanding: Centavos;
  days: number;
  bucketIndex: number;
  bucket: string;
  applications: CaApplication[];
}

export interface CaCredit {
  jevId: string;
  jevNumber: string | null;
  date: IsoDate;
  particulars: string;
  reference: string | null;
  amount: Centavos;
  /** Part applied to an advance named in the reference / description. */
  targeted: Centavos;
  unapplied: Centavos;
}

export interface CaSlSchedule {
  key: string;
  accountCode: string;
  subsidiaryId: string | null;
  slCode: string;
  officerName: string;
  items: CaScheduleItem[]; // every advance (incl. fully liquidated)
  credits: CaCredit[];
  totalAdvances: Centavos;
  totalCredits: Centavos;
  /** Σ outstanding of the listed items (incl. negative / unapplied lines) = advances − credits. */
  scheduleBalance: Centavos;
  /** Posted GL/SL balance of account+SL as of the date (debit − credit, incl. opening). */
  ledgerBalance: Centavos;
  difference: Centavos;
  /** Opening (period 00) balance per ledger, and the legacy items that detail it. */
  openingLedger: Centavos;
  openingDetail: Centavos;
}

export interface CaOfficerGroup {
  officerName: string;
  items: CaScheduleItem[]; // outstanding (≠ 0) only, oldest first
  total: Centavos;
  bucketTotals: Centavos[];
}

export interface CaSchedule {
  asOf: IsoDate;
  buckets: ReadonlyArray<{ maxDays: number; label: string }>;
  sls: CaSlSchedule[];
  officers: CaOfficerGroup[];
  grandTotal: Centavos;
  bucketTotals: Centavos[];
  reconciled: boolean;
  differences: CaSlSchedule[];
}

const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * TARGETED-LIQUIDATION RULE: a credit (liquidation/refund) is applied first to the advance whose
 * check no. or DV no. appears — as a whole word, case-insensitive, at least 3 characters — in the
 * credit line's primaryReference or lineDescription (e.g. "Chk 1218491", "Liq. of DV 2026-03-001").
 * Whatever is left is applied FIFO to the officer's oldest open advances on the same account+SL.
 */
export function creditNamesAdvance(text: string, item: Pick<CaScheduleItem, 'checkNumber' | 'dvNumber'>): boolean {
  const t = norm(text);
  if (!t) return false;
  return [item.checkNumber, item.dvNumber].some((ref) => {
    const r = norm(ref);
    return r.length >= 3 && new RegExp(`(^|[^A-Z0-9])${escapeRe(r)}($|[^A-Z0-9])`).test(t);
  });
}

function bucketOf(days: number, buckets: ReadonlyArray<{ maxDays: number }>): number {
  const i = buckets.findIndex((b) => days <= b.maxDays);
  return i < 0 ? buckets.length - 1 : i;
}

export interface CaScheduleInput {
  fiscalYear: number;
  asOf: IsoDate;
  legacy: readonly CaLegacyItem[];
  lines: readonly CaLedgerLine[];
  officers?: ReadonlyMap<string, CaOfficerInfo>; // by subsidiaryId
  buckets?: ReadonlyArray<{ maxDays: number; label: string }>;
}

const slKey = (accountCode: string, subsidiaryId: string | null) => `${accountCode}|${subsidiaryId ?? '-'}`;

/**
 * Build the schedule. Per account+SL:
 *   advances = legacy items (fiscal year) + debits of the year's posted non-opening lines (≤ asOf)
 *   credits  = credits of the year's posted non-opening lines (≤ asOf), applied targeted then FIFO
 * Opening (period 00) lines are the balance brought forward; the legacy items detail them. When an
 * SL has an opening balance but NO legacy items, the balance is listed as one "balance forward"
 * line dated January 1 (add legacy items to age it properly).
 * Credits beyond the open advances are listed as a negative "unapplied credit" line (over-liquidation).
 * Reconciliation: Σ schedule = GL/SL balance; the difference is reported, never forced.
 */
export function buildCaSchedule(input: CaScheduleInput): CaSchedule {
  const { asOf, fiscalYear } = input;
  const buckets = input.buckets ?? DEFAULT_AGING_BUCKETS;
  const sls = new Map<string, CaSlSchedule>();
  const officerOf = (subsidiaryId: string | null, fallback: string) => (subsidiaryId && input.officers?.get(subsidiaryId)?.name) || fallback;
  const sl = (accountCode: string, subsidiaryId: string | null, nameHint: string): CaSlSchedule => {
    const k = slKey(accountCode, subsidiaryId);
    let s = sls.get(k);
    if (!s) {
      s = {
        key: k,
        accountCode,
        subsidiaryId,
        slCode: (subsidiaryId && input.officers?.get(subsidiaryId)?.code) || (subsidiaryId ? subsidiaryId.split('_').pop() ?? '' : ''),
        officerName: officerOf(subsidiaryId, nameHint || '(no subsidiary ledger)'),
        items: [],
        credits: [],
        totalAdvances: 0 as Centavos,
        totalCredits: 0 as Centavos,
        scheduleBalance: 0 as Centavos,
        ledgerBalance: 0 as Centavos,
        difference: 0 as Centavos,
        openingLedger: 0 as Centavos,
        openingDetail: 0 as Centavos,
      };
      sls.set(k, s);
    }
    return s;
  };
  const mkItem = (s: CaSlSchedule, x: Omit<CaScheduleItem, 'applied' | 'outstanding' | 'days' | 'bucketIndex' | 'bucket' | 'applications' | 'accountCode' | 'subsidiaryId' | 'officerName'>): CaScheduleItem => ({
    ...x,
    accountCode: s.accountCode,
    subsidiaryId: s.subsidiaryId,
    officerName: s.officerName,
    applied: 0 as Centavos,
    outstanding: x.amount,
    days: 0,
    bucketIndex: 0,
    bucket: '',
    applications: [],
  });

  for (const l of input.legacy) {
    if (!isCaScheduleAccount(l.accountCode)) continue;
    const s = sl(l.accountCode, l.subsidiaryId, l.officerName);
    s.items.push(mkItem(s, { id: l.id, source: 'LEGACY', date: l.date, checkNumber: l.checkNumber, dvNumber: l.dvNumber, jevNumber: null, particulars: l.particulars, amount: l.amount }));
    s.openingDetail = (s.openingDetail + l.amount) as Centavos;
  }

  const lines = input.lines
    .filter((l) => isCaScheduleAccount(l.accountCode) && l.jevDate <= asOf && l.entryType !== 'CLOSING')
    .sort((a, b) => a.jevDate.localeCompare(b.jevDate) || (a.jevNumber ?? '').localeCompare(b.jevNumber ?? ''));
  const credits: Array<{ s: CaSlSchedule; c: CaCredit; text: string }> = [];
  for (const l of lines) {
    const s = sl(l.accountCode, l.subsidiaryId, l.payeeName ?? '');
    s.ledgerBalance = (s.ledgerBalance + l.debit - l.credit) as Centavos;
    if (l.entryType === 'OPENING') {
      s.openingLedger = (s.openingLedger + l.debit - l.credit) as Centavos;
      continue;
    }
    const particulars = l.particulars || l.lineDescription || l.payeeName || '';
    if (l.debit > 0)
      s.items.push(mkItem(s, { id: `${l.jevId}:${s.items.length}`, source: 'JOURNAL', date: l.jevDate, checkNumber: l.primaryReference, dvNumber: l.secondaryReference, jevNumber: l.jevNumber, particulars, amount: l.debit }));
    if (l.credit > 0) {
      const c: CaCredit = { jevId: l.jevId, jevNumber: l.jevNumber, date: l.jevDate, particulars, reference: l.primaryReference, amount: l.credit, targeted: 0 as Centavos, unapplied: l.credit };
      s.credits.push(c);
      credits.push({ s, c, text: `${l.primaryReference ?? ''} ${l.lineDescription ?? ''}` });
    }
  }

  // Opening balance without legacy detail → one balance-forward line.
  for (const s of sls.values()) {
    if (s.openingLedger !== 0 && !s.items.some((i) => i.source === 'LEGACY'))
      s.items.push(mkItem(s, { id: `${s.key}:BF`, source: 'BALANCE_FORWARD', date: `${fiscalYear}-01-01`, checkNumber: null, dvNumber: null, jevNumber: null, particulars: 'Balance forward (no detail of advances)', amount: s.openingLedger }));
    s.items.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  }

  // Apply credits in date order: targeted first, then FIFO (oldest open advance first).
  const apply = (item: CaScheduleItem, c: CaCredit, amount: number, targeted: boolean) => {
    item.applied = (item.applied + amount) as Centavos;
    item.outstanding = (item.outstanding - amount) as Centavos;
    item.applications.push({ jevId: c.jevId, jevNumber: c.jevNumber, date: c.date, amount: amount as Centavos, targeted });
    c.unapplied = (c.unapplied - amount) as Centavos;
    if (targeted) c.targeted = (c.targeted + amount) as Centavos;
  };
  for (const { s, c, text } of credits) {
    const target = s.items.find((i) => i.outstanding > 0 && creditNamesAdvance(text, i));
    if (target) apply(target, c, Math.min(c.unapplied, target.outstanding), true);
    for (const i of s.items) {
      if (c.unapplied <= 0) break;
      if (i.outstanding > 0) apply(i, c, Math.min(c.unapplied, i.outstanding), false);
    }
  }

  for (const s of sls.values()) {
    for (const c of s.credits)
      if (c.unapplied > 0)
        s.items.push(mkItem(s, { id: `${c.jevId}:UNAPPLIED`, source: 'UNAPPLIED_CREDIT', date: c.date, checkNumber: c.reference, dvNumber: null, jevNumber: c.jevNumber, particulars: `Over-liquidation / unapplied credit: ${c.particulars}`, amount: -c.unapplied as Centavos }));
    for (const i of s.items) {
      i.days = Math.max(0, daysBetween(i.date, asOf));
      i.bucketIndex = bucketOf(i.days, buckets);
      i.bucket = buckets[i.bucketIndex]!.label;
    }
    s.totalAdvances = s.items.filter((i) => i.source !== 'UNAPPLIED_CREDIT').reduce((t, i) => t + i.amount, 0) as Centavos;
    s.totalCredits = s.credits.reduce((t, c) => t + c.amount, 0) as Centavos;
    s.scheduleBalance = s.items.reduce((t, i) => t + i.outstanding, 0) as Centavos;
    s.difference = (s.scheduleBalance - s.ledgerBalance) as Centavos;
  }

  const slList = [...sls.values()].sort((a, b) => a.officerName.localeCompare(b.officerName) || a.accountCode.localeCompare(b.accountCode) || a.slCode.localeCompare(b.slCode));
  const byOfficer = new Map<string, CaOfficerGroup>();
  for (const s of slList) {
    const k = norm(s.officerName);
    let g = byOfficer.get(k);
    if (!g) byOfficer.set(k, (g = { officerName: s.officerName, items: [], total: 0 as Centavos, bucketTotals: buckets.map(() => 0 as Centavos) }));
    for (const i of s.items) {
      if (i.outstanding === 0) continue;
      g.items.push(i);
      g.total = (g.total + i.outstanding) as Centavos;
      g.bucketTotals[i.bucketIndex] = (g.bucketTotals[i.bucketIndex]! + i.outstanding) as Centavos;
    }
  }
  const officers = [...byOfficer.values()].filter((g) => g.items.length).sort((a, b) => a.officerName.localeCompare(b.officerName));
  for (const g of officers) g.items.sort((a, b) => a.date.localeCompare(b.date) || a.accountCode.localeCompare(b.accountCode));
  const differences = slList.filter((s) => s.difference !== 0);
  return {
    asOf,
    buckets,
    sls: slList,
    officers,
    grandTotal: officers.reduce((t, g) => t + g.total, 0) as Centavos,
    bucketTotals: buckets.map((_, i) => officers.reduce((t, g) => t + g.bucketTotals[i]!, 0) as Centavos),
    reconciled: differences.length === 0,
    differences,
  };
}

// =================================================================== 2. PPE depreciation

/** Depreciable PPE asset account: 1-07-xx-xx0, excluding land, leased land and construction in progress. */
export function isDepreciablePpeAccount(code: string): boolean {
  if (!/^1-07-\d{2}-\d{2}0$/.test(code)) return false;
  return !['1-07-01-010', '1-07-08-010'].includes(code) && !code.startsWith('1-07-10-');
}

/** Contra account: 1-07-xx-xx0 → 1-07-xx-xx1 (legacy books). */
export function accumulatedDepreciationCode(code: string): string {
  return `${code.slice(0, -1)}1`;
}

const EXPENSE_BY_GROUP: Record<string, string> = {
  '02': '5-04-01-010', // land improvements
  '03': '5-04-01-020', // infrastructure
  '04': '5-04-01-030', // buildings and other structures
  '05': '5-04-01-040', // machinery and equipment
  '06': '5-04-01-050', // transportation
  '07': '5-04-01-060', // furniture, fixtures and books
  '08': '5-04-01-070', // leased assets
  '09': '5-04-01-080', // leased assets improvements
};

/**
 * Defaults per account group as the legacy schedules use them: land improvements, infrastructure
 * and buildings — residual 0 %, 10 years; equipment, vehicles, furniture, books, other PPE —
 * residual 5 %, 5 years. Every value is editable in the schedule.
 */
export function ppeDefaults(code: string): Omit<PpeScheduleRow, 'remarks' | 'costOverride'> {
  const g = code.slice(5, 7);
  const structures = ['02', '03', '04'].includes(g);
  return {
    accountCode: code,
    residualRateBp: structures ? 0 : 500,
    usefulLifeYears: structures ? 10 : 5,
    accumulatedAccountCode: accumulatedDepreciationCode(code),
    expenseAccountCode: EXPENSE_BY_GROUP[g] ?? '5-04-01-990',
  };
}

export function defaultPpeRow(code: string): PpeScheduleRow {
  return { ...ppeDefaults(code), costOverride: null, remarks: '' };
}

/** GL figures for one PPE row. */
export interface PpeGlFigures {
  /** Asset account balance (debit − credit) at the cost date. */
  cost: Centavos;
  /** Accumulated depreciation (credit − debit) brought into the period (before its depreciation). */
  accumulatedBefore: Centavos;
  /** Accumulated depreciation (credit − debit) at the end of the period per GL. */
  accumulatedEnd: Centavos;
}

export interface PpeComputedRow extends PpeScheduleRow {
  glCost: Centavos;
  cost: Centavos;
  residualValue: Centavos;
  depreciableAmount: Centavos;
  annualDepreciation: Centavos;
  monthlyDepreciation: Centavos;
  /** Depreciation for the period (year or month), capped at depreciable − accumulated before. */
  periodDepreciation: Centavos;
  accumulatedBefore: Centavos;
  accumulatedEnd: Centavos;
  netBookValue: Centavos;
  capped: boolean;
}

export interface PpeRecapLine {
  accountCode: string;
  debit: Centavos;
  credit: Centavos;
}

/**
 * Straight-line: residual = cost × rate; depreciable = cost − residual; annual = depreciable ÷ life;
 * monthly = depreciable ÷ (life × 12) (rounded to the centavo). The period's depreciation never
 * exceeds the depreciable amount less the accumulated depreciation brought in; rows that share an
 * accumulated account share that cap in schedule order.
 */
export function computePpeSchedule(rows: readonly PpeScheduleRow[], gl: ReadonlyMap<string, PpeGlFigures>, period: 'YEAR' | 'MONTH' = 'YEAR'): PpeComputedRow[] {
  const capacity = new Map<string, number>();
  const accBefore = new Map<string, number>();
  for (const r of rows) accBefore.set(r.accumulatedAccountCode, gl.get(r.accountCode)?.accumulatedBefore ?? 0);
  const prelim = rows.map((r) => {
    const f = gl.get(r.accountCode);
    const glCost = (f?.cost ?? 0) as Centavos;
    const cost = (r.costOverride ?? glCost) as Centavos;
    const residualValue = Math.round((cost * r.residualRateBp) / 10_000) as Centavos;
    const depreciableAmount = Math.max(0, cost - residualValue) as Centavos;
    const life = r.usefulLifeYears > 0 ? r.usefulLifeYears : 0;
    const annualDepreciation = (life ? Math.round(depreciableAmount / life) : 0) as Centavos;
    const monthlyDepreciation = (life ? Math.round(depreciableAmount / (life * 12)) : 0) as Centavos;
    capacity.set(r.accumulatedAccountCode, (capacity.get(r.accumulatedAccountCode) ?? 0) + depreciableAmount);
    return { r, glCost, cost, residualValue, depreciableAmount, annualDepreciation, monthlyDepreciation };
  });
  // Remaining capacity per accumulated account.
  const remaining = new Map<string, number>();
  for (const [acc, cap] of capacity) remaining.set(acc, Math.max(0, cap - (accBefore.get(acc) ?? 0)));
  return prelim.map(({ r, ...x }) => {
    const want = period === 'YEAR' ? x.annualDepreciation : x.monthlyDepreciation;
    const rem = remaining.get(r.accumulatedAccountCode) ?? 0;
    const periodDepreciation = Math.min(want, rem) as Centavos;
    remaining.set(r.accumulatedAccountCode, rem - periodDepreciation);
    const f = gl.get(r.accountCode);
    const accumulatedBefore = (f?.accumulatedBefore ?? 0) as Centavos;
    const accumulatedEnd = (f?.accumulatedEnd ?? 0) as Centavos;
    return {
      ...r,
      ...x,
      periodDepreciation,
      accumulatedBefore,
      accumulatedEnd,
      netBookValue: (x.cost - accumulatedEnd) as Centavos,
      capped: periodDepreciation < want,
    };
  });
}

/** Consolidated depreciation entry: Dr each expense account, Cr each accumulated depreciation account. */
export function depreciationJevLines(rows: readonly Pick<PpeComputedRow, 'expenseAccountCode' | 'accumulatedAccountCode' | 'periodDepreciation'>[]): PpeRecapLine[] {
  const dr = new Map<string, number>();
  const cr = new Map<string, number>();
  for (const r of rows) {
    if (r.periodDepreciation <= 0) continue;
    dr.set(r.expenseAccountCode, (dr.get(r.expenseAccountCode) ?? 0) + r.periodDepreciation);
    cr.set(r.accumulatedAccountCode, (cr.get(r.accumulatedAccountCode) ?? 0) + r.periodDepreciation);
  }
  return [
    ...[...dr.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([accountCode, v]) => ({ accountCode, debit: v as Centavos, credit: 0 as Centavos })),
    ...[...cr.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([accountCode, v]) => ({ accountCode, debit: 0 as Centavos, credit: v as Centavos })),
  ];
}

/** Period key of a depreciation run: 'YR' (year, Dec 31) or '01'…'12'. */
export function depreciationRunId(barangayId: string, fiscalYear: number, month: number | null): string {
  return `${barangayId}_${fiscalYear}_${month ? String(month).padStart(2, '0') : 'YR'}`;
}

/** Monthly movement row (accountBalances shape) for the PPE GL figures. */
export interface PpeBalanceRow {
  month: number;
  accountCode: string;
  subsidiaryId: string | null;
  debit: Centavos;
  credit: Centavos;
}

/**
 * GL figures from period movements (account roll-up rows): cost as of the end of `costMonth`;
 * accumulated before = months < `fromMonth` (opening is month 0); accumulated end = months ≤ `toMonth`.
 */
export function ppeGlFigures(rows: readonly PpeScheduleRow[], balances: readonly PpeBalanceRow[], opts: { costMonth: number; fromMonth: number; toMonth: number }): Map<string, PpeGlFigures> {
  const roll = balances.filter((b) => b.subsidiaryId === null);
  const net = (code: string, pred: (m: number) => boolean) => roll.filter((b) => b.accountCode === code && pred(b.month)).reduce((t, b) => t + b.debit - b.credit, 0);
  const out = new Map<string, PpeGlFigures>();
  for (const r of rows)
    out.set(r.accountCode, {
      cost: net(r.accountCode, (m) => m <= opts.costMonth) as Centavos,
      accumulatedBefore: -net(r.accumulatedAccountCode, (m) => m < opts.fromMonth) as Centavos,
      accumulatedEnd: -net(r.accumulatedAccountCode, (m) => m <= opts.toMonth) as Centavos,
    });
  return out;
}

/** Asset accounts that need a schedule row: depreciable PPE with a GL balance (as of `month`). */
export function ppeAccountsWithBalance(balances: readonly PpeBalanceRow[], month = 12): string[] {
  const m = new Map<string, number>();
  for (const b of balances) if (b.subsidiaryId === null && b.month <= month && isDepreciablePpeAccount(b.accountCode)) m.set(b.accountCode, (m.get(b.accountCode) ?? 0) + b.debit - b.credit);
  return [...m.entries()].filter(([, v]) => v !== 0).map(([k]) => k).sort();
}

/** Saved rows merged with defaults for accounts that have a balance but no saved row yet. */
export function mergePpeRows(saved: readonly PpeScheduleRow[] | null | undefined, accountsWithBalance: readonly string[]): PpeScheduleRow[] {
  const byCode = new Map((saved ?? []).map((r) => [r.accountCode, r]));
  for (const c of accountsWithBalance) if (!byCode.has(c)) byCode.set(c, defaultPpeRow(c));
  return [...byCode.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}
