import {
  BfmsError,
  COL,
  DV_ACCT,
  DV_MODULE,
  PAYROLL_MODULE,
  agingCategory,
  computePayroll,
  dvJournalLines,
  dvLiquidationDueDate,
  manilaToday,
  periodOfDate,
  uniqueKeyId,
  type BankAccountDoc,
  type CashAdvanceDoc,
  type CheckRecord,
  type AdaRecord,
  type PayrollRecord,
} from '@bfms/shared';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { z } from 'zod';
import { writeWorkflowHistory } from '../../audit/auditWriter';
import { db, Timestamp } from '../../lib/admin';
import { SequenceAllocator, assertUniqueAvailable } from '../../numbering/sequences';
import type { ServerSourceModule, SourceRecord } from '../../sources/engine';
import { accountCode, assertPeriodOpen, centavos, dvSchema, isoDate, planCancelPayment, prepareDv, readCertifiedObligation, readOwned, readSl, type DvSource } from './common';

/** Bank account of the barangay that is active (check/ADA source). */
async function readBank(tx: FirebaseFirestore.Transaction, id: string, barangayId: string): Promise<DocumentSnapshot> {
  const b = await readOwned(tx, COL.bankAccounts, id, barangayId, 'Bank account');
  if (!b.get('active')) throw new BfmsError('VALIDATION_FAILED', 'The bank account is inactive.');
  return b;
}

// ------------------------------------------------------------------ disbursement vouchers
const dv: ServerSourceModule<typeof dvSchema> = {
  def: DV_MODULE,
  schema: dvSchema,
  async prepare({ input, tx, barangayId, existing, id }) {
    return prepareDv(tx, barangayId, input, existing as DvSource | null, id);
  },
  numbering: { action: 'APPROVE', docType: 'DV', field: 'dvNumber' },
  actionPayload: {
    ISSUE_CHECK: z.object({ bankAccountId: z.string().min(1).max(128), checkNumber: z.string().trim().regex(/^[0-9]{4,20}$/, 'Check numbers are 4–20 digits.'), checkDate: isoDate }),
    ISSUE_ADA: z.object({ bankAccountId: z.string().min(1).max(128), adaDate: isoDate }),
    RELEASE: z.object({ releasedDate: isoDate }),
    CANCEL_PAYMENT: z.object({ status: z.enum(['CANCELLED', 'VOID']).default('CANCELLED'), cancelledDate: isoDate.optional() }),
  },
  onAction: {
    /** PB approval: re-check the obligation, link it, and open the cash advance for CA vouchers. */
    async APPROVE({ tx, doc, ctx }) {
      const d = doc as DvSource;
      const obr = d.obligationId ? await readCertifiedObligation(tx, d.obligationId, d.barangayId, d.id) : null;
      if (obr && d.grossAmount > (obr.get('amount') as number)) throw new BfmsError('INSUFFICIENT_APPROPRIATION', 'The DV gross amount exceeds the certified obligation.');
      const isCa = d.dvCategory === 'CASH_ADVANCE' && !!d.cashAdvance && !d.cashAdvanceId;
      const aging = isCa ? await tx.get(db.collection(COL.systemSettings).doc('aging')) : null;
      const payroll = d.payrollId ? await tx.get(db.collection(COL.payrolls).doc(d.payrollId)) : null;
      return ({ now, number }) => {
        if (obr) tx.update(obr.ref, { dvId: d.id, updatedAt: now });
        let cashAdvanceId: string | null = d.cashAdvanceId ?? null;
        if (isCa && d.cashAdvance) {
          // Phase 6 owns the cash advance after this point (liquidations, refunds, aging).
          const ref = db.collection(COL.cashAdvances).doc();
          const buckets = aging?.get('buckets') as Array<{ maxDays: number; label: string }> | undefined;
          const ca: CashAdvanceDoc & Record<string, unknown> = {
            barangayId: d.barangayId,
            fiscalYear: periodOfDate(d.dvDate).fiscalYear,
            accountableOfficerId: d.cashAdvance.accountableOfficerId,
            accountableOfficerName: d.cashAdvance.accountableOfficerName,
            accountCode: d.cashAdvance.accountCode,
            cashAdvanceType: d.cashAdvance.cashAdvanceType,
            dvId: d.id,
            dvNumber: number ?? d.dvNumber ?? '',
            checkId: null,
            checkNumber: null,
            grantDate: d.dvDate,
            purpose: d.cashAdvance.purpose,
            amountGranted: d.netAmount,
            amountLiquidated: 0,
            amountRefunded: 0,
            outstandingBalance: d.netAmount,
            liquidationDueDate: dvLiquidationDueDate(d.dvDate, d.cashAdvance.cashAdvanceType, aging?.get('liquidationDueDays') as Record<string, number> | undefined),
            daysOutstanding: 0,
            agingCategory: buckets?.length ? agingCategory(0, buckets) : agingCategory(0),
            status: 'ACTIVE',
            isLegacy: false,
            payrollId: d.payrollId ?? null,
            createdAt: now,
            createdBy: ctx.uid,
            updatedAt: now,
          };
          tx.create(ref, ca);
          cashAdvanceId = ref.id;
        }
        if (payroll?.exists) tx.update(payroll.ref, { dvNumber: number ?? d.dvNumber ?? null, ...(cashAdvanceId ? { cashAdvanceId } : {}), updatedAt: now });
        return cashAdvanceId ? { cashAdvanceId } : {};
      };
    },

    /** Issue a check: unique per bank account + check no.; amount = DV net. */
    async ISSUE_CHECK({ tx, doc, ctx, payload }) {
      const d = doc as DvSource;
      const p = payload as { bankAccountId: string; checkNumber: string; checkDate: string };
      if (d.paymentMethod !== 'CHECK') throw new BfmsError('VALIDATION_FAILED', `This DV is paid by ${d.paymentMethod}, not by check.`);
      if (d.paymentStatus !== 'UNPAID') throw new BfmsError('INVALID_STATUS', `Check ${d.checkNumber ?? ''} is already issued for this DV; cancel it first to issue another.`);
      if (p.checkDate < d.dvDate) throw new BfmsError('VALIDATION_FAILED', 'The check date cannot be earlier than the DV date.');
      const bank = await readBank(tx, p.bankAccountId, d.barangayId);
      const keyRef = await assertUniqueAvailable(tx, uniqueKeyId('CHK', d.barangayId, p.bankAccountId, p.checkNumber));
      await assertPeriodOpen(tx, d.barangayId, p.checkDate);
      const ca = d.cashAdvanceId ? await tx.get(db.collection(COL.cashAdvances).doc(d.cashAdvanceId)) : null;
      return ({ now }) => {
        const ref = db.collection(COL.checks).doc();
        const check: CheckRecord = {
          barangayId: d.barangayId,
          fiscalYear: periodOfDate(p.checkDate).fiscalYear,
          bankAccountId: p.bankAccountId,
          bankSubsidiaryId: (bank.get('subsidiaryId') as string | undefined) ?? null,
          checkNumber: p.checkNumber,
          checkDate: p.checkDate,
          payee: d.payee,
          dvId: d.id,
          dvNumber: d.dvNumber,
          natureOfPayment: d.particulars.slice(0, 300),
          amount: d.netAmount,
          releasedDate: null,
          clearedDate: null,
          status: 'ISSUED',
          cancelReason: null,
          cancelledDate: null,
          cancelledBy: null,
          createdAt: now,
          createdBy: ctx.uid,
          updatedAt: now,
          updatedBy: ctx.uid,
        };
        tx.create(ref, check);
        tx.create(keyRef, { key: p.checkNumber, collection: COL.checks, documentId: ref.id, barangayId: d.barangayId, bankAccountId: p.bankAccountId, createdAt: now });
        writeWorkflowHistory(tx, ctx, { barangayId: d.barangayId, module: COL.checks, recordId: ref.id, fromStatus: 'PREPARED', toStatus: 'ISSUED', remarks: `DV ${d.dvNumber ?? d.id}` });
        if (ca?.exists) tx.update(ca.ref, { checkId: ref.id, checkNumber: p.checkNumber, updatedAt: now });
        return { paymentStatus: 'ISSUED', checkId: ref.id, checkNumber: p.checkNumber, checkDate: p.checkDate, bankAccountId: p.bankAccountId, paymentDate: p.checkDate };
      };
    },

    /** Advice to Debit Account: numbered ADA-YYYY-MM-NNN, amount = DV net. */
    async ISSUE_ADA({ tx, doc, ctx, payload }) {
      const d = doc as DvSource;
      const p = payload as { bankAccountId: string; adaDate: string };
      if (d.paymentMethod !== 'ADA') throw new BfmsError('VALIDATION_FAILED', `This DV is paid by ${d.paymentMethod}, not by ADA.`);
      if (d.paymentStatus !== 'UNPAID') throw new BfmsError('INVALID_STATUS', 'An ADA is already issued for this DV; cancel it first.');
      if (p.adaDate < d.dvDate) throw new BfmsError('VALIDATION_FAILED', 'The ADA date cannot be earlier than the DV date.');
      const bank = await readBank(tx, p.bankAccountId, d.barangayId);
      await assertPeriodOpen(tx, d.barangayId, p.adaDate);
      const { fiscalYear, month } = periodOfDate(p.adaDate);
      const seq = await SequenceAllocator.read(tx, d.barangayId, fiscalYear, 'ADA');
      return ({ now }) => {
        const ref = db.collection(COL.adas).doc();
        const adaNumber = seq.allocate(month, COL.adas, ref.id);
        seq.commit();
        const ada: AdaRecord = {
          barangayId: d.barangayId,
          fiscalYear,
          adaNumber,
          adaDate: p.adaDate,
          bankAccountId: p.bankAccountId,
          bankSubsidiaryId: (bank.get('subsidiaryId') as string | undefined) ?? null,
          dvId: d.id,
          dvNumber: d.dvNumber,
          payee: d.payee,
          natureOfPayment: d.particulars.slice(0, 300),
          amount: d.netAmount,
          status: 'ISSUED',
          releasedDate: null,
          cancelReason: null,
          cancelledDate: null,
          createdAt: now,
          createdBy: ctx.uid,
          updatedAt: now,
          updatedBy: ctx.uid,
        };
        tx.create(ref, ada);
        return { paymentStatus: 'ISSUED', adaId: ref.id, adaNumber, bankAccountId: p.bankAccountId, paymentDate: p.adaDate };
      };
    },

    /** Release: check handed to the payee, ADA debited by the bank, or cash paid out. */
    async RELEASE({ tx, doc, ctx, payload }) {
      const d = doc as DvSource;
      const { releasedDate } = payload as { releasedDate: string };
      if (d.paymentMethod === 'CASH') {
        if (d.paymentStatus !== 'UNPAID') throw new BfmsError('INVALID_STATUS', 'The cash payment is already released.');
        if (releasedDate < d.dvDate) throw new BfmsError('VALIDATION_FAILED', 'The payment date cannot be earlier than the DV date.');
        await assertPeriodOpen(tx, d.barangayId, releasedDate);
        return () => ({ paymentStatus: 'RELEASED', releasedDate, paymentDate: releasedDate });
      }
      if (d.paymentStatus !== 'ISSUED') throw new BfmsError('INVALID_STATUS', d.paymentStatus === 'RELEASED' ? 'The payment is already released.' : `Issue the ${d.paymentMethod === 'CHECK' ? 'check' : 'ADA'} first.`);
      const isCheck = d.paymentMethod === 'CHECK';
      const snap = await readOwned(tx, isCheck ? COL.checks : COL.adas, (isCheck ? d.checkId : d.adaId) ?? '-', d.barangayId, isCheck ? 'Check' : 'ADA');
      if (snap.get('status') !== 'ISSUED') throw new BfmsError('INVALID_STATUS', `The ${isCheck ? 'check' : 'ADA'} is ${String(snap.get('status'))}.`);
      if (releasedDate < (d.paymentDate ?? d.dvDate)) throw new BfmsError('VALIDATION_FAILED', `The release date cannot be earlier than the ${isCheck ? 'check' : 'ADA'} date.`);
      return ({ now }) => {
        tx.update(snap.ref, { status: 'RELEASED', releasedDate, updatedAt: now, updatedBy: ctx.uid });
        if (isCheck) writeWorkflowHistory(tx, ctx, { barangayId: d.barangayId, module: COL.checks, recordId: snap.id, fromStatus: 'ISSUED', toStatus: 'RELEASED', remarks: `Released ${releasedDate}` });
        return { paymentStatus: 'RELEASED', releasedDate };
      };
    },

    async CANCEL_PAYMENT({ tx, doc, ctx, payload, remarks }) {
      const d = doc as DvSource;
      const p = payload as { status: 'CANCELLED' | 'VOID'; cancelledDate?: string };
      const write = await planCancelPayment(tx, d, { status: p.status, reason: remarks ?? '', date: p.cancelledDate ?? manilaToday(), uid: ctx.uid });
      return ({ now }) => {
        const patch = write({ now });
        if (d.checkId) writeWorkflowHistory(tx, ctx, { barangayId: d.barangayId, module: COL.checks, recordId: d.checkId, fromStatus: d.paymentStatus === 'RELEASED' ? 'RELEASED' : 'ISSUED', toStatus: p.status, remarks });
        return patch;
      };
    },

    /** Accounting accepts only an approved AND paid voucher. */
    async ACCEPT({ doc }) {
      const d = doc as DvSource;
      const paid = d.paymentMethod === 'CASH' ? d.paymentStatus === 'RELEASED' : d.paymentStatus === 'ISSUED' || d.paymentStatus === 'RELEASED';
      if (!paid) throw new BfmsError('INVALID_STATUS', 'A DV must be approved and paid (check/ADA issued, or cash released) before it can be accepted.');
    },

    /** Voiding a voucher releases its links (obligation, payroll) and closes an untouched cash advance. */
    async VOID({ tx, doc }) {
      const d = doc as DvSource;
      if (d.paymentStatus && d.paymentStatus !== 'UNPAID')
        throw new BfmsError('INVALID_STATUS', d.paymentMethod === 'CASH' ? 'Cash has already been paid on this DV; it cannot be voided.' : 'Cancel the check / ADA of this DV before voiding it.');
      const obr = d.obligationId ? await tx.get(db.collection(COL.obligations).doc(d.obligationId)) : null;
      const payroll = d.payrollId ? await tx.get(db.collection(COL.payrolls).doc(d.payrollId)) : null;
      const ca = d.cashAdvanceId ? await tx.get(db.collection(COL.cashAdvances).doc(d.cashAdvanceId)) : null;
      if (ca?.exists && ((ca.get('amountLiquidated') as number) > 0 || (ca.get('amountRefunded') as number) > 0))
        throw new BfmsError('INVALID_STATUS', 'The cash advance of this DV already has liquidations or refunds.');
      return ({ now }) => {
        if (obr?.exists && obr.get('dvId') === d.id) tx.update(obr.ref, { dvId: null, updatedAt: now });
        if (payroll?.exists && payroll.get('dvId') === d.id) tx.update(payroll.ref, { dvId: null, dvNumber: null, cashAdvanceId: null, updatedAt: now });
        if (ca?.exists) tx.update(ca.ref, { status: 'CLOSED', outstandingBalance: 0, closedReason: 'DV voided', updatedAt: now });
      };
    },
  },
  /** JCT template (docs 04 §9) dated on the payment date (check/ADA date or cash release). */
  async jev({ tx, doc }) {
    const d = doc as DvSource;
    let cash: { accountCode: string; subsidiaryId: string | null };
    if (d.paymentMethod === 'CASH') {
      const sl = await readSl(tx, d.cashOfficerId ?? '-', d.barangayId, [DV_ACCT.CASH_LOCAL_TREASURY], 'Cash ledger');
      cash = { accountCode: DV_ACCT.CASH_LOCAL_TREASURY, subsidiaryId: sl.id };
    } else {
      const bank = (await readOwned(tx, COL.bankAccounts, d.bankAccountId ?? '-', d.barangayId, 'Bank account')).data() as BankAccountDoc;
      cash = { accountCode: bank.glAccountCode || DV_ACCT.CASH_IN_BANK, subsidiaryId: bank.subsidiaryId };
    }
    return {
      jevDate: d.paymentDate ?? d.dvDate,
      fundId: d.fundId,
      journal: 'JCT',
      particulars: `${d.payee.name} — ${d.particulars}`,
      primaryReference: d.checkNumber ?? d.adaNumber ?? null,
      secondaryReference: d.dvNumber,
      tertiaryReference: d.obligationNumber ?? null,
      payeeName: d.payee.name,
      lines: dvJournalLines(d, cash),
    };
  },
};

// ------------------------------------------------------------------ payrolls
const payrollSchema = z.object({
  payrollDate: isoDate,
  payrollType: z.enum(['HONORARIA', 'EMPLOYEES', 'LABOR', 'ALLOWANCE', 'OTHER']),
  payPeriodFrom: isoDate,
  payPeriodTo: isoDate,
  fundId: z.string().min(1).max(60).default('GF'),
  particulars: z.string().trim().max(500).default(''),
  obligationId: z.string().max(128).nullable().default(null),
  expenseAccountCode: accountCode,
  paymentMethod: z.enum(['CASH_ADVANCE', 'CHECK', 'ADA']),
  disbursingOfficerId: z.string().max(200).nullable().default(null),
  entries: z
    .array(
      z.object({
        payeeId: z.string().max(128).nullable().default(null),
        payeeName: z.string().trim().min(2).max(120),
        position: z.string().trim().max(120).default(''),
        grossAmount: centavos,
        deductions: z.array(z.object({ description: z.string().trim().min(1).max(60), accountCode, amount: centavos })).max(10).default([]),
        signed: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(200),
});

const payroll: ServerSourceModule<typeof payrollSchema> = {
  def: PAYROLL_MODULE,
  schema: payrollSchema,
  async prepare({ input, tx, barangayId, existing }) {
    if (input.payPeriodTo < input.payPeriodFrom) throw new BfmsError('VALIDATION_FAILED', 'The pay period cannot end before it starts.');
    const totals = computePayroll(input.entries);
    const codes = [...new Set([input.expenseAccountCode, ...totals.entries.flatMap((e) => e.deductions.map((x) => x.accountCode))])];
    for (const a of await tx.getAll(...codes.map((c) => db.collection(COL.chartOfAccounts).doc(c))))
      if (!a.exists || !a.get('active')) throw new BfmsError('INVALID_ACCOUNT', `Account ${a.id} is not an active account in the Chart of Accounts.`);
    if (!input.expenseAccountCode.startsWith('5-')) throw new BfmsError('VALIDATION_FAILED', 'The payroll is charged to an expense account (5-xx-xx-xxx).');
    let obr: Record<string, unknown> = { appropriationId: null, obligationNumber: null };
    if (input.obligationId) {
      const o = await readCertifiedObligation(tx, input.obligationId, barangayId, (existing?.dvId as string | undefined) ?? '-');
      if (o.get('accountCode') !== input.expenseAccountCode) throw new BfmsError('VALIDATION_FAILED', `The obligation is charged to ${String(o.get('accountCode'))}, not ${input.expenseAccountCode}.`);
      if (totals.grossAmount > (o.get('amount') as number)) throw new BfmsError('INSUFFICIENT_APPROPRIATION', `The payroll gross exceeds the certified obligation ${String(o.get('obligationNumber'))}.`);
      obr = { appropriationId: o.get('appropriationId') ?? null, obligationNumber: o.get('obligationNumber') ?? null };
    }
    let officer: Record<string, unknown> = { disbursingOfficerId: null, disbursingOfficerName: null };
    if (input.paymentMethod === 'CASH_ADVANCE') {
      if (!input.disbursingOfficerId) throw new BfmsError('VALIDATION_FAILED', 'Select the disbursing officer (AO## ledger under Advances for Payroll).');
      const sl = await readSl(tx, input.disbursingOfficerId, barangayId, [DV_ACCT.ADVANCES_PAYROLL], 'Disbursing officer');
      officer = { disbursingOfficerId: sl.id, disbursingOfficerName: sl.get('subsidiaryName') as string };
    }
    const fields: Record<string, unknown> = { ...input, ...obr, ...officer, entries: totals.entries, entryCount: totals.entryCount, grossAmount: totals.grossAmount, totalDeductions: totals.totalDeductions, netAmount: totals.netAmount };
    if (!existing) Object.assign(fields, { payrollNumber: null, dvId: null, dvNumber: null, cashAdvanceId: null, liquidationId: null });
    return fields;
  },
  numbering: { action: 'APPROVE', docType: 'PAYROLL', field: 'payrollNumber' },
  onAction: {
    async VOID({ tx, doc }) {
      const p = doc as SourceRecord & PayrollRecord;
      if (p.dvId) {
        const d = await tx.get(db.collection(COL.disbursementVouchers).doc(p.dvId));
        if (d.exists && d.get('status') !== 'VOID') throw new BfmsError('INVALID_STATUS', `Void DV ${String(d.get('dvNumber') ?? '')} of this payroll first.`);
      }
    },
  },
};

export const DISBURSEMENTS_SERVER_MODULES: ServerSourceModule[] = [dv, payroll] as ServerSourceModule[];
