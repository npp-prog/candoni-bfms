import { buildCashbook, type CashbookSourceLine } from '../../accounting/cashbook';
import {
  afAccountability,
  computeAfUsage,
  computeRcdTotals,
  describeAfProblems,
  formatAfSerial,
  isCollectionCounted,
  type AfQtyRange,
  type AfSerialUse,
} from '../../accounting/collections';
import { CASHBOOK_ACCOUNTS, CASHBOOK_VARIANTS, afFormLabel, type AccountableFormRecord, type CollectionRecord, type DepositRecord, type RcdRecord, type RcrDoc } from '../../modules/collections';
import type { AccountBalanceDoc } from '../../types/accounting';
import type { BankAccountDoc, BankMemoDoc } from '../../types/bank';
import type { Centavos, IsoDate } from '../../types/common';
import type { CheckDoc, DisbursementVoucherDoc } from '../../types/treasury';
import type { ReportBody, ReportBuilder, ReportContext } from '../context';
import type { WithId } from '../datasource';
import { peso } from '../helpers';
import { col, longDate, row, table, validation, type ReportColumn, type ReportRow, type ReportSection } from '../model';

type Coll = WithId<CollectionRecord>;
type Form = WithId<AccountableFormRecord>;

/** "BT01 — Teresa Bautista, Barangay Treasurer" → "Teresa Bautista, Barangay Treasurer" */
const personOf = (label: string | null | undefined) => (label ?? '').replace(/^[A-Z0-9-]+ — /, '');
const shortForm = (t: string) => (t.startsWith('AF') ? `AF ${t.slice(2)}` : t);

function emptyDocument(what: string): ReportBody {
  return { subtitle: [], meta: [], sections: [{ kind: 'text', paragraphs: [`Select ${what} to print.`] }], signatories: [], validations: [], isEmpty: true };
}

/** ORs/deposits listed on a report, loaded with the barangay+year scope (rules) and filtered by id. */
async function byIds<T>(ctx: ReportContext, collection: string, fiscalYear: number, ids: readonly string[]): Promise<WithId<T>[]> {
  if (!ids.length) return [];
  const want = new Set(ids);
  return (await ctx.ds.list<T>(collection, [['barangayId', '==', ctx.params.barangayId], ['fiscalYear', '==', fiscalYear]])).filter((d) => want.has(d.id));
}

/**
 * OR listing with the account breakdown (RCD section A / RCR): Date, OR No., Payor, Nature of
 * collection, Amount, then one column per account credited (legacy RCD "breakdown" columns).
 */
async function orListing(ctx: ReportContext, colls: readonly Coll[], opts: { collector?: boolean; title?: string }): Promise<{ section: ReportSection; total: number }> {
  const accounts = await ctx.accounts();
  const codes = [...new Set(colls.flatMap((c) => c.lines.map((l) => l.accountCode)))].sort();
  const MAX = 6; // keep the form printable on A4; the rest goes to "Other accounts"
  const shown = codes.slice(0, codes.length > MAX ? MAX - 1 : MAX);
  const other = codes.length > shown.length;
  const columns: ReportColumn[] = [
    col('date', 'Date', 'date'),
    col('or', 'OR No.', 'code'),
    col('payor', 'Name of Payor', 'text', { width: 2 }),
    col('nature', 'Nature of Collection', 'text', { width: 2 }),
    ...(opts.collector ? [col('collector', 'Collector', 'text')] : []),
    col('amount', 'Amount', 'money'),
    ...shown.map((c) => col(`a_${c}`, `${accounts.get(c)?.accountName ?? c} (${c})`, 'money', { group: 'Breakdown of collections' })),
    ...(other ? [col('a_other', 'Other accounts', 'money', { group: 'Breakdown of collections' })] : []),
  ];
  const sorted = [...colls].sort((a, b) => a.collectionDate.localeCompare(b.collectionDate) || a.serialNumber - b.serialNumber);
  const rows: ReportRow[] = sorted.map((c) => {
    const counted = isCollectionCounted(c.status);
    const cells: Record<string, string | number | null> = {
      date: c.collectionDate,
      or: c.officialReceiptNumber,
      payor: counted ? c.payor.name : 'CANCELLED',
      nature: counted ? [...new Set(c.lines.map((l) => l.natureOfCollection))].join('; ') : c.cancelReason ?? '',
      collector: personOf(c.collectingOfficerName),
      amount: counted ? c.amount : null,
    };
    if (counted)
      for (const l of c.lines) {
        const k = shown.includes(l.accountCode) ? `a_${l.accountCode}` : 'a_other';
        cells[k] = ((cells[k] as number | null) ?? 0) + l.amount;
      }
    return row(cells);
  });
  const total: Record<string, number | string | null> = { payor: 'TOTAL', amount: 0 };
  for (const r of rows) for (const c of columns) if (c.type === 'money' && typeof r.cells[c.key] === 'number') total[c.key] = ((total[c.key] as number) ?? 0) + (r.cells[c.key] as number);
  rows.push(row(total, 'total'));
  return { section: table(columns, rows, { title: opts.title, emptyText: 'No official receipts.' }), total: total.amount as number };
}

const fmtQ = (q: AfQtyRange, width: number) => ({ qty: q.qty || null, from: q.from === null ? null : formatAfSerial(q.from, width), to: q.to === null ? null : formatAfSerial(q.to, width) });

const AF_COLUMNS: ReportColumn[] = [
  col('form', 'Name of Form and No.', 'text', { width: 2 }),
  ...(['beg', 'rec', 'iss', 'end'] as const).flatMap((k) => {
    const g = { beg: 'Beginning Balance', rec: 'Receipt', iss: 'Issued', end: 'Ending Balance' }[k];
    return [col(`${k}Qty`, 'Qty.', 'number', { group: g }), col(`${k}From`, 'From', 'code', { group: g }), col(`${k}To`, 'To', 'code', { group: g })];
  }),
];

/** One accountability row per series (RCD section C and RAAF). */
async function afRows(ctx: ReportContext, forms: readonly Form[], range: { from: IsoDate; to: IsoDate }) {
  const rows: ReportRow[] = [];
  const problems: string[] = [];
  const tot = { begQty: 0, recQty: 0, issQty: 0, endQty: 0 };
  for (const f of forms) {
    const uses: AfSerialUse[] = (await ctx.ds.list<CollectionRecord>('collections', [['barangayId', '==', ctx.params.barangayId], ['accountableFormId', '==', f.id]])).map((c) => ({ serial: c.serialNumber, date: c.collectionDate, status: c.status }));
    const throughEnd = uses.filter((u) => u.date <= range.to);
    const usage = computeAfUsage({ begin: f.beginningSerialNumber, end: f.endingSerialNumber }, throughEnd);
    const p = describeAfProblems(`${shortForm(f.formType)} ${f.series}`, usage);
    if (p) problems.push(p);
    const a = afAccountability({ begin: f.beginningSerialNumber, end: f.endingSerialNumber }, f.dateIssued ?? f.dateReceived, throughEnd, range);
    const returned = f.status === 'RETURNED' && (f as Form & { returnedDate?: string }).returnedDate;
    if (!a.beginning.qty && !a.receipts.qty && !a.issued.qty && !a.ending.qty) continue;
    const q = { beg: fmtQ(a.beginning, f.serialWidth), rec: fmtQ(a.receipts, f.serialWidth), iss: fmtQ(a.issued, f.serialWidth), end: fmtQ(returned && returned <= range.to ? { qty: 0, from: null, to: null } : a.ending, f.serialWidth) };
    const cells: Record<string, string | number | null> = { form: `${shortForm(f.formType)} · ${f.series}${returned && returned <= range.to ? ` (balance returned ${returned})` : ''}` };
    for (const k of ['beg', 'rec', 'iss', 'end'] as const) {
      cells[`${k}Qty`] = q[k].qty;
      cells[`${k}From`] = q[k].from;
      cells[`${k}To`] = q[k].to;
      tot[`${k}Qty`] += q[k].qty ?? 0;
    }
    rows.push(row(cells));
  }
  return { rows, problems, tot };
}

// ------------------------------------------------------------------ RCD

const RCD: ReportBuilder = {
  code: 'RCD',
  params: 'DOCUMENT',
  document: { collection: 'rcdReports', numberField: 'rcdNumber', dateField: 'dateTo', labelField: 'accountableOfficerName' },
  async build(ctx) {
    const r = ctx.params.documentId ? await ctx.ds.get<RcdRecord>('rcdReports', ctx.params.documentId) : null;
    if (!r || r.barangayId !== ctx.params.barangayId) return emptyDocument('a Report of Collections and Deposits');
    const colls = await byIds<CollectionRecord>(ctx, 'collections', r.fiscalYear, r.collectionIds ?? []);
    const deps = await byIds<DepositRecord>(ctx, 'deposits', r.fiscalYear, r.depositIds ?? []);
    const remitted = colls.some((c) => c.collectingOfficerId !== r.accountableOfficerId);
    const a = await orListing(ctx, colls, { collector: remitted, title: 'A. COLLECTIONS' });

    const depRows: ReportRow[] = deps
      .sort((x, y) => x.depositDate.localeCompare(y.depositDate))
      .map((d) => row({ date: d.depositDate, ref: d.depositSlipNumber, bank: d.bankLabel, amount: d.amount, validated: d.validatedAmount }));
    const depTotal = deps.reduce((t, d) => t + d.amount, 0);
    depRows.push(row({ bank: 'TOTAL', amount: depTotal }, 'total'));
    const b = table([col('date', 'Date', 'date'), col('ref', 'Deposit Slip No.', 'code'), col('bank', 'Name of Depository Bank', 'text', { width: 3 }), col('amount', 'Amount', 'money'), col('validated', 'Validated by bank', 'money')], depRows, { title: 'B. REMITTANCES / DEPOSITS' });

    const forms = (await ctx.ds.list<AccountableFormRecord>('accountableForms', [['barangayId', '==', r.barangayId], ['accountableOfficerId', '==', r.accountableOfficerId]])).filter((f) => f.status !== 'VOID');
    const af = await afRows(ctx, forms.sort((x, y) => x.formType.localeCompare(y.formType) || x.beginningSerialNumber - y.beginningSerialNumber), { from: r.dateFrom, to: r.dateTo });

    const counted = colls.filter((c) => isCollectionCounted(c.status));
    const t = computeRcdTotals(r.undepositedBeginning ?? (0 as Centavos), counted.map((c) => c.amount), deps.map((d) => d.amount), r.differenceExplanation);
    const ors = r.orFrom ? `Collections per OR Nos. ${r.orFrom} to ${r.orTo}` : 'Collections per Official Receipts';
    const d = table([col('item', 'Particulars', 'text', { width: 4 }), col('amount', 'Amount', 'money')], [
      row({ item: 'Undeposited collections per last report', amount: t.undepositedBeginning }),
      row({ item: ors, amount: t.totalCollections }),
      row({ item: 'Total', amount: t.undepositedBeginning + t.totalCollections }, 'subtotal'),
      row({ item: 'Less: Remittance / Deposit to Cashier / Treasurer / Depository Bank', amount: t.totalDeposits }),
      row({ item: 'Balance (undeposited collections this report)', amount: t.undeposited }, 'grandtotal'),
    ], { title: 'D. SUMMARY OF COLLECTIONS AND REMITTANCES / DEPOSITS' });

    const sections: ReportSection[] = [
      { kind: 'fields', columns: 4, fields: [
        { label: 'Fund', value: r.fundId === 'GF' ? 'General Fund' : r.fundId },
        { label: 'Report No.', value: r.rcdNumber ?? '(assigned on submission)' },
        { label: 'Date', value: r.dateTo, type: 'date' },
        { label: 'Status', value: r.status },
        { label: 'Name of Accountable Officer', value: personOf(r.accountableOfficerName), span: 2 },
        { label: 'Period covered', value: `${longDate(r.dateFrom)} – ${longDate(r.dateTo)}`, span: 2 },
      ] },
      a.section,
      b,
      table(AF_COLUMNS, af.rows, { title: 'C. ACCOUNTABILITY FOR ACCOUNTABLE FORMS', emptyText: 'No accountable forms issued to this officer.' }),
      d,
    ];
    if (r.differenceExplanation && t.undeposited) sections.push({ kind: 'text', title: 'Explanation of undeposited collections', paragraphs: [r.differenceExplanation] });
    const bt = ctx.sign('Certified correct', 'BARANGAY_TREASURER', r.dateTo);
    const ma = ctx.sign('Verified', 'MUNICIPAL_ACCOUNTANT', r.dateTo);
    sections.push({
      kind: 'certifications',
      boxes: [
        { label: 'CERTIFICATION', text: 'I hereby certify that the foregoing Report of Collections and Deposits and the accompanying documents are true and correct.', name: personOf(r.accountableOfficerName).split(',')[0]!.toUpperCase() || bt.name, position: 'Accountable Officer / ' + bt.position, date: r.dateTo },
        { label: 'VERIFICATION AND ACKNOWLEDGEMENT', text: `I hereby certify that the foregoing report of collections and deposits has been verified and acknowledge receipt of ${peso(t.totalDeposits)}.`, name: ma.name, position: ma.position, date: null },
      ],
    });
    const stale = r.status !== 'DRAFT' && r.status !== 'RETURNED' && (r.totalCollections !== t.totalCollections || r.totalDeposits !== t.totalDeposits);
    return {
      subtitle: [`For the period ${longDate(r.dateFrom)} to ${longDate(r.dateTo)}`],
      meta: [{ label: 'RCD No.', value: r.rcdNumber ?? 'DRAFT' }, { label: 'Accountable officer', value: personOf(r.accountableOfficerName) }],
      sections,
      signatories: [],
      validations: [
        validation('RCD_COLLECTIONS_EQ_DEPOSITS', stale ? false : t.result === 'WARNING' ? 'WARNING' : t.result === 'PASSED', stale ? 'The listed ORs/deposits no longer match the totals recorded on the RCD.' : t.message),
        ...(af.problems.length ? [validation('AF_NO_GAPS', false, af.problems.join(' · '))] : []),
      ],
      isEmpty: counted.length === 0 && deps.length === 0,
    };
  },
};

// ------------------------------------------------------------------ RCR

const RCR: ReportBuilder = {
  code: 'RCR',
  params: 'DOCUMENT',
  document: { collection: 'rcrReports', numberField: 'rcrNumber', dateField: 'remittanceDate', labelField: 'collectorName' },
  async build(ctx) {
    const r = ctx.params.documentId ? await ctx.ds.get<RcrDoc>('rcrReports', ctx.params.documentId) : null;
    if (!r || r.barangayId !== ctx.params.barangayId) return emptyDocument('a Report of Collections and Remittances');
    const colls = await byIds<CollectionRecord>(ctx, 'collections', r.fiscalYear, r.collectionIds ?? []);
    const a = await orListing(ctx, colls, { title: 'A. COLLECTIONS' });
    const total = colls.filter((c) => isCollectionCounted(c.status)).reduce((s, c) => s + c.amount, 0);
    const bt = ctx.sign('Received by', 'BARANGAY_TREASURER', r.remittanceDate);
    return {
      subtitle: [`For the period ${longDate(r.dateFrom)} to ${longDate(r.dateTo)}`],
      meta: [{ label: 'RCR No.', value: r.rcrNumber ?? 'DRAFT' }, { label: 'Collector', value: personOf(r.collectorName) }],
      sections: [
        { kind: 'fields', columns: 4, fields: [
          { label: 'Fund', value: r.fundId === 'GF' ? 'General Fund' : r.fundId },
          { label: 'Report No.', value: r.rcrNumber ?? '(assigned on submission)' },
          { label: 'Date of remittance', value: r.remittanceDate, type: 'date' },
          { label: 'Status', value: r.status },
          { label: 'Name of Collector', value: personOf(r.collectorName), span: 2 },
          { label: 'Remitted to', value: personOf(r.receivingOfficerName), span: 2 },
        ] },
        a.section,
        table([col('item', 'Particulars', 'text', { width: 4 }), col('amount', 'Amount', 'money')], [
          row({ item: r.orFrom ? `Collections per OR Nos. ${r.orFrom} to ${r.orTo}` : 'Collections', amount: total }),
          row({ item: `Remitted to the Barangay Treasurer on ${longDate(r.remittanceDate)}`, amount: r.amountRemitted }),
          row({ item: 'Balance (unremitted)', amount: total - r.amountRemitted }, 'grandtotal'),
        ], { title: 'B. SUMMARY OF COLLECTIONS AND REMITTANCES' }),
        {
          kind: 'certifications',
          boxes: [
            { label: 'CERTIFICATION', text: `I hereby certify that the foregoing is a correct statement of my collections and that I have remitted ${peso(r.amountRemitted)} to the Barangay Treasurer.`, name: personOf(r.collectorName).split(',')[0]!.toUpperCase(), position: 'Collector', date: r.remittanceDate },
            { label: 'ACKNOWLEDGEMENT', text: `Received the amount of ${peso(r.amountRemitted)} covered by the official receipts listed above.`, name: bt.name, position: bt.position, date: r.status === 'ACCEPTED' ? r.remittanceDate : null },
          ],
        },
      ],
      signatories: [],
      validations: [],
      isEmpty: total === 0,
    };
  },
};

// ------------------------------------------------------------------ Cashbook

const LIVE_DV = ['APPROVED', 'ACCEPTED', 'POSTED'];
const LIVE_CHECK = ['ISSUED', 'RELEASED', 'CLEARED', 'OUTSTANDING', 'STALE'];

/**
 * Cashbook (MFMB Cash Book), rows derived from authorized transactions only:
 *  - Cash in Local Treasury: receipts = ORs issued (not VOID/CANCELLED); payments = deposits + cash DVs.
 *  - Cash in Bank: receipts = deposits (+ credit memos booked); payments = checks issued, ADA DVs (+ debit memos).
 * Beginning balance = opening balance (period 00 of the GL) + prior months' activity of the fiscal year.
 */
const CASHBOOK: ReportBuilder = {
  code: 'CASHBOOK',
  params: 'MONTH',
  extras: [
    { key: 'variant', label: 'Cashbook', kind: 'select', options: CASHBOOK_VARIANTS.map((v) => ({ value: v.value, label: v.label })), required: true },
    { key: 'bankAccountId', label: 'Bank account (Cash in Bank)', kind: 'bankAccount' },
  ],
  async build(ctx) {
    const bank = ctx.params.variant === 'CASH_IN_BANK';
    const yearStart = `${ctx.params.fiscalYear}-01-01`;
    const scope = ctx.scope();
    const ytd = (d: string | null | undefined) => !!d && d >= yearStart && d <= ctx.range.to;
    const lines: CashbookSourceLine[] = [];
    const bankId = bank ? ctx.params.bankAccountId || null : null;
    const bankAcct = bankId ? await ctx.ds.get<BankAccountDoc>('bankAccounts', bankId) : null;
    const deposits = (await ctx.ds.list<DepositRecord>('deposits', scope)).filter((d) => d.status !== 'VOID' && ytd(d.depositDate) && (!bankId || d.bankAccountId === bankId));
    const dvs = (await ctx.ds.list<DisbursementVoucherDoc & { bankAccountId?: string | null }>('disbursementVouchers', scope)).filter((v) => LIVE_DV.includes(v.status) && ytd(v.dvDate));

    if (!bank) {
      for (const c of (await ctx.ds.list<CollectionRecord>('collections', scope)).filter((c) => isCollectionCounted(c.status) && ytd(c.collectionDate)))
        lines.push({ date: c.collectionDate, sortKey: `1|${c.officialReceiptNumber}`, reference: `OR ${c.officialReceiptNumber}`, particulars: `${c.payor.name} — ${[...new Set(c.lines.map((l) => l.natureOfCollection))].join('; ')}`, receipt: c.amount, payment: 0 as Centavos });
      for (const d of deposits) lines.push({ date: d.depositDate, sortKey: `2|${d.depositSlipNumber}`, reference: `DS ${d.depositSlipNumber}`, particulars: `Deposit to ${d.bankLabel}`, receipt: 0 as Centavos, payment: d.amount });
      for (const v of dvs.filter((x) => x.paymentMethod === 'CASH'))
        lines.push({ date: v.dvDate, sortKey: `3|${v.dvNumber ?? ''}`, reference: `DV ${v.dvNumber ?? ''}`, particulars: `${v.payee.name} — ${v.particulars}`, receipt: 0 as Centavos, payment: v.netAmount });
    } else {
      for (const d of deposits) lines.push({ date: d.depositDate, sortKey: `1|${d.depositSlipNumber}`, reference: `DS ${d.depositSlipNumber}`, particulars: `Deposit of collections${d.bankLabel ? ` — ${d.bankLabel}` : ''}`, receipt: d.amount, payment: 0 as Centavos });
      for (const c of (await ctx.ds.list<CheckDoc>('checks', scope)).filter((k) => LIVE_CHECK.includes(k.status) && ytd(k.checkDate) && (!bankId || k.bankAccountId === bankId)))
        lines.push({ date: c.checkDate, sortKey: `2|${c.checkNumber}`, reference: `Check ${c.checkNumber}`, particulars: c.payee.name, receipt: 0 as Centavos, payment: c.amount });
      for (const v of dvs.filter((x) => x.paymentMethod === 'ADA' && (!bankId || !x.bankAccountId || x.bankAccountId === bankId)))
        lines.push({ date: v.dvDate, sortKey: `3|${v.dvNumber ?? ''}`, reference: `ADA / DV ${v.dvNumber ?? ''}`, particulars: `${v.payee.name} — ${v.particulars}`, receipt: 0 as Centavos, payment: v.netAmount });
      for (const m of (await ctx.ds.list<BankMemoDoc>('bankMemos', scope)).filter((x) => !!x.jevId && ytd(x.memoDate) && (!bankId || x.bankAccountId === bankId)))
        lines.push({ date: m.memoDate, sortKey: `4|${m.memoNumber}`, reference: `${m.memoType === 'CREDIT' ? 'CM' : 'DM'} ${m.memoNumber}`, particulars: m.particulars, receipt: (m.memoType === 'CREDIT' ? m.amount : 0) as Centavos, payment: (m.memoType === 'DEBIT' ? m.amount : 0) as Centavos });
    }
    // Opening balance booked in period 00 (OPENING entries) of the cash account.
    const account = bank ? CASHBOOK_ACCOUNTS.CASH_IN_BANK : CASHBOOK_ACCOUNTS.CASH_IN_TREASURY;
    const opening = (await ctx.ds.list<AccountBalanceDoc>('accountBalances', [...scope, ['month', '==', 0]]))
      .filter((b) => b.accountCode === account && (bankAcct ? b.subsidiaryId === bankAcct.subsidiaryId : b.subsidiaryId === null))
      .reduce((t, b) => t + b.debit - b.credit, 0);
    const prior = lines.filter((l) => l.date < ctx.range.from);
    const beginning = (opening + prior.reduce((t, l) => t + l.receipt - l.payment, 0)) as Centavos;
    const cb = buildCashbook(beginning, lines.filter((l) => l.date >= ctx.range.from));

    const [rLabel, pLabel] = bank ? ['Deposits', 'Checks Issued / ADA'] : ['Collections', 'Deposits / Disbursements'];
    const rows: ReportRow[] = [
      row({ date: ctx.range.from, particulars: 'Balance brought forward', balance: cb.beginningBalance }, 'subheading'),
      ...cb.rows.map((r) => row({ date: r.date, reference: r.reference, particulars: r.particulars, receipt: r.receipt || null, payment: r.payment || null, balance: r.balance })),
      row({ particulars: 'Totals / balance end of month', receipt: cb.totalReceipts, payment: cb.totalPayments, balance: cb.endingBalance }, 'grandtotal'),
    ];
    const variantLabel = CASHBOOK_VARIANTS.find((v) => v.value === (bank ? 'CASH_IN_BANK' : 'CASH_IN_TREASURY'))!.label.replace(/ \(.*\)$/, '');
    const neg = cb.negativeBalanceDates;
    return {
      title: `Cashbook — ${variantLabel}`,
      subtitle: [ctx.range.label],
      meta: [
        { label: 'Fund', value: 'General Fund' },
        { label: 'Account', value: `${account} ${bank ? 'Cash in Bank - Local Currency, Current Account' : 'Cash - In Local Treasury'}` },
        ...(bank ? [{ label: 'Bank account', value: bankAcct ? `${bankAcct.bankName} ••••${bankAcct.accountNumber.slice(-4)}` : 'All bank accounts' }] : []),
      ],
      sections: [table([col('date', 'Date', 'date'), col('reference', 'Reference', 'code'), col('particulars', 'Particulars', 'text', { width: 4 }), col('receipt', rLabel, 'money'), col('payment', pLabel, 'money'), col('balance', 'Balance', 'money')], rows)],
      signatories: [ctx.sign('Certified correct', 'BARANGAY_TREASURER')],
      validations: [
        validation('CASHBOOK_ROLLFORWARD', !cb.valid ? false : neg.length ? 'WARNING' : true, !cb.valid ? 'Running balance does not equal beginning + receipts − payments.' : neg.length ? `Beginning + receipts − payments = ending, but the balance is negative on ${[...new Set(neg)].join(', ')}.` : `Beginning ${peso(cb.beginningBalance)} + receipts ${peso(cb.totalReceipts)} − payments ${peso(cb.totalPayments)} = ending ${peso(cb.endingBalance)}.`),
      ],
      isEmpty: lines.length === 0 && opening === 0,
    };
  },
};

// ------------------------------------------------------------------ RAAF

/** Report of Accountability for Accountable Forms — per officer and series, with serial ranges. */
const RAAF: ReportBuilder = {
  code: 'RAAF',
  params: 'MONTH',
  async build(ctx) {
    const forms = (await ctx.ds.list<AccountableFormRecord>('accountableForms', [['barangayId', '==', ctx.params.barangayId]]))
      .filter((f) => f.status !== 'VOID' && f.status !== 'DRAFT' && (f.dateIssued ?? f.dateReceived) <= ctx.range.to)
      .sort((a, b) => (a.accountableOfficerName ?? '').localeCompare(b.accountableOfficerName ?? '') || a.formType.localeCompare(b.formType) || a.beginningSerialNumber - b.beginningSerialNumber);
    const stock = (await ctx.ds.list<AccountableFormRecord>('accountableForms', [['barangayId', '==', ctx.params.barangayId]])).filter((f) => f.status === 'DRAFT' && f.dateReceived <= ctx.range.to);
    const rows: ReportRow[] = [];
    const problems: string[] = [];
    const grand = { begQty: 0, recQty: 0, issQty: 0, endQty: 0 };
    const officers = [...new Set(forms.map((f) => f.accountableOfficerId))];
    for (const o of officers) {
      const mine = forms.filter((f) => f.accountableOfficerId === o);
      const r = await afRows(ctx, mine, ctx.range);
      problems.push(...r.problems);
      if (!r.rows.length) continue;
      rows.push(row({ form: personOf(mine[0]!.accountableOfficerName) || o }, 'heading'));
      rows.push(...r.rows);
      rows.push(row({ form: 'Sub-total', begQty: r.tot.begQty, recQty: r.tot.recQty, issQty: r.tot.issQty, endQty: r.tot.endQty }, 'subtotal'));
      for (const k of Object.keys(grand) as Array<keyof typeof grand>) grand[k] += r.tot[k];
    }
    if (stock.length) {
      rows.push(row({ form: 'Unissued stock (not yet issued to an accountable officer)' }, 'heading'));
      for (const f of stock) {
        const s = fmtQ({ qty: f.quantityReceived, from: f.beginningSerialNumber, to: f.endingSerialNumber }, f.serialWidth);
        rows.push(row({ form: `${shortForm(f.formType)} · ${f.series}`, endQty: s.qty, endFrom: s.from, endTo: s.to }));
      }
    }
    rows.push(row({ form: 'GRAND TOTAL', ...grand }, 'grandtotal'));
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Forms', value: [...new Set(forms.map((f) => afFormLabel(f.formType)))].join(', ') || '—' }],
      sections: [table(AF_COLUMNS, rows, { emptyText: 'No accountable forms.' })],
      signatories: [ctx.sign('Certified correct', 'BARANGAY_TREASURER'), ctx.sign('Verified', 'MUNICIPAL_ACCOUNTANT')],
      validations: [validation('AF_NO_GAPS', problems.length === 0, problems.length ? problems.join(' · ') : 'Every serial issued is accounted for: no missing, duplicate or out-of-series numbers.')],
      isEmpty: forms.length === 0 && stock.length === 0,
    };
  },
};

/** Phase 4 — collections, deposits, RCD/RCR, accountable forms: report builders. */
export const COLLECTIONS_REPORTS: ReportBuilder[] = [RCD, RCR, CASHBOOK, RAAF];
