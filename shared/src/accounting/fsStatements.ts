import { buildChartOfAccounts } from '../constants/chartOfAccounts';
import type { AccountBalanceDoc } from '../types/accounting';
import type { CashFlowClass, ChartOfAccountDoc } from '../types/coa';
import type { Centavos } from '../types/common';
import { checkCashFlow, checkFinancialPosition, computeNetAssetsChanges } from './statements';

/**
 * Financial-statement mapping and aggregation (docs 06 §16). Pure: period balances + Chart of
 * Accounts in, statement figures out. Every amount is integer centavos, presented on the side of
 * its LINE (assets/expenses debit, liabilities/equity/revenue credit) so contra accounts
 * (accumulated depreciation, allowances) net automatically within their line.
 */

export type FsStatement = 'SFP' | 'SFPERF';
export type FsSection = 'CA' | 'NCA' | 'CL' | 'NCL' | 'EQUITY' | 'REV' | 'EXP' | 'TRANSFERS_FROM' | 'TRANSFERS_TO';
export type FsSide = 'DEBIT' | 'CREDIT';

export interface FsLineDef {
  id: string;
  statement: FsStatement;
  section: FsSection;
  label: string;
  side: FsSide;
}

export const FS_SECTION_LABELS: Record<FsSection, string> = {
  CA: 'Current Assets',
  NCA: 'Non-Current Assets',
  CL: 'Current Liabilities',
  NCL: 'Non-Current Liabilities',
  EQUITY: 'Net Assets/Equity',
  REV: 'Revenue',
  EXP: 'Current Operating Expenses',
  TRANSFERS_FROM: 'Transfers, Assistance and Subsidy From',
  TRANSFERS_TO: 'Transfers, Assistance and Subsidy To',
};

const L = (id: string, section: FsSection, label: string): FsLineDef => ({
  id,
  statement: id.startsWith('SFPERF') ? 'SFPERF' : 'SFP',
  section,
  label,
  side: ['CA', 'NCA', 'EXP', 'TRANSFERS_TO'].includes(section) ? 'DEBIT' : 'CREDIT',
});

/** Line catalog in presentation order (legacy Agboy 2025 statements / MFMB). */
export const FS_LINES: readonly FsLineDef[] = [
  L('SFP.CA.CASH', 'CA', 'Cash and Cash Equivalents'),
  L('SFP.CA.INVESTMENTS', 'CA', 'Investments'),
  L('SFP.CA.RECEIVABLES', 'CA', 'Receivables'),
  L('SFP.CA.INVENTORIES', 'CA', 'Inventories'),
  L('SFP.CA.PREPAYMENTS', 'CA', 'Prepayments and Deferred Charges'),
  L('SFP.NCA.INVESTMENTS', 'NCA', 'Investments'),
  L('SFP.NCA.RECEIVABLES', 'NCA', 'Receivables'),
  L('SFP.NCA.INVESTMENT_PROPERTY', 'NCA', 'Investment Property'),
  L('SFP.NCA.PPE', 'NCA', 'Property, Plant and Equipment'),
  L('SFP.NCA.BIOLOGICAL_ASSETS', 'NCA', 'Biological Assets'),
  L('SFP.NCA.OTHER', 'NCA', 'Other Assets'),
  L('SFP.CL.FINANCIAL_LIABILITIES', 'CL', 'Financial Liabilities'),
  L('SFP.CL.INTER_AGENCY_PAYABLES', 'CL', 'Inter-Agency Payables'),
  L('SFP.CL.TRUST_LIABILITIES', 'CL', 'Trust Liabilities'),
  L('SFP.CL.OTHER_PAYABLES', 'CL', 'Other Payables'),
  L('SFP.NCL.LOANS', 'NCL', 'Financial Liabilities (Loans Payable)'),
  L('SFP.EQUITY', 'EQUITY', 'Government Equity'),
  L('SFPERF.REV.TAX', 'REV', 'Tax Revenue'),
  L('SFPERF.REV.SHARE_IRA', 'REV', 'Share from Internal Revenue Collections'),
  L('SFPERF.REV.SHARE_NATIONAL_WEALTH', 'REV', 'Share from National Wealth'),
  L('SFPERF.REV.SERVICE_BUSINESS', 'REV', 'Service and Business Income'),
  L('SFPERF.REV.GRANTS_DONATIONS', 'REV', 'Grants and Donations'),
  L('SFPERF.REV.GAINS', 'REV', 'Gains'),
  L('SFPERF.REV.OTHER', 'REV', 'Other Revenue'),
  L('SFPERF.EXP.PERSONNEL_SERVICES', 'EXP', 'Personnel Services'),
  L('SFPERF.EXP.MOOE', 'EXP', 'Maintenance and Other Operating Expenses'),
  L('SFPERF.EXP.FINANCIAL', 'EXP', 'Financial Expenses'),
  L('SFPERF.EXP.NON_CASH', 'EXP', 'Non-Cash Expenses'),
  L('SFPERF.TRANSFERS_FROM', 'TRANSFERS_FROM', 'Transfers, Assistance and Subsidy From'),
  L('SFPERF.TRANSFERS_TO', 'TRANSFERS_TO', 'Transfers, Assistance and Subsidy To'),
];

const LINE_BY_ID = new Map(FS_LINES.map((l) => [l.id, l]));
export function fsLineDef(id: string): FsLineDef {
  return LINE_BY_ID.get(id)!;
}

export type FsAccount = Pick<ChartOfAccountDoc, 'accountCode' | 'accountName' | 'financialStatementClassification' | 'isContra' | 'normalBalance'> &
  Partial<Pick<ChartOfAccountDoc, 'sortOrder' | 'cashFlowClassification' | 'isCashAccount'>>;
export type FsAccounts = ReadonlyMap<string, FsAccount>;

let seedMap: Map<string, ChartOfAccountDoc> | null = null;
function seed(): Map<string, ChartOfAccountDoc> {
  if (!seedMap) seedMap = new Map(buildChartOfAccounts().map((a) => [a.accountCode, a]));
  return seedMap;
}

/**
 * Statement line of an account: its stored classification when it names a catalog line, else the
 * seed default for the code, else a catch-all by account type (flagged `mapped: false`).
 */
export function resolveFsLine(code: string, account?: Pick<FsAccount, 'financialStatementClassification'> | null): { line: FsLineDef; mapped: boolean } {
  const stored = account?.financialStatementClassification;
  if (stored && LINE_BY_ID.has(stored)) return { line: LINE_BY_ID.get(stored)!, mapped: true };
  const s = seed().get(code)?.financialStatementClassification;
  if (s && LINE_BY_ID.has(s)) return { line: LINE_BY_ID.get(s)!, mapped: true };
  const fallback: Record<string, string> = { '1': 'SFP.NCA.OTHER', '2': 'SFP.CL.OTHER_PAYABLES', '3': 'SFP.EQUITY', '4': 'SFPERF.REV.OTHER', '5': 'SFPERF.EXP.MOOE' };
  return { line: LINE_BY_ID.get(fallback[code[0] ?? ''] ?? 'SFP.NCA.OTHER')!, mapped: false };
}

/** Net (debit − credit) per account from the roll-up rows of months `from..through` (00 opening … 13 closing). */
export function netByAccount(
  balances: readonly Pick<AccountBalanceDoc, 'accountCode' | 'subsidiaryId' | 'debit' | 'credit' | 'month'>[],
  fromMonth: number,
  throughMonth: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of balances) {
    if (b.subsidiaryId !== null || b.month < fromMonth || b.month > throughMonth) continue;
    out.set(b.accountCode, (out.get(b.accountCode) ?? 0) + b.debit - b.credit);
  }
  return out;
}

/** Same as netByAccount but per subsidiary ledger (key `${accountCode}|${subsidiaryId}`). */
export function netBySubsidiary(
  balances: readonly Pick<AccountBalanceDoc, 'accountCode' | 'subsidiaryId' | 'debit' | 'credit' | 'month'>[],
  fromMonth: number,
  throughMonth: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of balances) {
    if (b.subsidiaryId === null || b.month < fromMonth || b.month > throughMonth) continue;
    const k = `${b.accountCode}|${b.subsidiaryId}`;
    out.set(k, (out.get(k) ?? 0) + b.debit - b.credit);
  }
  return out;
}

/** Amount presented on a line: debit-side lines show net, credit-side lines show −net. */
export function onSide(side: FsSide, net: number): number {
  return side === 'DEBIT' ? net : -net;
}

export interface FsAccountAmount {
  accountCode: string;
  accountName: string;
  amount: number;
  contra: boolean;
}
export interface FsLineAmount {
  line: FsLineDef;
  amount: number;
  accounts: FsAccountAmount[];
}

/** Group net balances under statement lines (accounts with a zero net are dropped). */
export function groupByLine(nets: ReadonlyMap<string, number>, accounts: FsAccounts, statement: FsStatement): { lines: Map<string, FsLineAmount>; unmapped: string[] } {
  const lines = new Map<string, FsLineAmount>();
  const unmapped: string[] = [];
  for (const [code, net] of nets) {
    if (net === 0) continue;
    const a = accounts.get(code);
    const { line, mapped } = resolveFsLine(code, a);
    if (line.statement !== statement) continue;
    if (!mapped) unmapped.push(code);
    const cur = lines.get(line.id) ?? { line, amount: 0, accounts: [] };
    const amount = onSide(line.side, net);
    cur.amount += amount;
    cur.accounts.push({ accountCode: code, accountName: a?.accountName ?? seed().get(code)?.accountName ?? code, amount, contra: !!(a?.isContra ?? seed().get(code)?.isContra) });
    lines.set(line.id, cur);
  }
  for (const l of lines.values()) l.accounts.sort((x, y) => (accounts.get(x.accountCode)?.sortOrder ?? 0) - (accounts.get(y.accountCode)?.sortOrder ?? 0) || x.accountCode.localeCompare(y.accountCode));
  return { lines, unmapped };
}

export interface SfperfFigures {
  lines: Map<string, FsLineAmount>;
  totalRevenue: number;
  totalExpenses: number;
  surplusFromOperations: number;
  transfersFrom: number;
  transfersTo: number;
  surplus: number;
  unmapped: string[];
}

/** Statement of Financial Performance from nets of the period (normally months 01–12). */
export function computeSfperf(nets: ReadonlyMap<string, number>, accounts: FsAccounts): SfperfFigures {
  const { lines, unmapped } = groupByLine(nets, accounts, 'SFPERF');
  const sec = (s: FsSection) => [...lines.values()].filter((l) => l.line.section === s).reduce((t, l) => t + l.amount, 0);
  const totalRevenue = sec('REV');
  const totalExpenses = sec('EXP');
  const transfersFrom = sec('TRANSFERS_FROM');
  const transfersTo = sec('TRANSFERS_TO');
  const surplusFromOperations = totalRevenue - totalExpenses;
  return { lines, totalRevenue, totalExpenses, surplusFromOperations, transfersFrom, transfersTo, surplus: surplusFromOperations + transfersFrom - transfersTo, unmapped };
}

export interface SfpFigures {
  lines: Map<string, FsLineAmount>;
  currentAssets: number;
  nonCurrentAssets: number;
  totalAssets: number;
  currentLiabilities: number;
  nonCurrentLiabilities: number;
  totalLiabilities: number;
  /** Σ equity accounts (3-xx). */
  equityAccounts: number;
  /** Revenue − expenses not yet closed to equity (pre-closing books); 0 after closing entries. */
  unclosedSurplus: number;
  totalNetAssets: number;
  difference: number;
  balanced: boolean;
  unmapped: string[];
}

/**
 * Statement of Financial Position from cumulative nets (normally months 00–13). When closing
 * entries have not been posted, the year's surplus is still in revenue/expense accounts — it
 * flows into Net Assets/Equity here so Assets = Liabilities + Net Assets holds before closing.
 */
export function computeSfp(nets: ReadonlyMap<string, number>, accounts: FsAccounts): SfpFigures {
  const { lines, unmapped } = groupByLine(nets, accounts, 'SFP');
  const sec = (s: FsSection) => [...lines.values()].filter((l) => l.line.section === s).reduce((t, l) => t + l.amount, 0);
  const perf = computeSfperf(nets, accounts);
  const currentAssets = sec('CA');
  const nonCurrentAssets = sec('NCA');
  const currentLiabilities = sec('CL');
  const nonCurrentLiabilities = sec('NCL');
  const equityAccounts = sec('EQUITY');
  const totalAssets = currentAssets + nonCurrentAssets;
  const totalLiabilities = currentLiabilities + nonCurrentLiabilities;
  const totalNetAssets = equityAccounts + perf.surplus;
  const chk = checkFinancialPosition(totalAssets as Centavos, totalLiabilities as Centavos, totalNetAssets as Centavos);
  return {
    lines,
    currentAssets,
    nonCurrentAssets,
    totalAssets,
    currentLiabilities,
    nonCurrentLiabilities,
    totalLiabilities,
    equityAccounts,
    unclosedSurplus: perf.surplus,
    totalNetAssets,
    difference: chk.difference,
    balanced: chk.balanced,
    unmapped: [...unmapped, ...perf.unmapped],
  };
}

export const PRIOR_YEARS_ADJUSTMENTS = '3-01-01-020';

export interface NetAssetsChanges {
  beginningBalance: number;
  priorPeriodAdjustments: number;
  changesInAccountingPolicy: number;
  restatedBalance: number;
  surplusDeficit: number;
  otherAdjustments: number;
  endingBalance: number;
}

/**
 * Statement of Changes in Net Assets/Equity for one fiscal year's balances. Jan 1 = period 00
 * (equity + any unclosed nominal balances); prior years' adjustments = 3-01-01-020 movements in
 * 01–12; other direct equity entries are shown separately. Period 13 (closing) only moves amounts
 * between nominal and equity accounts, so it never changes the total — the ending balance equals
 * the SFP's total net assets.
 */
export function computeEquityChanges(balances: readonly Pick<AccountBalanceDoc, 'accountCode' | 'subsidiaryId' | 'debit' | 'credit' | 'month'>[], accounts: FsAccounts): NetAssetsChanges {
  const isEquity = (code: string) => resolveFsLine(code, accounts.get(code)).line.section === 'EQUITY';
  const isNominal = (code: string) => resolveFsLine(code, accounts.get(code)).line.statement === 'SFPERF';
  let beginning = 0;
  let pya = 0;
  let other = 0;
  for (const [code, net] of netByAccount(balances, 0, 0)) if (isEquity(code) || isNominal(code)) beginning -= net;
  for (const [code, net] of netByAccount(balances, 1, 12)) {
    if (!isEquity(code)) continue;
    if (code === PRIOR_YEARS_ADJUSTMENTS) pya -= net;
    else other -= net;
  }
  const surplus = computeSfperf(netByAccount(balances, 1, 12), accounts).surplus;
  const r = computeNetAssetsChanges({
    beginningBalance: beginning as Centavos,
    priorPeriodAdjustments: pya as Centavos,
    changesInAccountingPolicy: 0 as Centavos,
    surplusDeficit: surplus as Centavos,
    otherAdjustments: other as Centavos,
  });
  return { beginningBalance: beginning, priorPeriodAdjustments: pya, changesInAccountingPolicy: 0, restatedBalance: r.restatedBalance, surplusDeficit: surplus, otherAdjustments: other, endingBalance: r.endingBalance };
}

// ------------------------------------------------------------------ cash flows (direct method)

export type ScfSection = 'OPERATING' | 'INVESTING' | 'FINANCING';
export interface ScfLineDef {
  id: string;
  section: ScfSection;
  direction: 'IN' | 'OUT';
  label: string;
}

/** SCF line catalog (legacy direct-method layout). */
export const SCF_LINES: readonly ScfLineDef[] = [
  { id: 'OP_IN_TAX', section: 'OPERATING', direction: 'IN', label: 'Collection from taxpayers' },
  { id: 'OP_IN_IRA', section: 'OPERATING', direction: 'IN', label: 'Share from Internal Revenue Collections (NTA)' },
  { id: 'OP_IN_SERVICE', section: 'OPERATING', direction: 'IN', label: 'Receipts from business/service income' },
  { id: 'OP_IN_INTEREST', section: 'OPERATING', direction: 'IN', label: 'Interest income' },
  { id: 'OP_IN_OTHER', section: 'OPERATING', direction: 'IN', label: 'Other receipts' },
  { id: 'OP_OUT_PS', section: 'OPERATING', direction: 'OUT', label: 'Payments for personnel services' },
  { id: 'OP_OUT_MOOE', section: 'OPERATING', direction: 'OUT', label: 'Payments for maintenance and other operating expenses' },
  { id: 'OP_OUT_FIN', section: 'OPERATING', direction: 'OUT', label: 'Payments for financial expenses' },
  { id: 'OP_OUT_TRANSFERS', section: 'OPERATING', direction: 'OUT', label: 'Transfers, assistance and subsidy (SK, LDRRMF and others)' },
  { id: 'OP_OUT_REMIT', section: 'OPERATING', direction: 'OUT', label: 'Remittance of taxes withheld and mandatory deductions' },
  { id: 'OP_OUT_ADVANCES', section: 'OPERATING', direction: 'OUT', label: 'Grant of cash advances' },
  { id: 'OP_OUT_OTHER', section: 'OPERATING', direction: 'OUT', label: 'Other disbursements' },
  { id: 'INV_IN_PPE', section: 'INVESTING', direction: 'IN', label: 'Proceeds from sale/disposal of property, plant and equipment' },
  { id: 'INV_IN_INV', section: 'INVESTING', direction: 'IN', label: 'Proceeds from matured investments' },
  { id: 'INV_OUT_PPE', section: 'INVESTING', direction: 'OUT', label: 'Purchase/construction of property, plant and equipment' },
  { id: 'INV_OUT_INV', section: 'INVESTING', direction: 'OUT', label: 'Purchase of investments' },
  { id: 'FIN_IN_LOANS', section: 'FINANCING', direction: 'IN', label: 'Proceeds from loans' },
  { id: 'FIN_OUT_LOANS', section: 'FINANCING', direction: 'OUT', label: 'Payment of loan amortization' },
];

export const SCF_SECTION_LABELS: Record<ScfSection, string> = {
  OPERATING: 'Cash Flows from Operating Activities',
  INVESTING: 'Cash Flows from Investing Activities',
  FINANCING: 'Cash Flows from Financing Activities',
};

export function isCashCode(code: string, account?: Pick<FsAccount, 'isCashAccount'> | null): boolean {
  return account?.isCashAccount ?? code.startsWith('1-01');
}

function cashFlowClass(code: string, account?: Pick<FsAccount, 'cashFlowClassification'> | null): CashFlowClass | null {
  if (account?.cashFlowClassification) return account.cashFlowClassification;
  return seed().get(code)?.cashFlowClassification ?? (code.startsWith('2-01-03') ? 'FINANCING' : /^1-0[2678]/.test(code) ? 'INVESTING' : 'OPERATING');
}

/** SCF line for a counter-account amount (+ inflow / − outflow). */
export function scfLineFor(code: string, amount: number, account?: Pick<FsAccount, 'cashFlowClassification' | 'accountName'> | null): ScfLineDef {
  const inflow = amount > 0;
  const cls = cashFlowClass(code, account);
  const id = (() => {
    if (cls === 'INVESTING') return code.startsWith('1-02') ? (inflow ? 'INV_IN_INV' : 'INV_OUT_INV') : inflow ? 'INV_IN_PPE' : 'INV_OUT_PPE';
    if (cls === 'FINANCING') return inflow ? 'FIN_IN_LOANS' : 'FIN_OUT_LOANS';
    if (inflow) {
      if (code.startsWith('4-01-04-010')) return 'OP_IN_IRA';
      if (/interest/i.test(account?.accountName ?? '') && code.startsWith('4')) return 'OP_IN_INTEREST';
      if (code.startsWith('4-01')) return 'OP_IN_TAX';
      if (code.startsWith('4-04')) return 'OP_IN_SERVICE';
      return 'OP_IN_OTHER';
    }
    if (code.startsWith('5-01')) return 'OP_OUT_PS';
    if (code.startsWith('5-02-10')) return 'OP_OUT_TRANSFERS';
    if (code.startsWith('5-03')) return 'OP_OUT_FIN';
    if (code.startsWith('5-02') || code.startsWith('1-04') || code.startsWith('1-05') || code.startsWith('2-01-01')) return 'OP_OUT_MOOE';
    if (code.startsWith('2-02')) return 'OP_OUT_REMIT';
    if (code.startsWith('1-03-03')) return 'OP_OUT_ADVANCES';
    return 'OP_OUT_OTHER';
  })();
  return SCF_LINES.find((l) => l.id === id)!;
}

export interface CashFlowLine {
  jevId: string;
  accountCode: string;
  debit: number;
  credit: number;
}

/**
 * Classify cash movements by the counter-account of each journal entry (docs 06 §16 item 5).
 * Per JEV: N = net cash change (Σ cash Dr − Cr). Transfers between cash accounts net to zero
 * and are skipped. N is allocated over the counter lines moving the same way (largest remainder,
 * so the parts sum exactly to N); counter lines moving the other way (e.g. tax withheld on a DV)
 * reduce the gross instead of appearing as separate flows.
 */
export function allocateCashFlows(lines: readonly CashFlowLine[], isCash: (code: string) => boolean): Array<{ jevId: string; accountCode: string; amount: number }> {
  const byJev = new Map<string, CashFlowLine[]>();
  for (const l of lines) byJev.set(l.jevId, [...(byJev.get(l.jevId) ?? []), l]);
  const out: Array<{ jevId: string; accountCode: string; amount: number }> = [];
  for (const [jevId, ls] of byJev) {
    let n = 0;
    const counter = new Map<string, number>();
    for (const l of ls) {
      if (isCash(l.accountCode)) n += l.debit - l.credit;
      else counter.set(l.accountCode, (counter.get(l.accountCode) ?? 0) + l.credit - l.debit);
    }
    if (n === 0) continue;
    const sign = Math.sign(n);
    const same = [...counter].filter(([, c]) => Math.sign(c) === sign).sort((a, b) => a[0].localeCompare(b[0]));
    const total = same.reduce((t, [, c]) => t + Math.abs(c), 0);
    const abs = Math.abs(n);
    if (!total) {
      // Unbalanced input (cannot happen with posted JEVs): keep the cash movement visible.
      out.push({ jevId, accountCode: '', amount: n });
      continue;
    }
    const parts = same.map(([code, c]) => {
      const exact = (abs * Math.abs(c)) / total;
      return { code, base: Math.floor(exact), frac: exact - Math.floor(exact) };
    });
    let rest = abs - parts.reduce((t, p) => t + p.base, 0);
    for (const p of [...parts].sort((a, b) => b.frac - a.frac || a.code.localeCompare(b.code))) {
      if (rest <= 0) break;
      p.base += 1;
      rest -= 1;
    }
    for (const p of parts) if (p.base) out.push({ jevId, accountCode: p.code, amount: sign * p.base });
  }
  return out;
}

export interface ScfFigures {
  lines: Map<string, { line: ScfLineDef; amount: number }>;
  operating: number;
  investing: number;
  financing: number;
  netChange: number;
  beginningCash: number;
  endingCash: number;
  cashAccountsEnding: number;
  difference: number;
  reconciled: boolean;
}

/** Statement of Cash Flows for one year: cash lines of months 01–12 + cash balances (00 and 00–12). */
export function computeScf(
  lines: readonly (CashFlowLine & { month: number })[],
  balances: readonly Pick<AccountBalanceDoc, 'accountCode' | 'subsidiaryId' | 'debit' | 'credit' | 'month'>[],
  accounts: FsAccounts,
): ScfFigures {
  const isCash = (code: string) => isCashCode(code, accounts.get(code));
  const flows = allocateCashFlows(lines.filter((l) => l.month >= 1 && l.month <= 12), isCash);
  const out = new Map<string, { line: ScfLineDef; amount: number }>();
  for (const f of flows) {
    const line = scfLineFor(f.accountCode, f.amount, accounts.get(f.accountCode));
    const cur = out.get(line.id) ?? { line, amount: 0 };
    cur.amount += f.amount;
    out.set(line.id, cur);
  }
  const sec = (s: ScfSection) => [...out.values()].filter((l) => l.line.section === s).reduce((t, l) => t + l.amount, 0);
  const cashSum = (from: number, to: number) => [...netByAccount(balances, from, to)].filter(([c]) => isCash(c)).reduce((t, [, v]) => t + v, 0);
  const beginningCash = cashSum(0, 0);
  const cashAccountsEnding = cashSum(0, 13);
  const r = checkCashFlow({ beginningCash: beginningCash as Centavos, operating: sec('OPERATING') as Centavos, investing: sec('INVESTING') as Centavos, financing: sec('FINANCING') as Centavos, cashAccountsEnding: cashAccountsEnding as Centavos });
  return { lines: out, operating: sec('OPERATING'), investing: sec('INVESTING'), financing: sec('FINANCING'), netChange: r.netChange, beginningCash, endingCash: r.endingCash, cashAccountsEnding, difference: r.difference, reconciled: r.reconciled };
}
