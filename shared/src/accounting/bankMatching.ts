import type { ReconItem, ReconItemCategory } from '../types/bank';
import type { Centavos, IsoDate } from '../types/common';
import { computeBankReconciliation, totalReconItems, type ReconTotals } from './bankRecon';
import { parsePesos } from './money';

/**
 * Phase 9 — bank statement parsing and two-sided reconciliation matching (pure; shared by the
 * server callables, the reconciliation workspace preview and the report builders).
 * Bank perspective on statement lines: DEBIT = withdrawal (check paid, charge), CREDIT = deposit.
 */

// ------------------------------------------------------------------ statement lines

export interface StatementLineInput {
  date: IsoDate;
  reference: string;
  description: string;
  debit: Centavos;
  credit: Centavos;
}

export interface StatementLine extends StatementLineInput {
  /** Stable id (content hash) so classifications survive a re-paste of the same statement. */
  lineId: string;
  /** Running balance after this line (server-computed). */
  balance: Centavos;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function iso(y: number, m: number, d: number): IsoDate | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Statement dates as banks export them: 2026-03-05 · 03/05/2026 (MM/DD, LBP/PH usage) · 3/5/26 ·
 * 05-Mar-2026 · Mar 5, 2026 · 03/05 (needs `fiscalYear`).
 */
export function parseStatementDate(raw: string, fiscalYear?: number): IsoDate | null {
  const s = raw.trim().replace(/\s+/g, ' ');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) return iso(+m[3]!, +m[1]!, +m[2]!);
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ ,-]+(\d{2}|\d{4})$/.exec(s);
  if (m) return MONTHS[m[2]!.slice(0, 3).toLowerCase()] ? iso(+m[3]!, MONTHS[m[2]!.slice(0, 3).toLowerCase()]!, +m[1]!) : null;
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s);
  if (m) return MONTHS[m[1]!.slice(0, 3).toLowerCase()] ? iso(+m[3]!, MONTHS[m[1]!.slice(0, 3).toLowerCase()]!, +m[2]!) : null;
  m = /^(\d{1,2})[/-](\d{1,2})$/.exec(s);
  if (m && fiscalYear) return iso(fiscalYear, +m[1]!, +m[2]!);
  return null;
}

/** Split one CSV row (RFC-4180 quotes) or TSV row. */
function splitRow(line: string, delim: string): string[] {
  if (delim === '\t') return line.split('\t').map((c) => c.trim());
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) (out.push(cur.trim()), (cur = ''));
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

type ColKey = 'date' | 'reference' | 'description' | 'debit' | 'credit';
const HEADER_WORDS: Array<[ColKey, RegExp]> = [
  ['date', /^(txn |trans(action)? |value |posting )?date$/i],
  ['reference', /^(ref(erence)?|check|cheque|chk|check ?no\.?|cheque ?no\.?|ref ?no\.?|doc(ument)? ?no\.?|sn)$/i],
  ['description', /^(desc(ription)?|particulars|details|narration|transaction|remarks)$/i],
  ['debit', /^(debit|debits|withdrawals?|dr|amount debited)$/i],
  ['credit', /^(credit|credits|deposits?|cr|amount credited)$/i],
];

export interface PasteResult {
  lines: StatementLineInput[];
  errors: Array<{ row: number; message: string }>;
}

/**
 * Parse statement lines pasted from a spreadsheet or a bank CSV export.
 * Columns: date, reference/check no., description, debit, credit (a trailing balance column is
 * ignored). A header row with recognisable names may reorder the columns.
 */
export function parseStatementPaste(text: string, fiscalYear?: number): PasteResult {
  const rows = text.replace(/\r\n?/g, '\n').split('\n').filter((r) => r.trim() !== '');
  const delim = rows.some((r) => r.includes('\t')) ? '\t' : rows.some((r) => r.includes(';')) && !rows.some((r) => r.includes(',')) ? ';' : ',';
  let map: Record<ColKey, number> = { date: 0, reference: 1, description: 2, debit: 3, credit: 4 };
  const lines: StatementLineInput[] = [];
  const errors: PasteResult['errors'] = [];
  rows.forEach((raw, i) => {
    const cells = splitRow(raw, delim);
    const date = parseStatementDate(cells[map.date] ?? '', fiscalYear);
    if (!date) {
      // A header row (first non-date row) may name the columns.
      const named: Partial<Record<ColKey, number>> = {};
      cells.forEach((c, idx) => {
        const hit = HEADER_WORDS.find(([, re]) => re.test(c.trim()));
        if (hit && named[hit[0]] === undefined) named[hit[0]] = idx;
      });
      if (lines.length === 0 && named.date !== undefined && (named.debit !== undefined || named.credit !== undefined)) map = { ...map, ...named };
      else if (lines.length > 0 || i > 0 || !/[a-z]/i.test(raw)) errors.push({ row: i + 1, message: `Unrecognised date "${cells[map.date] ?? ''}".` });
      return;
    }
    try {
      const debit = parsePesos(cells[map.debit] ?? '');
      const credit = parsePesos(cells[map.credit] ?? '');
      if (debit < 0 || credit < 0) throw new Error('Amounts must not be negative; use the debit or the credit column.');
      if ((debit > 0) === (credit > 0)) throw new Error(debit > 0 ? 'A line cannot have both a debit and a credit.' : 'The line has no amount.');
      lines.push({ date, reference: (cells[map.reference] ?? '').slice(0, 60), description: (cells[map.description] ?? '').slice(0, 200), debit, credit });
    } catch (e) {
      errors.push({ row: i + 1, message: (e as Error).message });
    }
  });
  return { lines, errors };
}

/** FNV-1a 32-bit, base36 — short deterministic ids (not security relevant). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

/** Digits of a check/reference number without leading zeros ("CHK 0001762250" → "1762250"). */
export function normalizeRef(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

/**
 * Assign stable line ids and running balances. A kept `lineId` survives edits of the line; new
 * lines get a content id (date|ref|amounts) so re-pasting the same statement keeps classifications.
 */
export function buildStatementLines(beginningBalance: Centavos, input: ReadonlyArray<StatementLineInput & { lineId?: string | null }>) {
  const used = new Set<string>();
  let bal = beginningBalance as number;
  let totalDebits = 0;
  let totalCredits = 0;
  const lines: StatementLine[] = input.map((l) => {
    let id = l.lineId && !used.has(l.lineId) ? l.lineId : null;
    if (!id) {
      const base = `L${fnv1a(`${l.date}|${normalizeRef(l.reference) || l.reference.trim().toUpperCase()}|${l.debit}|${l.credit}`)}`;
      id = base;
      for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
    }
    used.add(id);
    bal += l.credit - l.debit;
    totalDebits += l.debit;
    totalCredits += l.credit;
    return { lineId: id, date: l.date, reference: l.reference.trim(), description: l.description.trim(), debit: l.debit, credit: l.credit, balance: bal as Centavos };
  });
  return { lines, totalDebits: totalDebits as Centavos, totalCredits: totalCredits as Centavos, computedEndingBalance: bal as Centavos };
}

// ------------------------------------------------------------------ classification of bank items

/** How an unmatched bank line is treated (the user's one-click classification). */
export type LineClass = 'BANK_CHARGES' | 'BANK_DEBIT_MEMO' | 'INTEREST_INCOME' | 'BANK_CREDIT_MEMO' | 'BANK_ERROR' | 'OTHER_BANK' | 'CLEARED_PRIOR';

export const LINE_CLASSES: ReadonlyArray<{ value: LineClass; label: string; side: 'DEBIT' | 'CREDIT' | 'BOTH'; hint: string }> = [
  { value: 'BANK_CHARGES', label: 'Bank charges', side: 'DEBIT', hint: 'Unrecorded in the books — deduct from the book balance; record a debit memo.' },
  { value: 'BANK_DEBIT_MEMO', label: 'Debit memo', side: 'DEBIT', hint: 'Unrecorded in the books — deduct from the book balance; record a debit memo.' },
  { value: 'INTEREST_INCOME', label: 'Interest earned', side: 'CREDIT', hint: 'Unrecorded in the books — add to the book balance; record a credit memo.' },
  { value: 'BANK_CREDIT_MEMO', label: 'Credit memo', side: 'CREDIT', hint: 'Unrecorded in the books — add to the book balance; record a credit memo.' },
  { value: 'BANK_ERROR', label: 'Bank error', side: 'BOTH', hint: 'The bank posted it in error — reverse it on the bank side.' },
  { value: 'OTHER_BANK', label: 'Other (bank side)', side: 'BOTH', hint: 'Other reconciling item on the bank side.' },
  { value: 'CLEARED_PRIOR', label: 'Clears a pre-BFMS item', side: 'BOTH', hint: 'Settles a check/deposit outstanding before BFMS — no reconciling effect this month.' },
];

export function lineClassAllowed(cls: LineClass, line: Pick<StatementLineInput, 'debit'>): boolean {
  const side = LINE_CLASSES.find((c) => c.value === cls)?.side;
  return side === 'BOTH' || (side === 'DEBIT') === line.debit > 0;
}

/** Default classification from the bank's description (LBP: "SVC CHG", "INT CR", "DM", "CM"). */
export function suggestLineClass(line: Pick<StatementLineInput, 'debit' | 'description' | 'reference'>): LineClass {
  const t = `${line.description} ${line.reference}`.toLowerCase();
  if (line.debit > 0) return /charge|chg|fee|svc|service|penalt|dormanc|maint|w\/?tax|tax/.test(t) ? 'BANK_CHARGES' : 'BANK_DEBIT_MEMO';
  return /interest|\bint\b|int\.? ?cr|int earned/.test(t) ? 'INTEREST_INCOME' : 'BANK_CREDIT_MEMO';
}

// ------------------------------------------------------------------ book-side inputs

export interface ReconCheck {
  id: string;
  checkNumber: string;
  checkDate: IsoDate;
  amount: Centavos;
  payeeName: string;
  dvId: string | null;
  status: string;
  clearedDate: IsoDate | null;
}
export interface ReconDeposit {
  id: string;
  depositDate: IsoDate;
  /** validatedAmount ?? amount */
  amount: Centavos;
  reference: string;
  status: string;
  bankReconciledDate: IsoDate | null;
}
/** Advice to Debit Account — behaves like a check that clears on its date. */
export interface ReconAda {
  id: string;
  adaDate: IsoDate;
  adaNumber: string;
  amount: Centavos;
  payeeName: string;
  status: string;
  clearedDate: IsoDate | null;
}
export interface ReconMemo {
  id: string;
  memoType: 'DEBIT' | 'CREDIT';
  category: MemoCategory;
  memoDate: IsoDate;
  amount: Centavos;
  memoNumber: string | null;
  bankReference: string;
  particulars: string;
  statementLineId: string | null;
  /** The memo's JEV is posted (jevNumber set). */
  posted: boolean;
  jevId: string | null;
  status: string;
}
export type MemoCategory = 'BANK_CHARGES' | 'INTEREST_INCOME' | 'OTHER';

export interface ManualReconItem {
  id: string;
  category: ReconItemCategory;
  date: IsoDate;
  reference: string;
  name: string;
  /** Unsigned for DIT/OC/memo categories; signed for errors and "other". */
  amount: Centavos;
  remarks: string;
}

export type SourceCollection = 'checks' | 'deposits' | 'adas' | 'bankMemos';

export interface ManualMatch {
  lineId: string;
  sourceCollection: SourceCollection;
  sourceId: string;
}

export interface ReconMatch extends ManualMatch {
  amount: Centavos;
  /** Statement (clearing) date. */
  date: IsoDate;
  how: 'CHECK_NO' | 'AMOUNT_DATE' | 'MEMO' | 'MANUAL';
}

/** A stored reconciliation item (bankReconciliations/{id}/items). */
export interface ReconItemRecord extends ReconItem {
  seq: number;
  side: 'BOOK' | 'BANK';
  statementLineId: string | null;
  sourceCollection: SourceCollection | null;
  /** Classification came from the description heuristic, not from a person. */
  suggested: boolean;
}

const UNISSUED = ['PREPARED', 'CANCELLED', 'VOID', 'DRAFT'];

/** Check (or ADA) still outstanding at `asOf`: issued on/before it and not cleared by then. */
export function isOutstandingAt(c: { status: string; clearedDate: IsoDate | null }, date: IsoDate, asOf: IsoDate): boolean {
  return !UNISSUED.includes(c.status) && date <= asOf && (!c.clearedDate || c.clearedDate > asOf);
}

/** Checks that may clear on this month's statement (issued by month-end, not cleared before it). */
export function isCheckCandidate(c: ReconCheck, monthStart: IsoDate, monthEnd: IsoDate): boolean {
  return !UNISSUED.includes(c.status) && c.checkDate <= monthEnd && (!c.clearedDate || c.clearedDate >= monthStart);
}
export function isAdaCandidate(a: ReconAda, monthStart: IsoDate, monthEnd: IsoDate): boolean {
  return !UNISSUED.includes(a.status) && a.adaDate <= monthEnd && (!a.clearedDate || a.clearedDate >= monthStart);
}
export function isDepositCandidate(d: ReconDeposit, monthStart: IsoDate, monthEnd: IsoDate): boolean {
  return !['VOID', 'CANCELLED'].includes(d.status) && d.depositDate <= monthEnd && (!d.bankReconciledDate || d.bankReconciledDate >= monthStart);
}

function dayNum(d: IsoDate): number {
  return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysFrom(from: IsoDate, to: IsoDate): number {
  return dayNum(to) - dayNum(from);
}

/** A check is stale six months after its date (COA / BSP practice). */
export function isStaleCheck(checkDate: IsoDate, asOf: IsoDate): boolean {
  const y = +checkDate.slice(0, 4);
  const m = +checkDate.slice(5, 7) + 6;
  const d = +checkDate.slice(8, 10);
  const yy = y + Math.floor((m - 1) / 12);
  const mm = ((m - 1) % 12) + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const staleOn = `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  return asOf > staleOn;
}

// ------------------------------------------------------------------ reconciliation

export interface ReconInput {
  monthStart: IsoDate;
  monthEnd: IsoDate;
  bookBalance: Centavos;
  bankBalance: Centavos;
  lines: readonly StatementLine[];
  checks: readonly ReconCheck[];
  deposits: readonly ReconDeposit[];
  adas: readonly ReconAda[];
  memos: readonly ReconMemo[];
  classifications: Readonly<Record<string, LineClass>>;
  manualItems: readonly ManualReconItem[];
  manualMatches: readonly ManualMatch[];
  /** A deposit may reach the statement up to this many days after the deposit slip date. */
  depositWindowDays?: number;
}

export interface ReconResult extends ReturnType<typeof computeBankReconciliation> {
  matches: ReconMatch[];
  items: ReconItemRecord[];
  totals: ReconTotals;
  /** Effective class of every unmatched line (saved or suggested). */
  lineClasses: Record<string, { cls: LineClass; suggested: boolean; memoId: string | null }>;
  /** Manual matches that could not be applied (wrong side/amount, item already matched). */
  rejectedMatches: Array<ManualMatch & { reason: string }>;
}

const SIDE: Record<ReconItemCategory, 'BOOK' | 'BANK'> = {
  DEPOSIT_IN_TRANSIT: 'BANK',
  OUTSTANDING_CHECK: 'BANK',
  BANK_ERROR: 'BANK',
  OTHER_BANK: 'BANK',
  BANK_DEBIT_MEMO: 'BOOK',
  BANK_CREDIT_MEMO: 'BOOK',
  BANK_CHARGES: 'BOOK',
  INTEREST_INCOME: 'BOOK',
  BOOK_ERROR: 'BOOK',
  OTHER_BOOK: 'BOOK',
};
export function reconSide(c: ReconItemCategory): 'BOOK' | 'BANK' {
  return SIDE[c];
}

/** Print/report order of the categories. */
export const RECON_CATEGORY_ORDER: readonly ReconItemCategory[] = [
  'DEPOSIT_IN_TRANSIT', 'OUTSTANDING_CHECK', 'BANK_ERROR', 'OTHER_BANK',
  'BANK_CREDIT_MEMO', 'INTEREST_INCOME', 'BANK_DEBIT_MEMO', 'BANK_CHARGES', 'BOOK_ERROR', 'OTHER_BOOK',
];
export const RECON_CATEGORY_LABELS: Record<ReconItemCategory, string> = {
  DEPOSIT_IN_TRANSIT: 'Deposits in transit',
  OUTSTANDING_CHECK: 'Outstanding checks',
  BANK_ERROR: 'Bank errors',
  OTHER_BANK: 'Other bank-side items',
  BANK_CREDIT_MEMO: 'Credit memos',
  INTEREST_INCOME: 'Interest earned',
  BANK_DEBIT_MEMO: 'Debit memos',
  BANK_CHARGES: 'Bank charges',
  BOOK_ERROR: 'Book errors',
  OTHER_BOOK: 'Other book-side items',
};
/** Categories whose amount is signed (errors, other); the rest are entered positive. */
export const SIGNED_CATEGORIES: readonly ReconItemCategory[] = ['BOOK_ERROR', 'BANK_ERROR', 'OTHER_BOOK', 'OTHER_BANK'];

function memoCategoryOf(m: Pick<ReconMemo, 'memoType' | 'category'>): ReconItemCategory {
  if (m.memoType === 'DEBIT') return m.category === 'BANK_CHARGES' ? 'BANK_CHARGES' : 'BANK_DEBIT_MEMO';
  return m.category === 'INTEREST_INCOME' ? 'INTEREST_INCOME' : 'BANK_CREDIT_MEMO';
}

/**
 * Two-sided ("adjusted balance") reconciliation of one bank account for one month:
 *  1. person-made matches; 2. checks by check no. + amount; 3. memos (linked line, else
 *  amount/type/date); 4. ADAs by number or date; 5. deposits by amount within a date window.
 * Unmatched book items → outstanding checks / deposits in transit (bank side).
 * Unmatched bank lines → memos, charges, interest (book side) or bank errors, as classified.
 */
export function buildReconciliation(inp: ReconInput): ReconResult {
  const window = inp.depositWindowDays ?? 7;
  const lines = [...inp.lines];
  const lineById = new Map(lines.map((l) => [l.lineId, l]));
  const usedLines = new Map<string, ReconMatch>();
  const usedSrc = new Set<string>();
  const matches: ReconMatch[] = [];
  const rejectedMatches: ReconResult['rejectedMatches'] = [];
  const checks = inp.checks.filter((c) => isCheckCandidate(c, inp.monthStart, inp.monthEnd)).sort((a, b) => a.checkDate.localeCompare(b.checkDate) || a.checkNumber.localeCompare(b.checkNumber));
  const adas = inp.adas.filter((a) => isAdaCandidate(a, inp.monthStart, inp.monthEnd)).sort((a, b) => a.adaDate.localeCompare(b.adaDate));
  const deposits = inp.deposits.filter((d) => isDepositCandidate(d, inp.monthStart, inp.monthEnd)).sort((a, b) => a.depositDate.localeCompare(b.depositDate));
  const memos = inp.memos.filter((m) => !['VOID', 'CANCELLED'].includes(m.status) && m.memoDate <= inp.monthEnd && m.memoDate >= inp.monthStart);

  const match = (l: StatementLine, sourceCollection: SourceCollection, sourceId: string, how: ReconMatch['how']) => {
    const m: ReconMatch = { lineId: l.lineId, sourceCollection, sourceId, amount: (l.debit || l.credit) as Centavos, date: l.date, how };
    usedLines.set(l.lineId, m);
    usedSrc.add(`${sourceCollection}:${sourceId}`);
    matches.push(m);
  };
  const free = (l: StatementLine) => !usedLines.has(l.lineId);

  // 1. Matches made by a person in the workspace.
  const pools: Record<SourceCollection, Map<string, { amount: number; debitSide: boolean }>> = {
    checks: new Map(checks.map((c) => [c.id, { amount: c.amount, debitSide: true }])),
    adas: new Map(adas.map((a) => [a.id, { amount: a.amount, debitSide: true }])),
    deposits: new Map(deposits.map((d) => [d.id, { amount: d.amount, debitSide: false }])),
    bankMemos: new Map(memos.map((m) => [m.id, { amount: m.amount, debitSide: m.memoType === 'DEBIT' }])),
  };
  for (const mm of inp.manualMatches) {
    const l = lineById.get(mm.lineId);
    const src = pools[mm.sourceCollection]?.get(mm.sourceId);
    const reason = !l ? 'statement line not found' : !src ? 'book item is not open this month' : !free(l) || usedSrc.has(`${mm.sourceCollection}:${mm.sourceId}`) ? 'already matched' : src.debitSide !== l.debit > 0 ? 'wrong side (debit vs credit)' : src.amount !== (l.debit || l.credit) ? 'amounts differ' : null;
    if (reason) rejectedMatches.push({ ...mm, reason });
    else match(l!, mm.sourceCollection, mm.sourceId, 'MANUAL');
  }

  // 2. Checks: check number + amount on a debit line (reference first, then the description).
  for (const c of checks) {
    if (usedSrc.has(`checks:${c.id}`)) continue;
    const no = normalizeRef(c.checkNumber);
    if (!no) continue;
    const l =
      lines.find((x) => free(x) && x.debit === c.amount && normalizeRef(x.reference) === no) ??
      lines.find((x) => free(x) && x.debit === c.amount && !normalizeRef(x.reference) && new RegExp(`(^|\\D)0*${no}(\\D|$)`).test(x.description));
    if (l) match(l, 'checks', c.id, 'CHECK_NO');
  }

  // 3. Memos recorded in BFMS: the linked line, else same type + amount within 3 days.
  for (const m of memos) {
    if (usedSrc.has(`bankMemos:${m.id}`)) continue;
    const debitSide = m.memoType === 'DEBIT';
    const fits = (x: StatementLine) => free(x) && (debitSide ? x.debit : x.credit) === m.amount && (x.debit > 0) === debitSide;
    const linked = m.statementLineId ? lineById.get(m.statementLineId) : undefined;
    const l = linked && fits(linked) ? linked : m.statementLineId && linked ? undefined : closest(lines.filter((x) => fits(x) && Math.abs(daysFrom(m.memoDate, x.date)) <= 3), m.memoDate);
    if (l) match(l, 'bankMemos', m.id, 'MEMO');
  }

  // 4. ADAs: number on the line, else amount within 3 days of the ADA date.
  for (const a of adas) {
    if (usedSrc.has(`adas:${a.id}`)) continue;
    const no = normalizeRef(a.adaNumber);
    const l =
      (no ? lines.find((x) => free(x) && x.debit === a.amount && normalizeRef(x.reference) === no) : undefined) ??
      closest(lines.filter((x) => free(x) && x.debit === a.amount && Math.abs(daysFrom(a.adaDate, x.date)) <= 3), a.adaDate);
    if (l) match(l, 'adas', a.id, 'AMOUNT_DATE');
  }

  // 5. Deposits: amount on a credit line dated from the day before to `window` days after.
  for (const d of deposits) {
    if (usedSrc.has(`deposits:${d.id}`)) continue;
    const l = closest(lines.filter((x) => free(x) && x.credit === d.amount && daysFrom(d.depositDate, x.date) >= -1 && daysFrom(d.depositDate, x.date) <= window), d.depositDate);
    if (l) match(l, 'deposits', d.id, 'AMOUNT_DATE');
  }

  // ---- items
  const items: Omit<ReconItemRecord, 'seq'>[] = [];
  const add = (i: Omit<ReconItemRecord, 'seq' | 'side' | 'jevId' | 'requiresJev'> & { jevId?: string | null; requiresJev?: boolean }) =>
    items.push({ ...i, side: SIDE[i.category], jevId: i.jevId ?? null, requiresJev: i.requiresJev ?? false });

  for (const c of checks)
    if (!usedSrc.has(`checks:${c.id}`))
      add({ category: 'OUTSTANDING_CHECK', date: c.checkDate, reference: c.checkNumber, name: c.payeeName, amount: c.amount, sourceType: 'CHECK', sourceId: c.id, sourceCollection: 'checks', statementLineId: null, remarks: '', suggested: false });
  for (const a of adas)
    if (!usedSrc.has(`adas:${a.id}`))
      add({ category: 'OUTSTANDING_CHECK', date: a.adaDate, reference: `ADA ${a.adaNumber}`.trim(), name: a.payeeName, amount: a.amount, sourceType: 'CHECK', sourceId: a.id, sourceCollection: 'adas', statementLineId: null, remarks: 'ADA not yet debited by the bank', suggested: false });
  for (const d of deposits)
    if (!usedSrc.has(`deposits:${d.id}`))
      add({ category: 'DEPOSIT_IN_TRANSIT', date: d.depositDate, reference: d.reference, name: 'Deposit', amount: d.amount, sourceType: 'DEPOSIT', sourceId: d.id, sourceCollection: 'deposits', statementLineId: null, remarks: '', suggested: false });

  const lineClasses: ReconResult['lineClasses'] = {};
  const memoByLine = new Map(matches.filter((m) => m.sourceCollection === 'bankMemos').map((m) => [m.lineId, memos.find((x) => x.id === m.sourceId)!]));
  for (const l of lines) {
    const memo = memoByLine.get(l.lineId);
    if (memo) {
      // On the statement and recorded as a memo: reconciling only until its JEV is posted.
      if (!memo.posted)
        add({ category: memoCategoryOf(memo), date: l.date, reference: memo.memoNumber ?? l.reference, name: memo.particulars || l.description, amount: memo.amount, sourceType: 'BANK_MEMO', sourceId: memo.id, sourceCollection: 'bankMemos', statementLineId: l.lineId, remarks: 'Memo recorded; JEV not yet posted', jevId: memo.jevId, requiresJev: true, suggested: false });
      continue;
    }
    if (usedLines.has(l.lineId)) continue;
    const saved = inp.classifications[l.lineId];
    const cls = saved && lineClassAllowed(saved, l) ? saved : suggestLineClass(l);
    lineClasses[l.lineId] = { cls, suggested: !saved || cls !== saved, memoId: null };
    if (cls === 'CLEARED_PRIOR') continue;
    const signed = cls === 'BANK_ERROR' || cls === 'OTHER_BANK';
    add({
      category: cls,
      date: l.date,
      reference: l.reference,
      name: l.description,
      // Bank-side reversal: an erroneous debit is added back, an erroneous credit deducted.
      amount: (signed ? l.debit - l.credit : l.debit || l.credit) as Centavos,
      sourceType: signed ? 'MANUAL' : 'BANK_MEMO',
      sourceId: null,
      sourceCollection: null,
      statementLineId: l.lineId,
      remarks: signed ? '' : 'Not yet recorded in the books',
      requiresJev: !signed,
      suggested: lineClasses[l.lineId]!.suggested,
    });
  }
  // Memos posted in the books but not (yet) on the statement: the bank will take them up later.
  for (const m of memos)
    if (m.posted && !usedSrc.has(`bankMemos:${m.id}`))
      add({ category: 'OTHER_BANK', date: m.memoDate, reference: m.memoNumber ?? '', name: `${m.memoType === 'DEBIT' ? 'Debit' : 'Credit'} memo not on the statement: ${m.particulars}`, amount: (m.memoType === 'DEBIT' ? -m.amount : m.amount) as Centavos, sourceType: 'BANK_MEMO', sourceId: m.id, sourceCollection: 'bankMemos', statementLineId: null, remarks: '', suggested: false });
  for (const mi of inp.manualItems)
    add({ category: mi.category, date: mi.date, reference: mi.reference, name: mi.name, amount: mi.amount, sourceType: 'MANUAL', sourceId: mi.id, sourceCollection: null, statementLineId: null, remarks: mi.remarks, suggested: false });

  const order = (c: ReconItemCategory) => RECON_CATEGORY_ORDER.indexOf(c);
  const sorted = items
    .sort((a, b) => order(a.category) - order(b.category) || a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference))
    .map((i, k) => ({ ...i, seq: k + 1 }));
  const totals = totalReconItems(sorted);
  return { ...computeBankReconciliation(inp.bookBalance, inp.bankBalance, totals), matches, items: sorted, totals, lineClasses, rejectedMatches };
}

function closest(lines: StatementLine[], date: IsoDate): StatementLine | undefined {
  return lines.sort((a, b) => Math.abs(daysFrom(date, a.date)) - Math.abs(daysFrom(date, b.date)) || a.date.localeCompare(b.date))[0];
}

/** GL book balance (debit − credit) of one subsidiary ledger from accountBalances rows, months 0..month. */
export function bookBalanceFromRows(
  rows: ReadonlyArray<{ accountCode: string; subsidiaryId: string | null; month: number; debit: number; credit: number }>,
  accountCode: string,
  subsidiaryId: string,
  month: number,
): Centavos {
  let t = 0;
  for (const r of rows) if (r.accountCode === accountCode && r.subsidiaryId === subsidiaryId && r.month <= month) t += r.debit - r.credit;
  return t as Centavos;
}
