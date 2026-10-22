import { formatPesos } from '../../accounting/money';
import { manilaToday } from '../../accounting/periods';
import { DV_ACCT, dvJournalLines, payrollDeductionColumns, type DvJournalLine } from '../../accounting/disbursements';
import { DV_CATEGORIES, DV_PAYMENT_METHODS, PAYROLL_PAYMENT_METHODS, PAYROLL_TYPES, type CheckRecord, type DvRecord, type PayrollRecord } from '../../modules/disbursements';
import type { JournalLineDoc } from '../../types/accounting';
import type { BankAccountDoc } from '../../types/bank';
import type { ObligationDoc } from '../../types/budget';
import type { Ts } from '../../types/common';
import type { ReportBody, ReportBuilder, ReportContext } from '../context';
import type { WithId } from '../datasource';
import { inRange } from '../helpers';
import { col, longDate, row, table, type ReportRow, type ReportSection } from '../model';

/** Phase 5 — DV and Payroll forms (MFMB), Report of Checks Issued, Cancelled Checks. */

const tsDate = (t: Ts | null | undefined): string | null => (t && typeof t.seconds === 'number' ? manilaToday(new Date(t.seconds * 1000)) : null);
const peso = (v: number) => formatPesos(v, { symbol: true });
const mask = (n: string | undefined) => (!n ? '' : n.length <= 4 ? n : `••••${n.slice(-4)}`);
const bankLabel = (b: BankAccountDoc | undefined) => (b ? `${b.bankName}${b.branch ? ` (${b.branch})` : ''} — Acct. No. ${b.accountNumber}` : 'Unknown bank account');

/** A FORM report for a missing / foreign document renders an explanatory empty model. */
function notFound(what: string): ReportBody {
  return { subtitle: [], meta: [], sections: [{ kind: 'text', paragraphs: [`Select a ${what} of this barangay and fiscal year.`] }], signatories: [], validations: [], isEmpty: true };
}

async function loadDoc<T>(ctx: ReportContext, collection: string): Promise<WithId<T & { barangayId: string }> | null> {
  if (!ctx.params.documentId) return null;
  const d = await ctx.ds.get<T & { barangayId: string }>(collection, ctx.params.documentId);
  return d && d.barangayId === ctx.params.barangayId ? d : null;
}

// ------------------------------------------------------------------ DV
const DV: ReportBuilder = {
  code: 'DV',
  params: 'DOCUMENT',
  document: { collection: 'disbursementVouchers', numberField: 'dvNumber', dateField: 'dvDate', labelField: 'payee' },
  async build(ctx) {
    const dv = await loadDoc<DvRecord>(ctx, 'disbursementVouchers');
    if (!dv) return notFound('disbursement voucher');
    const accounts = await ctx.accounts();
    const sls = await ctx.subsidiaries();
    const obr = dv.obligationId ? await ctx.ds.get<ObligationDoc>('obligations', dv.obligationId) : null;
    const bank = dv.bankAccountId ? await ctx.ds.get<BankAccountDoc>('bankAccounts', dv.bankAccountId) : null;
    const asOf = dv.dvDate;
    const pb = ctx.sign('Punong Barangay', 'PUNONG_BARANGAY', asOf);
    const ac = ctx.sign('Committee on Appropriations', 'APPROPRIATIONS_CHAIR', asOf);
    const bt = ctx.sign('Barangay Treasurer', 'BARANGAY_TREASURER', asOf);
    const method = DV_PAYMENT_METHODS.find((m) => m.value === dv.paymentMethod)?.label ?? dv.paymentMethod;

    const header: ReportSection = {
      kind: 'fields',
      columns: 4,
      fields: [
        { label: 'Fund', value: dv.fundId === 'GF' ? 'General Fund' : dv.fundId },
        { label: 'DV No.', value: dv.dvNumber ?? '(assigned on approval)' },
        { label: 'Date', value: longDate(dv.dvDate) },
        { label: 'OBR No.', value: dv.obligationNumber ?? '' },
        { label: 'Payee', value: dv.payee?.name ?? '', span: 2 },
        { label: 'TIN / Employee No.', value: dv.payee?.tin ?? '' },
        { label: 'Mode of payment', value: method },
        { label: 'Address', value: dv.payee?.address ?? '', span: 2 },
        { label: 'Nature of disbursement', value: DV_CATEGORIES.find((c) => c.value === dv.dvCategory)?.label ?? dv.dvCategory, span: 2 },
      ],
    };

    // Particulars / amount block: gross, less taxes and deductions, amount due.
    const prow: ReportRow[] = [row({ expl: dv.particulars, amount: dv.grossAmount })];
    if (dv.cashAdvance) prow.push(row({ expl: `Cash advance of ${dv.cashAdvance.accountableOfficerName} — ${dv.cashAdvance.purpose}` }, 'note'));
    for (const t of dv.taxDeductions ?? []) prow.push(row({ expl: `Less: ${t.taxType} ${(t.rateBp / 100).toFixed(2)}%${t.base !== undefined && t.base !== dv.grossAmount ? ` of ${peso(t.base)}` : ''}`, amount: -t.amount }, 'normal', 1));
    for (const d of dv.otherDeductions ?? []) prow.push(row({ expl: `Less: ${d.description}`, amount: -d.amount }, 'normal', 1));
    prow.push(row({ expl: 'Amount due', amount: dv.netAmount }, 'grandtotal'));
    const particulars = table([col('expl', 'Explanation', 'text', { width: 4 }), col('amount', 'Amount', 'money')], prow, { title: 'Particulars' });

    const boxes = {
      kind: 'certifications' as const,
      boxes: [
        { label: 'A. Certified', text: 'Expenses / cash advance necessary, lawful and incurred under my direct supervision.', name: pb.name, position: pb.position, date: dv.dvDate },
        { label: 'B. Certified', text: `Existence of available appropriation${dv.obligationNumber ? ` (OBR No. ${dv.obligationNumber})` : ''}.`, name: ac.name, position: ac.position, date: tsDate((obr as (ObligationDoc & { certifiedAt?: Ts }) | null)?.certifiedAt) },
        { label: 'C. Certified', text: `Supporting documents complete and proper, and cash available in the amount of ${peso(dv.netAmount)}.`, name: bt.name, position: bt.position, date: tsDate(dv.submittedAt) },
        { label: 'D. Approved for payment', text: dv.dvNumber ? `DV No. ${dv.dvNumber}` : '', name: pb.name, position: pb.position, date: tsDate(dv.approvedAt) },
        {
          label: 'E. Received payment',
          text: [dv.checkNumber ? `Check No. ${dv.checkNumber} dated ${dv.checkDate}` : dv.adaNumber ? `ADA No. ${dv.adaNumber}` : dv.paymentMethod === 'CASH' ? 'Cash' : '', bank ? `${bank.bankName} ${mask(bank.accountNumber)}` : ''].filter(Boolean).join(' · ') || 'Check / ADA No. ______  Bank ______  OR / other document ______',
          name: dv.payee?.name ?? '',
          position: 'Payee',
          date: dv.releasedDate,
        },
      ],
    };

    // Accounting entries: the generated JEV when there is one (accounting may have reclassified), else the template.
    let lines: Array<Pick<DvJournalLine, 'accountCode' | 'subsidiaryId' | 'debit' | 'credit'>> = [];
    let jevNumber: string | null = dv.jevNumber ?? null;
    if (dv.jevId) {
      lines = (await ctx.ds.listSub<JournalLineDoc>('journalEntries', dv.jevId, 'lines')).sort((a, b) => a.lineNo - b.lineNo);
      jevNumber = jevNumber ?? lines.map((l) => (l as JournalLineDoc).jevNumber).find(Boolean) ?? null;
    } else {
      try {
        const cash = dv.paymentMethod === 'CASH' ? { accountCode: DV_ACCT.CASH_LOCAL_TREASURY, subsidiaryId: dv.cashOfficerId } : { accountCode: DV_ACCT.CASH_IN_BANK, subsidiaryId: bank?.subsidiaryId ?? null };
        lines = dvJournalLines(dv, cash);
      } catch {
        lines = [];
      }
    }
    const erows = lines.map((l) => {
      const sl = l.subsidiaryId ? sls.get(l.subsidiaryId) : undefined;
      return row({ title: `${accounts.get(l.accountCode)?.accountName ?? l.accountCode}${sl ? ` — ${sl.subsidiaryCode}` : ''}`, code: l.accountCode, debit: l.debit || null, credit: l.credit || null }, 'normal', l.credit ? 1 : 0);
    });
    erows.push(row({ title: 'Total', debit: lines.reduce((t, l) => t + l.debit, 0), credit: lines.reduce((t, l) => t + l.credit, 0) }, 'total'));
    const entries = table([col('title', 'Account title', 'text', { width: 3 }), col('code', 'Account code', 'code'), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money')], erows, {
      title: `Accounting entries${jevNumber ? ` — JEV No. ${jevNumber}` : dv.jevId ? ' — JEV (for posting)' : ' (proposed)'}`,
    });

    const payment: ReportSection = {
      kind: 'fields',
      title: 'Payment',
      columns: 4,
      fields: [
        { label: 'Check / ADA No.', value: dv.checkNumber ?? dv.adaNumber ?? '' },
        { label: 'Date', value: dv.checkDate ?? dv.paymentDate ?? '' },
        { label: 'Bank', value: bank ? `${bank.bankName} ${mask(bank.accountNumber)}` : '' },
        { label: 'Released', value: dv.releasedDate ?? '' },
        { label: 'JEV No.', value: jevNumber ?? '' },
        { label: 'Status', value: dv.status },
        ...(dv.cancelledPayments?.length ? [{ label: 'Cancelled checks / ADA', value: dv.cancelledPayments.map((c) => `${c.number} (${c.status.toLowerCase()} ${c.date})`).join('; '), span: 2 as const }] : []),
      ],
    };

    return {
      subtitle: [`DV No. ${dv.dvNumber ?? '(unnumbered draft)'}`],
      meta: [{ label: 'Status', value: dv.status }],
      sections: [header, particulars, boxes, payment, entries],
      signatories: [],
      validations: [],
      isEmpty: false,
      notes: dv.status === 'VOID' ? [`VOID — ${dv.voidReason ?? ''}`] : undefined,
    };
  },
};

// ------------------------------------------------------------------ PAYROLL
const PAYROLL: ReportBuilder = {
  code: 'PAYROLL',
  params: 'DOCUMENT',
  document: { collection: 'payrolls', numberField: 'payrollNumber', dateField: 'payrollDate', labelField: 'particulars' },
  async build(ctx) {
    const p = await loadDoc<PayrollRecord>(ctx, 'payrolls');
    if (!p) return notFound('payroll');
    const accounts = await ctx.accounts();
    const asOf = p.payrollDate;
    const pb = ctx.sign('Punong Barangay', 'PUNONG_BARANGAY', asOf);
    const bt = ctx.sign('Barangay Treasurer', 'BARANGAY_TREASURER', asOf);
    const dedCols = payrollDeductionColumns(p.entries ?? []);
    const columns = [
      col('no', 'No.', 'number', { width: 1 }),
      col('name', 'Name', 'text', { width: 3 }),
      col('position', 'Designation', 'text', { width: 2 }),
      col('gross', 'Gross amount', 'money'),
      ...dedCols.map((d, i) => col(`d${i}`, d.description, 'money', { group: 'Deductions' })),
      ...(dedCols.length ? [col('ded', 'Total deductions', 'money', { group: 'Deductions' })] : []),
      col('net', 'Net amount due', 'money'),
      col('sig', 'Signature of payee', 'text', { width: 2 }),
    ];
    const totals: Record<string, number> = { gross: 0, ded: 0, net: 0 };
    const rows: ReportRow[] = (p.entries ?? []).map((e, i) => {
      const cells: Record<string, string | number | null> = { no: i + 1, name: e.payeeName, position: e.position, gross: e.grossAmount, net: e.netAmount, sig: e.signed ? 'Signed' : '' };
      let ded = 0;
      dedCols.forEach((c, j) => {
        const v = e.deductions.filter((d) => d.accountCode === c.accountCode && d.description === c.description).reduce((t, d) => t + d.amount, 0);
        cells[`d${j}`] = v || null;
        totals[`d${j}`] = (totals[`d${j}`] ?? 0) + v;
        ded += v;
      });
      if (dedCols.length) cells.ded = ded || null;
      totals.gross! += e.grossAmount;
      totals.ded! += ded;
      totals.net! += e.netAmount;
      return row(cells);
    });
    rows.push(row({ name: 'TOTAL', ...totals }, 'grandtotal'));
    const pm = PAYROLL_PAYMENT_METHODS.find((m) => m.value === p.paymentMethod)?.label ?? p.paymentMethod;
    const payer = p.paymentMethod === 'CASH_ADVANCE' && p.disbursingOfficerName ? { name: p.disbursingOfficerName, position: 'Disbursing Officer' } : bt;
    return {
      subtitle: [`For the period ${longDate(p.payPeriodFrom)} to ${longDate(p.payPeriodTo)}`],
      meta: [
        { label: 'Payroll No.', value: p.payrollNumber ?? '(assigned on approval)' },
        { label: 'Fund', value: p.fundId === 'GF' ? 'General Fund' : p.fundId },
      ],
      sections: [
        {
          kind: 'fields',
          columns: 4,
          fields: [
            { label: 'Type', value: PAYROLL_TYPES.find((t) => t.value === p.payrollType)?.label ?? p.payrollType },
            { label: 'Account charged', value: `${p.expenseAccountCode} ${accounts.get(p.expenseAccountCode)?.accountName ?? ''}`.trim(), span: 2 },
            { label: 'OBR No.', value: p.obligationNumber ?? '' },
            { label: 'Mode of payment', value: pm },
            { label: 'DV No.', value: p.dvNumber ?? '' },
            { label: 'Particulars', value: p.particulars ?? '', span: 2 },
          ],
        },
        { kind: 'text', paragraphs: ['We acknowledge receipt of cash shown opposite our names as full compensation for services rendered for the period covered.'] },
        table(columns, rows),
        {
          kind: 'certifications',
          boxes: [
            { label: 'A. Certified', text: 'Services duly rendered as stated.', name: pb.name, position: pb.position },
            { label: 'B. Certified', text: `Supporting documents complete and proper; cash available in the amount of ${peso(p.netAmount)}.`, name: bt.name, position: bt.position },
            { label: 'C. Approved for payment', text: p.payrollNumber ? `Payroll No. ${p.payrollNumber}` : '', name: pb.name, position: pb.position, date: tsDate(p.approvedAt) },
            { label: 'D. Certified', text: `Each person whose name appears on this payroll has been paid the amount stated opposite his/her name (${(p.entries ?? []).filter((e) => e.signed).length} of ${p.entryCount} signed).`, name: payer.name, position: payer.position },
          ],
        },
      ],
      signatories: [],
      validations: [],
      isEmpty: false,
      notes: p.status === 'VOID' ? [`VOID — ${p.voidReason ?? ''}`] : undefined,
    };
  },
};

// ------------------------------------------------------------------ checks
const byCheckNo = (a: CheckRecord, b: CheckRecord) => a.checkNumber.padStart(20, '0').localeCompare(b.checkNumber.padStart(20, '0')) || a.checkDate.localeCompare(b.checkDate);
const DEAD = ['CANCELLED', 'VOID'];

/** Report of Checks Issued — every check number issued in the month, per bank account (cancelled ones listed at zero). */
const CHECKS_ISSUED: ReportBuilder = {
  code: 'CHECKS_ISSUED',
  params: 'MONTH',
  extras: [{ key: 'bankAccountId', label: 'Bank account', kind: 'bankAccount' }],
  async build(ctx) {
    const banks = new Map((await ctx.ds.list<BankAccountDoc>('bankAccounts', [['barangayId', '==', ctx.params.barangayId]])).map((b) => [b.id, b]));
    const checks = (await ctx.ds.list<CheckRecord>('checks', ctx.scope())).filter((c) => inRange(c.checkDate, ctx.range) && (!ctx.params.bankAccountId || c.bankAccountId === ctx.params.bankAccountId));
    const columns = [
      col('date', 'Date', 'date'),
      col('checkNo', 'Check No.', 'code'),
      col('dvNo', 'DV / Payroll No.', 'code'),
      col('payee', 'Payee', 'text', { width: 3 }),
      col('nature', 'Nature of payment', 'text', { width: 3 }),
      col('amount', 'Amount', 'money'),
    ];
    const bankIds = [...new Set(checks.map((c) => c.bankAccountId))].sort((a, b) => bankLabel(banks.get(a)).localeCompare(bankLabel(banks.get(b))));
    const sections: ReportSection[] = [];
    let grand = 0;
    for (const id of bankIds) {
      const list = checks.filter((c) => c.bankAccountId === id).sort(byCheckNo);
      const rows = list.map((c) =>
        DEAD.includes(c.status)
          ? row({ date: c.checkDate, checkNo: c.checkNumber, dvNo: c.dvNumber, payee: c.payee?.name ?? '', nature: `${c.status} — ${c.cancelReason ?? ''}`.trim(), amount: null }, 'note')
          : row({ date: c.checkDate, checkNo: c.checkNumber, dvNo: c.dvNumber, payee: c.payee?.name ?? '', nature: c.natureOfPayment ?? '', amount: c.amount }),
      );
      const total = list.filter((c) => !DEAD.includes(c.status)).reduce((t, c) => t + c.amount, 0);
      grand += total;
      rows.push(row({ payee: `Total — ${list.length} check(s), ${list.filter((c) => DEAD.includes(c.status)).length} cancelled`, amount: total }, 'total'));
      sections.push(table(columns, rows, { title: bankLabel(banks.get(id)) }));
    }
    if (!sections.length) sections.push(table(columns, [], { emptyText: 'No checks were issued this month.' }));
    else if (bankIds.length > 1) sections.push(table(columns, [row({ payee: 'GRAND TOTAL', amount: grand }, 'grandtotal')]));
    const bt = ctx.sign('Certified correct', 'BARANGAY_TREASURER');
    sections.push({
      kind: 'text',
      paragraphs: [`I hereby certify that this Report of Checks Issued is a full, true and correct statement of all checks issued by me during the period stated above, totalling ${peso(grand)}.`],
    });
    const only = ctx.params.bankAccountId ? banks.get(ctx.params.bankAccountId) : undefined;
    return {
      subtitle: [ctx.range.label],
      meta: [
        { label: 'Fund', value: 'General Fund' },
        { label: 'Bank account', value: only ? bankLabel(only) : 'All bank accounts' },
        { label: 'Accountable officer', value: [bt.name, bt.position].filter(Boolean).join(', ') },
      ],
      sections,
      signatories: [bt],
      validations: [],
      isEmpty: checks.length === 0,
    };
  },
};

/** Cancelled Checks — checks cancelled or voided in the month (numbers retained, never reused). */
const CANCELLED_CHECKS: ReportBuilder = {
  code: 'CANCELLED_CHECKS',
  params: 'MONTH',
  extras: [{ key: 'bankAccountId', label: 'Bank account', kind: 'bankAccount' }],
  async build(ctx) {
    const banks = new Map((await ctx.ds.list<BankAccountDoc>('bankAccounts', [['barangayId', '==', ctx.params.barangayId]])).map((b) => [b.id, b]));
    // Barangay-wide read: a check dated last year may be cancelled this month.
    const list = (await ctx.ds.list<CheckRecord>('checks', [['barangayId', '==', ctx.params.barangayId]]))
      .filter((c) => DEAD.includes(c.status) && inRange(c.cancelledDate ?? c.checkDate, ctx.range) && (!ctx.params.bankAccountId || c.bankAccountId === ctx.params.bankAccountId))
      .sort((a, b) => (a.cancelledDate ?? a.checkDate).localeCompare(b.cancelledDate ?? b.checkDate) || byCheckNo(a, b));
    const rows = list.map((c) =>
      row({ cancelled: c.cancelledDate ?? c.checkDate, date: c.checkDate, checkNo: c.checkNumber, bank: `${banks.get(c.bankAccountId)?.bankName ?? ''} ${mask(banks.get(c.bankAccountId)?.accountNumber)}`.trim(), dvNo: c.dvNumber, payee: c.payee?.name ?? '', amount: c.amount, reason: `${c.status === 'VOID' ? 'Void' : 'Cancelled'}: ${c.cancelReason ?? ''}` }),
    );
    if (rows.length) rows.push(row({ payee: `Total — ${list.length} check(s)`, amount: list.reduce((t, c) => t + c.amount, 0) }, 'total'));
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund', value: 'General Fund' }],
      sections: [
        table(
          [
            col('cancelled', 'Date cancelled', 'date'),
            col('date', 'Check date', 'date'),
            col('checkNo', 'Check No.', 'code'),
            col('bank', 'Bank / account', 'text', { width: 2 }),
            col('dvNo', 'DV No.', 'code'),
            col('payee', 'Payee', 'text', { width: 2 }),
            col('amount', 'Amount', 'money'),
            col('reason', 'Reason', 'text', { width: 3 }),
          ],
          rows,
          { emptyText: 'No checks were cancelled this month.' },
        ),
      ],
      signatories: [ctx.sign('Certified correct', 'BARANGAY_TREASURER')],
      validations: [],
      isEmpty: list.length === 0,
    };
  },
};

export const DISBURSEMENTS_REPORTS: ReportBuilder[] = [DV, PAYROLL, CHECKS_ISSUED, CANCELLED_CHECKS];
