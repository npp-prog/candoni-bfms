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

interface FsData {
  fy: number;
  accounts: FsAccounts;
  cur: Bal[];
  prior: Bal[];
  hasPrior: boolean;
}

async function fsData(ctx: ReportContext): Promise<FsData> {
  const fy = ctx.params.fiscalYear;
  const [accounts, cur, prior] = await Promise.all([ctx.accounts(), periodBalances(ctx), periodBalances(ctx, fy - 1)]);
  return { fy, accounts, cur, prior, hasPrior: prior.some((b) => b.subsidiaryId === null) };
}

const asAt = (fy: number) => `As at December 31, ${fy}`;
const fsSigns = (ctx: ReportContext) => [ctx.sign('Certified correct', 'MUNICIPAL_ACCOUNTANT'), ctx.sign('Noted by', 'PUNONG_BARANGAY')];

function cols(fy: number, detailed: boolean, priorLabel = String(fy - 1)): ReportColumn[] {
  return [...(detailed ? [col('code', 'Account code', 'code')] : []), col('label', 'Particulars', 'text', { width: 4 }), col('cur', String(fy), 'money'), col('prior', priorLabel, 'money')];
}

/** Rows of one statement section: each line (condensed) or each account under its line (detailed). */
function sectionRows(section: FsSection, cur: Map<string, FsLineAmount>, prior: Map<string, FsLineAmount> | null, detailed: boolean, accounts: FsAccounts): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const def of FS_LINES.filter((l) => l.section === section)) {
    const c = cur.get(def.id);
    const p = prior?.get(def.id);
    if (!c && !p) continue;
    if (!detailed) {
      rows.push(row({ label: def.label, cur: c?.amount ?? 0, prior: prior ? (p?.amount ?? 0) : null }, 'normal', 1));
      continue;
    }
    rows.push(row({ label: def.label }, 'subheading', 1));
    const codes = [...new Set([...(c?.accounts ?? []), ...(p?.accounts ?? [])].map((a) => a.accountCode))].sort((a, b) => (accounts.get(a)?.sortOrder ?? 0) - (accounts.get(b)?.sortOrder ?? 0) || a.localeCompare(b));
    for (const code of codes) {
      const ca = c?.accounts.find((a) => a.accountCode === code);
      const pa = p?.accounts.find((a) => a.accountCode === code);
      rows.push(row({ code, label: (ca ?? pa)!.contra ? `Less: ${(ca ?? pa)!.accountName}` : (ca ?? pa)!.accountName, cur: ca?.amount ?? 0, prior: prior ? (pa?.amount ?? 0) : null }, 'normal', 2));
    }
    rows.push(row({ label: `Total ${def.label}`, cur: c?.amount ?? 0, prior: prior ? (p?.amount ?? 0) : null }, 'subtotal', 1));
  }
  return rows;
}

const unmappedNote = (codes: string[]) => (codes.length ? [`Accounts without a statement classification (shown under a catch-all line): ${[...new Set(codes)].join(', ')}. Review their Financial Statement Classification in the Chart of Accounts.`] : []);

// ------------------------------------------------------------------ SFP / DSFP

function sfpBuilder(code: 'SFP' | 'DSFP', detailed: boolean): ReportBuilder {
  return {
    code,
    params: 'YEAR',
    async build(ctx) {
      const d = await fsData(ctx);
      const cur = computeSfp(netByAccount(d.cur, 0, 13), d.accounts);
      const pri = computeSfp(d.hasPrior ? netByAccount(d.prior, 0, 13) : netByAccount(d.cur, 0, 0), d.accounts);
      const r = (label: string, c: number, p: number, style: ReportRow['style'] = 'normal', indent?: ReportRow['indent']) => row({ label, cur: c, prior: p }, style, indent);
      const rows: ReportRow[] = [
        row({ label: 'ASSETS' }, 'heading'),
        row({ label: 'Current Assets' }, 'subheading'),
        ...sectionRows('CA', cur.lines, pri.lines, detailed, d.accounts),
        r('Total Current Assets', cur.currentAssets, pri.currentAssets, 'subtotal'),
        row({ label: 'Non-Current Assets' }, 'subheading'),
        ...sectionRows('NCA', cur.lines, pri.lines, detailed, d.accounts),
        r('Total Non-Current Assets', cur.nonCurrentAssets, pri.nonCurrentAssets, 'subtotal'),
        r('TOTAL ASSETS', cur.totalAssets, pri.totalAssets, 'grandtotal'),
        row({ label: 'LIABILITIES' }, 'heading'),
        row({ label: 'Current Liabilities' }, 'subheading'),
        ...sectionRows('CL', cur.lines, pri.lines, detailed, d.accounts),
        r('Total Current Liabilities', cur.currentLiabilities, pri.currentLiabilities, 'subtotal'),
        ...(cur.nonCurrentLiabilities || pri.nonCurrentLiabilities
          ? [row({ label: 'Non-Current Liabilities' }, 'subheading'), ...sectionRows('NCL', cur.lines, pri.lines, detailed, d.accounts), r('Total Non-Current Liabilities', cur.nonCurrentLiabilities, pri.nonCurrentLiabilities, 'subtotal')]
          : []),
        r('TOTAL LIABILITIES', cur.totalLiabilities, pri.totalLiabilities, 'total'),
        row({ label: 'NET ASSETS/EQUITY' }, 'heading'),
        ...sectionRows('EQUITY', cur.lines, pri.lines, detailed, d.accounts),
        ...(cur.unclosedSurplus || pri.unclosedSurplus ? [r('Surplus (Deficit) for the period (not yet closed)', cur.unclosedSurplus, pri.unclosedSurplus, 'normal', detailed ? 2 : 1)] : []),
        r('TOTAL NET ASSETS/EQUITY', cur.totalNetAssets, pri.totalNetAssets, 'total'),
        r('TOTAL LIABILITIES AND NET ASSETS/EQUITY', cur.totalLiabilities + cur.totalNetAssets, pri.totalLiabilities + pri.totalNetAssets, 'grandtotal'),
      ];
      const notes = [...unmappedNote(cur.unmapped), ...(!pri.balanced ? [`The ${d.fy - 1} comparative does not balance (difference ${peso(pri.difference)}).`] : []), ...(!d.hasPrior ? [`${d.fy - 1} figures are the opening balances of ${d.fy}.`] : [])];
      return {
        subtitle: [asAt(d.fy), 'General Fund'],
        meta: [],
        sections: [table(cols(d.fy, detailed), rows)],
        signatories: fsSigns(ctx),
        validations: [validation('SFP_BALANCED', cur.balanced, cur.balanced ? `Total assets ${peso(cur.totalAssets)} = liabilities ${peso(cur.totalLiabilities)} + net assets/equity ${peso(cur.totalNetAssets)}.` : `Assets differ from liabilities + net assets/equity by ${peso(cur.difference)}.`)],
        notes,
        isEmpty: !d.cur.some((b) => b.subsidiaryId === null),
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
      const cur = computeSfperf(netByAccount(d.cur, 1, 12), d.accounts);
      const pri = d.hasPrior ? computeSfperf(netByAccount(d.prior, 1, 12), d.accounts) : null;
      const r = (label: string, k: 'totalRevenue' | 'totalExpenses' | 'surplusFromOperations' | 'transfersFrom' | 'transfersTo' | 'surplus', style: ReportRow['style'] = 'normal', indent?: ReportRow['indent']) => row({ label, cur: cur[k], prior: pri ? pri[k] : null }, style, indent);
      const rows: ReportRow[] = [
        row({ label: 'Revenue' }, 'heading'),
        ...sectionRows('REV', cur.lines, pri?.lines ?? null, detailed, d.accounts),
        r('Total Revenue', 'totalRevenue', 'subtotal'),
        row({ label: 'Less: Current Operating Expenses' }, 'heading'),
        ...sectionRows('EXP', cur.lines, pri?.lines ?? null, detailed, d.accounts),
        r('Total Current Operating Expenses', 'totalExpenses', 'subtotal'),
        r('Surplus (Deficit) from Current Operations', 'surplusFromOperations', 'total'),
      ];
      if (cur.transfersFrom || pri?.transfersFrom) rows.push(row({ label: 'Add: Transfers, Assistance and Subsidy From' }, 'subheading'), ...sectionRows('TRANSFERS_FROM', cur.lines, pri?.lines ?? null, detailed, d.accounts).filter((x) => x.style !== 'subheading'));
      if (cur.transfersTo || pri?.transfersTo) rows.push(row({ label: 'Less: Transfers, Assistance and Subsidy To' }, 'subheading'), ...sectionRows('TRANSFERS_TO', cur.lines, pri?.lines ?? null, detailed, d.accounts).filter((x) => x.style !== 'subheading'));
      rows.push(r('SURPLUS (DEFICIT) FOR THE PERIOD', 'surplus', 'grandtotal'));
      return {
        subtitle: [ctx.range.label, 'General Fund'],
        meta: [],
        sections: [table(cols(d.fy, detailed), rows)],
        signatories: fsSigns(ctx),
        validations: [],
        notes: unmappedNote(cur.unmapped),
        isEmpty: !d.cur.some((b) => b.subsidiaryId === null && b.month >= 1 && b.month <= 12),
      };
    },
  };
}

// ------------------------------------------------------------------ SNAE / SCNAE

function equityRows(d: FsData): ReportRow[] {
  const cur = computeEquityChanges(d.cur, d.accounts);
  const pri = d.hasPrior ? computeEquityChanges(d.prior, d.accounts) : null;
  const r = (label: string, k: keyof typeof cur, style: ReportRow['style'] = 'normal', indent?: ReportRow['indent']) => row({ label, cur: cur[k], prior: pri ? pri[k] : null }, style, indent);
  return [
    r('Balance at January 1', 'beginningBalance', 'subheading'),
    row({ label: 'Add/(Deduct):' }, 'normal'),
    r('Changes in accounting policy', 'changesInAccountingPolicy', 'normal', 1),
    r("Prior years' adjustments", 'priorPeriodAdjustments', 'normal', 1),
    r('Restated balance', 'restatedBalance', 'subtotal'),
    row({ label: 'Changes in net assets/equity for the year:' }, 'normal'),
    r('Surplus (Deficit) for the period', 'surplusDeficit', 'normal', 1),
    ...(cur.otherAdjustments || pri?.otherAdjustments ? [r('Other adjustments', 'otherAdjustments', 'normal', 1)] : []),
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
    return {
      subtitle: [ctx.range.label, 'General Fund'],
      meta: [],
      sections: [table(cols(d.fy, false), equityRows(d))],
      signatories: fsSigns(ctx),
      validations: [],
      notes: equityCheck(d),
      isEmpty: !d.cur.some((b) => b.subsidiaryId === null),
    };
  },
};

/** Statement of Net Assets/Equity: composition at year end, then the movement for the year. */
const SNAE: ReportBuilder = {
  code: 'SNAE',
  params: 'YEAR',
  async build(ctx) {
    const d = await fsData(ctx);
    const curNets = netByAccount(d.cur, 0, 13);
    const priNets = d.hasPrior ? netByAccount(d.prior, 0, 13) : netByAccount(d.cur, 0, 0);
    const isEq = (c: string) => resolveFsLine(c, d.accounts.get(c)).line.section === 'EQUITY';
    const codes = [...new Set([...curNets.keys(), ...priNets.keys()])].filter((c) => isEq(c) && (curNets.get(c) || priNets.get(c))).sort();
    const sfpC = computeSfp(curNets, d.accounts);
    const sfpP = computeSfp(priNets, d.accounts);
    const rows: ReportRow[] = codes.map((c) => row({ code: c, label: d.accounts.get(c)?.accountName ?? c, cur: -(curNets.get(c) ?? 0), prior: -(priNets.get(c) ?? 0) }, 'normal', 1));
    if (sfpC.unclosedSurplus || sfpP.unclosedSurplus) rows.push(row({ label: 'Surplus (Deficit) for the period (not yet closed)', cur: sfpC.unclosedSurplus, prior: sfpP.unclosedSurplus }, 'normal', 1));
    rows.push(row({ label: 'TOTAL NET ASSETS/EQUITY', cur: sfpC.totalNetAssets, prior: sfpP.totalNetAssets }, 'grandtotal'));
    return {
      subtitle: [asAt(d.fy), 'General Fund'],
      meta: [],
      sections: [table(cols(d.fy, true), rows, { title: 'Net assets/equity' }), table(cols(d.fy, false), equityRows(d), { title: 'Movement for the year' })],
      signatories: fsSigns(ctx),
      validations: [],
      notes: equityCheck(d),
      isEmpty: !d.cur.some((b) => b.subsidiaryId === null),
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
    const cur = await scfFigures(ctx, d.fy, d.cur, d.accounts);
    const pri = d.hasPrior ? await scfFigures(ctx, d.fy - 1, d.prior, d.accounts) : null;
    const rows: ReportRow[] = [];
    const amt = (f: ScfFigures | null, id: string) => (f ? Math.abs(f.lines.get(id)?.amount ?? 0) : null);
    for (const s of ['OPERATING', 'INVESTING', 'FINANCING'] as ScfSection[]) {
      rows.push(row({ label: SCF_SECTION_LABELS[s] }, 'heading'));
      for (const dir of ['IN', 'OUT'] as const) {
        const defs = SCF_LINES.filter((l) => l.section === s && l.direction === dir && (cur.lines.has(l.id) || pri?.lines.has(l.id)));
        if (!defs.length) continue;
        rows.push(row({ label: dir === 'IN' ? 'Cash Inflows' : 'Cash Outflows' }, 'subheading', 1));
        for (const l of defs) rows.push(row({ label: l.label, cur: amt(cur, l.id), prior: amt(pri, l.id) }, 'normal', 2));
        const tot = (f: ScfFigures | null) => (f ? defs.reduce((t, l) => t + Math.abs(f.lines.get(l.id)?.amount ?? 0), 0) : null);
        rows.push(row({ label: `Total Cash ${dir === 'IN' ? 'Inflows' : 'Outflows'}`, cur: tot(cur), prior: tot(pri) }, 'subtotal', 1));
      }
      const k = s === 'OPERATING' ? 'operating' : s === 'INVESTING' ? 'investing' : 'financing';
      rows.push(row({ label: `Net Cash Provided by (Used in) ${s.charAt(0) + s.slice(1).toLowerCase()} Activities`, cur: cur[k], prior: pri ? pri[k] : null }, 'total'));
    }
    rows.push(row({ label: 'Total Cash Provided by (Used in) Operating, Investing and Financing Activities', cur: cur.netChange, prior: pri?.netChange ?? null }, 'subtotal'));
    rows.push(row({ label: 'Add: Cash and Cash Equivalents, January 1', cur: cur.beginningCash, prior: pri?.beginningCash ?? null }, 'normal'));
    rows.push(row({ label: 'Cash and Cash Equivalents, December 31', cur: cur.endingCash, prior: pri?.endingCash ?? null }, 'grandtotal'));
    return {
      subtitle: [ctx.range.label, 'General Fund', 'Direct method'],
      meta: [],
      sections: [table(cols(d.fy, false), rows)],
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
      sections.push(table(cols(d.fy, true), [...s.rows, row({ label: totalLabel, cur: s.cur, prior: s.prior }, 'grandtotal')], { title: `Note ${++k}. ${title}` }));
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

export const STATEMENT_REPORTS: ReportBuilder[] = [
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
