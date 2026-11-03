import {
  FS_LINES,
  SCF_LINES,
  SCF_SECTION_LABELS,
  computeEquityChanges,
  computeScf,
  computeSfp,
  computeSfperf,
  isCashCode,
  netByAccount,
  netBySubsidiary,
  resolveFsLine,
  type FsAccounts,
  type FsLineAmount,
  type FsSection,
  type ScfFigures,
  type ScfSection,
} from '../../accounting/fsStatements';
import { EXPENSE_CLASSES } from '../../modules/budget';
import { defaultNfsNotes, nfsNarrativeId, type NfsNarrativeDoc } from '../../modules/books';
import type { AccountBalanceDoc, JournalLineDoc } from '../../types/accounting';
import type { LegacyBalanceDoc } from '../../types/accountingSchedules';
import type { AppropriationDoc, EstimatedIncomeDoc } from '../../types/budget';
import type { ReportBuilder, ReportContext } from '../context';
import type { WithId } from '../datasource';
import { periodBalances, peso } from '../helpers';
import { col, row, table, validation, type ReportColumn, type ReportRow, type ReportSection } from '../model';

/**
 * Phase 11 — Financial statements (docs 06 §16). Built from the `accountBalances` period
 * aggregates of FY and FY−1 through the pure mapping in accounting/fsStatements.ts; nothing is
 * hard-coded per barangay. When FY−1 has no balances in BFMS (first year on the system), the
 * SFP comparative is the FY opening balances (period 00) — the same figures as at Dec 31 of FY−1.
 */

type Bal = WithId<AccountBalanceDoc>;

/**
 * One column of a statement. BFMS = the year's own postings; LEGACY = the prior year's pre-closing
 * trial balance imported from the workbook (legacyBalances); OPENING = no prior-year data at all,
 * so the SFP comparative is FY's period-00 opening balances.
 */
interface YearData {
  fy: number;
  bals: Bal[];
  source: 'BFMS' | 'LEGACY' | 'OPENING';
}

interface FsData {
  fy: number;
  accounts: FsAccounts;
  cur: Bal[];
  prior: Bal[];
  hasPrior: boolean;
  /** Comparative years shown after FY (up to FY−1 and FY−2, as the legacy statements do). */
  comparatives: YearData[];
}

const hasRollup = (b: readonly Bal[]) => b.some((x) => x.subsidiaryId === null);

/**
 * Rows from an imported pre-closing TB: equity accounts (except prior years' adjustments) count
 * as January 1 balances (period 00), everything else as the year's activity (period 12), so the
 * SFP, SFPerf and SCNAE builders treat them exactly like posted balances.
 */
function legacyRows(doc: LegacyBalanceDoc): Bal[] {
  return doc.rows.map((r, i) => {
    const month = r.accountCode.startsWith('3-') && r.accountCode !== '3-01-01-020' ? 0 : 12;
    return { id: `legacy-${i}`, barangayId: doc.barangayId, fiscalYear: doc.fiscalYear, month, accountingPeriod: `${doc.fiscalYear}-${String(month).padStart(2, '0')}`, fundId: 'GF', accountCode: r.accountCode, subsidiaryId: null, debit: r.debit, credit: r.credit, lineCount: 1, updatedAt: doc.importedAt } as Bal;
  });
}

async function loadYear(ctx: ReportContext, fy: number): Promise<YearData | null> {
  const bals = await periodBalances(ctx, fy);
  if (hasRollup(bals)) return { fy, bals, source: 'BFMS' };
  const legacy = await ctx.ds.get<LegacyBalanceDoc>('legacyBalances', `${ctx.params.barangayId}_${fy}`);
  return legacy?.rows.length ? { fy, bals: legacyRows(legacy), source: 'LEGACY' } : null;
}

async function fsData(ctx: ReportContext): Promise<FsData> {
  const fy = ctx.params.fiscalYear;
  const [accounts, cur, p1, p2] = await Promise.all([ctx.accounts(), periodBalances(ctx), loadYear(ctx, fy - 1), loadYear(ctx, fy - 2)]);
  const comparatives = [p1, p2].filter((y): y is YearData => !!y);
  // First year on the system and nothing imported: compare the SFP with the opening balances.
  if (!p1) comparatives.unshift({ fy: fy - 1, bals: cur.filter((b) => b.month === 0), source: 'OPENING' });
  return { fy, accounts, cur, prior: p1?.bals ?? [], hasPrior: !!p1, comparatives };
}

const asAt = (fy: number) => `As at December 31, ${fy}`;
const fsSigns = (ctx: ReportContext) => [ctx.sign('Certified correct', 'MUNICIPAL_ACCOUNTANT'), ctx.sign('Noted by', 'PUNONG_BARANGAY')];
const yk = (i: number) => `y${i}`;

/** Columns: (code) · particulars · FY · comparatives. */
function cols(fy: number, years: readonly YearData[], detailed: boolean): ReportColumn[] {
  return [...(detailed ? [col('code', 'Account code', 'code')] : []), col('label', 'Particulars', 'text', { width: 4 }), col(yk(0), String(fy), 'money'), ...years.map((y, i) => col(yk(i + 1), String(y.fy), 'money'))];
}

/** Two-column (FY vs FY−1) layout used by the NFS schedules. */
const nfsCols = (fy: number): ReportColumn[] => [col('code', 'Account code', 'code'), col('label', 'Particulars', 'text', { width: 4 }), col('cur', String(fy), 'money'), col('prior', String(fy - 1), 'money')];

/** Cells for one row: value per year (null = not applicable for that year). */
function yearCells(values: ReadonlyArray<number | null>): Record<string, number | null> {
  return Object.fromEntries(values.map((v, i) => [yk(i), v]));
}

/** Rows of one statement section: each line (condensed) or each account under its line (detailed). */
function sectionRows(section: FsSection, maps: ReadonlyArray<Map<string, FsLineAmount> | null>, detailed: boolean, accounts: FsAccounts): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const def of FS_LINES.filter((l) => l.section === section)) {
    const per = maps.map((m) => m?.get(def.id));
    if (per.every((p) => !p)) continue;
    const amounts = per.map((p, i) => (maps[i] ? (p?.amount ?? 0) : null));
    if (!detailed) {
      rows.push(row({ label: def.label, ...yearCells(amounts) }, 'normal', 1));
      continue;
    }
    rows.push(row({ label: def.label }, 'subheading', 1));
    const codes = [...new Set(per.flatMap((p) => p?.accounts ?? []).map((a) => a.accountCode))].sort((a, b) => (accounts.get(a)?.sortOrder ?? 0) - (accounts.get(b)?.sortOrder ?? 0) || a.localeCompare(b));
    for (const code of codes) {
      const found = per.map((p) => p?.accounts.find((a) => a.accountCode === code));
      const any = found.find(Boolean)!;
      rows.push(row({ code, label: any.contra ? `Less: ${any.accountName}` : any.accountName, ...yearCells(found.map((a, i) => (maps[i] ? (a?.amount ?? 0) : null))) }, 'normal', 2));
    }
    rows.push(row({ label: `Total ${def.label}`, ...yearCells(amounts) }, 'subtotal', 1));
  }
  return rows;
}

const unmappedNote = (codes: string[]) => (codes.length ? [`Accounts without a statement classification (shown under a catch-all line): ${[...new Set(codes)].join(', ')}. Review their Financial Statement Classification in the Chart of Accounts.`] : []);
const sourceNotes = (d: FsData) =>
  d.comparatives.flatMap((y) => (y.source === 'LEGACY' ? [`${y.fy} figures are from the pre-closing trial balance imported from the legacy workbook.`] : y.source === 'OPENING' ? [`${y.fy} figures are the opening balances of ${d.fy}.`] : []));

// ------------------------------------------------------------------ SFP / DSFP

function sfpBuilder(code: 'SFP' | 'DSFP', detailed: boolean): ReportBuilder {
  return {
    code,
    params: 'YEAR',
    async build(ctx) {
      const d = await fsData(ctx);
      const years = [computeSfp(netByAccount(d.cur, 0, 13), d.accounts), ...d.comparatives.map((y) => computeSfp(netByAccount(y.bals, 0, 13), d.accounts))];
      const maps = years.map((y) => y.lines);
      const r = (label: string, pick: (s: (typeof years)[number]) => number, style: ReportRow['style'] = 'normal', indent?: ReportRow['indent']) => row({ label, ...yearCells(years.map(pick)) }, style, indent);
      const cur = years[0]!;
      const anyNcl = years.some((y) => y.nonCurrentLiabilities);
      const anyUnclosed = years.some((y) => y.unclosedSurplus);
      const rows: ReportRow[] = [
        row({ label: 'ASSETS' }, 'heading'),
        row({ label: 'Current Assets' }, 'subheading'),
        ...sectionRows('CA', maps, detailed, d.accounts),
        r('Total Current Assets', (y) => y.currentAssets, 'subtotal'),
        row({ label: 'Non-Current Assets' }, 'subheading'),
        ...sectionRows('NCA', maps, detailed, d.accounts),
        r('Total Non-Current Assets', (y) => y.nonCurrentAssets, 'subtotal'),
        r('TOTAL ASSETS', (y) => y.totalAssets, 'grandtotal'),
        row({ label: 'LIABILITIES' }, 'heading'),
        row({ label: 'Current Liabilities' }, 'subheading'),
        ...sectionRows('CL', maps, detailed, d.accounts),
        r('Total Current Liabilities', (y) => y.currentLiabilities, 'subtotal'),
        ...(anyNcl ? [row({ label: 'Non-Current Liabilities' }, 'subheading'), ...sectionRows('NCL', maps, detailed, d.accounts), r('Total Non-Current Liabilities', (y) => y.nonCurrentLiabilities, 'subtotal')] : []),
        r('TOTAL LIABILITIES', (y) => y.totalLiabilities, 'total'),
        row({ label: 'NET ASSETS/EQUITY' }, 'heading'),
        ...sectionRows('EQUITY', maps, detailed, d.accounts),
        ...(anyUnclosed ? [r('Surplus (Deficit) for the period (not yet closed)', (y) => y.unclosedSurplus, 'normal', detailed ? 2 : 1)] : []),
        r('TOTAL NET ASSETS/EQUITY', (y) => y.totalNetAssets, 'total'),
        r('TOTAL LIABILITIES AND NET ASSETS/EQUITY', (y) => y.totalLiabilities + y.totalNetAssets, 'grandtotal'),
      ];
      const notes = [
        ...unmappedNote(cur.unmapped),
        ...years.slice(1).flatMap((y, i) => (!y.balanced ? [`The ${d.comparatives[i]!.fy} comparative does not balance (difference ${peso(y.difference)}).`] : [])),
        ...sourceNotes(d),
      ];
      return {
        subtitle: [asAt(d.fy), 'General Fund', ...(d.comparatives.length > 1 ? [`(With comparative figures for CY ${d.comparatives.map((y) => y.fy).join(' and ')})`] : [])],
        meta: [],
        sections: [table(cols(d.fy, d.comparatives, detailed), rows)],
        signatories: fsSigns(ctx),
        validations: [validation('SFP_BALANCED', cur.balanced, cur.balanced ? `Total assets ${peso(cur.totalAssets)} = liabilities ${peso(cur.totalLiabilities)} + net assets/equity ${peso(cur.totalNetAssets)}.` : `Assets differ from liabilities + net assets/equity by ${peso(cur.difference)}.`)],
        notes,
        isEmpty: !hasRollup(d.cur),
      };
    },
  };
}

// ------------------------------------------------------------------ SFPERF / DSFPERF

function sfperfBuilder(code: 'SFPERF' | 'DSFPERF', detailed: boolean): ReportBuilder {
  return {
    code,
    params: 'YEAR',
    async build(ctx) {
      const d = await fsData(ctx);
      // Opening balances carry no performance figures, so that column is dropped here.
      const comps = d.comparatives.filter((y) => y.source !== 'OPENING');
      const years = [computeSfperf(netByAccount(d.cur, 1, 12), d.accounts), ...comps.map((y) => computeSfperf(netByAccount(y.bals, 1, 12), d.accounts))];
      const maps = years.map((y) => y.lines);
      const r = (label: string, k: 'totalRevenue' | 'totalExpenses' | 'surplusFromOperations' | 'transfersFrom' | 'transfersTo' | 'surplus', style: ReportRow['style'] = 'normal', indent?: ReportRow['indent']) => row({ label, ...yearCells(years.map((y) => y[k])) }, style, indent);
      const rows: ReportRow[] = [
        row({ label: 'Revenue' }, 'heading'),
        ...sectionRows('REV', maps, detailed, d.accounts),
        r('Total Revenue', 'totalRevenue', 'subtotal'),
        row({ label: 'Less: Current Operating Expenses' }, 'heading'),
        ...sectionRows('EXP', maps, detailed, d.accounts),
        r('Total Current Operating Expenses', 'totalExpenses', 'subtotal'),
        r('Surplus (Deficit) from Current Operations', 'surplusFromOperations', 'total'),
      ];
      if (years.some((y) => y.transfersFrom)) rows.push(row({ label: 'Add: Transfers, Assistance and Subsidy From' }, 'subheading'), ...sectionRows('TRANSFERS_FROM', maps, detailed, d.accounts).filter((x) => x.style !== 'subheading'));
      if (years.some((y) => y.transfersTo)) rows.push(row({ label: 'Less: Transfers, Assistance and Subsidy To' }, 'subheading'), ...sectionRows('TRANSFERS_TO', maps, detailed, d.accounts).filter((x) => x.style !== 'subheading'));
      rows.push(r('SURPLUS (DEFICIT) FOR THE PERIOD', 'surplus', 'grandtotal'));
      return {
        subtitle: [ctx.range.label, 'General Fund', ...(comps.length ? [`(With comparative figures for CY ${comps.map((y) => y.fy).join(' and ')})`] : [])],
        meta: [],
        sections: [table(cols(d.fy, comps, detailed), rows)],
        signatories: fsSigns(ctx),
        validations: [],
        notes: [...unmappedNote(years[0]!.unmapped), ...sourceNotes({ ...d, comparatives: comps })],
        isEmpty: !d.cur.some((b) => b.subsidiaryId === null && b.month >= 1 && b.month <= 12),
      };
    },
  };
}

// ------------------------------------------------------------------ SNAE / SCNAE

/** Equity movements per year; opening-only comparatives have no movement, so they are skipped. */
function equityYears(d: FsData): { comps: YearData[]; years: ReturnType<typeof computeEquityChanges>[] } {
  const comps = d.comparatives.filter((y) => y.source !== 'OPENING');
  return { comps, years: [computeEquityChanges(d.cur, d.accounts), ...comps.map((y) => computeEquityChanges(y.bals, d.accounts))] };
}

function equityRows(years: ReturnType<typeof computeEquityChanges>[]): ReportRow[] {
  const r = (label: string, k: keyof (typeof years)[number], style: ReportRow['style'] = 'normal', indent?: ReportRow['indent']) => row({ label, ...yearCells(years.map((y) => y[k])) }, style, indent);
  return [
    r('Balance at January 1', 'beginningBalance', 'subheading'),
    row({ label: 'Add/(Deduct):' }, 'normal'),
    r('Changes in accounting policy', 'changesInAccountingPolicy', 'normal', 1),
    r("Prior years' adjustments", 'priorPeriodAdjustments', 'normal', 1),
    r('Restated balance', 'restatedBalance', 'subtotal'),
    row({ label: 'Changes in net assets/equity for the year:' }, 'normal'),
    r('Surplus (Deficit) for the period', 'surplusDeficit', 'normal', 1),
    ...(years.some((y) => y.otherAdjustments) ? [r('Other adjustments', 'otherAdjustments', 'normal', 1)] : []),
    r('Balance at December 31', 'endingBalance', 'grandtotal'),
  ];
}

/** Ending equity must equal the SFP's total net assets (period 13 only reclassifies). */
function equityCheck(d: FsData): string[] {
  const end = computeEquityChanges(d.cur, d.accounts).endingBalance;
  const sfp = computeSfp(netByAccount(d.cur, 0, 13), d.accounts).totalNetAssets;
  return end === sfp ? [] : [`Balance at December 31 (${peso(end)}) differs from total net assets/equity in the Statement of Financial Position (${peso(sfp)}).`];
}

const SCNAE: ReportBuilder = {
  code: 'SCNAE',
  params: 'YEAR',
  async build(ctx) {
    const d = await fsData(ctx);
    const { comps, years } = equityYears(d);
    return {
      subtitle: [ctx.range.label, 'General Fund', ...(comps.length ? [`(With comparative figures for CY ${comps.map((y) => y.fy).join(' and ')})`] : [])],
      meta: [],
      sections: [table(cols(d.fy, comps, false), equityRows(years))],
      signatories: fsSigns(ctx),
      validations: [],
      notes: [...equityCheck(d), ...sourceNotes({ ...d, comparatives: comps })],
      isEmpty: !hasRollup(d.cur),
    };
  },
};

/** Statement of Net Assets/Equity: composition at year end, then the movement for the year. */
const SNAE: ReportBuilder = {
  code: 'SNAE',
  params: 'YEAR',
  async build(ctx) {
    const d = await fsData(ctx);
    const netsPer = [netByAccount(d.cur, 0, 13), ...d.comparatives.map((y) => netByAccount(y.bals, 0, 13))];
    const isEq = (c: string) => resolveFsLine(c, d.accounts.get(c)).line.section === 'EQUITY';
    const codes = [...new Set(netsPer.flatMap((m) => [...m.keys()]))].filter((c) => isEq(c) && netsPer.some((m) => m.get(c))).sort();
    const sfps = netsPer.map((m) => computeSfp(m, d.accounts));
    const rows: ReportRow[] = codes.map((c) => row({ code: c, label: d.accounts.get(c)?.accountName ?? c, ...yearCells(netsPer.map((m) => -(m.get(c) ?? 0))) }, 'normal', 1));
    if (sfps.some((s) => s.unclosedSurplus)) rows.push(row({ label: 'Surplus (Deficit) for the period (not yet closed)', ...yearCells(sfps.map((s) => s.unclosedSurplus)) }, 'normal', 1));
    rows.push(row({ label: 'TOTAL NET ASSETS/EQUITY', ...yearCells(sfps.map((s) => s.totalNetAssets)) }, 'grandtotal'));
    const { comps, years } = equityYears(d);
    return {
      subtitle: [asAt(d.fy), 'General Fund'],
      meta: [],
      sections: [table(cols(d.fy, d.comparatives, true), rows, { title: 'Net assets/equity' }), table(cols(d.fy, comps, false), equityRows(years), { title: 'Movement for the year' })],
      signatories: fsSigns(ctx),
      validations: [],
      notes: [...equityCheck(d), ...sourceNotes(d)],
      isEmpty: !hasRollup(d.cur),
    };
  },
};

// ------------------------------------------------------------------ SCF

async function scfFigures(ctx: ReportContext, fy: number, balances: Bal[], accounts: FsAccounts): Promise<ScfFigures> {
  const q = (journal: 'JCT' | 'GJ') =>
    ctx.ds.listGroup<JournalLineDoc>('lines', [['barangayId', '==', ctx.params.barangayId], ['fiscalYear', '==', fy], ['posted', '==', true], ['journal', '==', journal]], [['jevDate', 'asc']]);
  const lines = [...(await q('JCT')), ...(await q('GJ'))];
  return computeScf(lines.map((l) => ({ jevId: l.jevId, accountCode: l.accountCode, debit: l.debit, credit: l.credit, month: Number(l.accountingPeriod.slice(5, 7)) })), balances, accounts);
}

const SCF: ReportBuilder = {
  code: 'SCF',
  params: 'YEAR',
  async build(ctx) {
    const d = await fsData(ctx);
    // Cash flows need the year's cash journal, so only years posted in BFMS get a column.
    const comps = d.comparatives.filter((y) => y.source === 'BFMS');
    const figs = [await scfFigures(ctx, d.fy, d.cur, d.accounts), ...(await Promise.all(comps.map((y) => scfFigures(ctx, y.fy, y.bals, d.accounts))))];
    const cur = figs[0]!;
    const rows: ReportRow[] = [];
    const amt = (id: string) => yearCells(figs.map((f) => Math.abs(f.lines.get(id)?.amount ?? 0)));
    for (const s of ['OPERATING', 'INVESTING', 'FINANCING'] as ScfSection[]) {
      rows.push(row({ label: SCF_SECTION_LABELS[s] }, 'heading'));
      for (const dir of ['IN', 'OUT'] as const) {
        const defs = SCF_LINES.filter((l) => l.section === s && l.direction === dir && figs.some((f) => f.lines.has(l.id)));
        if (!defs.length) continue;
        rows.push(row({ label: dir === 'IN' ? 'Cash Inflows' : 'Cash Outflows' }, 'subheading', 1));
        for (const l of defs) rows.push(row({ label: l.label, ...amt(l.id) }, 'normal', 2));
        rows.push(row({ label: `Total Cash ${dir === 'IN' ? 'Inflows' : 'Outflows'}`, ...yearCells(figs.map((f) => defs.reduce((t, l) => t + Math.abs(f.lines.get(l.id)?.amount ?? 0), 0))) }, 'subtotal', 1));
      }
      const k = s === 'OPERATING' ? 'operating' : s === 'INVESTING' ? 'investing' : 'financing';
      rows.push(row({ label: `Net Cash Provided by (Used in) ${s.charAt(0) + s.slice(1).toLowerCase()} Activities`, ...yearCells(figs.map((f) => f[k])) }, 'total'));
    }
    rows.push(row({ label: 'Total Cash Provided by (Used in) Operating, Investing and Financing Activities', ...yearCells(figs.map((f) => f.netChange)) }, 'subtotal'));
    rows.push(row({ label: 'Add: Cash and Cash Equivalents, January 1', ...yearCells(figs.map((f) => f.beginningCash)) }, 'normal'));
    rows.push(row({ label: 'Cash and Cash Equivalents, December 31', ...yearCells(figs.map((f) => f.endingCash)) }, 'grandtotal'));
    const skipped = d.comparatives.filter((y) => y.source === 'LEGACY').map((y) => y.fy);
    return {
      subtitle: [ctx.range.label, 'General Fund', 'Direct method'],
      meta: [],
      sections: [table(cols(d.fy, comps, false), rows)],
      signatories: fsSigns(ctx),
      validations: [
        validation(
          'SCF_RECONCILES',
          cur.reconciled,
          cur.reconciled
            ? `Ending cash ${peso(cur.endingCash)} equals the cash accounts in the trial balance.`
            : `Ending cash per statement ${peso(cur.endingCash)} differs from the cash accounts ${peso(cur.cashAccountsEnding)} by ${peso(cur.difference)}.`,
        ),
      ],
      notes: skipped.length ? [`No comparative cash flows for ${skipped.join(' and ')}: only the pre-closing trial balance was imported for those years, not their cash journal.`] : [],
      isEmpty: cur.lines.size === 0 && cur.beginningCash === 0 && cur.cashAccountsEnding === 0,
    };
  },
};

// ------------------------------------------------------------------ SCBAA

/** Budget vs actual: REAI estimates vs posted revenue; appropriations vs obligations (comparable basis). */
const SCBAA: ReportBuilder = {
  code: 'SCBAA',
  params: 'YEAR',
  async build(ctx) {
    const d = await fsData(ctx);
    const [apps, estimates] = await Promise.all([
      ctx.ds.list<AppropriationDoc & { accountName?: string }>('appropriations', ctx.scope()),
      ctx.ds.list<EstimatedIncomeDoc>('estimatedIncome', ctx.scope()),
    ]);
    const active = apps.filter((a) => a.status === 'ACTIVE' || a.status === 'CLOSED');
    const nets = netByAccount(d.cur, 1, 12);
    const columns = [col('label', 'Particulars', 'text', { width: 4 }), col('orig', 'Original', 'money', { group: 'Budgeted amounts' }), col('final', 'Final', 'money', { group: 'Budgeted amounts' }), col('actual', 'Actual amounts on comparable basis', 'money'), col('diff', 'Difference: final budget and actual', 'money')];
    const fig = (label: string, o: number, f: number, a: number, style: ReportRow['style'] = 'normal', indent?: ReportRow['indent']) => row({ label, orig: o, final: f, actual: a, diff: f - a }, style, indent);
    const rows: ReportRow[] = [row({ label: 'RECEIPTS' }, 'heading')];

    // Receipts: every revenue account with an estimate or a posted amount, under its SFPerf line.
    const rev = new Map<string, { est: number; act: number }>();
    for (const e of estimates) rev.set(e.incomeAccountCode, { est: (rev.get(e.incomeAccountCode)?.est ?? 0) + e.estimatedIncome, act: 0 });
    for (const [code, net] of nets) if (code.startsWith('4') && net) rev.set(code, { est: rev.get(code)?.est ?? 0, act: -net });
    let tr = { o: 0, a: 0 };
    for (const def of FS_LINES.filter((l) => l.section === 'REV' || l.section === 'TRANSFERS_FROM')) {
      const codes = [...rev.keys()].filter((c) => resolveFsLine(c, d.accounts.get(c)).line.id === def.id).sort();
      if (!codes.length) continue;
      const o = codes.reduce((t, c) => t + rev.get(c)!.est, 0);
      const a = codes.reduce((t, c) => t + rev.get(c)!.act, 0);
      rows.push(fig(def.label, o, o, a, 'subheading', 1));
      for (const c of codes) rows.push(fig(`${c} ${d.accounts.get(c)?.accountName ?? ''}`, rev.get(c)!.est, rev.get(c)!.est, rev.get(c)!.act, 'normal', 2));
      tr = { o: tr.o + o, a: tr.a + a };
    }
    rows.push(fig('Total Receipts', tr.o, tr.o, tr.a, 'subtotal'));

    // Payments: appropriations by expense class (PS, MOOE, FE, CO) and account.
    rows.push(row({ label: 'PAYMENTS' }, 'heading'));
    const tp = { o: 0, f: 0, a: 0 };
    for (const ec of EXPENSE_CLASSES) {
      const list = active.filter((a) => a.expenseClass === ec.value);
      if (!list.length) continue;
      const by = new Map<string, { name: string; o: number; f: number; a: number }>();
      for (const a of list) {
        const cur = by.get(a.accountCode) ?? { name: a.accountName ?? d.accounts.get(a.accountCode)?.accountName ?? '', o: 0, f: 0, a: 0 };
        cur.o += a.originalAppropriation;
        cur.f += a.totalAppropriation;
        cur.a += a.obligations;
        by.set(a.accountCode, cur);
      }
      const s = [...by.values()].reduce((t, x) => ({ o: t.o + x.o, f: t.f + x.f, a: t.a + x.a }), { o: 0, f: 0, a: 0 });
      rows.push(fig(ec.label, s.o, s.f, s.a, 'subheading', 1));
      for (const [code, x] of [...by].sort((p, q) => p[0].localeCompare(q[0]))) rows.push(fig(`${code} ${x.name}`, x.o, x.f, x.a, 'normal', 2));
      tp.o += s.o;
      tp.f += s.f;
      tp.a += s.a;
    }
    rows.push(fig('Total Payments', tp.o, tp.f, tp.a, 'subtotal'));
    rows.push(fig('NET RECEIPTS/(PAYMENTS)', tr.o - tp.o, tr.o - tp.f, tr.a - tp.a, 'grandtotal'));
    return {
      subtitle: [ctx.range.label, 'General Fund'],
      meta: [],
      sections: [table(columns, rows)],
      signatories: fsSigns(ctx),
      validations: [],
      notes: ['Actual receipts are posted revenue for the year; actual payments are obligations certified against the appropriations (comparable budget basis).'],
      isEmpty: active.length === 0 && estimates.length === 0 && rev.size === 0,
    };
  },
};

// ------------------------------------------------------------------ NFS

/** Account rows with SL breakdown for an NFS schedule (balances at Dec 31, current and prior). */
function scheduleRows(codes: string[], d: FsData, subsNames: Map<string, string>, priorNets: Map<string, number>, priorSl: Map<string, number>): { rows: ReportRow[]; cur: number; prior: number } {
  const curNets = netByAccount(d.cur, 0, 13);
  const curSl = netBySubsidiary(d.cur, 0, 13);
  const rows: ReportRow[] = [];
  let tc = 0;
  let tp = 0;
  for (const code of codes) {
    const side = resolveFsLine(code, d.accounts.get(code)).line.side;
    const sign = side === 'DEBIT' ? 1 : -1;
    const c = sign * (curNets.get(code) ?? 0);
    const p = sign * (priorNets.get(code) ?? 0);
    if (!c && !p) continue;
    rows.push(row({ code, label: d.accounts.get(code)?.accountName ?? code, cur: c, prior: p }, 'normal', 1));
    const sls = [...new Set([...curSl.keys(), ...priorSl.keys()].filter((k) => k.startsWith(`${code}|`)))].sort();
    for (const k of sls) {
      const sc = sign * (curSl.get(k) ?? 0);
      const sp = sign * (priorSl.get(k) ?? 0);
      if (sc || sp) rows.push(row({ label: subsNames.get(k.slice(code.length + 1)) ?? k.slice(code.length + 1), cur: sc, prior: sp }, 'note', 2));
    }
    tc += c;
    tp += p;
  }
  return { rows, cur: tc, prior: tp };
}

const NFS: ReportBuilder = {
  code: 'NFS',
  params: 'YEAR',
  async build(ctx) {
    const d = await fsData(ctx);
    const [narr, subs] = await Promise.all([ctx.ds.get<NfsNarrativeDoc>('nfsNarratives', nfsNarrativeId(ctx.params.barangayId, d.fy)), ctx.subsidiaries()]);
    const notes = narr?.notes?.length ? narr.notes : defaultNfsNotes(ctx.barangayName, d.fy);
    const sections: ReportSection[] = notes.map((n, i) => ({ kind: 'text', title: `Note ${i + 1}. ${n.title}`, paragraphs: n.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) }));
    let k = notes.length;
    const subsNames = new Map([...subs.values()].map((s) => [s.id, `${s.subsidiaryCode} — ${s.subsidiaryName}`]));
    const priorNets = d.hasPrior ? netByAccount(d.prior, 0, 13) : netByAccount(d.cur, 0, 0);
    const priorSl = d.hasPrior ? netBySubsidiary(d.prior, 0, 13) : netBySubsidiary(d.cur, 0, 0);
    const allCodes = [...new Set([...netByAccount(d.cur, 0, 13).keys(), ...priorNets.keys()])].sort((a, b) => (d.accounts.get(a)?.sortOrder ?? 0) - (d.accounts.get(b)?.sortOrder ?? 0) || a.localeCompare(b));
    const lineOf = (c: string) => resolveFsLine(c, d.accounts.get(c)).line;
    const sched = (title: string, codes: string[], totalLabel: string) => {
      const s = scheduleRows(codes, d, subsNames, priorNets, priorSl);
      if (!s.rows.length) return;
      sections.push(table(nfsCols(d.fy), [...s.rows, row({ label: totalLabel, cur: s.cur, prior: s.prior }, 'grandtotal')], { title: `Note ${++k}. ${title}` }));
    };
    sched('Cash and Cash Equivalents', allCodes.filter((c) => lineOf(c).id === 'SFP.CA.CASH' || isCashCode(c, d.accounts.get(c))), 'Total Cash and Cash Equivalents');
    sched('Receivables', allCodes.filter((c) => lineOf(c).id.endsWith('.RECEIVABLES')), 'Total Receivables (net)');

    // PPE roll-forward: cost at Jan 1 + additions − disposals = cost at Dec 31; less accumulated depreciation.
    const ppe = allCodes.filter((c) => lineOf(c).id === 'SFP.NCA.PPE' && !(d.accounts.get(c)?.isContra ?? /^1-07-\d{2}-\d{2}[1-9]$/.test(c)));
    const net = (from: number, to: number, code: string, k2: 'debit' | 'credit') => d.cur.filter((b) => b.subsidiaryId === null && b.accountCode === code && b.month >= from && b.month <= to).reduce((t, b) => t + b[k2], 0);
    const bal = (from: number, to: number, code: string) => net(from, to, code, 'debit') - net(from, to, code, 'credit');
    const ppeRows: ReportRow[] = [];
    const tot = { beg: 0, add: 0, disp: 0, end: 0, acc: 0, nbv: 0 };
    for (const code of ppe) {
      const contra = allCodes.filter((c) => c !== code && c.slice(0, 10) === code.slice(0, 10) && (d.accounts.get(c)?.isContra ?? false));
      const beg = bal(0, 0, code);
      const add = net(1, 12, code, 'debit');
      const disp = net(1, 12, code, 'credit');
      const end = beg + add - disp;
      const acc = -contra.reduce((t, c) => t + bal(0, 13, c), 0);
      if (!beg && !add && !disp && !acc) continue;
      ppeRows.push(row({ code, label: d.accounts.get(code)?.accountName ?? code, beg, add: add || null, disp: disp || null, end, acc: acc || null, nbv: end - acc }, 'normal', 1));
      tot.beg += beg;
      tot.add += add;
      tot.disp += disp;
      tot.end += end;
      tot.acc += acc;
      tot.nbv += end - acc;
    }
    if (ppeRows.length) {
      ppeRows.push(row({ label: 'TOTAL', ...tot }, 'grandtotal'));
      sections.push(
        table(
          [col('code', 'Account code', 'code'), col('label', 'Property, plant and equipment', 'text', { width: 3 }), col('beg', 'Cost, January 1', 'money'), col('add', 'Additions', 'money'), col('disp', 'Disposals', 'money'), col('end', 'Cost, December 31', 'money'), col('acc', 'Accumulated depreciation', 'money'), col('nbv', 'Net book value', 'money')],
          ppeRows,
          { title: `Note ${++k}. Property, Plant and Equipment` },
        ),
      );
    }
    sched('Payables and Other Liabilities', allCodes.filter((c) => ['CL', 'NCL'].includes(lineOf(c).section)), 'Total Liabilities');
    return {
      subtitle: [ctx.range.label, 'General Fund'],
      meta: narr ? [{ label: 'Narrative version', value: `${narr.version}${narr.status === 'FINAL' ? ' (final)' : ''}` }] : [{ label: 'Narrative', value: 'Standard template (not yet edited)' }],
      sections,
      signatories: fsSigns(ctx),
      validations: [],
      isEmpty: !narr && !d.cur.some((b) => b.subsidiaryId === null),
    };
  },
};

// ------------------------------------------------------------------ SMR

/** Statement of Management Responsibility for Financial Statements (standard government template). */
const SMR: ReportBuilder = {
  code: 'SMR',
  params: 'YEAR',
  async build(ctx) {
    const fy = ctx.params.fiscalYear;
    const entity = `Barangay ${ctx.barangayName}, Municipality of Candoni, Province of Negros Occidental`;
    return {
      title: 'Statement of Management Responsibility for Financial Statements',
      subtitle: [],
      meta: [],
      sections: [
        {
          kind: 'text',
          paragraphs: [
            `The management of ${entity} is responsible for all information and representations contained in the accompanying Statement of Financial Position as of December 31, ${fy} and the related Statement of Financial Performance, Statement of Changes in Net Assets/Equity, Statement of Cash Flows, Statement of Comparison of Budget and Actual Amounts and the Notes to the Financial Statements for the year then ended. The financial statements have been prepared in conformity with the Philippine Public Sector Accounting Standards and generally accepted state accounting principles, and reflect amounts that are based on the best estimates and informed judgment of management with an appropriate consideration to materiality.`,
            'In this regard, management maintains a system of accounting and reporting which provides for the necessary internal controls to ensure that transactions are properly authorized and recorded, assets are safeguarded against unauthorized use or disposition, and liabilities are recognized.',
            'The Commission on Audit, through its auditors, has the responsibility to express an opinion on the financial statements of the barangay in accordance with the International Standards of Supreme Audit Institutions.',
          ],
        },
      ],
      signatories: [ctx.sign('', 'BARANGAY_TREASURER', `${fy}-12-31`), ctx.sign('', 'PUNONG_BARANGAY', `${fy}-12-31`)],
      validations: [],
      isEmpty: false,
    };
  },
};

// ------------------------------------------------------------------ TB_3Y

/**
 * Pre-closing trial balance with the two prior years side by side (legacy 02.2_PRETB_3Y): periods
 * 00–12 of each year (closing entries excluded), prior years from BFMS or the imported workbook TB.
 */
const TB_3Y: ReportBuilder = {
  code: 'TB_3Y',
  params: 'YEAR',
  async build(ctx) {
    const d = await fsData(ctx);
    const years = [{ fy: d.fy, bals: d.cur, source: 'BFMS' as const }, ...d.comparatives.filter((y) => y.source !== 'OPENING')];
    const nets = years.map((y) => netByAccount(y.bals, 0, 12));
    const codes = [...new Set(nets.flatMap((m) => [...m.keys()]))].filter((c) => nets.some((m) => m.get(c))).sort((a, b) => (d.accounts.get(a)?.sortOrder ?? 0) - (d.accounts.get(b)?.sortOrder ?? 0) || a.localeCompare(b));
    const columns: ReportColumn[] = [col('code', 'Account code', 'code'), col('name', 'Account name', 'text', { width: 3 })];
    years.forEach((y, i) => columns.push(col(`d${i}`, 'Debit', 'money', { group: String(y.fy) }), col(`c${i}`, 'Credit', 'money', { group: String(y.fy) })));
    const cells = (code: string) => Object.fromEntries(nets.flatMap((m, i) => { const v = m.get(code) ?? 0; return [[`d${i}`, v > 0 ? v : null], [`c${i}`, v < 0 ? -v : null]]; }));
    const rows: ReportRow[] = codes.map((c) => row({ code: c, name: d.accounts.get(c)?.accountName ?? c, ...cells(c) }));
    const totals = nets.map((m) => [...m.values()].reduce((t, v) => ({ d: t.d + Math.max(v, 0), c: t.c + Math.max(-v, 0) }), { d: 0, c: 0 }));
    rows.push(row({ name: 'TOTAL', ...Object.fromEntries(totals.flatMap((t, i) => [[`d${i}`, t.d], [`c${i}`, t.c]])) }, 'grandtotal'));
    const unbalanced = years.filter((_, i) => totals[i]!.d !== totals[i]!.c).map((y) => y.fy);
    return {
      title: 'Pre-Closing Trial Balance',
      subtitle: [`As of December 31, ${d.fy}`, 'General Fund', ...(years.length > 1 ? [`(With comparative figures for CY ${years.slice(1).map((y) => y.fy).join(' and ')})`] : [])],
      meta: [],
      sections: [table(columns, rows)],
      signatories: [ctx.sign('Certified correct', 'MUNICIPAL_ACCOUNTANT')],
      validations: [validation('TB_BALANCED', !unbalanced.length, unbalanced.length ? `Debits and credits differ for ${unbalanced.join(', ')}.` : 'Every year balances.')],
      notes: sourceNotes({ ...d, comparatives: years.slice(1) as YearData[] }),
      isEmpty: !hasRollup(d.cur),
    };
  },
};

export const STATEMENT_REPORTS: ReportBuilder[] = [
  TB_3Y,
  sfpBuilder('SFP', false),
  sfpBuilder('DSFP', true),
  sfperfBuilder('SFPERF', false),
  sfperfBuilder('DSFPERF', true),
  SNAE,
  SCNAE,
  SCF,
  SCBAA,
  NFS,
  SMR,
];
