import { daysBetween } from '../../accounting/cashAdvance';
import { buildCashbook, type CashbookSourceLine } from '../../accounting/cashbook';
import {
  APPLIED_LIQUIDATION_STATUSES,
  caAddDays,
  caBucketIndex,
  caOutstandingAsOf,
  normalizeAgingSettings,
  pettyCashEffect,
  type CaMovement,
  type PettyCashKind,
} from '../../accounting/cashAdvancesLedger';
import { formatPesos } from '../../accounting/money';
import { CA_ACCOUNTS, caTypeLabel, type CashAdvanceRecord, type LiquidationRecord, type PettyCashFundRecord, type PettyCashTxnRecord, type SpecialTrustFundRecord } from '../../modules/cashAdvances';
import type { JournalEntryDoc } from '../../types/accounting';
import type { ObligationDoc, RaoEntryDoc } from '../../types/budget';
import type { Centavos, IsoDate } from '../../types/common';
import type { DisbursementVoucherDoc } from '../../types/treasury';
import type { ReportBuilder, ReportContext } from '../context';
import type { WithId } from '../datasource';
import { col, longDate, row, table, validation, type CellValue, type ReportRow, type ReportSection, type ReportSignatory } from '../model';

/**
 * Phases 6–7 reports, laid out after the MFMB forms and the legacy workbooks: Liquidation Report,
 * aging of cash advances, the disbursing officer's cashbook, the petty cash forms/records and the
 * Registry of Special Trust Funds.
 */

const peso = (v: number) => formatPesos(v as Centavos, { symbol: true, dashZero: false });
const dayBefore = (d: IsoDate) => caAddDays(d, -1);
const isApplied = (s: string) => (APPLIED_LIQUIDATION_STATUSES as readonly string[]).includes(s);
const blankSig = (label: string, position: string): ReportSignatory => ({ label, name: '', position });
/** "Teresa Bautista, Barangay Treasurer" → name and designation for signature lines. */
function splitName(s: string): { name: string; position: string } {
  const i = s.indexOf(',');
  return i > 0 ? { name: s.slice(0, i).trim().toUpperCase(), position: s.slice(i + 1).trim() } : { name: s.toUpperCase(), position: 'Accountable Officer' };
}

async function loadDoc<T>(ctx: ReportContext, collection: string, label: string): Promise<WithId<T>> {
  const id = ctx.params.documentId;
  if (!id) throw new Error(`Select a ${label}.`);
  const d = await ctx.ds.get<T & { barangayId: string }>(collection, id);
  if (!d || d.barangayId !== ctx.params.barangayId) throw new Error(`${label[0]!.toUpperCase()}${label.slice(1)} not found for this barangay.`);
  return d;
}

/** Accepted liquidations as movements per cash advance (all years: advances outlive fiscal years). */
async function caMovements(ctx: ReportContext): Promise<{ byCa: Map<string, CaMovement[]>; lrs: WithId<LiquidationRecord>[] }> {
  const lrs = (await ctx.ds.list<LiquidationRecord>('liquidations', [['barangayId', '==', ctx.params.barangayId]])).filter((l) => isApplied(l.status));
  const byCa = new Map<string, CaMovement[]>();
  for (const l of lrs) byCa.set(l.cashAdvanceId, [...(byCa.get(l.cashAdvanceId) ?? []), { date: l.liquidationDate, supported: l.totalSupported, refunded: l.cashRefunded }]);
  return { byCa, lrs };
}

// ------------------------------------------------------------------ LR
const LR: ReportBuilder = {
  code: 'LR',
  params: 'DOCUMENT',
  document: { collection: 'liquidations', numberField: 'liquidationNumber', dateField: 'liquidationDate', labelField: 'accountableOfficerName' },
  async build(ctx) {
    const l = await loadDoc<LiquidationRecord>(ctx, 'liquidations', 'liquidation report');
    const ca = await ctx.ds.get<CashAdvanceRecord>('cashAdvances', l.cashAdvanceId);
    const accounts = await ctx.accounts();
    const jev = l.jevId ? await ctx.ds.get<JournalEntryDoc>('journalEntries', l.jevId) : null;
    const granted = ca?.amountGranted ?? l.cashAdvanceAmount;
    const previously = granted - l.outstandingBefore;
    const items = l.items ?? [];
    const rows: ReportRow[] = items.map((i) =>
      row({ date: i.date, ref: [i.officialReceiptNumber && `OR ${i.officialReceiptNumber}`, i.invoiceNumber && `SI ${i.invoiceNumber}`].filter(Boolean).join(' / ') || null, supplier: i.supplier || null, particulars: i.particulars, account: i.accountCode, title: accounts.get(i.accountCode)?.accountName ?? '', amount: i.amount }),
    );
    rows.push(row({ particulars: 'TOTAL AMOUNT SPENT', amount: l.totalSupported }, 'total'));
    const sum = items.reduce((t, i) => t + i.amount, 0);
    const reconciles = sum === l.totalSupported && l.outstandingBefore - l.totalSupported - l.cashRefunded === l.balanceRemaining && l.balanceRemaining >= 0;
    const claimant = splitName(l.accountableOfficerName);
    const pb = ctx.sign('', 'PUNONG_BARANGAY', l.liquidationDate);
    const ma = ctx.sign('', 'MUNICIPAL_ACCOUNTANT', l.liquidationDate);
    const sections: ReportSection[] = [
      {
        kind: 'fields',
        columns: 4,
        fields: [
          { label: 'Entity name', value: `Barangay ${ctx.barangayName}`, span: 2 },
          { label: 'Serial no.', value: l.liquidationNumber ?? '(assigned on submission)' },
          { label: 'Date', value: longDate(l.liquidationDate) },
          { label: 'Fund cluster', value: ca?.fundId && ca.fundId !== 'GF' ? ca.fundId : 'General Fund', span: 2 },
          { label: 'Accountable officer', value: l.accountableOfficerName, span: 2 },
          { label: 'Cash advance', value: `DV No. ${l.caDvNumber} dated ${longDate(l.caGrantDate)}`, span: 2 },
          { label: 'Purpose', value: l.caPurpose, span: 2 },
        ],
      },
      table(
        [
          col('date', 'Date', 'date'),
          col('ref', 'OR / Invoice No.', 'text'),
          col('supplier', 'Payee / Supplier', 'text', { width: 2 }),
          col('particulars', 'Particulars', 'text', { width: 3 }),
          col('account', 'Account code', 'code'),
          col('title', 'Account title', 'text', { width: 2 }),
          col('amount', 'Amount', 'money'),
        ],
        rows,
        { title: 'Particulars', emptyText: 'No expenditures; refund only.' },
      ),
      {
        kind: 'fields',
        title: 'Summary',
        columns: 2,
        fields: [
          { label: `Amount of cash advance per DV No. ${l.caDvNumber} dated ${longDate(l.caGrantDate)}`, value: granted, type: 'money' },
          { label: 'Less: previously liquidated / refunded', value: previously, type: 'money' },
          { label: 'Balance of cash advance before this report', value: l.outstandingBefore, type: 'money' },
          { label: 'Total amount spent (per supporting documents)', value: l.totalSupported, type: 'money' },
          { label: `Amount refunded${l.refundOrNumber ? ` per OR No. ${l.refundOrNumber}${l.refundOrDate ? ` dated ${longDate(l.refundOrDate)}` : ''}` : ''}`, value: l.cashRefunded, type: 'money' },
          { label: 'Balance of cash advance remaining (unliquidated)', value: l.balanceRemaining, type: 'money' },
          { label: 'Amount to be reimbursed', value: 0, type: 'money' },
          { label: 'Status', value: l.status },
        ],
      },
      {
        kind: 'certifications',
        boxes: [
          { label: 'A. Certified: Correctness of the above data', name: claimant.name, position: `Claimant — ${claimant.position}`, date: l.liquidationDate },
          { label: 'B. Certified: Purpose of the cash advance duly accomplished', name: pb.name, position: pb.position, date: null },
          { label: 'C. Certified: Supporting documents complete and proper', text: jev?.jevNumber ? `JEV No. ${jev.jevNumber} dated ${longDate(jev.jevDate)}` : 'JEV No.: ________  Date: ________', name: ma.name, position: `${ma.position} / Head, Accounting Unit`, date: null },
        ],
      },
    ];
    return {
      subtitle: [],
      meta: [{ label: 'LR No.', value: l.liquidationNumber ?? '(draft)' }],
      sections,
      signatories: [],
      validations: [validation('LIQUIDATION_RECONCILES', reconciles, reconciles ? 'Cash advance − supported expenditures − refund = balance remaining.' : 'The liquidation does not reconcile with the cash advance; re-save the report.')],
      isEmpty: false,
    };
  },
};

// ------------------------------------------------------------------ CA aging
const CA_AGING: ReportBuilder = {
  code: 'CA_AGING',
  params: 'AS_OF',
  async build(ctx) {
    const asOf = ctx.range.to;
    const settings = normalizeAgingSettings(await ctx.ds.get('systemSettings', 'aging'));
    const buckets = settings.buckets;
    const { byCa } = await caMovements(ctx);
    const cas = (await ctx.ds.list<CashAdvanceRecord>('cashAdvances', [['barangayId', '==', ctx.params.barangayId]])).filter((c) => c.status !== 'CLOSED' && c.grantDate <= asOf);
    type Line = { ca: WithId<CashAdvanceRecord>; bal: number; days: number; b: number };
    const byOfficer = new Map<string, Line[]>();
    for (const ca of cas) {
      const bal = caOutstandingAsOf(ca, byCa.get(ca.id) ?? [], asOf);
      if (!bal || bal <= 0) continue;
      const days = daysBetween(ca.grantDate, asOf);
      byOfficer.set(ca.accountableOfficerId, [...(byOfficer.get(ca.accountableOfficerId) ?? []), { ca, bal, days, b: caBucketIndex(days, buckets) }]);
    }
    const sls = await ctx.subsidiaries();
    const bk = (i: number) => `b${i}`;
    const columns = [
      col('dv', 'DV / Check No.', 'text'),
      col('date', 'Date granted', 'date'),
      col('particulars', 'Purpose', 'text', { width: 3 }),
      col('due', 'Due date', 'date'),
      col('amount', 'Amount granted', 'money'),
      col('liquidated', 'Liquidated / refunded', 'money'),
      col('balance', 'Unliquidated balance', 'money'),
      ...buckets.map((b, i) => col(bk(i), b.label, 'money', { group: 'Aging (days from grant)' })),
      col('days', 'Days', 'number'),
    ];
    const rows: ReportRow[] = [];
    const grand: Record<string, number> = { amount: 0, liquidated: 0, balance: 0 };
    let overdue = 0;
    const officers = [...byOfficer.entries()].sort((a, b) => (sls.get(a[0])?.subsidiaryCode ?? a[0]).localeCompare(sls.get(b[0])?.subsidiaryCode ?? b[0]));
    for (const [officerId, lines] of officers) {
      const sl = sls.get(officerId);
      rows.push(row({ dv: `${sl?.subsidiaryCode ?? ''} ${lines[0]!.ca.accountableOfficerName}`.trim(), particulars: `${lines[0]!.ca.accountCode}` }, 'heading'));
      const sub: Record<string, number> = { amount: 0, liquidated: 0, balance: 0 };
      for (const { ca, bal, days, b } of lines.sort((x, y) => x.ca.grantDate.localeCompare(y.ca.grantDate))) {
        if (asOf > ca.liquidationDueDate) overdue++;
        const cells: Record<string, CellValue> = {
          dv: [ca.dvNumber, ca.checkNumber && `Chk ${ca.checkNumber}`].filter(Boolean).join(' / ') + (ca.isLegacy ? ' (migrated)' : ''),
          date: ca.grantDate,
          particulars: `${ca.purpose} [${caTypeLabel(ca.cashAdvanceType)}]${asOf > ca.liquidationDueDate ? ' — OVERDUE' : ''}`,
          due: ca.liquidationDueDate,
          amount: ca.amountGranted,
          liquidated: ca.amountGranted - bal || null,
          balance: bal,
          [bk(b)]: bal,
          days,
        };
        rows.push(row(cells, 'normal', 1));
        sub.amount! += ca.amountGranted;
        sub.liquidated! += ca.amountGranted - bal;
        sub.balance! += bal;
        sub[bk(b)] = (sub[bk(b)] ?? 0) + bal;
      }
      rows.push(row({ particulars: `Total — ${lines[0]!.ca.accountableOfficerName}`, ...sub }, 'subtotal'));
      for (const [k, v] of Object.entries(sub)) grand[k] = (grand[k] ?? 0) + v;
    }
    rows.push(row({ particulars: 'GRAND TOTAL', ...grand }, 'grandtotal'));
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Accounts', value: '1-03-03-010 Advances for Payroll; 1-03-03-020 Advances to Officers and Employees' }, { label: 'Overdue advances', value: String(overdue) }],
      sections: [table(columns, officers.length ? rows : [], { emptyText: 'No unliquidated cash advances as of this date.' })],
      signatories: [blankSig('Prepared by', 'Accounting Staff'), ctx.sign('Certified correct', 'MUNICIPAL_ACCOUNTANT')],
      validations: [],
      isEmpty: officers.length === 0,
      notes: ['Aging is counted in days from the date the cash advance was granted. Overdue: past the liquidation due date (systemSettings/aging).'],
    };
  },
};

// ------------------------------------------------------------------ Cashbook — disbursing officer
const CASHBOOK_DO: ReportBuilder = {
  code: 'CASHBOOK_DO',
  params: 'MONTH',
  extras: [
    { key: 'accountCode', label: 'Cash advance account', kind: 'select', options: CA_ACCOUNTS.map((a) => ({ value: a.value, label: a.label })) },
    { key: 'subsidiaryId', label: 'Disbursing officer', kind: 'subsidiary' },
  ],
  async build(ctx) {
    const { from, to } = ctx.range;
    const { lrs } = await caMovements(ctx);
    const cas = (await ctx.ds.list<CashAdvanceRecord>('cashAdvances', [['barangayId', '==', ctx.params.barangayId]])).filter(
      (c) => c.status !== 'CLOSED' && (!ctx.params.accountCode || c.accountCode === ctx.params.accountCode) && (!ctx.params.subsidiaryId || c.accountableOfficerId === ctx.params.subsidiaryId),
    );
    const caById = new Map(cas.map((c) => [c.id, c]));
    const movements = new Map<string, CaMovement[]>();
    for (const l of lrs) if (caById.has(l.cashAdvanceId)) movements.set(l.cashAdvanceId, [...(movements.get(l.cashAdvanceId) ?? []), { date: l.liquidationDate, supported: l.totalSupported, refunded: l.cashRefunded }]);
    const officers = [...new Set(cas.map((c) => c.accountableOfficerId))];
    const sls = await ctx.subsidiaries();
    const columns = [
      col('date', 'Date', 'date'),
      col('reference', 'Reference (DV / LR / OR No.)', 'text'),
      col('particulars', 'Particulars', 'text', { width: 3 }),
      col('receipt', 'Cash advance received', 'money'),
      col('liquidated', 'Liquidations', 'money', { group: 'Payments' }),
      col('refunded', 'Refunds', 'money', { group: 'Payments' }),
      col('balance', 'Balance', 'money'),
    ];
    const sections: ReportSection[] = [];
    let allOk = true;
    for (const officerId of officers.sort((a, b) => (sls.get(a)?.subsidiaryCode ?? a).localeCompare(sls.get(b)?.subsidiaryCode ?? b))) {
      const mine = cas.filter((c) => c.accountableOfficerId === officerId);
      const outstanding = (d: IsoDate) => mine.reduce((t, c) => t + (caOutstandingAsOf(c, movements.get(c.id) ?? [], d) ?? 0), 0);
      const beginning = outstanding(dayBefore(from)) as Centavos;
      const extra = new Map<string, { liquidated: number; refunded: number }>();
      const lines: CashbookSourceLine[] = [];
      for (const c of mine) {
        if (c.grantDate < from || c.grantDate > to) continue;
        const k = `${c.grantDate}|0|${c.id}`;
        lines.push({ date: c.grantDate, sortKey: k, reference: [c.dvNumber && `DV ${c.dvNumber}`, c.checkNumber && `Chk ${c.checkNumber}`].filter(Boolean).join(' / '), particulars: `${c.purpose}${c.isLegacy && c.openingLiquidated ? ' (net of amounts liquidated before migration)' : ''}`, receipt: (c.amountGranted - (c.openingLiquidated ?? 0)) as Centavos, payment: 0 as Centavos });
      }
      for (const l of lrs) {
        if (!mine.some((c) => c.id === l.cashAdvanceId) || l.liquidationDate < from || l.liquidationDate > to) continue;
        const k = `${l.liquidationDate}|1|${l.id}`;
        extra.set(k, { liquidated: l.totalSupported, refunded: l.cashRefunded });
        lines.push({ date: l.liquidationDate, sortKey: k, reference: [l.liquidationNumber, l.refundOrNumber && `OR ${l.refundOrNumber}`].filter(Boolean).join(' / '), particulars: `Liquidation of CA per DV ${l.caDvNumber} — ${l.caPurpose}`, receipt: 0 as Centavos, payment: (l.totalSupported + l.cashRefunded) as Centavos });
      }
      if (!beginning && !lines.length) continue;
      const cb = buildCashbook(beginning, lines);
      const ending = outstanding(to);
      const ok = cb.valid && cb.endingBalance === ending;
      allOk &&= ok;
      const rows: ReportRow[] = [row({ particulars: 'Balance brought forward', balance: beginning }, 'subheading')];
      for (const r of cb.rows) {
        const x = extra.get(r.sortKey);
        rows.push(row({ date: r.date, reference: r.reference, particulars: r.particulars, receipt: r.receipt || null, liquidated: x?.liquidated || null, refunded: x?.refunded || null, balance: r.balance }));
      }
      const tl = [...extra.values()].reduce((t, x) => t + x.liquidated, 0);
      const tr = [...extra.values()].reduce((t, x) => t + x.refunded, 0);
      rows.push(row({ particulars: 'Totals / balance carried forward', receipt: cb.totalReceipts, liquidated: tl, refunded: tr, balance: cb.endingBalance }, 'total'));
      const sl = sls.get(officerId);
      sections.push(table(columns, rows, { title: `${sl?.subsidiaryCode ?? ''} ${mine[0]!.accountableOfficerName} — ${mine[0]!.accountCode}`.trim() }));
    }
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund', value: 'General Fund' }, ...(ctx.params.accountCode ? [{ label: 'Account', value: ctx.params.accountCode }] : [])],
      sections: sections.length ? sections : [table(columns, [], { emptyText: 'No cash advances or liquidations for the period.' })],
      signatories: [ctx.sign('Certified correct', 'BARANGAY_TREASURER')],
      validations: [validation('CASHBOOK_ROLLFORWARD', allOk, allOk ? 'Beginning + cash advances − liquidations/refunds = ending balance = unliquidated advances.' : 'The cashbook does not roll forward to the unliquidated balance of the officer\'s cash advances.')],
      isEmpty: sections.length === 0,
    };
  },
};

// ------------------------------------------------------------------ petty cash
const PCV: ReportBuilder = {
  code: 'PCV',
  params: 'DOCUMENT',
  document: { collection: 'pettyCashTransactions', numberField: 'pcvNumber', dateField: 'date', labelField: 'payee' },
  async build(ctx) {
    const t = await loadDoc<PettyCashTxnRecord>(ctx, 'pettyCashTransactions', 'petty cash voucher');
    if (t.kind !== 'PAYMENT') throw new Error('Select a petty cash voucher (this record is a fund transaction).');
    const fund = await ctx.ds.get<PettyCashFundRecord>('pettyCashFunds', t.pettyCashFundId);
    const accounts = await ctx.accounts();
    const pb = ctx.sign('', 'PUNONG_BARANGAY', t.date);
    const custodian = splitName(fund?.custodianName ?? '');
    return {
      subtitle: [],
      meta: [{ label: 'PCV No.', value: t.pcvNumber ?? '(assigned on approval)' }],
      sections: [
        {
          kind: 'fields',
          columns: 4,
          fields: [
            { label: 'Entity name', value: `Barangay ${ctx.barangayName}`, span: 2 },
            { label: 'PCV No.', value: t.pcvNumber ?? '(assigned on approval)' },
            { label: 'Date', value: longDate(t.date) },
            { label: 'Fund cluster', value: 'General Fund', span: 2 },
            { label: 'Petty cash fund', value: fund ? `${fund.fundName} — ${fund.custodianName}` : '', span: 2 },
            { label: 'Payee / office', value: t.payee?.name ?? '', span: 2 },
            { label: 'Address', value: t.payee?.address ?? '', span: 2 },
          ],
        },
        table(
          [col('particulars', 'Particulars', 'text', { width: 4 }), col('account', 'Account code', 'code'), col('title', 'Account title', 'text', { width: 2 }), col('amount', 'Amount', 'money')],
          [row({ particulars: t.particulars, account: t.accountCode, title: t.accountCode ? accounts.get(t.accountCode)?.accountName ?? '' : '', amount: t.amount }), row({ particulars: 'TOTAL', amount: t.amount }, 'total')],
        ),
        {
          kind: 'certifications',
          boxes: [
            { label: 'A. Requested by', text: 'Signature over printed name of the requesting officer / payee', name: (t.payee?.name ?? '').toUpperCase(), position: 'Payee', date: t.date },
            { label: 'B. Approved by', text: 'Approved for payment from the petty cash fund', name: pb.name, position: pb.position, date: null },
            { label: 'C. Paid by', text: `Cash paid: ${peso(t.amount)}`, name: custodian.name, position: 'Petty Cash Custodian', date: null },
            { label: 'D. Cash received by', text: `Received the amount of ${peso(t.amount)}`, name: (t.payee?.name ?? '').toUpperCase(), position: 'Payee', date: null },
          ],
        },
      ],
      signatories: [],
      validations: [],
      isEmpty: false,
    };
  },
};

async function pettyCashData(ctx: ReportContext) {
  const funds = await ctx.ds.list<PettyCashFundRecord>('pettyCashFunds', [['barangayId', '==', ctx.params.barangayId]]);
  const txns = await ctx.ds.list<PettyCashTxnRecord>('pettyCashTransactions', [['barangayId', '==', ctx.params.barangayId]]);
  return { funds: funds.sort((a, b) => a.dateEstablished.localeCompare(b.dateEstablished)), txns };
}

const PCR: ReportBuilder = {
  code: 'PCR',
  params: 'MONTH',
  async build(ctx) {
    const { from, to } = ctx.range;
    const { funds, txns } = await pettyCashData(ctx);
    const accounts = await ctx.accounts();
    const sections: ReportSection[] = [];
    let any = false;
    for (const f of funds.filter((x) => x.dateEstablished <= to && (!x.closedDate || x.closedDate >= from))) {
      const mine = txns.filter((t) => t.pettyCashFundId === f.id);
      const eff = mine.map((t) => ({ t, e: pettyCashEffect({ ...t, kind: t.kind as PettyCashKind }) })).filter((x): x is { t: WithId<PettyCashTxnRecord>; e: NonNullable<ReturnType<typeof pettyCashEffect>> } => !!x.e);
      const beginning = eff.filter((x) => x.e.date < from).reduce((s, x) => s + x.e.receipt - x.e.payment, 0) as Centavos;
      const month = eff.filter((x) => x.e.date >= from && x.e.date <= to);
      const byKey = new Map(month.map((x) => [`${x.e.date}|${x.t.kind === 'PAYMENT' ? 1 : 0}|${x.t.pcvNumber ?? ''}|${x.t.id}`, x.t]));
      const cb = buildCashbook(
        beginning,
        [...byKey.entries()].map(([k, t]) => {
          const x = month.find((m) => m.t.id === t.id)!;
          const ref = t.kind === 'PAYMENT' ? t.pcvNumber ?? '' : t.kind === 'REPLENISH' ? `DV ${t.replenishmentDvNumber ?? ''}` : t.kind === 'ESTABLISH' ? `DV ${t.replenishmentDvNumber ?? ''}` : `OR ${t.refundOrNumber ?? ''}`;
          return { date: x.e.date, sortKey: k, reference: ref.trim(), particulars: t.particulars, receipt: x.e.receipt, payment: x.e.payment };
        }),
      );
      const acctCodes = [...new Set(month.filter((x) => x.t.kind === 'PAYMENT' && x.t.accountCode).map((x) => x.t.accountCode!))].sort();
      const ak = (c: string) => `a_${c}`;
      const columns = [
        col('date', 'Date', 'date'),
        col('reference', 'PCV / DV No.', 'text'),
        col('payee', 'Payee', 'text', { width: 2 }),
        col('particulars', 'Particulars', 'text', { width: 3 }),
        col('receipt', 'Receipts / replenishments', 'money'),
        col('payment', 'Payments', 'money'),
        col('balance', 'Cash on hand', 'money'),
        ...acctCodes.map((c) => col(ak(c), `${c} ${accounts.get(c)?.accountName ?? ''}`.trim(), 'money', { group: 'Analysis of payments' })),
      ];
      const rows: ReportRow[] = [row({ particulars: 'Balance brought forward', balance: beginning }, 'subheading')];
      const totals: Record<string, number> = {};
      for (const r of cb.rows) {
        const t = byKey.get(r.sortKey)!;
        const cells: Record<string, CellValue> = { date: r.date, reference: r.reference, payee: t.payee?.name ?? '', particulars: r.particulars, receipt: r.receipt || null, payment: r.payment || null, balance: r.balance };
        if (t.kind === 'PAYMENT' && t.accountCode) {
          cells[ak(t.accountCode)] = t.amount;
          totals[ak(t.accountCode)] = (totals[ak(t.accountCode)] ?? 0) + t.amount;
        }
        rows.push(row(cells));
      }
      rows.push(row({ particulars: 'Totals / balance carried forward', receipt: cb.totalReceipts, payment: cb.totalPayments, balance: cb.endingBalance, ...totals }, 'total'));
      any ||= month.length > 0 || beginning !== 0;
      sections.push(table(columns, rows, { title: `${f.fundName} — ${f.custodianName} (imprest ${peso(f.fundAmount)})` }));
    }
    const custodian = funds[0] ? splitName(funds[0].custodianName) : null;
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund', value: 'General Fund' }],
      sections: sections.length ? sections : [table([col('particulars', 'Particulars', 'text')], [], { emptyText: 'No petty cash fund for this period.' })],
      signatories: [custodian ? { label: 'Prepared by', name: custodian.name, position: 'Petty Cash Custodian' } : blankSig('Prepared by', 'Petty Cash Custodian'), ctx.sign('Certified correct', 'BARANGAY_TREASURER')],
      validations: [],
      isEmpty: !any,
    };
  },
};

const SPCD: ReportBuilder = {
  code: 'SPCD',
  params: 'MONTH',
  async build(ctx) {
    const { txns, funds } = await pettyCashData(ctx);
    const accounts = await ctx.accounts();
    const pcvs = txns
      .filter((t) => t.kind === 'PAYMENT' && t.status === 'APPROVED' && t.date >= ctx.range.from && t.date <= ctx.range.to)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.pcvNumber ?? '').localeCompare(b.pcvNumber ?? ''));
    const detail = pcvs.map((t) => row({ date: t.date, pcv: t.pcvNumber, payee: t.payee?.name ?? '', particulars: t.particulars, account: t.accountCode, amount: t.amount }));
    const total = pcvs.reduce((s, t) => s + t.amount, 0);
    detail.push(row({ particulars: 'TOTAL', amount: total }, 'total'));
    const byAcct = new Map<string, WithId<PettyCashTxnRecord>[]>();
    for (const t of pcvs) byAcct.set(t.accountCode ?? '', [...(byAcct.get(t.accountCode ?? '') ?? []), t]);
    const recap = [...byAcct.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([code, list]) =>
      row({ account: code, title: accounts.get(code)?.accountName ?? '', count: list.length, pcvs: list.map((x) => x.pcvNumber).join(', '), amount: list.reduce((s, x) => s + x.amount, 0) }),
    );
    recap.push(row({ title: 'TOTAL', count: pcvs.length, amount: total }, 'grandtotal'));
    const custodian = funds[0] ? splitName(funds[0].custodianName) : null;
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund', value: 'General Fund' }],
      sections: [
        table([col('date', 'Date', 'date'), col('pcv', 'PCV No.', 'text'), col('payee', 'Payee', 'text', { width: 2 }), col('particulars', 'Particulars', 'text', { width: 3 }), col('account', 'Account code', 'code'), col('amount', 'Amount', 'money')], pcvs.length ? detail : [], { title: 'Petty cash vouchers paid', emptyText: 'No petty cash disbursements for the month.' }),
        table([col('account', 'Account code', 'code'), col('title', 'Account title', 'text', { width: 3 }), col('count', 'No. of PCVs', 'number'), col('pcvs', 'PCV Nos.', 'text', { width: 3 }), col('amount', 'Amount', 'money')], pcvs.length ? recap : [], { title: 'Recapitulation by account', emptyText: '' }),
      ],
      signatories: [custodian ? { label: 'Prepared by', name: custodian.name, position: 'Petty Cash Custodian' } : blankSig('Prepared by', 'Petty Cash Custodian'), ctx.sign('Certified correct', 'BARANGAY_TREASURER')],
      validations: [],
      isEmpty: pcvs.length === 0,
    };
  },
};

// ------------------------------------------------------------------ RSTF
const RSTF: ReportBuilder = {
  code: 'RSTF',
  params: 'MONTH',
  async build(ctx) {
    const { from, to } = ctx.range;
    const bid = ctx.params.barangayId;
    const funds = (await ctx.ds.list<SpecialTrustFundRecord>('specialTrustFunds', [['barangayId', '==', bid]])).filter((f) => f.dateReceived <= to).sort((a, b) => a.fundCode.localeCompare(b.fundCode));
    const obls = funds.length ? (await ctx.ds.list<ObligationDoc>('obligations', [['barangayId', '==', bid]])).filter((o) => o.specialTrustFundId && o.obligationNumber) : [];
    const cancels = obls.some((o) => o.status === 'CANCELLED') ? (await ctx.ds.list<RaoEntryDoc>('raoEntries', [['barangayId', '==', bid]])).filter((e) => e.sourceType === 'OBLIGATION_CANCEL') : [];
    const dvIds = new Set(obls.map((o) => (o as ObligationDoc & { dvId?: string | null }).dvId).filter((x): x is string => !!x));
    const dvs = dvIds.size ? new Map((await ctx.ds.list<DisbursementVoucherDoc>('disbursementVouchers', [['barangayId', '==', bid]])).filter((d) => dvIds.has(d.id) && ['APPROVED', 'ACCEPTED', 'POSTED'].includes(d.status)).map((d) => [d.id, d])) : new Map<string, WithId<DisbursementVoucherDoc>>();
    type Ev = { date: IsoDate; k: string; reference: string; particulars: string; receipt: number; obligation: number; disbursement: number };
    const columns = [
      col('date', 'Date', 'date'),
      col('reference', 'Reference (OR / OBR / DV No.)', 'text'),
      col('particulars', 'Particulars', 'text', { width: 3 }),
      col('receipt', 'Receipts / adjustments', 'money'),
      col('obligation', 'Obligations', 'money'),
      col('disbursement', 'Disbursements', 'money'),
      col('unobligated', 'Unobligated balance', 'money', { group: 'Balance' }),
      col('undisbursed', 'Undisbursed (cash) balance', 'money', { group: 'Balance' }),
    ];
    const summary: ReportRow[] = [];
    const sections: ReportSection[] = [];
    for (const f of funds) {
      const ev: Ev[] = (f.history ?? []).map((h, i) => ({ date: h.date, k: `0${i}`, reference: h.reference, particulars: h.kind === 'RECEIPT' ? `Receipt from ${f.source}` : `${h.kind.replace(/_/g, ' ').toLowerCase()} — ${h.reason}`, receipt: h.amount, obligation: 0, disbursement: 0 }));
      for (const o of obls.filter((x) => x.specialTrustFundId === f.id)) {
        ev.push({ date: o.date, k: `1${o.obligationNumber}`, reference: o.obligationNumber ?? '', particulars: `${o.payee?.name ?? ''} — ${o.particulars}`, receipt: 0, obligation: o.amount, disbursement: 0 });
        const c = o.status === 'CANCELLED' ? cancels.find((e) => e.sourceId === o.id) : null;
        if (c) ev.push({ date: c.date, k: `2${o.obligationNumber}`, reference: o.obligationNumber ?? '', particulars: `Cancelled obligation — ${o.payee?.name ?? ''}`, receipt: 0, obligation: -o.amount, disbursement: 0 });
        const dv = dvs.get((o as ObligationDoc & { dvId?: string | null }).dvId ?? '');
        if (dv && o.status !== 'CANCELLED') ev.push({ date: dv.dvDate, k: `3${dv.dvNumber}`, reference: `DV ${dv.dvNumber ?? ''}`, particulars: `${dv.payee?.name ?? ''} — ${dv.particulars}`.slice(0, 300), receipt: 0, obligation: 0, disbursement: dv.grossAmount });
      }
      ev.sort((a, b) => a.date.localeCompare(b.date) || a.k.localeCompare(b.k));
      const before = ev.filter((e) => e.date < from);
      const inMonth = ev.filter((e) => e.date >= from && e.date <= to);
      const s = (list: Ev[], k: 'receipt' | 'obligation' | 'disbursement') => list.reduce((t, e) => t + e[k], 0);
      let unob = s(before, 'receipt') - s(before, 'obligation');
      let undis = s(before, 'receipt') - s(before, 'disbursement');
      const rows: ReportRow[] = [row({ particulars: 'Balance brought forward', unobligated: unob, undisbursed: undis }, 'subheading')];
      for (const e of inMonth) {
        unob += e.receipt - e.obligation;
        undis += e.receipt - e.disbursement;
        rows.push(row({ date: e.date, reference: e.reference, particulars: e.particulars, receipt: e.receipt || null, obligation: e.obligation || null, disbursement: e.disbursement || null, unobligated: unob, undisbursed: undis }));
      }
      rows.push(row({ particulars: 'Totals / balance carried forward', receipt: s(inMonth, 'receipt'), obligation: s(inMonth, 'obligation'), disbursement: s(inMonth, 'disbursement'), unobligated: unob, undisbursed: undis }, 'total'));
      sections.push(table(columns, rows, { title: `${f.fundCode} — ${f.fundName} (${f.source})` }));
      const upTo = ev.filter((e) => e.date <= to);
      summary.push(row({ code: f.fundCode, name: f.fundName, source: f.source, received: s(upTo, 'receipt'), obligated: s(upTo, 'obligation'), disbursed: s(upTo, 'disbursement'), balance: unob, status: f.status }));
    }
    if (summary.length) {
      const tot = (k: string) => summary.reduce((t, r) => t + ((r.cells[k] as number) ?? 0), 0);
      summary.push(row({ name: 'TOTAL', received: tot('received'), obligated: tot('obligated'), disbursed: tot('disbursed'), balance: tot('balance') }, 'grandtotal'));
    }
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Account', value: '2-03-01-010 Trust Liabilities' }],
      sections: [
        table([col('code', 'Fund code', 'code'), col('name', 'Fund', 'text', { width: 3 }), col('source', 'Source', 'text'), col('received', 'Received (net)', 'money'), col('obligated', 'Obligated', 'money'), col('disbursed', 'Disbursed', 'money'), col('balance', 'Unobligated balance', 'money'), col('status', 'Status', 'text')], summary, { title: 'Summary of Special Trust Funds', emptyText: 'No Special Trust Funds registered.' }),
        ...sections,
      ],
      signatories: [ctx.sign('Certified correct', 'BARANGAY_TREASURER')],
      validations: [],
      isEmpty: funds.length === 0,
    };
  },
};

export const CASH_ADVANCES_REPORTS: ReportBuilder[] = [LR, CA_AGING, CASHBOOK_DO, PCV, PCR, SPCD, RSTF];
