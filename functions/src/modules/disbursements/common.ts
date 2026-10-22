import {
  BfmsError,
  COL,
  DV_ACCT,
  DV_CASH_ADVANCE_ACCOUNTS,
  assertPeriodAllowsEncoding,
  computeDvTotals,
  dvRequiresObligation,
  periodDocId,
  periodOfDate,
  type BarangayId,
  type DvCancelledPayment,
  type DvRecord,
  type IsoDate,
  type PeriodStatus,
} from '@bfms/shared';
import type { DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../../lib/admin';
import type { SourceRecord, WriteArgs } from '../../sources/engine';

/** Server-side helpers shared by the DV/payroll source modules and the Phase 5 callables. */

export const centavos = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const accountCode = z.string().regex(/^\d-\d{2}-\d{2}-\d{3}$/);
const slId = z.string().max(200).nullable().default(null);
const party = z.object({ id: z.string().max(128).nullable().default(null), name: z.string().trim().min(2).max(160), address: z.string().max(240).optional(), tin: z.string().max(30).optional() });

export const dvSchema = z.object({
  dvDate: isoDate,
  dvCategory: z.enum(['REGULAR', 'CASH_ADVANCE', 'PAYROLL', 'REIMBURSEMENT', 'REMITTANCE', 'TRANSFER', 'OTHER']),
  payee: party,
  particulars: z.string().trim().min(3).max(2000),
  fundId: z.string().min(1).max(60).default('GF'),
  officeId: z.string().max(128).nullable().default(null),
  fppId: z.string().max(128).nullable().default(null),
  obligationId: z.string().max(128).nullable().default(null),
  charges: z.array(z.object({ accountCode, subsidiaryId: slId, amount: centavos })).min(1, 'Enter at least one charge.').max(30),
  taxDeductions: z.array(z.object({ taxType: z.enum(['EWT', 'VAT', 'PT', 'DST', 'OTHER']), rateBp: z.number().int().min(1).max(10000), base: centavos.nullable().optional() })).max(6).default([]),
  otherDeductions: z.array(z.object({ description: z.string().trim().min(2).max(120), accountCode, subsidiaryId: slId, amount: centavos })).max(20).default([]),
  paymentMethod: z.enum(['CHECK', 'ADA', 'CASH']),
  /** CASH: SL under 1-01-01-010 (BT##) paying out. */
  cashOfficerId: slId,
  /** Preferred bank account for CHECK/ADA (the actual one is fixed when the check/ADA is issued). */
  bankAccountId: z.string().max(128).nullable().default(null),
  cashAdvance: z
    .object({
      accountableOfficerId: z.string().min(1).max(200),
      cashAdvanceType: z.enum(['PAYROLL', 'OFFICIAL_TRAVEL', 'SPECIAL_PURPOSE', 'PETTY_CASH', 'OTHER_AUTHORIZED']),
      purpose: z.string().trim().min(3).max(500),
    })
    .nullable()
    .default(null),
  supportingDocumentIds: z.array(z.string().max(128)).max(50).default([]),
});
export type DvInput = z.infer<typeof dvSchema>;

export type DvSource = SourceRecord & DvRecord;

/** Read a document that must exist and belong to the barangay (docs 02 reference rule 2). */
export async function readOwned(tx: Transaction, collection: string, id: string, barangayId: string, label: string): Promise<DocumentSnapshot> {
  const snap = await tx.get(db.collection(collection).doc(id));
  if (!snap.exists) throw new BfmsError('VALIDATION_FAILED', `${label} not found.`);
  if (snap.get('barangayId') !== barangayId) throw new BfmsError('BARANGAY_MISMATCH', `The ${label.toLowerCase()} belongs to another barangay.`);
  return snap;
}

export async function assertPeriodOpen(tx: Transaction, barangayId: BarangayId, date: IsoDate): Promise<void> {
  const { fiscalYear, month } = periodOfDate(date);
  const p = await tx.get(db.collection(COL.accountingPeriods).doc(periodDocId(barangayId, fiscalYear, month)));
  assertPeriodAllowsEncoding(p.get('status') as PeriodStatus | undefined);
}

/** Read a subsidiary ledger and check it is active and controlled by one of `accounts`. */
export async function readSl(tx: Transaction, id: string, barangayId: string, accounts: readonly string[], label: string): Promise<DocumentSnapshot> {
  const sl = await readOwned(tx, COL.subsidiaryAccounts, id, barangayId, label);
  if (!accounts.includes(sl.get('accountCode') as string)) throw new BfmsError('SUBSIDIARY_MISMATCH', `${label} must be a subsidiary ledger of ${accounts.join(' or ')}.`);
  if (!sl.get('active')) throw new BfmsError('SUBSIDIARY_MISMATCH', `${label} (${String(sl.get('subsidiaryCode'))}) is inactive.`);
  return sl;
}

/**
 * Default subsidiary for an SL-controlled account when the encoder left it blank (BIR01 for
 * taxes withheld, the single GSIS/Pag-IBIG ledger for payroll deductions …). Ambiguity is an error.
 */
async function defaultSl(tx: Transaction, barangayId: string, account: string, prefer?: string): Promise<string> {
  const q = await tx.get(db.collection(COL.subsidiaryAccounts).where('barangayId', '==', barangayId).where('accountCode', '==', account));
  const active = q.docs.filter((d) => d.get('active'));
  const pick = (prefer && active.find((d) => d.get('subsidiaryCode') === prefer)) || (active.length === 1 ? active[0] : null);
  if (!pick)
    throw new BfmsError(
      'SUBSIDIARY_REQUIRED',
      active.length
        ? `Select the subsidiary ledger of ${account} (${active.map((d) => d.get('subsidiaryCode')).join(', ')}).`
        : `Account ${account} needs a subsidiary ledger${prefer ? ` (e.g. ${prefer})` : ''}. Create it under Setup → Subsidiary ledgers first.`,
    );
  return pick.id;
}

/**
 * READ phase of a DV save (saveSource and createDvFromPayroll): validate accounts, ledgers, the
 * certified obligation, the cash-advance officer and the payment source; recompute every total.
 */
export async function prepareDv(tx: Transaction, barangayId: BarangayId, input: DvInput, existing: (Partial<DvSource> & { id: string }) | null, id: string): Promise<Record<string, unknown>> {
  const totals = computeDvTotals({ charges: input.charges, taxes: input.taxDeductions, otherDeductions: input.otherDeductions });
  const charges = input.charges.map((c) => ({ ...c }));
  const otherDeductions = input.otherDeductions.map((d) => ({ ...d }));
  const isCa = input.dvCategory === 'CASH_ADVANCE';

  // Chart of Accounts: every account used must exist and be active.
  const codes = [...new Set([...charges.map((c) => c.accountCode), ...otherDeductions.map((d) => d.accountCode)])];
  const accts = await tx.getAll(...codes.map((c) => db.collection(COL.chartOfAccounts).doc(c)));
  const acctMap = new Map(accts.map((a) => [a.id, a]));
  for (const a of accts) if (!a.exists || !a.get('active')) throw new BfmsError('INVALID_ACCOUNT', `Account ${a.id} is not an active account in the Chart of Accounts.`);

  // Subsidiary ledgers: explicit ones must match; blank ones on SL-controlled accounts get the default.
  for (const l of [...charges, ...otherDeductions]) {
    if (l.subsidiaryId) await readSl(tx, l.subsidiaryId, barangayId, [l.accountCode], `Subsidiary ledger of ${l.accountCode}`);
    else if (acctMap.get(l.accountCode)?.get('requiresSubsidiaryLedger')) l.subsidiaryId = await defaultSl(tx, barangayId, l.accountCode);
  }
  const taxSubsidiaryId = totals.totalTaxes > 0 ? await defaultSl(tx, barangayId, DV_ACCT.DUE_TO_BIR, 'BIR01') : null;

  // Cash advance: one charge, on the accountable officer's AO/EO ledger; no deductions.
  let cashAdvance: DvRecord['cashAdvance'] = null;
  if (isCa) {
    if (!input.cashAdvance) throw new BfmsError('VALIDATION_FAILED', 'A cash-advance DV needs the accountable officer, type and purpose.');
    const sl = await readSl(tx, input.cashAdvance.accountableOfficerId, barangayId, DV_CASH_ADVANCE_ACCOUNTS, 'Accountable officer');
    const acct = sl.get('accountCode') as string;
    if (charges.length !== 1 || charges[0]!.accountCode !== acct || charges[0]!.subsidiaryId !== sl.id)
      throw new BfmsError('VALIDATION_FAILED', `A cash-advance DV is charged to ${acct} of the accountable officer (${String(sl.get('subsidiaryCode'))}) only.`);
    if (totals.totalTaxes || totals.totalOtherDeductions) throw new BfmsError('VALIDATION_FAILED', 'A cash advance is granted in full: remove the taxes and deductions.');
    cashAdvance = { ...input.cashAdvance, accountableOfficerName: sl.get('subsidiaryName') as string, accountCode: acct };
  } else if (charges.some((c) => DV_CASH_ADVANCE_ACCOUNTS.includes(c.accountCode))) {
    throw new BfmsError('VALIDATION_FAILED', 'Charges to Advances for Payroll / Advances to Officers and Employees use the Cash advance category.');
  }

  // Committee on Appropriations box: the certified obligation (required for expense / capital charges).
  const needsObr = !isCa && charges.some((c) => dvRequiresObligation(c.accountCode));
  if (needsObr && !input.obligationId) throw new BfmsError('VALIDATION_FAILED', 'Charges to expense or capital outlay accounts need a certified obligation request (OBR).');
  let obligation: Record<string, unknown> = { obligationNumber: null, appropriationId: null, specialTrustFundId: null };
  if (input.obligationId) {
    const o = await readCertifiedObligation(tx, input.obligationId, barangayId, id);
    if (totals.grossAmount > (o.get('amount') as number))
      throw new BfmsError('INSUFFICIENT_APPROPRIATION', `The DV gross amount exceeds the certified obligation ${String(o.get('obligationNumber'))}.`, { gross: totals.grossAmount, obligation: o.get('amount') });
    const obrAccount = o.get('accountCode') as string;
    const off = charges.find((c) => dvRequiresObligation(c.accountCode) && c.accountCode !== obrAccount);
    if (!isCa && off) throw new BfmsError('VALIDATION_FAILED', `Charge ${off.accountCode} does not match the obligation's account ${obrAccount}.`);
    // Phase 7 (STF registry) follows the obligation's specialTrustFundId; snapshot for reports.
    obligation = { obligationNumber: o.get('obligationNumber') ?? null, appropriationId: o.get('appropriationId') ?? null, specialTrustFundId: o.get('specialTrustFundId') ?? null };
  }

  // Payment source.
  if (input.paymentMethod === 'CASH') {
    if (!input.cashOfficerId) throw new BfmsError('VALIDATION_FAILED', 'Select the cash ledger (BT##) paying this cash disbursement.');
    await readSl(tx, input.cashOfficerId, barangayId, [DV_ACCT.CASH_LOCAL_TREASURY], 'Cash ledger');
  }
  if (input.paymentMethod !== 'CASH' && input.bankAccountId) await readOwned(tx, COL.bankAccounts, input.bankAccountId, barangayId, 'Bank account');

  // A voucher returned after payment must still match its check / ADA.
  const paid = existing?.paymentStatus && existing.paymentStatus !== 'UNPAID';
  if (paid && (totals.netAmount !== existing.netAmount || input.paymentMethod !== existing.paymentMethod))
    throw new BfmsError('INVALID_STATUS', 'This DV is already paid: cancel the check / ADA before changing the net amount or payment method.');

  const fields: Record<string, unknown> = {
    dvDate: input.dvDate,
    dvCategory: input.dvCategory,
    payee: input.payee,
    particulars: input.particulars,
    fundId: input.fundId,
    officeId: input.officeId,
    fppId: input.fppId,
    obligationId: input.obligationId,
    ...obligation,
    charges,
    grossAmount: totals.grossAmount,
    taxDeductions: totals.taxDeductions,
    totalTaxes: totals.totalTaxes,
    taxSubsidiaryId,
    otherDeductions,
    totalOtherDeductions: totals.totalOtherDeductions,
    netAmount: totals.netAmount,
    paymentMethod: input.paymentMethod,
    cashOfficerId: input.paymentMethod === 'CASH' ? input.cashOfficerId : null,
    cashAdvance,
    supportingDocumentIds: input.supportingDocumentIds,
  };
  if (!paid) fields.bankAccountId = input.paymentMethod === 'CASH' ? null : input.bankAccountId;
  if (!existing)
    Object.assign(fields, {
      dvNumber: null,
      checkId: null,
      cashAdvanceId: null,
      payrollId: null,
      paymentStatus: 'UNPAID',
      checkNumber: null,
      checkDate: null,
      adaId: null,
      adaNumber: null,
      paymentDate: null,
      releasedDate: null,
      cancelledPayments: [],
    });
  return fields;
}

/** A CERTIFIED obligation of the barangay not already paid by another live DV. */
export async function readCertifiedObligation(tx: Transaction, obligationId: string, barangayId: string, dvId: string): Promise<DocumentSnapshot> {
  const o = await readOwned(tx, COL.obligations, obligationId, barangayId, 'Obligation request');
  if (o.get('status') !== 'CERTIFIED') throw new BfmsError('INVALID_STATUS', `The obligation request is ${String(o.get('status'))}; only a CERTIFIED obligation can be paid.`);
  const linked = o.get('dvId') as string | null | undefined;
  if (linked && linked !== dvId) {
    const other = await tx.get(db.collection(COL.disbursementVouchers).doc(linked));
    if (other.exists && other.get('status') !== 'VOID') throw new BfmsError('VALIDATION_FAILED', `Obligation ${String(o.get('obligationNumber'))} is already paid by DV ${String(other.get('dvNumber') ?? linked)}.`);
  }
  return o;
}

/**
 * Cancel / void the DV's check or ADA (number retained, never reused). READ phase here; the
 * returned writer updates the payment record and the cash advance and returns the DV patch.
 * Used by the DV CANCEL_PAYMENT action and the checks-register `cancelCheck` callable.
 */
export async function planCancelPayment(tx: Transaction, dv: Partial<DvRecord> & { id: string; barangayId: string }, opts: { status: 'CANCELLED' | 'VOID'; reason: string; date: IsoDate; uid: string }) {
  if (!dv.paymentStatus || dv.paymentStatus === 'UNPAID') throw new BfmsError('INVALID_STATUS', 'This DV has no check or ADA to cancel.');
  if (dv.paymentMethod === 'CASH') throw new BfmsError('INVALID_STATUS', 'A cash payment cannot be cancelled; return the DV to correct it.');
  const isCheck = dv.paymentMethod === 'CHECK';
  const payId = isCheck ? dv.checkId : dv.adaId;
  if (!payId) throw new BfmsError('INVALID_STATUS', 'This DV has no check or ADA to cancel.');
  const snap = await readOwned(tx, isCheck ? COL.checks : COL.adas, payId, dv.barangayId, isCheck ? 'Check' : 'ADA');
  const st = snap.get('status') as string;
  if (!['PREPARED', 'ISSUED', 'RELEASED'].includes(st)) throw new BfmsError('INVALID_STATUS', `The ${isCheck ? 'check' : 'ADA'} is ${st} and can no longer be cancelled.`);
  const ca = dv.cashAdvanceId ? await tx.get(db.collection(COL.cashAdvances).doc(dv.cashAdvanceId)) : null;
  const entry: DvCancelledPayment = { kind: isCheck ? 'CHECK' : 'ADA', id: payId, number: String(isCheck ? snap.get('checkNumber') : snap.get('adaNumber')), status: opts.status, reason: opts.reason, date: opts.date };
  return ({ now }: Pick<WriteArgs, 'now'>) => {
    tx.update(snap.ref, { status: opts.status, cancelReason: opts.reason, cancelledDate: opts.date, cancelledBy: opts.uid, updatedAt: now, updatedBy: opts.uid });
    if (ca?.exists && isCheck) tx.update(ca.ref, { checkId: null, checkNumber: null, updatedAt: now });
    return {
      paymentStatus: 'UNPAID',
      checkId: null,
      checkNumber: null,
      checkDate: null,
      adaId: null,
      adaNumber: null,
      paymentDate: null,
      releasedDate: null,
      cancelledPayments: [...(dv.cancelledPayments ?? []), entry],
    };
  };
}
