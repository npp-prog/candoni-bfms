import { BARANGAYS } from '../constants/barangays';
import { buildChartOfAccounts } from '../constants/chartOfAccounts';
import { transactionTypeFromLegacy, type TransactionType } from '../constants/transactionTypes';
import type { BarangayId, Centavos } from '../types/common';
import type { SubsidiaryType } from '../types/coa';
import { parsePesos } from './money';

/**
 * Legacy workbook import — pure parser/normaliser (no Excel dependency).
 *
 * Input: the sheets of one barangay workbook (the Google Sheets template kept by the Municipal
 * Accounting Office) as arrays of row arrays. Cells may be strings, numbers, booleans, Dates or
 * null; the browser converts ExcelJS cell values to these first.
 *
 * Every sheet is located by NAME PATTERN and every column by HEADER TEXT, so the small template
 * variations between barangays (extra empty columns, renamed sheets, a header typed "fff") are
 * tolerated. Money is converted to integer centavos with `parsePesos` (half away from zero).
 *
 * Entry grouping rule for 01_CY DB (documented in the UI):
 *   1. Rows with a "JEV No" are grouped by that number, wherever they are in the sheet
 *      (some barangays list all debits first and all credits below).
 *   2. Other rows are grouped CONSECUTIVELY by (date, primary ref, secondary ref). A new entry
 *      starts when that key changes, or when the current entry already balances (Σdr = Σcr ≠ 0)
 *      and the row's particulars/name differ (two vouchers sharing a check/date).
 *   3. Zero-amount rows named/particular'd "Cancelled …" are cancelled checks, not entries.
 *   4. Rows without account code, amounts or references (template residue) are ignored.
 */

export type ImportSeverity = 'ERROR' | 'WARNING';

export interface ImportIssue {
  severity: ImportSeverity;
  sheet: string;
  /** 1-based sheet row (as shown in Sheets/Excel); null for sheet-level issues. */
  row: number | null;
  code: string;
  message: string;
  /** Entry the issue belongs to (ERROR ⇒ the entry is not imported). */
  entryKey?: string;
}

export interface ImportSubsidiary {
  accountCode: string;
  subsidiaryCode: string;
  subsidiaryName: string;
  type: SubsidiaryType;
  /** ACODE "All SL Codes" list, or created because the journal/opening uses an unlisted code. */
  source: 'ACODE' | 'JOURNAL';
}

export interface ImportLine {
  accountCode: string;
  subsidiaryCode: string | null;
  debit: Centavos;
  credit: Centavos;
  row: number;
}

export interface ImportEntry {
  /** Stable key within the workbook (also the idempotency key on the server). */
  key: string;
  sheet: string;
  rows: number[];
  date: string | null;
  dateInferred: boolean;
  transactionType: TransactionType;
  /** True when the legacy "Transaction Type" column was blank and the type was inferred from the lines. */
  transactionTypeInferred: boolean;
  primaryReference: string | null;
  secondaryReference: string | null;
  tertiaryReference: string | null;
  legacyJevNo: string | null;
  payeeName: string | null;
  particulars: string;
  lines: ImportLine[];
  totalDebit: Centavos;
  totalCredit: Centavos;
  /** totalDebit − totalCredit */
  difference: Centavos;
  balanced: boolean;
  /** Any ERROR issue ⇒ not importable. */
  hasError: boolean;
}

export interface ImportCancelledCheck {
  checkNumber: string;
  date: string | null;
  dvNumber: string | null;
  payeeName: string | null;
  rows: number[];
}

export interface ImportPriorYear {
  fiscalYear: number;
  rows: Array<{ accountCode: string; debit: Centavos; credit: Centavos }>;
  totalDebit: Centavos;
  totalCredit: Centavos;
}

export interface ImportLegacyCashAdvance {
  accountCode: string;
  subsidiaryCode: string | null;
  officerName: string;
  date: string;
  checkNumber: string | null;
  dvNumber: string | null;
  particulars: string;
  amount: Centavos;
  sheet: string;
  row: number;
}

export interface ImportPpeRow {
  accountCode: string;
  accountName: string;
  costOverride: Centavos | null;
  residualRateBp: number;
  usefulLifeYears: number;
  accumulatedAccountCode: string;
  expenseAccountCode: string;
  remarks: string;
  /** As shown in the workbook (informational). */
  workbookCost: Centavos;
  workbookDepreciation: Centavos;
  row: number;
}

export interface ImportOpening {
  sheet: string;
  date: string;
  lines: ImportLine[];
  totalDebit: Centavos;
  totalCredit: Centavos;
  difference: Centavos;
  balanced: boolean;
  hasError: boolean;
}

export interface WorkbookImport {
  title: string;
  barangayGuess: BarangayId | null;
  fiscalYear: number | null;
  sheets: {
    acode: string | null;
    opening: string | null;
    journal: string | null;
    preTb: string | null;
    cashAdvances: string[];
    ppe: string | null;
  };
  subsidiaries: ImportSubsidiary[];
  opening: ImportOpening | null;
  entries: ImportEntry[];
  cancelledChecks: ImportCancelledCheck[];
  priorYears: ImportPriorYear[];
  legacyCashAdvances: ImportLegacyCashAdvance[];
  ppeSchedule: ImportPpeRow[];
  /** Workbook's own pre-closing TB for the import year (tie-out), signed debit − credit per account. */
  workbookTb: Array<{ accountCode: string; balance: Centavos }>;
  issues: ImportIssue[];
}

export interface ParseOptions {
  /** Override the fiscal year guess. */
  fiscalYear?: number;
  /** Override the barangay guess (only used in messages). */
  barangayId?: BarangayId;
  title?: string;
  /** Assume the previous row's date for entries with no date (WARNING) instead of rejecting them (ERROR). Default true. */
  inferMissingDates?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Cell helpers

type Row = readonly unknown[];

const COA = buildChartOfAccounts();
const COA_MAP = new Map(COA.map((a) => [a.accountCode, a]));
export const IMPORT_ACCOUNT_RE = /^\d-\d{2}-\d{2}-\d{3}$/;
/** SL code used when an SL-controlled account has no SL in the workbook. */
export const UNASSIGNED_SL = 'UNASSIGNED';

/** Trimmed text of a cell; whole numbers print without ".0" (check numbers are stored as floats). */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (v instanceof Date) return isoOfDate(v);
  return String(v).replace(/\s+/g, ' ').trim();
}

function textOrNull(v: unknown): string | null {
  const s = cellText(v);
  return s && !/^(n\/?a|-|none)$/i.test(s) ? s : null;
}

function isBlank(v: unknown): boolean {
  return cellText(v) === '';
}

/** Amount cell → centavos (blank/dash → 0). Throws on non-numeric text. */
export function cellCentavos(v: unknown): Centavos {
  if (v === null || v === undefined || v === '') return 0 as Centavos;
  if (typeof v === 'number') return parsePesos(v);
  if (typeof v === 'boolean') throw new Error('not an amount');
  return parsePesos(String(v));
}

function safeCentavos(v: unknown): Centavos | null {
  try {
    return cellCentavos(v);
  } catch {
    return null;
  }
}

function isoOfDate(d: Date): string {
  // ExcelJS returns dates as UTC midnight; use UTC parts so the day never shifts.
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function validYmd(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return isoOfDate(dt);
}

/**
 * Date cell → ISO date. Accepts Date, Excel serial numbers, `YYYY-MM-DD`, `M/D/YYYY`, `M/D/YY`
 * and the mistyped `M/DDYYYY` (missing slash, e.g. "12/202025" → 2025-12-20, flagged).
 */
export function cellDate(v: unknown): { date: string | null; note?: string } {
  if (v === null || v === undefined || v === '') return { date: null };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { date: null } : { date: isoOfDate(v) };
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return { date: isoOfDate(new Date(Math.round((v - 25569) * 86400000))) };
    return { date: null };
  }
  const s = cellText(v);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return { date: validYmd(+m[1]!, +m[2]!, +m[3]!) };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    return { date: validYmd(y, +m[1]!, +m[2]!) };
  }
  m = /^(\d{1,2})\/(\d{1,2})(\d{4})$/.exec(s);
  if (m) {
    const d = validYmd(+m[3]!, +m[1]!, +m[2]!);
    return d ? { date: d, note: `Malformed date "${s}" read as ${d}.` } : { date: null };
  }
  return { date: null };
}

function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Find a header row within the first `scan` rows that has every `required` column. */
function findHeader(rows: readonly Row[], spec: Record<string, RegExp>, required: string[], from = 0, scan = 15): { index: number; cols: Record<string, number> } | null {
  for (let r = from; r < Math.min(rows.length, from + scan); r++) {
    const row = rows[r] ?? [];
    const cols: Record<string, number> = {};
    row.forEach((c, i) => {
      const t = cellText(c);
      if (!t) return;
      for (const [k, re] of Object.entries(spec)) if (cols[k] === undefined && re.test(t)) cols[k] = i;
    });
    if (required.every((k) => cols[k] !== undefined)) return { index: r, cols };
  }
  return null;
}

function findSheet(names: string[], patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const hit = names.find((n) => p.test(n.trim()));
    if (hit) return hit;
  }
  return null;
}

function sumC(values: Iterable<number>): Centavos {
  let t = 0;
  for (const v of values) t += v;
  return t as Centavos;
}

function peso(c: number): string {
  const s = (Math.abs(c) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return c < 0 ? `(${s})` : s;
}

/** Signed → (debit, credit) with negatives moved to the other side. */
function sides(debit: number, credit: number): { debit: Centavos; credit: Centavos } {
  let d = debit;
  let c = credit;
  if (d < 0) {
    c += -d;
    d = 0;
  }
  if (c < 0) {
    d += -c;
    c = 0;
  }
  return { debit: d as Centavos, credit: c as Centavos };
}

/** Subsidiary type by controlling account (legacy SL code families). */
export function subsidiaryTypeFor(accountCode: string): SubsidiaryType {
  if (accountCode === '1-01-01-010' || accountCode === '1-01-01-020') return 'ACCOUNTABLE_OFFICER';
  if (accountCode === '1-01-02-010') return 'BANK';
  if (accountCode.startsWith('1-03-03-0')) return 'CASH_ADVANCE';
  if (accountCode.startsWith('2-02-01')) return 'BIR';
  return 'OTHER';
}

/** Infer the transaction type of an entry whose legacy column was blank. */
export function inferTransactionType(lines: readonly Pick<ImportLine, 'accountCode' | 'debit' | 'credit'>[]): TransactionType {
  const dr = (p: string) => lines.some((l) => l.debit > 0 && l.accountCode.startsWith(p));
  const cr = (p: string) => lines.some((l) => l.credit > 0 && l.accountCode.startsWith(p));
  if (dr('1-01-02') && cr('1-01-01')) return 'DEPOSIT';
  if (cr('1-01-02')) return 'DISBURSEMENT';
  if (dr('1-01-01') && !cr('1-01')) return 'COLLECTION';
  if (cr('1-03-03') || cr('1-03-04-020')) return 'LIQUIDATION';
  return 'OTHERS';
}

/** Default accumulated-depreciation and expense accounts of a PPE account (verified against the COA). */
export function importPpeAccounts(accountCode: string): { accumulated: string | null; expense: string } {
  const accumulated = accountCode.replace(/\d$/, '1');
  const group = accountCode.slice(0, 7);
  const EXP: Record<string, string> = {
    '1-07-02': '5-04-01-010',
    '1-07-03': '5-04-01-020',
    '1-07-04': '5-04-01-030',
    '1-07-05': '5-04-01-040',
    '1-07-06': '5-04-01-050',
    '1-07-07': '5-04-01-060',
  };
  const exp = EXP[group];
  return {
    accumulated: COA_MAP.has(accumulated) ? accumulated : null,
    expense: exp && COA_MAP.has(exp) ? exp : '5-04-01-990',
  };
}

// ---------------------------------------------------------------------------------------------

export function parseWorkbook(sheets: Record<string, unknown[][]>, opts: ParseOptions = {}): WorkbookImport {
  const names = Object.keys(sheets);
  const issues: ImportIssue[] = [];
  const issue = (severity: ImportSeverity, sheet: string, row: number | null, code: string, message: string, entryKey?: string) =>
    issues.push({ severity, sheet, row, code, message, ...(entryKey ? { entryKey } : {}) });
  const inferDates = opts.inferMissingDates !== false;

  const sh = {
    acode: findSheet(names, [/^acode$/i, /acode/i]),
    opening: findSheet(names, [/^py\s*db$/i, /py\s*db/i]),
    journal: findSheet(names, [/^01_?\s*cy\s*db$/i, /cy\s*db/i]),
    preTb: findSheet(names, [/pre\s*tb/i]),
    cashAdvances: names.filter((n) => /unliquidated|list of advances|aging.*ca/i.test(n)),
    ppe: findSheet(names, [/ppe depreciation schedule/i, /ppe\s*depr/i, /ppe schedule/i, /^ppe/i]),
  };
  const rowsOf = (n: string | null) => (n ? (sheets[n] ?? []) : []);

  // ---- Barangay guess: "BARANGAY AGBOY" title lines (first rows of every sheet + journal names).
  const votes = new Map<BarangayId, number>();
  const vote = (text: string) => {
    const m = /\b(?:BARANGAY|BRGY\.?)\s+([A-Z][A-Z-]+)/i.exec(text);
    if (!m) return;
    const b = BARANGAYS.find((x) => x.barangayName.toUpperCase() === m[1]!.toUpperCase() || x.barangayId === m[1]!.toUpperCase());
    if (b) votes.set(b.barangayId, (votes.get(b.barangayId) ?? 0) + 1);
  };
  for (const n of names) for (const row of rowsOf(n).slice(0, 10)) for (const c of row) if (typeof c === 'string') vote(c);
  if (opts.title) vote(opts.title.replace(/_/g, ' '));

  // ---- ACODE: chart (A–C) and "All SL Codes" (K–M).
  const acodeRows = rowsOf(sh.acode);
  const acodeAccounts = new Set<string>();
  const subsidiaries: ImportSubsidiary[] = [];
  const slKey = (a: string, s: string) => `${a}|${s.toUpperCase()}`;
  const slSet = new Map<string, ImportSubsidiary>();
  if (sh.acode) {
    const h = findHeader(acodeRows, { code: /^account code$/i, sl: /all sl codes/i }, ['code'], 0, 5);
    if (!h) issue('WARNING', sh.acode, null, 'NO_HEADER', 'ACODE: "Account Code" header not found.');
    else {
      for (let r = h.index + 1; r < acodeRows.length; r++) {
        const row = acodeRows[r] ?? [];
        const code = cellText(row[h.cols.code!]);
        if (IMPORT_ACCOUNT_RE.test(code)) acodeAccounts.add(code);
        if (h.cols.sl !== undefined) {
          const a = cellText(row[h.cols.sl]);
          const s = cellText(row[h.cols.sl + 1]).toUpperCase();
          const name = cellText(row[h.cols.sl + 2]);
          if (IMPORT_ACCOUNT_RE.test(a) && /^[A-Z0-9-]{2,20}$/.test(s)) {
            if (!COA_MAP.has(a)) {
              issue('WARNING', sh.acode, r + 1, 'UNKNOWN_ACCOUNT', `SL ${s} is under ${a}, which is not in the BFMS Chart of Accounts; skipped.`);
              continue;
            }
            const k = slKey(a, s);
            if (slSet.has(k)) continue;
            const sub: ImportSubsidiary = { accountCode: a, subsidiaryCode: s, subsidiaryName: name || s, type: subsidiaryTypeFor(a), source: 'ACODE' };
            slSet.set(k, sub);
            subsidiaries.push(sub);
          }
        }
      }
      const extra = [...acodeAccounts].filter((c) => !COA_MAP.has(c));
      if (extra.length) issue('WARNING', sh.acode, null, 'UNKNOWN_ACCOUNT', `ACODE lists ${extra.length} account(s) not in the BFMS Chart of Accounts (${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ', …' : ''}); lines using them are rejected.`);
    }
  } else issue('WARNING', '(workbook)', null, 'NO_SHEET', 'No ACODE sheet: subsidiary ledger names cannot be imported.');

  /**
   * Validate an account/SL pair of a line; registers JOURNAL-sourced SLs. Returns false on ERROR,
   * otherwise true or the SL code to use (dropped/defaulted SLs).
   */
  const checkLine = (sheet: string, row: number, accountCode: string, slIn: string | null, name: string | null, entryKey?: string): boolean | string => {
    let sl = slIn;
    if (!accountCode) {
      issue('ERROR', sheet, row, 'NO_ACCOUNT', 'Line has an amount but no account code.', entryKey);
      return false;
    }
    if (!IMPORT_ACCOUNT_RE.test(accountCode)) {
      issue('ERROR', sheet, row, 'UNKNOWN_ACCOUNT', `"${accountCode}" is not an account code (x-xx-xx-xxx).`, entryKey);
      return false;
    }
    const acct = COA_MAP.get(accountCode);
    if (!acct) {
      issue('ERROR', sheet, row, 'UNKNOWN_ACCOUNT', `Account ${accountCode} is not in the BFMS Chart of Accounts.`, entryKey);
      return false;
    }
    if (sl && !acct.requiresSubsidiaryLedger && !slSet.has(slKey(accountCode, sl))) {
      issue('WARNING', sheet, row, 'SL_DROPPED', `SL ${sl} on ${accountCode} (${acct.accountName}) ignored: the account has no subsidiary ledger.`, entryKey);
      sl = null;
    }
    if (sl) {
      if (!/^[A-Z0-9-]{2,20}$/.test(sl)) {
        issue('ERROR', sheet, row, 'BAD_SL', `SL code "${sl}" is not valid (letters, digits, dashes).`, entryKey);
        return false;
      }
      const k = slKey(accountCode, sl);
      if (!slSet.has(k)) {
        const sub: ImportSubsidiary = { accountCode, subsidiaryCode: sl, subsidiaryName: name || sl, type: subsidiaryTypeFor(accountCode), source: 'JOURNAL' };
        slSet.set(k, sub);
        subsidiaries.push(sub);
        issue('WARNING', sheet, row, 'SL_NOT_IN_ACODE', `SL ${sl} under ${accountCode} is not in the ACODE SL list; it will be created as "${sub.subsidiaryName}".`, entryKey);
      }
    } else if (acct.requiresSubsidiaryLedger) {
      // BFMS keeps an SL for this account; the workbook did not. Park the amount on a per-account
      // "unassigned" ledger so the books still tie; the accountant reclassifies it later.
      const k = slKey(accountCode, UNASSIGNED_SL);
      if (!slSet.has(k)) {
        const sub: ImportSubsidiary = { accountCode, subsidiaryCode: UNASSIGNED_SL, subsidiaryName: 'Unassigned (imported without SL)', type: subsidiaryTypeFor(accountCode), source: 'JOURNAL' };
        slSet.set(k, sub);
        subsidiaries.push(sub);
      }
      issue('WARNING', sheet, row, 'SL_DEFAULTED', `Account ${accountCode} (${acct.accountName}) needs an SL but the row has none; posted to SL ${UNASSIGNED_SL}.`, entryKey);
      return UNASSIGNED_SL;
    }
    return sl ?? true;
  };

  // ---- Fiscal year: PY DB opening date, else the most common CY DB year.
  const journalSpec = {
    primary: /^primary ref/i,
    code: /^account code$/i,
    sl: /^sl$/i,
    debit: /^debit$/i,
    credit: /^credit$/i,
    jev: /^jev\s*no/i,
    name: /^name$/i,
    secondary: /^secondary ref/i,
    tertiary: /^tertiary ref/i,
    date: /^date$/i,
    particulars: /^particulars$/i,
    ttype: /^transaction type$/i,
    month: /^month$/i,
  };
  const pyRows = rowsOf(sh.opening);
  const pyH = sh.opening ? findHeader(pyRows, journalSpec, ['code', 'debit', 'credit']) : null;
  const cyRows = rowsOf(sh.journal);
  const cyH = sh.journal ? findHeader(cyRows, journalSpec, ['code', 'debit', 'credit', 'date']) : null;
  let fiscalYear: number | null = opts.fiscalYear ?? null;
  if (!fiscalYear && pyH && pyH.cols.date !== undefined) {
    for (let r = pyH.index + 1; r < pyRows.length && !fiscalYear; r++) {
      const d = cellDate(pyRows[r]?.[pyH.cols.date]).date;
      if (d) fiscalYear = Number(d.slice(0, 4));
    }
  }
  if (!fiscalYear && cyH) {
    const years = new Map<number, number>();
    for (let r = cyH.index + 1; r < cyRows.length; r++) {
      const d = cellDate(cyRows[r]?.[cyH.cols.date!]).date;
      if (d) years.set(+d.slice(0, 4), (years.get(+d.slice(0, 4)) ?? 0) + 1);
    }
    fiscalYear = [...years.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
  if (!fiscalYear) issue('ERROR', '(workbook)', null, 'NO_FISCAL_YEAR', 'Could not determine the fiscal year (no dated rows in PY DB / 01_CY DB).');

  // ---- Opening balances (PY DB)
  let opening: ImportOpening | null = null;
  if (sh.opening && !pyH) issue('ERROR', sh.opening, null, 'NO_HEADER', 'PY DB: header row with Account Code / Debit / Credit not found.');
  if (sh.opening && pyH && fiscalYear) {
    const c = pyH.cols;
    const lines: ImportLine[] = [];
    let hasError = false;
    for (let r = pyH.index + 1; r < pyRows.length; r++) {
      const row = pyRows[r] ?? [];
      const code = cellText(row[c.code!]);
      const dr = safeCentavos(row[c.debit!]);
      const cr = safeCentavos(row[c.credit!]);
      if (dr === null || cr === null) {
        issue('ERROR', sh.opening, r + 1, 'BAD_AMOUNT', 'Debit/Credit is not a number.', 'OPENING');
        hasError = true;
        continue;
      }
      if (!code && dr === 0 && cr === 0) continue;
      if (dr === 0 && cr === 0) continue;
      const slCell = c.sl !== undefined ? textOrNull(row[c.sl])?.toUpperCase() ?? null : null;
      const chk = checkLine(sh.opening, r + 1, code, slCell, c.name !== undefined ? textOrNull(row[c.name]) : null, 'OPENING');
      if (chk === false) {
        hasError = true;
        continue;
      }
      const sl = typeof chk === 'string' ? chk : null;
      const s = sides(dr, cr);
      const net = s.debit - s.credit;
      if (net === 0) continue;
      lines.push({ accountCode: code, subsidiaryCode: sl, debit: (net > 0 ? net : 0) as Centavos, credit: (net < 0 ? -net : 0) as Centavos, row: r + 1 });
    }
    const totalDebit = sumC(lines.map((l) => l.debit));
    const totalCredit = sumC(lines.map((l) => l.credit));
    const difference = (totalDebit - totalCredit) as Centavos;
    if (difference !== 0) {
      issue('ERROR', sh.opening, null, 'UNBALANCED', `Opening balances do not balance: debits ${peso(totalDebit)}, credits ${peso(totalCredit)}, difference ${peso(difference)}.`, 'OPENING');
      hasError = true;
    }
    if (lines.length > 150) {
      issue('ERROR', sh.opening, null, 'TOO_MANY_LINES', `Opening entry has ${lines.length} lines (maximum 150).`, 'OPENING');
      hasError = true;
    }
    if (lines.length) opening = { sheet: sh.opening, date: `${fiscalYear}-01-01`, lines, totalDebit, totalCredit, difference, balanced: difference === 0, hasError };
  } else if (!sh.opening) issue('WARNING', '(workbook)', null, 'NO_SHEET', 'No PY DB sheet: no opening balances.');

  // ---- Current-year journal (01_CY DB)
  const entries: ImportEntry[] = [];
  const cancelledChecks: ImportCancelledCheck[] = [];
  if (sh.journal && !cyH) issue('ERROR', sh.journal, null, 'NO_HEADER', '01_CY DB: header row (Account Code / Debit / Credit / Date) not found.');
  if (sh.journal && cyH) {
    const c = cyH.cols;
    const sheet = sh.journal;
    interface Raw {
      row: number;
      primary: string | null;
      code: string;
      sl: string | null;
      debit: Centavos;
      credit: Centavos;
      jev: string | null;
      name: string | null;
      secondary: string | null;
      tertiary: string | null;
      date: string | null;
      particulars: string;
      ttype: string | null;
      month: string | null;
      bad: boolean;
    }
    const get = (row: Row, k: keyof typeof journalSpec) => (c[k] !== undefined ? row[c[k]!] : undefined);
    const raws: Raw[] = [];
    const cancelled = new Map<string, ImportCancelledCheck>();
    let lastDate: string | null = null;
    const prevDateAt: Array<string | null> = [];
    for (let r = cyH.index + 1; r < cyRows.length; r++) {
      const row = cyRows[r] ?? [];
      const dRaw = cellDate(get(row, 'date'));
      if (dRaw.note) issue('WARNING', sheet, r + 1, 'MALFORMED_DATE', dRaw.note);
      if (!dRaw.date && !isBlank(get(row, 'date'))) issue('WARNING', sheet, r + 1, 'MALFORMED_DATE', `Date "${cellText(get(row, 'date'))}" could not be read.`);
      const dr = safeCentavos(get(row, 'debit'));
      const cr = safeCentavos(get(row, 'credit'));
      const raw: Raw = {
        row: r + 1,
        primary: textOrNull(get(row, 'primary')),
        code: cellText(get(row, 'code')),
        sl: textOrNull(get(row, 'sl'))?.toUpperCase() ?? null,
        debit: (dr ?? 0) as Centavos,
        credit: (cr ?? 0) as Centavos,
        jev: textOrNull(get(row, 'jev')),
        name: textOrNull(get(row, 'name')),
        secondary: textOrNull(get(row, 'secondary')),
        tertiary: textOrNull(get(row, 'tertiary')),
        date: dRaw.date,
        particulars: cellText(get(row, 'particulars')),
        ttype: textOrNull(get(row, 'ttype')),
        month: textOrNull(get(row, 'month')),
        bad: dr === null || cr === null,
      };
      prevDateAt.push(lastDate);
      if (raw.date) lastDate = raw.date;
      const zero = raw.debit === 0 && raw.credit === 0 && !raw.bad;
      if (zero && /cancel+ed/i.test(`${raw.name ?? ''} ${raw.particulars}`)) {
        const no = raw.primary ?? `row ${raw.row}`;
        const cc = cancelled.get(no) ?? { checkNumber: no, date: null, dvNumber: null, payeeName: null, rows: [] };
        cc.rows.push(raw.row);
        cc.date ??= raw.date ?? (inferDates ? prevDateAt[prevDateAt.length - 1] ?? null : null);
        cc.dvNumber ??= raw.secondary;
        cancelled.set(no, cc);
        continue;
      }
      if (zero && (!raw.code || (!raw.primary && !raw.secondary && !raw.jev && !raw.date))) continue; // blank/template residue
      if (zero && raw.code) {
        issue('WARNING', sheet, raw.row, 'ZERO_LINE', `Zero-amount line on ${raw.code} ignored.`);
        continue;
      }
      if (raw.bad) issue('ERROR', sheet, raw.row, 'BAD_AMOUNT', 'Debit/Credit is not a number.');
      raws.push(raw);
    }
    cancelledChecks.push(...cancelled.values());

    // Group
    const groups: Raw[][] = [];
    const byJev = new Map<string, Raw[]>();
    let cur: Raw[] | null = null;
    const keyOf = (x: Raw) => `${x.date ?? ''}|${x.primary ?? ''}|${x.secondary ?? ''}`;
    for (const x of raws) {
      if (x.jev) {
        const g = byJev.get(x.jev);
        if (g) g.push(x);
        else {
          const ng = [x];
          byJev.set(x.jev, ng);
          groups.push(ng);
        }
        cur = null;
        continue;
      }
      if (cur && keyOf(cur[0]!) === keyOf(x)) {
        const d = sumC(cur.map((l) => l.debit)) - sumC(cur.map((l) => l.credit));
        const closed = d === 0 && cur.some((l) => l.debit > 0);
        const same = cur[0]!.particulars === x.particulars && cur[0]!.name === x.name;
        if (!closed || same) {
          cur.push(x);
          continue;
        }
      }
      cur = [x];
      groups.push(cur);
    }

    // Repair pass: lines of one voucher that are not consecutive (a debit block followed by a credit
    // block, or the check no. typed differently on one line). Still-unbalanced groups sharing a key
    // are merged when — and only when — together they balance.
    const net = (g: Raw[]) => g.reduce((s, x) => s + sides(x.debit, x.credit).debit - sides(x.debit, x.credit).credit, 0);
    const tiers: Array<[string, (x: Raw) => string | null]> = [
      ['same date and references', (x) => `${x.date ?? ''}|${x.primary ?? ''}|${x.secondary ?? ''}`],
      ['same date and secondary reference', (x) => (x.secondary ? `${x.date ?? ''}|S|${x.secondary}` : null)],
      ['same date and primary reference', (x) => (x.primary ? `${x.date ?? ''}|P|${x.primary}` : null)],
    ];
    const merged = new Set<Raw[]>();
    for (const [label, tier] of tiers) {
      const buckets = new Map<string, Raw[][]>();
      for (const g of groups) {
        if (merged.has(g) || g[0]!.jev || net(g) === 0) continue;
        const k = tier(g[0]!);
        if (k) buckets.set(k, [...(buckets.get(k) ?? []), g]);
      }
      for (const gs of buckets.values()) {
        if (gs.length < 2 || gs.reduce((s, g) => s + net(g), 0) !== 0) continue;
        const [head, ...rest] = gs as [Raw[], ...Raw[][]];
        for (const g of rest) {
          head.push(...g);
          merged.add(g);
        }
        head.sort((a, b) => a.row - b.row);
        issue('WARNING', sheet, head[0]!.row, 'MERGED_ROWS', `Rows ${head.map((x) => x.row).join(', ')} were not consecutive; joined into one entry (${label}).`, `CY-${String(head[0]!.row).padStart(5, '0')}`);
      }
    }
    const finalGroups = groups.filter((g) => !merged.has(g));

    // Normalise
    const checkUse = new Map<string, string[]>();
    for (const g of finalGroups) {
      const first = g[0]!;
      const key = `CY-${String(first.row).padStart(5, '0')}`;
      const pick = <K extends keyof Raw>(k: K) => g.find((x) => x[k] !== null && x[k] !== '')?.[k] ?? null;
      let date = pick('date') as string | null;
      let dateInferred = false;
      const before = issues.length;
      let hasError = g.some((x) => x.bad);
      if (!date) {
        const prev = prevDateAt[first.row - cyH.index - 2] ?? null;
        // A DV no. like 2025-08-107 tells the month; prefer it over the previous row's month.
        const dvm = /^(\d{4})-(\d{2})-\d{2,4}$/.exec(g.find((x) => x.secondary)?.secondary ?? '');
        const dvMonth = dvm && validYmd(+dvm[1]!, +dvm[2]!, 1) ? `${dvm[1]}-${dvm[2]}` : null;
        const guess = dvMonth && (!prev || prev.slice(0, 7) !== dvMonth) ? `${dvMonth}-01` : prev;
        if (inferDates && guess) {
          date = guess;
          dateInferred = true;
          issue('WARNING', sheet, first.row, 'MISSING_DATE', `No date; assumed ${guess} (${guess === prev ? 'the previous dated row' : `the month of DV ${dvMonth}`}). Check the voucher.`, key);
        } else {
          issue('ERROR', sheet, first.row, 'MISSING_DATE', 'Entry has no date.', key);
          hasError = true;
        }
      }
      const dates = new Set(g.map((x) => x.date).filter(Boolean));
      if (dates.size > 1) issue('WARNING', sheet, first.row, 'MIXED_DATES', `Lines carry different dates (${[...dates].join(', ')}); using ${date}.`, key);
      if (date && fiscalYear && Number(date.slice(0, 4)) !== fiscalYear) {
        issue('ERROR', sheet, first.row, 'OUTSIDE_YEAR', `Date ${date} is outside fiscal year ${fiscalYear}.`, key);
        hasError = true;
      }
      const month = pick('month') as string | null;
      if (date && month && /^\d{1,2}$/.test(month) && Number(month) !== Number(date.slice(5, 7)))
        issue('WARNING', sheet, first.row, 'MONTH_MISMATCH', `Month column says ${month.padStart(2, '0')} but the date is ${date}.`, key);
      const lines: ImportLine[] = [];
      for (const x of g) {
        const chk = checkLine(sheet, x.row, x.code, x.sl, x.name, key);
        if (chk === false) {
          hasError = true;
          continue;
        }
        const sl = typeof chk === 'string' ? chk : null;
        let { debit, credit } = sides(x.debit, x.credit);
        if (debit > 0 && credit > 0) {
          issue('WARNING', sheet, x.row, 'BOTH_SIDES', 'Line has both a debit and a credit; the net is used.', key);
          const n = debit - credit;
          debit = (n > 0 ? n : 0) as Centavos;
          credit = (n < 0 ? -n : 0) as Centavos;
        }
        if (debit === 0 && credit === 0) continue;
        lines.push({ accountCode: x.code, subsidiaryCode: sl, debit, credit, row: x.row });
      }
      const totalDebit = sumC(g.map((x) => sides(x.debit, x.credit).debit));
      const totalCredit = sumC(g.map((x) => sides(x.debit, x.credit).credit));
      const difference = (totalDebit - totalCredit) as Centavos;
      if (difference !== 0) {
        issue('ERROR', sheet, first.row, 'UNBALANCED', `Entry does not balance: debits ${peso(totalDebit)}, credits ${peso(totalCredit)}, difference ${peso(difference)} (rows ${g.map((x) => x.row).join(', ')}).`, key);
        hasError = true;
      } else if (totalDebit === 0) {
        issue('ERROR', sheet, first.row, 'ZERO_ENTRY', 'Entry totals zero.', key);
        hasError = true;
      }
      if (lines.length > 150) {
        issue('ERROR', sheet, first.row, 'TOO_MANY_LINES', `Entry has ${lines.length} lines (maximum 150).`, key);
        hasError = true;
      }
      if (!hasError && lines.length < 2) {
        issue('ERROR', sheet, first.row, 'ONE_LINE', 'Entry needs at least two lines.', key);
        hasError = true;
      }
      const legacyType = pick('ttype') as string | null;
      let tt = transactionTypeFromLegacy(legacyType);
      if (legacyType && !tt) issue('WARNING', sheet, first.row, 'UNKNOWN_TYPE', `Transaction type "${legacyType}" is not recognised; inferred from the lines.`, key);
      const inferred = !tt;
      tt ??= inferTransactionType(lines);
      const e: ImportEntry = {
        key,
        sheet,
        rows: g.map((x) => x.row),
        date,
        dateInferred,
        transactionType: tt,
        transactionTypeInferred: inferred,
        primaryReference: (pick('primary') as string | null)?.slice(0, 60) ?? null,
        secondaryReference: (pick('secondary') as string | null)?.slice(0, 60) ?? null,
        tertiaryReference: (pick('tertiary') as string | null)?.slice(0, 60) ?? null,
        legacyJevNo: (pick('jev') as string | null)?.slice(0, 60) ?? null,
        payeeName: (pick('name') as string | null)?.slice(0, 200) ?? null,
        particulars: ((pick('particulars') as string | null) || (pick('name') as string | null) || 'Imported entry').slice(0, 2000),
        lines,
        totalDebit,
        totalCredit,
        difference,
        balanced: difference === 0,
        hasError: hasError || issues.slice(before).some((i) => i.severity === 'ERROR'),
      };
      if (e.particulars.length < 3) e.particulars = `${e.particulars} (imported)`;
      entries.push(e);
      if (e.primaryReference && /^\d{5,10}$/.test(e.primaryReference) && lines.some((l) => l.credit > 0 && l.accountCode === '1-01-02-010'))
        checkUse.set(e.primaryReference, [...(checkUse.get(e.primaryReference) ?? []), key]);
    }
    for (const [no, keys] of checkUse)
      if (keys.length > 1)
        for (const k of keys) {
          const e = entries.find((x) => x.key === k)!;
          issue('WARNING', sheet, e.rows[0]!, 'DUPLICATE_CHECK', `Check no. ${no} is used by ${keys.length} entries.`, k);
        }
    for (const cc of cancelledChecks) {
      if (checkUse.has(cc.checkNumber)) issue('WARNING', sheet, cc.rows[0]!, 'DUPLICATE_CHECK', `Check no. ${cc.checkNumber} is marked cancelled but is also used by an entry.`);
      if (!cc.date) issue('WARNING', sheet, cc.rows[0]!, 'MISSING_DATE', `Cancelled check ${cc.checkNumber} has no date; it will not be imported.`);
    }
    entries.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.rows[0]! - b.rows[0]!);
  } else if (!sh.journal) issue('WARNING', '(workbook)', null, 'NO_SHEET', 'No 01_CY DB sheet: no current-year journal.');

  // ---- Prior years (02.2_PRETB_3Y) + workbook TB of the import year (tie-out)
  const priorYears: ImportPriorYear[] = [];
  const workbookTb: WorkbookImport['workbookTb'] = [];
  if (sh.preTb && fiscalYear) {
    const rows = rowsOf(sh.preTb);
    let yearRow = -1;
    const yearCols = new Map<number, number>();
    for (let r = 0; r < Math.min(rows.length, 10) && yearRow < 0; r++) {
      (rows[r] ?? []).forEach((v, i) => {
        const t = cellText(v);
        // Merged header cells repeat their value in every cell: keep the first (Debit) column.
        if (/^(19|20)\d{2}$/.test(t) && !yearCols.has(Number(t))) yearCols.set(Number(t), i);
      });
      if (yearCols.size) yearRow = r;
    }
    if (yearRow < 0) issue('WARNING', sh.preTb, null, 'NO_HEADER', 'Pre-closing TB: no year columns found.');
    else {
      // Account-code column = the column holding x-xx-xx-xxx codes (the header can be anything, e.g. "fff").
      let codeCol = -1;
      for (let r = yearRow + 1; r < Math.min(rows.length, yearRow + 10) && codeCol < 0; r++)
        codeCol = (rows[r] ?? []).findIndex((v) => IMPORT_ACCOUNT_RE.test(cellText(v)));
      const readYear = (fy: number) => {
        const col = yearCols.get(fy);
        if (col === undefined) return null;
        const out: Array<{ accountCode: string; debit: Centavos; credit: Centavos }> = [];
        for (let r = yearRow + 1; r < rows.length; r++) {
          const row = rows[r] ?? [];
          const code = cellText(row[codeCol]);
          if (!IMPORT_ACCOUNT_RE.test(code)) continue;
          const dr = safeCentavos(row[col]);
          const cr = safeCentavos(row[col + 1]);
          if (dr === null || cr === null) {
            issue('WARNING', sh.preTb!, r + 1, 'BAD_AMOUNT', `${fy}: amount for ${code} is not a number; skipped.`);
            continue;
          }
          const s = sides(dr, cr);
          const net = s.debit - s.credit;
          if (net === 0) continue;
          if (!COA_MAP.has(code)) issue('WARNING', sh.preTb!, r + 1, 'UNKNOWN_ACCOUNT', `${fy}: account ${code} is not in the BFMS Chart of Accounts (kept for comparatives).`);
          out.push({ accountCode: code, debit: (net > 0 ? net : 0) as Centavos, credit: (net < 0 ? -net : 0) as Centavos });
        }
        return out;
      };
      if (codeCol >= 0) {
        for (const fy of [fiscalYear - 1, fiscalYear - 2]) {
          const rs = readYear(fy);
          if (!rs) {
            issue('WARNING', sh.preTb, null, 'NO_YEAR', `Pre-closing TB has no ${fy} column.`);
            continue;
          }
          const totalDebit = sumC(rs.map((x) => x.debit));
          const totalCredit = sumC(rs.map((x) => x.credit));
          if (totalDebit !== totalCredit) issue('WARNING', sh.preTb, null, 'UNBALANCED', `${fy} pre-closing TB does not balance: difference ${peso(totalDebit - totalCredit)}.`);
          priorYears.push({ fiscalYear: fy, rows: rs, totalDebit, totalCredit });
        }
        for (const x of readYear(fiscalYear) ?? []) workbookTb.push({ accountCode: x.accountCode, balance: (x.debit - x.credit) as Centavos });
      }
    }
  }

  // ---- Legacy cash advances
  const legacyCashAdvances: ImportLegacyCashAdvance[] = [];
  const LEGACY_CA_CODES: Record<string, string> = { '106': '1-03-03-010', '148': '1-03-03-020', '123': '1-03-04-020' };
  const nameToCode = new Map<string, string>(COA.map((a) => [norm(a.accountName), a.accountCode]));
  nameToCode.set('payroll fund', '1-03-03-010');
  const resolveCaAccount = (code: string, name: string): string | null => {
    if (IMPORT_ACCOUNT_RE.test(code) && COA_MAP.has(code)) return code;
    if (LEGACY_CA_CODES[code]) return LEGACY_CA_CODES[code]!;
    return nameToCode.get(norm(name)) ?? null;
  };
  const tokens = (s: string) => norm(s).split(' ').filter((t) => t.length > 1 && !['jr', 'sr', 'ii', 'iii', 'hon'].includes(t));
  let lastSlGuess: string | null = null;
  const officerSl = (accountCode: string, officer: string): string | null => {
    lastSlGuess = null;
    const want = tokens(officer);
    if (!want.length) return null;
    const cands = subsidiaries.filter((s) => s.accountCode === accountCode);
    const exact = cands.filter((s) => {
      const t = tokens(s.subsidiaryName);
      return t.length === want.length && t.every((x) => want.includes(x));
    });
    if (exact.length === 1) return exact[0]!.subsidiaryCode;
    const fl = cands.filter((s) => {
      const t = tokens(s.subsidiaryName);
      return t[0] === want[0] && t[t.length - 1] === want[want.length - 1];
    });
    if (fl.length === 1) return fl[0]!.subsidiaryCode;
    // First name and surname each off by a small typo (SHIELA / SHEILA, CAMNCHO / CAMANCHO).
    const near = cands.filter((s) => {
      const t = tokens(s.subsidiaryName);
      return t.length > 0 && editDistance(t[0]!, want[0]!) <= 2 && editDistance(t[t.length - 1]!, want[want.length - 1]!) <= 2;
    });
    if (near.length !== 1) return null;
    lastSlGuess = `${near[0]!.subsidiaryCode} ${near[0]!.subsidiaryName}`;
    return near[0]!.subsidiaryCode;
  };
  const caSpec = {
    date: /^date$/i,
    check: /^check(\s*no\.?)?$/i,
    dv: /^(dv\s*no\.?|ref\.?)$/i,
    accountName: /^account name$/i,
    accountCode: /^(account code|new code)$/i,
    oldCode: /^old code$/i,
    officer: /^(name|ao|officer)$/i,
    particulars: /^particulars$/i,
    amount: /^amount$/i,
  };
  const caSeen = new Set<string>();
  for (const sheet of sh.cashAdvances) {
    const rows = rowsOf(sheet);
    let h = findHeader(rows, caSpec, ['date', 'officer', 'amount'], 0, 15);
    if (!h) continue;
    let section: Array<{ row: number; ca: Omit<ImportLegacyCashAdvance, 'accountCode' | 'subsidiaryCode'>; account: string | null }> = [];
    const flush = () => {
      const known = section.find((s) => s.account)?.account ?? null;
      let last = known;
      for (const s of section) {
        const account = s.account ?? last;
        if (s.account) last = s.account;
        if (!account) {
          issue('WARNING', sheet, s.row, 'CA_NO_ACCOUNT', `Cash advance of ${s.ca.officerName} (${peso(s.ca.amount)}): account could not be determined; skipped.`);
          continue;
        }
        const k = `${account}|${s.ca.checkNumber ?? ''}|${s.ca.amount}|${norm(s.ca.officerName)}|${s.ca.date}`;
        if (caSeen.has(k)) continue;
        caSeen.add(k);
        const slc = officerSl(account, s.ca.officerName);
        if (lastSlGuess) issue('WARNING', sheet, s.row, 'CA_SL_GUESSED', `Cash advance of ${s.ca.officerName} (${peso(s.ca.amount)}) matched to ${account} ${lastSlGuess} by similar spelling; check that it is the same person.`);
        legacyCashAdvances.push({ ...s.ca, accountCode: account, subsidiaryCode: slc });
      }
      section = [];
    };
    for (let r = h.index + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const hc = h.cols;
      const texts = row.map(cellText);
      if (texts.some((t) => /^(sub\s*)?total|grand total|total amount/i.test(t))) {
        flush();
        continue;
      }
      const again = findHeader([row], caSpec, ['date', 'officer', 'amount'], 0, 1);
      if (again) {
        flush();
        h = { index: r, cols: again.cols };
        continue;
      }
      const officer = cellText(row[hc.officer!]);
      const amt = safeCentavos(row[hc.amount!]);
      const d = cellDate(row[hc.date!]).date;
      if (!officer || amt === null || amt === 0) continue;
      if (/prepared|certified|accountant/i.test(officer)) continue;
      if (!d) {
        issue('WARNING', sheet, r + 1, 'MISSING_DATE', `Cash advance of ${officer} (${peso(amt)}) has no date; skipped.`);
        continue;
      }
      const code = hc.accountCode !== undefined ? cellText(row[hc.accountCode]) : '';
      const old = hc.oldCode !== undefined ? cellText(row[hc.oldCode]) : '';
      const aname = hc.accountName !== undefined ? cellText(row[hc.accountName]) : '';
      const account = resolveCaAccount(code, aname) ?? (old ? resolveCaAccount(old, '') : null);
      const ref = hc.dv !== undefined ? textOrNull(row[hc.dv]) : null;
      section.push({
        row: r + 1,
        account,
        ca: {
          officerName: officer.slice(0, 160),
          date: d,
          checkNumber: hc.check !== undefined ? textOrNull(row[hc.check])?.slice(0, 40) ?? null : null,
          dvNumber: ref ? (/^\d{4}-\d{2}-\d{2}$/.test(ref) ? null : ref.slice(0, 60)) : null,
          particulars: (hc.particulars !== undefined ? cellText(row[hc.particulars]) : '').slice(0, 500),
          amount: amt,
          sheet,
          row: r + 1,
        },
      });
    }
    flush();
  }
  const unmatched = legacyCashAdvances.filter((c) => !c.subsidiaryCode).length;
  if (unmatched) issue('WARNING', sh.cashAdvances[0] ?? '(workbook)', null, 'CA_NO_SL', `${unmatched} legacy cash advance(s) could not be matched to an AO/EO subsidiary ledger by officer name (imported without SL).`);

  // ---- PPE depreciation schedule: last block of asset rows in the preferred sheet.
  const ppeSchedule: ImportPpeRow[] = [];
  if (sh.ppe) {
    const rows = rowsOf(sh.ppe);
    const spec = { life: /^(life|years|useful life)/i, residualRate: /^residual( rate| %)?$/i, residualAmount: /^residual (value|amount)$/i, depreciation: /^depreciation expense$/i, cost: /^(cost|acquisition cost|total cost)$/i, depreciable: /^depreciable/i };
    let cols: Record<string, number> | null = null;
    const blocks: Array<{ cols: Record<string, number>; rows: number[] }> = [];
    let curBlock: { cols: Record<string, number>; rows: number[] } | null = null;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const hh = findHeader([row], spec, ['life'], 0, 1);
      if (hh) {
        cols = hh.cols;
        curBlock = null;
        continue;
      }
      const code = cellText(row[0]);
      const isAsset = /^1-07-\d{2}-\d{2}0$/.test(code) && typeof row[2] === 'number';
      if (isAsset && cols) {
        if (!curBlock) {
          curBlock = { cols, rows: [] };
          blocks.push(curBlock);
        }
        curBlock.rows.push(r);
      } else curBlock = null; // any other row (blank, totals, contra accounts) ends the block
    }
    const block = blocks[blocks.length - 1];
    if (!block) issue('WARNING', sh.ppe, null, 'NO_HEADER', 'PPE schedule: no rows with code, cost and life found.');
    else {
      if (blocks.length > 1) issue('WARNING', sh.ppe, block.rows[0]! + 1, 'PPE_BLOCK', `PPE sheet has ${blocks.length} schedules; the last one (from row ${block.rows[0]! + 1}) is used.`);
      for (const r of block.rows) {
        const row = rows[r] ?? [];
        const bc = block.cols;
        const code = cellText(row[0]);
        const cost = safeCentavos(row[bc.cost ?? 2]) ?? (0 as Centavos);
        const life = Number(row[bc.life!]);
        if (!COA_MAP.has(code)) {
          issue('WARNING', sh.ppe, r + 1, 'UNKNOWN_ACCOUNT', `PPE account ${code} is not in the BFMS Chart of Accounts; skipped.`);
          continue;
        }
        if (!Number.isFinite(life) || life <= 0 || life > 100) {
          issue('WARNING', sh.ppe, r + 1, 'PPE_LIFE', `PPE ${code}: useful life "${cellText(row[bc.life!])}" is not valid; skipped.`);
          continue;
        }
        let bp = 0;
        const rateCell = bc.residualRate !== undefined ? row[bc.residualRate] : undefined;
        if (typeof rateCell === 'number') bp = Math.round((rateCell <= 1 ? rateCell * 100 : rateCell) * 100);
        else if (typeof rateCell === 'string' && /%/.test(rateCell)) bp = Math.round(parseFloat(rateCell) * 100);
        else if (bc.residualAmount !== undefined && cost > 0) bp = Math.round(((safeCentavos(row[bc.residualAmount]) ?? 0) / cost) * 10000);
        if (bp !== 0 && bp !== 500) issue('WARNING', sh.ppe, r + 1, 'PPE_RESIDUAL', `PPE ${code}: residual rate ${bp / 100}% (usually 0% or 5%).`);
        const def = importPpeAccounts(code);
        if (!def.accumulated) {
          issue('WARNING', sh.ppe, r + 1, 'UNKNOWN_ACCOUNT', `PPE ${code}: no accumulated-depreciation account ${code.replace(/\d$/, '1')} in the Chart of Accounts; skipped.`);
          continue;
        }
        // Explicit codes in the sheet are often shifted copies; the COA pairing is authoritative.
        for (const v of row.slice(7)) {
          const t = cellText(v);
          if (/^1-07-\d{2}-\d{2}1$/.test(t) && t !== def.accumulated) issue('WARNING', sh.ppe, r + 1, 'PPE_CODE', `PPE ${code}: sheet shows accumulated depreciation ${t}; using ${def.accumulated}.`);
          if (/^5-04-01-\d{3}$/.test(t) && t !== def.expense) issue('WARNING', sh.ppe, r + 1, 'PPE_CODE', `PPE ${code}: sheet shows depreciation expense ${t}; using ${def.expense}.`);
        }
        const dep = safeCentavos(row[bc.depreciation ?? -1]) ?? (0 as Centavos);
        ppeSchedule.push({
          accountCode: code,
          accountName: COA_MAP.get(code)!.accountName,
          costOverride: null,
          residualRateBp: bp,
          usefulLifeYears: Math.round(life),
          accumulatedAccountCode: def.accumulated,
          expenseAccountCode: def.expense,
          remarks: `Imported from "${sh.ppe}": workbook cost ${peso(cost)}, annual depreciation ${peso(dep)}.`,
          workbookCost: cost,
          workbookDepreciation: dep,
          row: r + 1,
        });
      }
    }
  }

  const barangayGuess = opts.barangayId ?? ([...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null);
  return {
    title: opts.title ?? '',
    barangayGuess,
    fiscalYear,
    sheets: sh,
    subsidiaries,
    opening,
    entries,
    cancelledChecks,
    priorYears,
    legacyCashAdvances,
    ppeSchedule,
    workbookTb,
    issues,
  };
}

// ---------------------------------------------------------------------------------------------
// Preview helpers (pure; used by the import page and the tie-out check)

/** Signed balance (debit − credit) per account from the opening entry + importable entries. */
export function projectedBalances(w: Pick<WorkbookImport, 'opening' | 'entries'>, opts: { includeErrors?: boolean } = {}): Map<string, number> {
  const m = new Map<string, number>();
  const add = (lines: readonly ImportLine[]) => lines.forEach((l) => m.set(l.accountCode, (m.get(l.accountCode) ?? 0) + l.debit - l.credit));
  if (w.opening && (opts.includeErrors || !w.opening.hasError)) add(w.opening.lines);
  for (const e of w.entries) if (opts.includeErrors || !e.hasError) add(e.lines);
  return m;
}

/** Compare the projected BFMS balances with the workbook's own pre-closing TB of the import year. */
export function tieOut(w: WorkbookImport, opts: { includeErrors?: boolean } = {}): Array<{ accountCode: string; workbook: number; imported: number; difference: number }> {
  if (!w.workbookTb.length) return [];
  const proj = projectedBalances(w, opts);
  const codes = new Set([...proj.keys(), ...w.workbookTb.map((x) => x.accountCode)]);
  const wb = new Map(w.workbookTb.map((x) => [x.accountCode, x.balance as number]));
  return [...codes]
    .sort()
    .map((accountCode) => ({ accountCode, workbook: wb.get(accountCode) ?? 0, imported: proj.get(accountCode) ?? 0, difference: (proj.get(accountCode) ?? 0) - (wb.get(accountCode) ?? 0) }))
    .filter((x) => x.difference !== 0);
}

/** Entries per month (importable vs with errors) for the preview. */
export function entriesByMonth(entries: readonly ImportEntry[]): Array<{ month: string; entries: number; errors: number; debit: number }> {
  const m = new Map<string, { month: string; entries: number; errors: number; debit: number }>();
  for (const e of entries) {
    const k = e.date ? e.date.slice(0, 7) : '(no date)';
    const r = m.get(k) ?? { month: k, entries: 0, errors: 0, debit: 0 };
    r.entries++;
    if (e.hasError) r.errors++;
    r.debit += e.totalDebit;
    m.set(k, r);
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** Short fingerprint (FNV-1a) of the importable content — lets the server recognise a resumed import. */
export function importFingerprint(w: Pick<WorkbookImport, 'opening' | 'entries' | 'fiscalYear'>): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  feed(String(w.fiscalYear));
  if (w.opening) feed(`O${w.opening.totalDebit}`);
  for (const e of w.entries) feed(`${e.key}${e.date}${e.totalDebit}`);
  return h.toString(16).padStart(8, '0');
}
