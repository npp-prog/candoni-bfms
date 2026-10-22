import {
  BfmsError,
  COL,
  DV_ACCT,
  PAYROLL_TYPES,
  aggregatePayrollDeductions,
  manilaToday,
  periodOfDate,
  type BarangayId,
  type DvRecord,
  type PayrollRecord,
} from '@bfms/shared';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { AuditWriter, writeWorkflowHistory } from '../../audit/auditWriter';
import { db, Timestamp } from '../../lib/admin';
import { secureCallable } from '../../lib/callable';
import { assertPeriodOpen, dvSchema, isoDate, planCancelPayment, prepareDv, readOwned } from './common';

/**
 * Phase 5 callables that are not a single source-document save/transition:
 *  - createDvFromPayroll: the treasurer prepares the DV of an APPROVED payroll (linked both ways).
 *  - cancelCheck: cancel / void a check from the checks register (number retained).
 *  - setPayrollSignatures: mark which payees signed the payroll on receipt of payment.
 */

export const createDvFromPayroll = secureCallable(
  z.object({
    payrollId: z.string().min(1).max(128),
    dvDate: isoDate,
    /** How the DV itself is paid (a CA payroll is usually a check to the disbursing officer). */
    paymentMethod: z.enum(['CHECK', 'ADA', 'CASH']).default('CHECK'),
    bankAccountId: z.string().max(128).nullable().default(null),
    cashOfficerId: z.string().max(200).nullable().default(null),
  }),
  async (input, ctx) => {
    const pref = db.collection(COL.payrolls).doc(input.payrollId);
    const dvRef = db.collection(COL.disbursementVouchers).doc();
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(pref);
      if (!snap.exists) throw new HttpsError('not-found', 'Payroll not found.');
      const p = snap.data() as PayrollRecord;
      ctx.require('treasury.encode', p.barangayId);
      if (p.status !== 'APPROVED') throw new BfmsError('INVALID_STATUS', 'Only an APPROVED payroll can be paid through a DV.');
      if (p.dvId) {
        const prev = await tx.get(db.collection(COL.disbursementVouchers).doc(p.dvId));
        if (prev.exists && prev.get('status') !== 'VOID') throw new BfmsError('VALIDATION_FAILED', `This payroll already has DV ${String(prev.get('dvNumber') ?? '(draft)')}.`);
      }
      const typeLabel = PAYROLL_TYPES.find((t) => t.value === p.payrollType)?.label ?? p.payrollType;
      const particulars = `${p.particulars ? `${p.particulars}. ` : ''}Payment of ${typeLabel.toLowerCase()} for the period ${p.payPeriodFrom} to ${p.payPeriodTo} per Payroll No. ${p.payrollNumber ?? ''}`.trim();
      const isCa = p.paymentMethod === 'CASH_ADVANCE';
      if (isCa && !p.disbursingOfficerId) throw new BfmsError('VALIDATION_FAILED', 'The payroll has no disbursing officer.');
      const raw = isCa
        ? {
            dvDate: input.dvDate,
            dvCategory: 'CASH_ADVANCE',
            payee: { id: p.disbursingOfficerId, name: p.disbursingOfficerName ?? 'Disbursing officer' },
            particulars: `Cash advance for ${particulars.charAt(0).toLowerCase()}${particulars.slice(1)}`,
            fundId: p.fundId,
            obligationId: p.obligationId,
            // The disbursing officer receives the payroll net; withholdings are booked at liquidation.
            charges: [{ accountCode: DV_ACCT.ADVANCES_PAYROLL, subsidiaryId: p.disbursingOfficerId, amount: p.netAmount }],
            paymentMethod: input.paymentMethod,
            bankAccountId: input.bankAccountId,
            cashOfficerId: input.cashOfficerId,
            cashAdvance: { accountableOfficerId: p.disbursingOfficerId, cashAdvanceType: 'PAYROLL', purpose: `Payroll ${p.payrollNumber ?? ''} (${p.payPeriodFrom} to ${p.payPeriodTo})` },
          }
        : {
            dvDate: input.dvDate,
            dvCategory: 'PAYROLL',
            payee: { id: null, name: `Various payees per Payroll No. ${p.payrollNumber ?? ''}`.trim() },
            particulars,
            fundId: p.fundId,
            obligationId: p.obligationId,
            charges: [{ accountCode: p.expenseAccountCode, subsidiaryId: null, amount: p.grossAmount }],
            otherDeductions: aggregatePayrollDeductions(p.entries).map((d) => ({ ...d, subsidiaryId: null })),
            paymentMethod: input.paymentMethod,
            bankAccountId: input.bankAccountId,
            cashOfficerId: input.cashOfficerId,
          };
      const parsed = dvSchema.safeParse(raw);
      if (!parsed.success) throw new HttpsError('invalid-argument', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const fields = await prepareDv(tx, p.barangayId, parsed.data, null, dvRef.id);
      await assertPeriodOpen(tx, p.barangayId, input.dvDate);
      const audit = await AuditWriter.begin(tx, ctx, p.barangayId);

      const now = Timestamp.now();
      const { fiscalYear, key } = periodOfDate(input.dvDate);
      tx.create(dvRef, { ...fields, payrollId: snap.id, barangayId: p.barangayId, fiscalYear, accountingPeriod: key, status: 'DRAFT', revisionNumber: 0, createdAt: now, createdBy: ctx.uid, updatedAt: now, updatedBy: ctx.uid, jevId: null });
      tx.update(pref, { dvId: dvRef.id, dvNumber: null, updatedAt: now, updatedBy: ctx.uid });
      audit.write({ module: COL.disbursementVouchers, recordId: dvRef.id, action: 'CREATE', newValue: { payrollId: snap.id, dvCategory: raw.dvCategory, grossAmount: fields.grossAmount as number, netAmount: fields.netAmount as number }, source: 'callable:createDvFromPayroll' });
      audit.write({ module: COL.payrolls, recordId: snap.id, action: 'EDIT', oldValue: { dvId: p.dvId ?? null }, newValue: { dvId: dvRef.id }, source: 'callable:createDvFromPayroll' });
      audit.commit();
      return { dvId: dvRef.id };
    });
  },
);

export const cancelCheck = secureCallable(
  z.object({
    checkId: z.string().min(1).max(128),
    status: z.enum(['CANCELLED', 'VOID']).default('CANCELLED'),
    reason: z.string().trim().min(5, 'State the reason (at least 5 characters).').max(1000),
    cancelledDate: isoDate.optional(),
  }),
  async (input, ctx) => {
    const cref = db.collection(COL.checks).doc(input.checkId);
    return db.runTransaction(async (tx) => {
      const c = await tx.get(cref);
      if (!c.exists) throw new HttpsError('not-found', 'Check not found.');
      const bid = c.get('barangayId') as BarangayId;
      ctx.require('treasury.submit', bid);
      const dvId = c.get('dvId') as string | null;
      if (!dvId) throw new BfmsError('VALIDATION_FAILED', 'This check is not linked to a DV.');
      const dvSnap = await readOwned(tx, COL.disbursementVouchers, dvId, bid, 'Disbursement voucher');
      const dv = { ...(dvSnap.data() as DvRecord), id: dvSnap.id };
      if (dv.status !== 'APPROVED')
        throw new BfmsError('INVALID_STATUS', `DV ${dv.dvNumber ?? ''} is ${dv.status}; a check of an accepted or posted DV is cancelled through a reversing entry by Municipal Accounting.`);
      if (dv.checkId !== cref.id) throw new BfmsError('INVALID_STATUS', 'This check is no longer the DV\'s current payment.');
      const write = await planCancelPayment(tx, dv, { status: input.status, reason: input.reason, date: input.cancelledDate ?? manilaToday(), uid: ctx.uid });
      const audit = await AuditWriter.begin(tx, ctx, bid);
      const now = Timestamp.now();
      const patch = write({ now });
      tx.update(dvSnap.ref, { ...patch, updatedAt: now, updatedBy: ctx.uid });
      writeWorkflowHistory(tx, ctx, { barangayId: bid, module: COL.checks, recordId: cref.id, fromStatus: c.get('status') as string, toStatus: input.status, remarks: input.reason });
      audit.write({ module: COL.checks, recordId: cref.id, action: 'CANCEL', oldValue: { status: c.get('status') }, newValue: { status: input.status, checkNumber: c.get('checkNumber') }, reason: input.reason, source: 'callable:cancelCheck' });
      audit.write({ module: COL.disbursementVouchers, recordId: dvId, action: 'EDIT', oldValue: { paymentStatus: dv.paymentStatus, checkId: dv.checkId }, newValue: { paymentStatus: 'UNPAID', checkId: null }, reason: input.reason, source: 'callable:cancelCheck' });
      audit.commit();
      return { status: input.status };
    });
  },
);

export const setPayrollSignatures = secureCallable(
  z.object({ payrollId: z.string().min(1).max(128), signed: z.array(z.boolean()).min(1).max(200) }),
  async (input, ctx) => {
    const ref = db.collection(COL.payrolls).doc(input.payrollId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Payroll not found.');
      const p = snap.data() as PayrollRecord;
      ctx.require('treasury.encode', p.barangayId);
      if (p.status !== 'APPROVED') throw new BfmsError('INVALID_STATUS', 'Payees sign an APPROVED payroll when they are paid.');
      if (input.signed.length !== p.entries.length) throw new BfmsError('VALIDATION_FAILED', 'The signature list does not match the payroll entries.');
      const audit = await AuditWriter.begin(tx, ctx, p.barangayId);
      const now = Timestamp.now();
      tx.update(ref, { entries: p.entries.map((e, i) => ({ ...e, signed: input.signed[i] })), updatedAt: now, updatedBy: ctx.uid });
      audit.write({ module: COL.payrolls, recordId: ref.id, action: 'EDIT', oldValue: { signed: p.entries.filter((e) => e.signed).length }, newValue: { signed: input.signed.filter(Boolean).length }, source: 'callable:setPayrollSignatures' });
      audit.commit();
      return { signed: input.signed.filter(Boolean).length };
    });
  },
);
