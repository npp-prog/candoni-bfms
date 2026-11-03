import type { ReconItem, ReconItemCategory } from '../types/bank';
import type { Centavos, IsoDate } from '../types/common';
import { computeBankReconciliation, totalReconItems, type ReconTotals } from './bankRecon';
import { parsePesos } from './money';

/**
 * Bank statement parsing and the journal-based bank reconciliation (pure; shared by the server
 * callables, the reconciliation workspace and the report builders).
 *
 * The Municipal Accounting Office keeps each barangay's books from the documents the barangay
 * submits, so — exactly like the legacy workbook (04.1 Checks Issued · 04.2 Checks Encashed ·
 * 04.3 Schedule 1 · 04.4 Schedule 2 · 04 BR) — the book side is the JOURNAL: posted lines on
 * Cash in Bank (1-01-02-010) and the bank account's CIB## ledger.
 *   credit + check no. (primaryReference)  → check issued
 *   credit without a check no.             → other book disbursement (charges recorded, transfers, ADA)
 *   debit                                  → deposit / credit (RCD deposits, NTA "BS" credits, interest)
 * Bank perspective on statement lines: DEBIT = withdrawal (check encashed, charge), CREDIT = deposit.
 */

// ------------------------------------------------------------------ statement lines

export interface StatementLineInput {
  date: IsoDate;
  reference: string;
  description: string;
  debit: Centavos;
  credit: Centavos;
  /** Check number of an encashed check (legacy 04.2 "Check No." column); derived from the reference when absent. */
  checkNumber?: string | null;
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
 * 05-Mar-2026 · Mar 5, 2026 · 03/05 (needs `fiscalYear`). A trailing time (the legacy
 * ChecksEncashed sheet stores "1/13/2025 23:59:59") is ignored.
 */
export function parseStatementDate(raw: string, fiscalYear?: number): IsoDate | null {
  const s = raw.trim().replace(/\s+/g, ' ').replace(/[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?( ?[AP]M)?Z?$/i, '');
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

type ColKey = 'date' | 'reference' | 'description' | 'debit' | 'credit' | 'balance';
const HEADER_WORDS: Array<[ColKey, RegExp]> = [
  ['date', /^(txn |trans(action)? |value |posting )?date$|^month$/i],
  ['reference', /^(ref(erence)?|check|cheque|chk|check ?no\.?|cheque ?no\.?|chk ?no\.?|ref ?no\.?|doc(ument)? ?no\.?|sn)$/i],
  ['description', /^(desc(ription)?|particulars|details|narration|transaction|remarks)$/i],
  ['debit', /^(debit|debits|debit amount|withdrawals?|dr|amount debited)$/i],
  ['credit', /^(credit|credits|credit amount|deposits?|cr|amount credited)$/i],
  ['balance', /^(running )?balance$/i],
];

export interface PasteResult {
  lines: StatementLineInput[];
  errors: Array<{ row: number; message: string }>;
  /** A "Balance" row without a date (legacy 04.2 first row: balance brought forward). */
  beginningBalance?: Centavos;
  /** An "Ending Balance" row (legacy 04.2 heading). */
  endingBalance?: Centavos;
  /** The rows were read in the legacy ChecksEncashed layout (date, check no., debit, credit, balance). */
  legacyLayout?: boolean;
}

const isAmountCell = (s: string | undefined) => !s || /^\(?-?[₱P]?\s*[\d,]*\.?\d*\)?$/i.test(s.trim());
const lastAmount = (cells: string[]): Centavos | undefined => {
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i]!.trim();
    if (c && /\d/.test(c) && isAmountCell(c)) {
      try {
        return parsePesos(c);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

/**
 * Parse statement lines pasted from a spreadsheet or a bank CSV export. Two layouts:
 *  - bank export: date, reference/check no., description, debit, credit (a balance column is ignored);
 *  - legacy 04.2 ChecksEncashed: date, check no., debit, credit, (balance) — detected from the
 *    header ("Month · Check No. · Debit Amount · Credit Amount · Balance") or from the cells.
 * A header row with recognisable names may reorder the columns. "Balance" / "Ending Balance" rows
 * are read as the statement's beginning / ending balance.
 */
export function parseStatementPaste(text: string, fiscalYear?: number): PasteResult {
  const rows = text.replace(/\r\n?/g, '\n').split('\n').filter((r) => r.trim() !== '');
  const delim = rows.some((r) => r.includes('\t')) ? '\t' : rows.some((r) => r.includes(';')) && !rows.some((r) => r.includes(',')) ? ';' : ',';
  const cellRows = rows.map((r) => splitRow(r, delim));
  // Legacy layout without a header: the third cell of every dated row is an amount (or blank).
  const dated = cellRows.filter((c) => parseStatementDate(c[0] ?? '', fiscalYear));
  const legacyGuess = dated.length > 0 && dated.every((c) => c.length <= 5 && isAmountCell(c[2]) && isAmountCell(c[3])) && dated.some((c) => /\d/.test(c[2] ?? '') || /\d/.test(c[3] ?? ''));
  let map: Record<ColKey, number> = legacyGuess ? { date: 0, reference: 1, description: -1, debit: 2, credit: 3, balance: 4 } : { date: 0, reference: 1, description: 2, debit: 3, credit: 4, balance: 5 };
  let legacyLayout = legacyGuess;
  const out: PasteResult = { lines: [], errors: [] };
  cellRows.forEach((cells, i) => {
    const date = parseStatementDate(cells[map.date] ?? '', fiscalYear);
    if (!date) {
      const words = cells.map((c) => c.trim().toLowerCase());
      if (words.some((w) => /^ending balance$/.test(w))) {
        const v = lastAmount(cells);
        if (v !== undefined) out.endingBalance = v;
        return;
      }
      if (words.some((w) => /^(beginning |opening )?balance( forward| brought forward)?$/.test(w)) && lastAmount(cells) !== undefined && !words.some((w) => /^date$|^month$/.test(w))) {
        out.beginningBalance = lastAmount(cells)!;
        return;
      }
      // A header row (first non-date row) may name the columns.
      const named: Partial<Record<ColKey, number>> = {};
      cells.forEach((c, idx) => {
        const hit = HEADER_WORDS.find(([, re]) => re.test(c.trim()));
        if (hit && named[hit[0]] === undefined) named[hit[0]] = idx;
      });
      if (out.lines.length === 0 && named.date !== undefined && (named.debit !== undefined || named.credit !== undefined)) {
        map = { date: -1, reference: -1, description: -1, debit: -1, credit: -1, balance: -1, ...named };
        legacyLayout = named.description === undefined;
      } else if (out.lines.length > 0 || i > 0 || !/[a-z]/i.test(rows[i]!)) out.errors.push({ row: i + 1, message: `Unrecognised date "${cells[map.date] ?? ''}".` });
      return;
    }
    const cell = (k: ColKey) => (map[k] >= 0 ? cells[map[k]] ?? '' : '');
    try {
      const debit = parsePesos(cell('debit'));
      const credit = parsePesos(cell('credit'));
      if (debit < 0 || credit < 0) throw new Error('Amounts must not be negative; use the debit or the credit column.');
      if ((debit > 0) === (credit > 0)) throw new Error(debit > 0 ? 'A line cannot have both a debit and a credit.' : 'The line has no amount.');
      const reference = cell('reference').replace(/\.0+$/, '').slice(0, 60);
      const line: StatementLineInput = { date, reference, description: cell('description').slice(0, 200), debit, credit };
      if (legacyLayout) {
        line.checkNumber = debit > 0 && checkNoOf(reference) ? reference : null;
        if (!line.description) line.description = line.checkNumber ? 'Check encashed' : debit > 0 ? 'Debit' : 'Deposit / credit';
      }
      out.lines.push(line);
    } catch (e) {
      out.errors.push({ row: i + 1, message: (e as Error).message });
    }
  });
  if (legacyLayout) out.legacyLayout = true;
  return out;
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

/** Digits of a check/reference number without leading zeros ("CHK 0001762250" → "1762250", "1655543.0" → "1655543"). */
export function normalizeRef(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/\.0+$/, '').replace(/\D/g, '').replace(/^0+/, '');
}

/**
 * The normalized check number when a reference IS a check number ("1762250", "CHK 0001762250",
 * "Check No. 1762250"), else ''. Memo numbers (BM-2026-03-001), ADA and OR references are not.
 */
export function checkNoOf(ref: string | null | undefined): string {
  const s = (ref ?? '').trim().replace(/\.0+$/, '');
  return /^(?:(?:chk|check|cheque|ck)\.?\s*(?:no\.?)?\s*#?\s*)?\d{3,12}$/i.test(s) ? normalizeRef(s) : '';
}

/** Check number of a statement line: its check-no. column, a numeric reference, or "CHECK 1762250" in the description. */
export function lineCheckNo(l: Pick<StatementLineInput, 'checkNumber' | 'reference' | 'description' | 'debit'>): string {
  if (!(l.debit > 0)) return '';
  const direct = checkNoOf(l.checkNumber) || checkNoOf(l.reference);
  if (direct) return direct;
  const m = /(?:chk|check|cheque)\.?\s*(?:no\.?)?\s*#?\s*0*(\d{4,12})\b/i.exec(l.description ?? '');
  return m ? normalizeRef(m[1]) : '';
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
      const base = `L${fnv1a(`${l.date}|${normalizeRef(l.checkNumber ?? l.reference) || l.reference.trim().toUpperCase()}|${l.debit}|${l.credit}`)}`;
      id = base;
      for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
    }
    used.add(id);
    bal += l.credit - l.debit;
    totalDebits += l.debit;
    totalCredits += l.credit;
    const checkNumber = (l.checkNumber ?? '').trim() || null;
    return { lineId: id, date: l.date, reference: l.reference.trim(), description: l.description.trim(), debit: l.debit, credit: l.credit, checkNumber, balance: bal as Centavos };
  });
  return { lines, totalDebits: totalDebits as Centavos, totalCredits: totalCredits as Centavos, computedEndingBalance: bal as Centavos };
}

// ------------------------------------------------------------------ classification of bank items

/** How an unmatched bank line is treated (the user's one-click classification). */
export type LineClass = 'BANK_CHARGES' | 'BANK_DEBIT_MEMO' | 'INTEREST_INCOME' | 'BANK_CREDIT_MEMO' | 'BANK_ERROR' | 'OTHER_BANK' | 'CLEARED_PRIOR';

export const LINE_CLASSES: ReadonlyArray<{ value: LineClass; label: string; side: 'DEBIT' | 'CREDIT' | 'BOTH'; hint: string }> = [
  { value: 'BANK_CHARGES', label: 'Bank charges', side: 'DEBIT', hint: 'Not yet in the books — deduct from the book balance; record a debit memo.' },
  { value: 'BANK_DEBIT_MEMO', label: 'Debit memo / unrecorded check', side: 'DEBIT', hint: 'Not yet in the books — deduct from the book balance; record a debit memo.' },
  { value: 'INTEREST_INCOME', label: 'Interest earned', side: 'CREDIT', hint: 'Not yet in the books — add to the book balance; record a credit memo.' },
  { value: 'BANK_CREDIT_MEMO', label: 'Credit memo / unrecorded deposit', side: 'CREDIT', hint: 'Not yet in the books — add to the book balance; record a credit memo.' },
  { value: 'BANK_ERROR', label: 'Bank error', side: 'BOTH', hint: 'The bank posted it in error — reverse it on the bank side.' },
  { value: 'OTHER_BANK', label: 'Other (bank side)', side: 'BOTH', hint: 'Other reconciling item on the bank side.' },
  { value: 'CLEARED_PRIOR', label: 'Clears an item not in the books', side: 'BOTH', hint: 'Settles a prior-year item already outside this year\'s books — no reconciling effect.' },
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

/** A posted journal line on the bank account's Cash in Bank ledger (the fields the reconciliation reads). */
export interface BookLine {
  jevId: string;
  lineNo: number;
  jevNumber: string | null;
  jevDate: IsoDate;
  accountingPeriod: string;
  entryType: string;
  debit: Centavos;
  credit: Centavos;
  /** Check no. on disbursements (OR / deposit slip on receipts). */
  primaryReference: string | null;
  /** DV no. / RCD no. */
  secondaryReference: string | null;
  payeeName: string | null;
  lineDescription: string;
}

/** cancelledChecks/{id} (functions/src/accounting/cancelledChecks.ts). */
export interface CancelledCheckRecord {
  barangayId: string;
  bankAccountId: string;
  checkNumber: string;
  checkDate: IsoDate;
  payeeName: string | null;
  remarks: string;
  fiscalYear?: number;
}

/** Prior-year check outstanding on January 1 (legacy Schedule 1 "Prior Years"). */
export interface OpeningCheck {
  id: string;
  date: IsoDate;
  checkNumber: string;
  payeeName: string;
  dvNumber: string;
  amount: Centavos;
}
/** Prior-year deposit in transit on January 1. */
export interface OpeningDeposit {
  id: string;
  date: IsoDate;
  reference: string;
  particulars: string;
  amount: Centavos;
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
  /** The memo's JEV is posted (jevNumber set) — its journal line is then a book item. */
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

export type BookItemKind = 'CHECK' | 'DISBURSEMENT' | 'DEPOSIT';

/**
 * One book-side item. Checks are keyed by check number (`CHK:<no>`; all journal lines of one check
 * add up), prior-year items by their opening id (`PY:`/`PYD:`), cancelled checks `CXL:<id>`, other
 * journal lines `JL:<jevId>:<lineNo>`.
 */
export interface BookItem {
  key: string;
  kind: BookItemKind;
  date: IsoDate;
  checkNumber: string;
  /** DV no. (checks / disbursements) or RCD / deposit slip no. (deposits). */
  reference: string;
  payeeName: string;
  particulars: string;
  amount: Centavos;
  jevIds: string[];
  jevNumbers: string[];
  priorYear: boolean;
  cancelled: boolean;
  /** Why a check shows 0: cancelled register, or reversed / taken back up in the books. */
  cancelRemarks: string;
}

/** A person-made match of a statement line to a book item. */
export interface ManualMatch {
  lineId: string;
  bookKey: string;
}

export interface ReconMatch extends ManualMatch {
  kind: BookItemKind;
  /** Bank (statement) amount. */
  amount: Centavos;
  bookAmount: Centavos;
  /** Statement (clearing) date. */
  date: IsoDate;
  how: 'CHECK_NO' | 'AMOUNT_DATE' | 'MEMO' | 'MANUAL';
}

export type ItemSourceCollection = 'journal' | 'opening' | 'bankMemos' | null;

/** A stored reconciliation item (bankReconciliations/{id}/items). `sourceId` is the book key or memo id. */
export interface ReconItemRecord extends ReconItem {
  seq: number;
  side: 'BOOK' | 'BANK';
  statementLineId: string | null;
  sourceCollection: ItemSourceCollection;
  /** Classification came from the description heuristic, not from a person. */
  suggested: boolean;
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
  'BANK_CREDIT_MEMO', 'INTEREST_INCOME', 'BANK_DEBIT_MEMO', 'BANK_CHARGES', 'BOOK_ERROR', 'OTHER_BOOK',
  'DEPOSIT_IN_TRANSIT', 'OUTSTANDING_CHECK', 'BANK_ERROR', 'OTHER_BANK',
];
export const RECON_CATEGORY_LABELS: Record<ReconItemCategory, string> = {
  DEPOSIT_IN_TRANSIT: 'Deposits in transit',
  OUTSTANDING_CHECK: 'Outstanding checks',
  BANK_ERROR: 'Bank errors',
  OTHER_BANK: 'Other bank-side items',
  BANK_CREDIT_MEMO: 'Credit memos / unrecorded credits',
  INTEREST_INCOME: 'Interest earned',
  BANK_DEBIT_MEMO: 'Debit memos / unrecorded debits',
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

/** Month (0–13) of an accounting period key "2026-03". */
const periodMonth = (p: string) => Number(p.slice(5, 7));

/**
 * Book items of one bank account from its journal lines (fiscal year, periods 1..month, posted).
 * Opening/closing entries are excluded (the opening balance is in period 00 and its reconciling
 * items are the prior-year outstanding checks / deposits in transit). A JEV and its reversal that
 * are both in the window cancel out; a reversed check is listed at 0.
 */
export function bookItemsFromJournal(args: {
  fiscalYear: number;
  month: number;
  asOf: IsoDate;
  lines: readonly BookLine[];
  reversed?: ReadonlyArray<{ jevId: string; reversedByJevId: string | null }>;
  cancelled?: ReadonlyArray<CancelledCheckRecord & { id: string }>;
  opening?: { outstandingChecks: readonly OpeningCheck[]; depositsInTransit: readonly OpeningDeposit[] } | null;
}): { items: BookItem[]; warnings: string[] } {
  const warnings: string[] = [];
  const inWindow = args.lines.filter((l) => {
    const m = periodMonth(l.accountingPeriod);
    return m >= 1 && m <= args.month && l.jevDate <= args.asOf && l.entryType !== 'OPENING' && l.entryType !== 'CLOSING' && (l.debit > 0 || l.credit > 0);
  });
  const jevIds = new Set(inWindow.map((l) => l.jevId));
  const dropped = new Map<string, string>(); // jevId → reversal jevId
  for (const r of args.reversed ?? []) if (r.reversedByJevId && jevIds.has(r.jevId) && jevIds.has(r.reversedByJevId)) (dropped.set(r.jevId, r.reversedByJevId), dropped.set(r.reversedByJevId, r.jevId));
  const sorted = [...inWindow].sort((a, b) => a.jevDate.localeCompare(b.jevDate) || (a.jevNumber ?? '').localeCompare(b.jevNumber ?? '') || a.lineNo - b.lineNo);
  const checks = new Map<string, BookItem>();
  const others: BookItem[] = [];
  const reversedChecks: BookItem[] = [];
  const newCheck = (no: string, l: BookLine): BookItem => ({
    key: `CHK:${no}`, kind: 'CHECK', date: l.jevDate, checkNumber: (l.primaryReference ?? '').trim().replace(/\.0+$/, ''), reference: l.secondaryReference ?? '', payeeName: l.payeeName ?? '', particulars: l.lineDescription ?? '',
    amount: 0 as Centavos, jevIds: [], jevNumbers: [], priorYear: false, cancelled: false, cancelRemarks: '',
  });
  const debitsWithCheckNo: BookLine[] = [];
  for (const l of sorted) {
    const no = checkNoOf(l.primaryReference);
    if (dropped.has(l.jevId)) {
      // Reversed in the window: the check number stays in the series at 0.
      if (no && l.credit > 0) {
        const c = newCheck(no, l);
        reversedChecks.push({ ...c, key: `REV:${l.jevId}:${l.lineNo}`, cancelled: true, cancelRemarks: 'Reversed in the books' });
      }
      continue;
    }
    if (l.credit > 0 && no) {
      const c = checks.get(no) ?? newCheck(no, l);
      c.amount = (c.amount + l.credit) as Centavos;
      if (!c.jevIds.includes(l.jevId)) c.jevIds.push(l.jevId);
      if (l.jevNumber && !c.jevNumbers.includes(l.jevNumber)) c.jevNumbers.push(l.jevNumber);
      if (!c.payeeName && l.payeeName) c.payeeName = l.payeeName;
      if (!c.reference && l.secondaryReference) c.reference = l.secondaryReference;
      checks.set(no, c);
    } else if (l.debit > 0 && no) debitsWithCheckNo.push(l);
    else
      others.push({
        key: `JL:${l.jevId}:${l.lineNo}`, kind: l.credit > 0 ? 'DISBURSEMENT' : 'DEPOSIT', date: l.jevDate, checkNumber: '', reference: l.secondaryReference ?? l.primaryReference ?? '', payeeName: l.payeeName ?? '', particulars: l.lineDescription ?? '',
        amount: (l.credit || l.debit) as Centavos, jevIds: [l.jevId], jevNumbers: l.jevNumber ? [l.jevNumber] : [], priorYear: false, cancelled: false, cancelRemarks: '',
      });
  }
  // A debit carrying an issued check's number takes it back up (cancelled / corrected check).
  for (const l of debitsWithCheckNo) {
    const no = checkNoOf(l.primaryReference);
    const c = checks.get(no);
    if (c && l.debit <= c.amount) {
      c.amount = (c.amount - l.debit) as Centavos;
      if (l.jevNumber) c.jevNumbers.push(l.jevNumber);
      if (c.amount === 0) (c.cancelled = true), (c.cancelRemarks = `Taken back up in the books${l.jevNumber ? ` (JEV ${l.jevNumber})` : ''}`);
    } else
      others.push({
        key: `JL:${l.jevId}:${l.lineNo}`, kind: 'DEPOSIT', date: l.jevDate, checkNumber: '', reference: l.primaryReference ?? '', payeeName: l.payeeName ?? '', particulars: l.lineDescription ?? '',
        amount: l.debit, jevIds: [l.jevId], jevNumbers: l.jevNumber ? [l.jevNumber] : [], priorYear: false, cancelled: false, cancelRemarks: '',
      });
  }
  const cancelled: BookItem[] = [];
  for (const x of args.cancelled ?? []) {
    if (x.checkDate.slice(0, 4) !== String(args.fiscalYear) || x.checkDate > args.asOf) continue;
    const no = normalizeRef(x.checkNumber);
    const c = checks.get(no);
    if (c && c.amount > 0) {
      warnings.push(`Check ${x.checkNumber} is in the cancelled-checks register but is recorded in the books at ${c.amount / 100}; take it back up in the journal or remove the register entry.`);
      continue;
    }
    if (c) continue; // already 0 in the books
    cancelled.push({ key: `CXL:${x.id}`, kind: 'CHECK', date: x.checkDate, checkNumber: x.checkNumber, reference: '', payeeName: x.payeeName ?? '', particulars: x.remarks, amount: 0 as Centavos, jevIds: [], jevNumbers: [], priorYear: false, cancelled: true, cancelRemarks: x.remarks || 'Cancelled' });
  }
  const prior: BookItem[] = [
    ...(args.opening?.outstandingChecks ?? []).map((o): BookItem => ({ key: `PY:${o.id}`, kind: 'CHECK', date: o.date, checkNumber: o.checkNumber, reference: o.dvNumber ?? '', payeeName: o.payeeName ?? '', particulars: 'Outstanding check, prior year', amount: o.amount, jevIds: [], jevNumbers: [], priorYear: true, cancelled: false, cancelRemarks: '' })),
    ...(args.opening?.depositsInTransit ?? []).map((o): BookItem => ({ key: `PYD:${o.id}`, kind: 'DEPOSIT', date: o.date, checkNumber: '', reference: o.reference ?? '', payeeName: '', particulars: o.particulars || 'Deposit in transit, prior year', amount: o.amount, jevIds: [], jevNumbers: [], priorYear: true, cancelled: false, cancelRemarks: '' })),
  ];
  for (const c of checks.values()) if (c.amount < 0) warnings.push(`Check ${c.checkNumber}: more taken back up than issued.`);
  return { items: [...prior, ...checks.values(), ...reversedChecks, ...cancelled, ...others], warnings };
}

// ------------------------------------------------------------------ reconciliation

export interface BankReconInput {
  fiscalYear: number;
  month: number;
  /** Cut-off (default: month end). */
  asOf?: IsoDate;
  bookBalance: Centavos;
  bankBalance: Centavos;
  book: readonly BookItem[];
  /** Statement lines of the fiscal year so far (all months ≤ month), in statement order. */
  bankLines: readonly StatementLine[];
  memos: readonly ReconMemo[];
  classifications: Readonly<Record<string, LineClass>>;
  manualItems: readonly ManualReconItem[];
  manualMatches: readonly ManualMatch[];
  /** A deposit/credit may reach the statement this many days around the book date (default 10). */
  windowDays?: number;
}

export type ReconCheckStatus = 'CLEARED' | 'OUTSTANDING' | 'STALE' | 'CANCELLED' | 'AMOUNT_DIFFERS';
export const CHECK_STATUS_LABEL: Record<ReconCheckStatus, string> = { CLEARED: 'Cleared', OUTSTANDING: 'Outstanding', STALE: 'Stale (over 6 months)', CANCELLED: 'Cancelled', AMOUNT_DIFFERS: 'Amount differs' };

/** Schedule 1 row — Checks Issued Reconciliation. */
export interface Schedule1Row {
  key: string;
  priorYear: boolean;
  date: IsoDate;
  checkNumber: string;
  payeeName: string;
  dvNumber: string;
  jevNumbers: string[];
  book: Centavos;
  bank: Centavos;
  /** book − bank: the outstanding amount, or the amount difference of a cleared check. */
  diff: Centavos;
  clearedDate: IsoDate | null;
  status: ReconCheckStatus;
  remarks: string;
}

/** Schedule 2 row — Deposits Reconciliation (and its "Bank adjustments" block). Debits are negative. */
export interface Schedule2Row {
  key: string;
  priorYear: boolean;
  date: IsoDate;
  particulars: string;
  reference: string;
  book: Centavos;
  bank: Centavos;
  diff: Centavos;
  bankDate: IsoDate | null;
  remarks: string;
}

export interface BankReconResult extends ReturnType<typeof computeBankReconciliation> {
  asOf: IsoDate;
  bookBalance: Centavos;
  bankBalance: Centavos;
  matches: ReconMatch[];
  items: ReconItemRecord[];
  totals: ReconTotals;
  schedule1: Schedule1Row[];
  schedule2: Schedule2Row[];
  adjustments: Schedule2Row[];
  /** Effective class of every unmatched statement line (saved or suggested). */
  lineClasses: Record<string, { cls: LineClass; suggested: boolean; memoId: string | null }>;
  /** Manual matches that could not be applied. */
  rejectedMatches: Array<ManualMatch & { reason: string }>;
}

function closest<T extends { date: IsoDate }>(xs: T[], date: IsoDate): T | undefined {
  return xs.sort((a, b) => Math.abs(daysFrom(date, a.date)) - Math.abs(daysFrom(date, b.date)) || a.date.localeCompare(b.date))[0];
}

function monthEndOf(fy: number, m: number): IsoDate {
  const d = new Date(Date.UTC(fy, m, 0)).getUTCDate();
  return `${fy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Journal-based two-sided ("adjusted balance") reconciliation of one bank account as of a month
 * end, cumulative for the fiscal year like the legacy workbook:
 *  1. person-made matches; 2. memo JEVs to the statement line they were recorded from;
 *  3. checks by check no. (amount differences flagged and carried as book errors);
 *  4. other disbursements and deposits by amount within a date window (closest date wins).
 * Unmatched book items → outstanding checks / deposits in transit / disbursements not yet on the
 * statement (bank side). Unmatched statement lines → items requiring adjustment by the agency
 * (book side), as classified.
 */
export function reconcileBank(inp: BankReconInput): BankReconResult {
  const asOf = inp.asOf ?? monthEndOf(inp.fiscalYear, inp.month);
  const window = inp.windowDays ?? 10;
  const lines = inp.bankLines.filter((l) => l.date <= asOf);
  const lineById = new Map(lines.map((l) => [l.lineId, l]));
  const book = inp.book.filter((b) => b.date <= asOf || b.priorYear);
  const bookByKey = new Map(book.map((b) => [b.key, b]));
  const usedLines = new Map<string, ReconMatch>();
  const usedBook = new Map<string, ReconMatch>();
  const matches: ReconMatch[] = [];
  const rejectedMatches: BankReconResult['rejectedMatches'] = [];
  const free = (l: StatementLine) => !usedLines.has(l.lineId);
  const open = (b: BookItem) => !usedBook.has(b.key) && !b.cancelled && b.amount > 0;
  const match = (l: StatementLine, b: BookItem, how: ReconMatch['how']) => {
    const m: ReconMatch = { lineId: l.lineId, bookKey: b.key, kind: b.kind, amount: (l.debit || l.credit) as Centavos, bookAmount: b.amount, date: l.date, how };
    usedLines.set(l.lineId, m);
    usedBook.set(b.key, m);
    matches.push(m);
  };
  const sideOk = (l: StatementLine, b: BookItem) => (b.kind === 'DEPOSIT') === l.credit > 0;

  // 1. Matches made by a person in the workspace.
  for (const mm of inp.manualMatches) {
    const l = lineById.get(mm.lineId);
    const b = bookByKey.get(mm.bookKey);
    const reason = !l ? 'statement line not found' : !b ? 'book item not found' : !free(l) || !open(b) ? 'already matched' : !sideOk(l, b) ? 'wrong side (debit vs credit)' : b.kind !== 'CHECK' && b.amount !== (l.debit || l.credit) ? 'amounts differ' : null;
    if (reason) rejectedMatches.push({ ...mm, reason });
    else match(l!, b!, 'MANUAL');
  }

  // 2. Posted memo JEVs → the statement line the memo was recorded from.
  for (const m of inp.memos) {
    if (!m.posted || !m.jevId || !m.statementLineId || m.status === 'VOID') continue;
    const l = lineById.get(m.statementLineId);
    const b = book.find((x) => open(x) && x.kind !== 'CHECK' && x.jevIds.includes(m.jevId!));
    if (l && b && free(l) && sideOk(l, b) && b.amount === (l.debit || l.credit)) match(l, b, 'MEMO');
  }

  // 3. Checks by number (prior-year items first, then in check-date order).
  const checks = book.filter((b) => b.kind === 'CHECK').sort((a, b) => Number(b.priorYear) - Number(a.priorYear) || a.date.localeCompare(b.date) || a.checkNumber.localeCompare(b.checkNumber));
  for (const c of checks) {
    if (!open(c)) continue;
    const no = normalizeRef(c.checkNumber);
    if (!no) continue;
    const cands = lines.filter((x) => free(x) && x.debit > 0 && lineCheckNo(x) === no);
    const l = cands.find((x) => x.debit === c.amount) ?? cands[0];
    if (l) match(l, c, 'CHECK_NO');
  }

  // 4. Other disbursements (debit lines without a check no.) and deposits (credit lines) by amount and date.
  const rest = book.filter((b) => b.kind !== 'CHECK').sort((a, b) => Number(b.priorYear) - Number(a.priorYear) || a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  for (const b of rest) {
    if (!open(b)) continue;
    const fits = (x: StatementLine) => {
      if (!free(x) || !sideOk(x, b) || (x.debit || x.credit) !== b.amount) return false;
      const d = daysFrom(b.date, x.date);
      return b.priorYear ? d >= -1 && d <= 31 : d >= -window && d <= window;
    };
    const l = closest(lines.filter(fits), b.date);
    if (l) match(l, b, 'AMOUNT_DATE');
  }

  // ---- reconciling items
  const items: Omit<ReconItemRecord, 'seq'>[] = [];
  const add = (i: Omit<ReconItemRecord, 'seq' | 'side' | 'jevId' | 'requiresJev'> & { jevId?: string | null; requiresJev?: boolean }) =>
    items.push({ ...i, side: SIDE[i.category], jevId: i.jevId ?? null, requiresJev: i.requiresJev ?? false });

  const schedule1: Schedule1Row[] = [];
  for (const c of checks) {
    const m = usedBook.get(c.key);
    const bank = (m?.amount ?? 0) as Centavos;
    const diff = (c.amount - bank) as Centavos;
    const stale = !m && !c.cancelled && isStaleCheck(c.date, asOf);
    const status: ReconCheckStatus = c.cancelled ? 'CANCELLED' : m ? (diff !== 0 ? 'AMOUNT_DIFFERS' : 'CLEARED') : stale ? 'STALE' : 'OUTSTANDING';
    schedule1.push({
      key: c.key, priorYear: c.priorYear, date: c.date, checkNumber: c.checkNumber, payeeName: c.payeeName, dvNumber: c.reference, jevNumbers: c.jevNumbers, book: c.amount, bank, diff, clearedDate: m?.date ?? null, status,
      remarks: c.cancelled ? c.cancelRemarks : m ? (diff !== 0 ? `Encashed ${m.date} for ${(bank / 100).toFixed(2)}` : '') : stale ? 'Stale — over six months outstanding' : 'Outstanding',
    });
    if (c.cancelled) continue;
    if (!m)
      add({ category: 'OUTSTANDING_CHECK', date: c.date, reference: c.checkNumber, name: c.payeeName || 'Check', amount: c.amount, sourceType: 'CHECK', sourceId: c.key, sourceCollection: c.priorYear ? 'opening' : 'journal', statementLineId: null, remarks: stale ? 'STALE' : c.priorYear ? 'Prior year' : '', suggested: false });
    else if (diff !== 0)
      add({ category: 'BOOK_ERROR', date: m.date, reference: c.checkNumber, name: `Check ${c.checkNumber} recorded at ${(c.amount / 100).toFixed(2)}, encashed at ${(bank / 100).toFixed(2)}`, amount: diff, sourceType: 'CHECK', sourceId: c.key, sourceCollection: c.priorYear ? 'opening' : 'journal', statementLineId: m.lineId, remarks: 'Correct the journal entry', requiresJev: true, suggested: false });
  }
  schedule1.sort((a, b) => Number(b.priorYear) - Number(a.priorYear) || a.date.localeCompare(b.date) || a.checkNumber.padStart(20, '0').localeCompare(b.checkNumber.padStart(20, '0')));

  const schedule2: Schedule2Row[] = [];
  const adjustments: Schedule2Row[] = [];
  for (const b of rest) {
    const m = usedBook.get(b.key);
    const sign = b.kind === 'DEPOSIT' ? 1 : -1;
    const row: Schedule2Row = {
      key: b.key, priorYear: b.priorYear, date: b.date, particulars: [b.payeeName, b.particulars].filter(Boolean).join(' — ') || (b.kind === 'DEPOSIT' ? 'Deposit' : 'Disbursement'), reference: b.reference,
      book: (sign * b.amount) as Centavos, bank: (sign * (m?.amount ?? 0)) as Centavos, diff: (sign * (b.amount - (m?.amount ?? 0))) as Centavos, bankDate: m?.date ?? null,
      remarks: m ? '' : b.kind === 'DEPOSIT' ? 'Deposit in transit' : 'Not yet on the bank statement',
    };
    (b.kind === 'DEPOSIT' ? schedule2 : adjustments).push(row);
    if (m) continue;
    if (b.kind === 'DEPOSIT')
      add({ category: 'DEPOSIT_IN_TRANSIT', date: b.date, reference: b.reference, name: row.particulars, amount: b.amount, sourceType: 'DEPOSIT', sourceId: b.key, sourceCollection: b.priorYear ? 'opening' : 'journal', statementLineId: null, remarks: b.priorYear ? 'Prior year' : '', suggested: false });
    else
      add({ category: 'OTHER_BANK', date: b.date, reference: b.reference, name: `Recorded in the books, not yet debited by the bank: ${row.particulars}`, amount: -b.amount as Centavos, sourceType: 'MANUAL', sourceId: b.key, sourceCollection: 'journal', statementLineId: null, remarks: '', suggested: false });
  }

  // Unposted memos recorded from (or matching) a statement line: reconciling until the JEV is posted.
  const memoByLine = new Map<string, ReconMemo>();
  for (const m of inp.memos) {
    if (m.posted || m.status === 'VOID' || m.status === 'CANCELLED') continue;
    const fits = (x: StatementLine) => free(x) && !memoByLine.has(x.lineId) && (m.memoType === 'DEBIT' ? x.debit : x.credit) === m.amount && (x.debit > 0) === (m.memoType === 'DEBIT');
    const linked = m.statementLineId ? lineById.get(m.statementLineId) : undefined;
    const l = m.statementLineId ? (linked && fits(linked) ? linked : undefined) : closest(lines.filter((x) => fits(x) && Math.abs(daysFrom(m.memoDate, x.date)) <= 3), m.memoDate);
    if (l) memoByLine.set(l.lineId, m);
  }

  const lineClasses: BankReconResult['lineClasses'] = {};
  for (const l of lines) {
    if (usedLines.has(l.lineId)) continue;
    const memo = memoByLine.get(l.lineId);
    const chk = suggestLineClass(l) === 'BANK_CHARGES' ? '' : lineCheckNo(l);
    const sign = l.debit > 0 ? -1 : 1;
    if (memo) {
      lineClasses[l.lineId] = { cls: memo.memoType === 'DEBIT' ? (memo.category === 'BANK_CHARGES' ? 'BANK_CHARGES' : 'BANK_DEBIT_MEMO') : memo.category === 'INTEREST_INCOME' ? 'INTEREST_INCOME' : 'BANK_CREDIT_MEMO', suggested: false, memoId: memo.id };
      add({ category: memoCategoryOf(memo), date: l.date, reference: memo.memoNumber ?? l.reference, name: memo.particulars || l.description, amount: memo.amount, sourceType: 'BANK_MEMO', sourceId: memo.id, sourceCollection: 'bankMemos', statementLineId: l.lineId, remarks: 'Memo recorded; JEV not yet posted', jevId: memo.jevId, requiresJev: true, suggested: false });
      adjustments.push({ key: `LINE:${l.lineId}`, priorYear: false, date: l.date, particulars: memo.particulars || l.description, reference: memo.memoNumber ?? l.reference, book: 0 as Centavos, bank: (sign * (l.debit || l.credit)) as Centavos, diff: (-sign * (l.debit || l.credit)) as Centavos, bankDate: l.date, remarks: 'Memo recorded; JEV not yet posted' });
      continue;
    }
    const saved = inp.classifications[l.lineId];
    const cls = saved && lineClassAllowed(saved, l) ? saved : suggestLineClass(l);
    lineClasses[l.lineId] = { cls, suggested: !saved || cls !== saved, memoId: null };
    const label = LINE_CLASSES.find((c) => c.value === cls)!.label;
    const name = chk ? `Check ${l.checkNumber || l.reference || chk} encashed — not in the books` : l.description || l.reference || label;
    if (!chk || l.credit > 0) adjustments.push({ key: `LINE:${l.lineId}`, priorYear: false, date: l.date, particulars: name, reference: l.reference, book: 0 as Centavos, bank: (sign * (l.debit || l.credit)) as Centavos, diff: (-sign * (l.debit || l.credit)) as Centavos, bankDate: l.date, remarks: cls === 'CLEARED_PRIOR' ? 'No effect (prior item)' : label });
    else schedule1.push({ key: `LINE:${l.lineId}`, priorYear: false, date: l.date, checkNumber: l.checkNumber || l.reference || chk, payeeName: '', dvNumber: '', jevNumbers: [], book: 0 as Centavos, bank: l.debit, diff: -l.debit as Centavos, clearedDate: l.date, status: 'AMOUNT_DIFFERS', remarks: cls === 'CLEARED_PRIOR' ? 'Encashed; prior item not in the books' : 'Encashed; not in the books' });
    if (cls === 'CLEARED_PRIOR') continue;
    const signed = cls === 'BANK_ERROR' || cls === 'OTHER_BANK';
    add({
      category: cls,
      date: l.date,
      reference: l.checkNumber || l.reference,
      name,
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
  for (const mi of inp.manualItems)
    add({ category: mi.category, date: mi.date, reference: mi.reference, name: mi.name, amount: mi.amount, sourceType: 'MANUAL', sourceId: mi.id, sourceCollection: null, statementLineId: null, remarks: mi.remarks, suggested: false });

  // Bank adjustments: matched non-check disbursements too (bank charges recorded, transfers).
  for (const r of adjustments) {
    const m = r.key.startsWith('JL:') ? usedBook.get(r.key) : undefined;
    if (m) r.remarks = r.remarks || 'Cleared';
  }
  adjustments.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  schedule2.sort((a, b) => Number(b.priorYear) - Number(a.priorYear) || a.date.localeCompare(b.date) || a.key.localeCompare(b.key));

  const order = (c: ReconItemCategory) => RECON_CATEGORY_ORDER.indexOf(c);
  const sortedItems = items
    .sort((a, b) => order(a.category) - order(b.category) || a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference))
    .map((i, k) => ({ ...i, seq: k + 1 }));
  const totals = totalReconItems(sortedItems);
  return {
    ...computeBankReconciliation(inp.bookBalance, inp.bankBalance, totals),
    asOf,
    bookBalance: inp.bookBalance,
    bankBalance: inp.bankBalance,
    matches,
    items: sortedItems,
    totals,
    schedule1,
    schedule2,
    adjustments,
    lineClasses,
    rejectedMatches,
  };
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
