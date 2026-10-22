import { randomUUID } from 'node:crypto';
import {
  BARANGAY_IDS,
  BfmsError,
  COL,
  STF_ADJUSTMENT_KINDS,
  assertIsoDate,
  assertPeriodAllowsEncoding,
  caLiquidationDueDate,
  computeCashAdvanceBalance,
  computeStfBalance,
  manilaToday,
  normalizeAgingSettings,
  periodDocId,
  periodOfDate,
  stfStatusFor,
  type BarangayId,
  type CashAdvanceRecord,
  type Centavos,
  type PeriodStatus,
  type PettyCashFundRecord,
  type PettyCashTxnRecord,
  type SpecialTrustFundRecord,
  type StfHistoryEntry,
} from '@bfms/shared';
import type { Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { z } from 'zod';
import { AuditWriter } from '../../audit/auditWriter';
import { REGION, db, Timestamp } from '../../lib/admin';
import { secureCallable } from '../../lib/callable';
import type { CallerContext } from '../../lib/context';
import { subsidiaryId } from '../../setup/masters';
import { createGeneratedJev } from '../../sources/jev';
import { assertCashOfficer, readOwned } from './index';

/**
 * Phases 6–7 callables: legacy (migrated) cash advances, aging refresh (scheduled + on demand),
 * petty cash fund establishment/closing, and the Special Trust Fund registry.
 */
const barangay = z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const centavos = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

async function assertOpen(tx: Transaction, barangayId: BarangayId, date: string) {
  const { fiscalYear, month } = periodOfDate(assertIsoDate(date));
  const p = await tx.get(db.collection(COL.accountingPeriods).doc(periodDocId(barangayId, fiscalYear, month)));
  assertPeriodAllowsEncoding(p.get('status') as PeriodStatus | undefined);
}

// ------------------------------------------------------------------ cash advances
/**
 * Opening balances: an unliquidated cash advance granted before BFMS (isLegacy). Accounting
 * encodes it once; later liquidations go through the normal Liquidation Report workflow.
 */
export const recordLegacyCashAdvance = secureCallable(
  z.object({
    id: z.string().max(128).nullish(),
    barangayId: barangay,
    accountableOfficerId: z.string().min(1).max(200),
    cashAdvanceType: z.enum(['PAYROLL', 'OFFICIAL_TRAVEL', 'SPECIAL_PURPOSE', 'PETTY_CASH', 'OTHER_AUTHORIZED']),
    purpose: z.string().trim().min(3).max(500),
    grantDate: isoDate,
    dvNumber: z.string().trim().min(1).max(40),
    checkNumber: z.string().trim().max(40).nullish(),
    amountGranted: positive,
    /** Already liquidated/refunded before migration. */
    openingLiquidated: centavos.default(0),
    liquidationDueDate: isoDate.nullish(),
  }),
  async (input, ctx) => {
    ctx.require('jev.prepare', input.barangayId);
    if (input.openingLiquidated >= input.amountGranted) throw new HttpsError('invalid-argument', 'A fully liquidated advance is not an opening balance; nothing to record.');
    const ref = input.id ? db.collection(COL.cashAdvances).doc(input.id) : db.collection(COL.cashAdvances).doc();
    await db.runTransaction(async (tx) => {
      const existing = input.id ? await tx.get(ref) : null;
      if (existing) {
        if (!existing.exists || existing.get('barangayId') !== input.barangayId) throw new HttpsError('not-found', 'Cash advance not found.');
        if (!existing.get('isLegacy')) throw new BfmsError('INVALID_STATUS', 'Only migrated (legacy) cash advances can be edited here.');
        if (existing.get('amountLiquidated') !== (existing.get('openingLiquidated') ?? 0) || existing.get('amountRefunded'))
          throw new BfmsError('INVALID_STATUS', 'A liquidation was already applied to this cash advance; it can no longer be edited.');
      }
      const sl = await tx.get(db.collection(COL.subsidiaryAccounts).doc(input.accountableOfficerId));
      const accountCode = sl.get('accountCode') as string | undefined;
      if (!sl.exists || sl.get('barangayId') !== input.barangayId || !accountCode || !['1-03-03-010', '1-03-03-020'].includes(accountCode))
        throw new BfmsError('SUBSIDIARY_MISMATCH', 'Select the accountable officer\'s ledger under 1-03-03-010 (AO##) or 1-03-03-020 (EO##).');
      const settings = normalizeAgingSettings((await tx.get(db.collection(COL.systemSettings).doc('aging'))).data());
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const today = manilaToday();
      const liquidationDueDate = input.liquidationDueDate ?? caLiquidationDueDate(input.grantDate, input.cashAdvanceType, settings);
      const figures = { amountGranted: input.amountGranted as Centavos, amountLiquidated: input.openingLiquidated as Centavos, amountRefunded: 0 as Centavos, grantDate: input.grantDate, liquidationDueDate };
      const bal = computeCashAdvanceBalance(figures, today < input.grantDate ? input.grantDate : today, settings.buckets);
      const now = Timestamp.now();
      const doc: Omit<CashAdvanceRecord, 'dvId'> & { dvId: null; createdAt?: unknown; createdBy?: string; updatedBy: string } = {
        barangayId: input.barangayId,
        fiscalYear: Number(input.grantDate.slice(0, 4)),
        accountableOfficerId: input.accountableOfficerId,
        accountableOfficerName: sl.get('subsidiaryName') as string,
        accountCode,
        cashAdvanceType: input.cashAdvanceType,
        dvId: null, // migrated: no BFMS voucher
        dvNumber: input.dvNumber,
        checkId: null,
        checkNumber: input.checkNumber ?? null,
        purpose: input.purpose,
        ...figures,
        openingLiquidated: input.openingLiquidated as Centavos,
        ...bal,
        agingAsOf: today,
        isLegacy: true,
        fundId: 'GF',
        updatedAt: now,
        updatedBy: ctx.uid,
      };
      if (existing) tx.update(ref, doc);
      else tx.create(ref, { ...doc, createdAt: now, createdBy: ctx.uid });
      audit.write({ module: COL.cashAdvances, recordId: ref.id, action: existing ? 'EDIT' : 'CREATE', newValue: { accountableOfficerId: doc.accountableOfficerId, dvNumber: doc.dvNumber, amountGranted: doc.amountGranted, openingLiquidated: doc.openingLiquidated, isLegacy: true }, source: 'callable:recordLegacyCashAdvance' });
      audit.commit();
    });
    return { id: ref.id };
  },
);

type AuditCtx = Pick<CallerContext, 'uid' | 'userName' | 'requestId' | 'rolesAt'>;

/** Recompute days outstanding, aging bucket and status of a barangay's open cash advances. */
async function refreshAging(barangayId: BarangayId, asOf: string, actor: AuditCtx, source: string) {
  return db.runTransaction(async (tx) => {
    const settings = normalizeAgingSettings((await tx.get(db.collection(COL.systemSettings).doc('aging'))).data());
    const snap = await tx.get(db.collection(COL.cashAdvances).where('barangayId', '==', barangayId));
    const changes: Array<{ ref: FirebaseFirestore.DocumentReference; patch: Record<string, unknown> }> = [];
    let overdue = 0;
    for (const d of snap.docs) {
      const ca = d.data() as CashAdvanceRecord;
      if (ca.status === 'CLOSED' || ca.status === 'FULLY_LIQUIDATED' || ca.grantDate > asOf) continue;
      const next = computeCashAdvanceBalance(ca, asOf, settings.buckets);
      if (next.status === 'OVERDUE') overdue++;
      if (next.status !== ca.status || next.daysOutstanding !== ca.daysOutstanding || next.agingCategory !== ca.agingCategory || next.outstandingBalance !== ca.outstandingBalance)
        changes.push({ ref: d.ref, patch: { ...next, agingAsOf: asOf } });
    }
    const audit = changes.length ? await AuditWriter.begin(tx, actor, barangayId) : null;
    const now = Timestamp.now();
    for (const c of changes.slice(0, 450)) tx.update(c.ref, { ...c.patch, updatedAt: now });
    if (audit) {
      audit.write({ module: COL.cashAdvances, recordId: `aging-${asOf}`, action: 'EDIT', newValue: { asOf, updated: changes.length, overdue }, source });
      audit.commit();
    }
    return { updated: Math.min(changes.length, 450), overdue, open: snap.size };
  });
}

/** On demand (accounting): refresh aging now, optionally as of a given date. */
export const recomputeCashAdvanceAging = secureCallable(z.object({ barangayId: barangay, asOf: isoDate.nullish() }), async (input, ctx) => {
  ctx.require('submission.review', input.barangayId);
  return refreshAging(input.barangayId, input.asOf ?? manilaToday(), ctx, 'callable:recomputeCashAdvanceAging');
});

/** Daily 01:00 Asia/Manila: advances past their liquidation due date become OVERDUE. */
export const refreshCashAdvanceAging = onSchedule({ region: REGION, schedule: '0 1 * * *', timeZone: 'Asia/Manila' }, async () => {
  const today = manilaToday();
  const actor: AuditCtx = { uid: 'system', userName: 'System (daily aging)', requestId: randomUUID(), rolesAt: () => [] };
  for (const b of BARANGAY_IDS) {
    try {
      const r = await refreshAging(b, today, actor, 'schedule:refreshCashAdvanceAging');
      if (r.updated) console.log(`Aging ${b}: ${r.updated} updated, ${r.overdue} overdue.`);
    } catch (e) {
      console.error(`Aging refresh failed for ${b}`, e);
    }
  }
});

// ------------------------------------------------------------------ petty cash
export const establishPettyCashFund = secureCallable(
  z.object({
    barangayId: barangay,
    custodianId: z.string().min(1).max(200),
    fundName: z.string().trim().min(3).max(120).default('Petty Cash Fund'),
    fundAmount: positive,
    dateEstablished: isoDate,
    establishedDvId: z.string().max(200).nullish(),
    establishedDvNumber: z.string().trim().min(1).max(40),
  }),
  async (input, ctx) => {
    ctx.require('treasury.encode', input.barangayId);
    const fundRef = db.collection(COL.pettyCashFunds).doc();
    const txnRef = db.collection(COL.pettyCashTransactions).doc();
    await db.runTransaction(async (tx) => {
      const sl = await assertCashOfficer(tx, input.barangayId, input.custodianId, '1-01-01-020');
      const active = await tx.get(db.collection(COL.pettyCashFunds).where('barangayId', '==', input.barangayId).where('custodianId', '==', input.custodianId));
      if (active.docs.some((d) => d.get('status') === 'ACTIVE')) throw new BfmsError('VALIDATION_FAILED', 'This custodian already has an active petty cash fund. Close it first.');
      if (input.establishedDvId) {
        const dv = await readOwned(tx, COL.disbursementVouchers, input.establishedDvId, input.barangayId, 'Disbursement voucher');
        if (dv.get('status') === 'VOID') throw new BfmsError('INVALID_STATUS', 'The establishing DV is void.');
      }
      await assertOpen(tx, input.barangayId, input.dateEstablished);
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const now = Timestamp.now();
      const fy = Number(input.dateEstablished.slice(0, 4));
      const fund: PettyCashFundRecord & Record<string, unknown> = {
        barangayId: input.barangayId,
        fiscalYear: fy,
        custodianId: input.custodianId,
        custodianName: sl.get('subsidiaryName') as string,
        custodianCode: sl.get('subsidiaryCode') as string,
        fundName: input.fundName,
        fundAmount: input.fundAmount as Centavos,
        cashOnHand: input.fundAmount as Centavos,
        unreplenished: 0 as Centavos,
        status: 'ACTIVE',
        establishedDvId: input.establishedDvId ?? '',
        establishedDvNumber: input.establishedDvNumber,
        dateEstablished: input.dateEstablished,
        closedDate: null,
        createdAt: now,
        createdBy: ctx.uid,
        updatedAt: now,
      };
      tx.create(fundRef, fund);
      tx.create(txnRef, {
        barangayId: input.barangayId,
        fiscalYear: fy,
        accountingPeriod: periodOfDate(input.dateEstablished).key,
        pettyCashFundId: fundRef.id,
        custodianId: input.custodianId,
        kind: 'ESTABLISH',
        pcvNumber: null,
        date: input.dateEstablished,
        payee: { id: input.custodianId, name: fund.custodianName },
        particulars: `Establishment of ${input.fundName} per DV No. ${input.establishedDvNumber}`,
        accountCode: '1-01-01-020',
        amount: input.fundAmount,
        replenishmentDvId: input.establishedDvId ?? null,
        replenishmentDvNumber: input.establishedDvNumber,
        attachmentIds: [],
        status: 'APPROVED',
        revisionNumber: 0,
        jevId: null,
        createdAt: now,
        createdBy: ctx.uid,
        updatedAt: now,
        updatedBy: ctx.uid,
      } satisfies PettyCashTxnRecord & Record<string, unknown>);
      audit.write({ module: COL.pettyCashFunds, recordId: fundRef.id, action: 'CREATE', newValue: { custodianId: input.custodianId, fundAmount: input.fundAmount, establishedDvNumber: input.establishedDvNumber }, source: 'callable:establishPettyCashFund' });
      audit.commit();
    });
    return { id: fundRef.id };
  },
);

/**
 * Return the remaining cash and close the fund (or year-end return). Every PCV must be
 * replenished first, so cash on hand equals the imprest. Generates the DRAFT entry
 * Dr 1-01-01-010 (BT##) / Cr 1-01-01-020 (custodian) for the cash returned under an OR.
 */
export const closePettyCashFund = secureCallable(
  z.object({
    fundId: z.string().min(1).max(200),
    date: isoDate,
    kind: z.enum(['RETURN', 'YEAR_END_CLOSE']).default('RETURN'),
    refundOrNumber: z.string().trim().min(1).max(40),
    cashSubsidiaryId: z.string().min(1).max(200),
    remarks: z.string().trim().max(500).default(''),
  }),
  async (input, ctx) => {
    const fundRef = db.collection(COL.pettyCashFunds).doc(input.fundId);
    const txnRef = db.collection(COL.pettyCashTransactions).doc();
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(fundRef);
      if (!snap.exists) throw new HttpsError('not-found', 'Petty cash fund not found.');
      const fund = snap.data() as PettyCashFundRecord;
      ctx.require('treasury.submit', fund.barangayId);
      if (fund.status !== 'ACTIVE') throw new BfmsError('INVALID_STATUS', 'The fund is already closed.');
      if (fund.unreplenished > 0) throw new BfmsError('VALIDATION_FAILED', 'Replenish the paid petty cash vouchers before closing the fund.', { unreplenished: fund.unreplenished });
      if (input.date < fund.dateEstablished) throw new BfmsError('VALIDATION_FAILED', 'The closing date is earlier than the establishment of the fund.');
      const txns = await tx.get(db.collection(COL.pettyCashTransactions).where('barangayId', '==', fund.barangayId).where('pettyCashFundId', '==', input.fundId));
      const pending = txns.docs.filter((d) => ['SUBMITTED', 'RESUBMITTED', 'APPROVED'].includes(d.get('status') as string) && d.get('kind') === 'REPLENISH');
      const pendingPcv = txns.docs.filter((d) => d.get('kind') === 'PAYMENT' && ['DRAFT', 'SUBMITTED', 'RESUBMITTED', 'RETURNED'].includes(d.get('status') as string));
      if (pending.length || pendingPcv.length) throw new BfmsError('INVALID_STATUS', 'Finish or void the pending petty cash vouchers and replenishment requests first.');
      await assertCashOfficer(tx, fund.barangayId, input.cashSubsidiaryId);
      await assertOpen(tx, fund.barangayId, input.date);
      const audit = await AuditWriter.begin(tx, ctx, fund.barangayId);
      const now = Timestamp.now();
      const amount = fund.cashOnHand;
      const jevId = amount > 0
        ? createGeneratedJev(tx, ctx, { barangayId: fund.barangayId, sourceModule: 'PETTY_CASH', sourceDocumentId: txnRef.id }, {
            jevDate: input.date,
            fundId: 'GF',
            journal: 'GJ',
            particulars: `To record return of ${fund.fundName} of ${fund.custodianName} per OR No. ${input.refundOrNumber}`,
            primaryReference: `OR ${input.refundOrNumber}`,
            payeeName: fund.custodianName,
            lines: [
              { accountCode: '1-01-01-010', subsidiaryId: input.cashSubsidiaryId, debit: amount, credit: 0, lineDescription: 'Petty cash returned' },
              { accountCode: '1-01-01-020', subsidiaryId: fund.custodianId, debit: 0, credit: amount, lineDescription: 'Petty cash fund closed' },
            ],
          })
        : null;
      tx.create(txnRef, {
        barangayId: fund.barangayId,
        fiscalYear: Number(input.date.slice(0, 4)),
        accountingPeriod: periodOfDate(input.date).key,
        pettyCashFundId: input.fundId,
        custodianId: fund.custodianId,
        kind: input.kind,
        pcvNumber: null,
        date: input.date,
        payee: { id: fund.custodianId, name: fund.custodianName },
        particulars: input.remarks || (input.kind === 'YEAR_END_CLOSE' ? 'Year-end return of petty cash fund' : 'Return of petty cash fund'),
        accountCode: '1-01-01-020',
        amount,
        replenishmentDvId: null,
        refundOrNumber: input.refundOrNumber,
        attachmentIds: [],
        status: 'APPROVED',
        revisionNumber: 0,
        jevId,
        createdAt: now,
        createdBy: ctx.uid,
        updatedAt: now,
        updatedBy: ctx.uid,
      } satisfies PettyCashTxnRecord & Record<string, unknown>);
      tx.update(fundRef, { status: 'CLOSED', cashOnHand: 0, closedDate: input.date, updatedAt: now });
      audit.write({ module: COL.pettyCashFunds, recordId: input.fundId, action: 'EDIT', oldValue: { status: 'ACTIVE', cashOnHand: amount }, newValue: { status: 'CLOSED', returned: amount, refundOrNumber: input.refundOrNumber, jevId }, source: 'callable:closePettyCashFund' });
      audit.commit();
      return { transactionId: txnRef.id, jevId, amount };
    });
  },
);

// ------------------------------------------------------------------ special trust funds
const fundCode = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9-]{2,20}$/, 'Use letters, digits and dashes (e.g. TRUST106).'));

/** Register a Special Trust Fund received (DOH, DILG, POPCOM …) with its own Trust Liabilities ledger. */
export const registerSpecialTrustFund = secureCallable(
  z.object({
    barangayId: barangay,
    fundCode,
    fundName: z.string().trim().min(3).max(160),
    source: z.string().trim().min(2).max(80),
    purpose: z.string().trim().min(3).max(1000),
    dateReceived: isoDate,
    amountReceived: positive,
    reference: z.string().trim().max(80).default(''),
    /** When given, a DRAFT receipt entry Dr Cash in Bank / Cr Trust Liabilities is generated. */
    bankAccountId: z.string().max(200).nullish(),
  }),
  async (input, ctx) => {
    ctx.require('treasury.encode', input.barangayId);
    const id = `${input.barangayId}_STF-${input.fundCode}`;
    const ref = db.collection(COL.specialTrustFunds).doc(id);
    const slId = subsidiaryId(input.barangayId, '2-03-01-010', input.fundCode);
    return db.runTransaction(async (tx) => {
      const [snap, sl, acct] = await Promise.all([tx.get(ref), tx.get(db.collection(COL.subsidiaryAccounts).doc(slId)), tx.get(db.collection(COL.chartOfAccounts).doc('2-03-01-010'))]);
      if (snap.exists) throw new BfmsError('DUPLICATE_NUMBER', `Fund code ${input.fundCode} is already registered. Record additional receipts as an adjustment.`);
      if (!acct.exists) throw new HttpsError('failed-precondition', 'Account 2-03-01-010 Trust Liabilities is not in the Chart of Accounts.');
      const bank = input.bankAccountId ? await readOwned(tx, COL.bankAccounts, input.bankAccountId, input.barangayId, 'Bank account') : null;
      await assertOpen(tx, input.barangayId, input.dateReceived);
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const now = Timestamp.now();
      const slData = { barangayId: input.barangayId, accountCode: '2-03-01-010', subsidiaryCode: input.fundCode, subsidiaryName: `${input.fundName} (${input.source})`, type: 'SPECIAL_TRUST_FUND', partyId: id, active: true, updatedAt: now, updatedBy: ctx.uid };
      if (sl.exists) tx.update(sl.ref, slData);
      else tx.create(sl.ref, { ...slData, createdAt: now, createdBy: ctx.uid });
      const jevId = bank
        ? createGeneratedJev(tx, ctx, { barangayId: input.barangayId, sourceModule: 'STF', sourceDocumentId: id }, {
            jevDate: input.dateReceived,
            fundId: 'GF',
            journal: 'JCT',
            particulars: `To record receipt of ${input.fundName} from ${input.source} for ${input.purpose}`.slice(0, 500),
            primaryReference: input.reference || input.fundCode,
            payeeName: input.source,
            lines: [
              { accountCode: '1-01-02-010', subsidiaryId: bank.get('subsidiaryId') as string, debit: input.amountReceived, credit: 0, lineDescription: input.fundCode },
              { accountCode: '2-03-01-010', subsidiaryId: slId, debit: 0, credit: input.amountReceived, lineDescription: input.fundName },
            ],
          })
        : null;
      const entry: StfHistoryEntry = { date: input.dateReceived, kind: 'RECEIPT', amount: input.amountReceived as Centavos, reference: input.reference, reason: 'Initial receipt', by: ctx.userName, at: now.toDate().toISOString() };
      const doc: SpecialTrustFundRecord & Record<string, unknown> = {
        barangayId: input.barangayId,
        fiscalYear: Number(input.dateReceived.slice(0, 4)),
        fundId: `STF-${input.fundCode}`,
        fundCode: input.fundCode,
        fundName: input.fundName,
        source: input.source,
        purpose: input.purpose,
        dateReceived: input.dateReceived,
        amountReceived: input.amountReceived as Centavos,
        amountObligated: 0 as Centavos,
        amountDisbursed: 0 as Centavos,
        adjustments: 0 as Centavos,
        balance: input.amountReceived as Centavos,
        status: 'ACTIVE',
        subsidiaryId: slId,
        history: [entry],
        bankAccountId: input.bankAccountId ?? null,
        jevId,
        createdAt: now,
        createdBy: ctx.uid,
        updatedAt: now,
        updatedBy: ctx.uid,
      };
      tx.create(ref, doc);
      audit.write({ module: COL.specialTrustFunds, recordId: id, action: 'CREATE', newValue: { fundCode: input.fundCode, source: input.source, amountReceived: input.amountReceived, jevId }, source: 'callable:registerSpecialTrustFund' });
      audit.commit();
      return { id, jevId };
    });
  },
);

/** Additional receipts, returns to the source agency and other adjustments (with reason). */
export const adjustSpecialTrustFund = secureCallable(
  z.object({
    stfId: z.string().min(1).max(200),
    date: isoDate,
    kind: z.enum(['ADDITIONAL_RECEIPT', 'RETURN', 'OTHER_INCREASE', 'OTHER_DECREASE']),
    amount: positive,
    reference: z.string().trim().max(80).default(''),
    reason: z.string().trim().min(5, 'Please state the reason (at least 5 characters).').max(500),
  }),
  async (input, ctx) => {
    const ref = db.collection(COL.specialTrustFunds).doc(input.stfId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Special Trust Fund not found.');
      const f = snap.data() as SpecialTrustFundRecord;
      ctx.require('treasury.encode', f.barangayId);
      if (f.status === 'CLOSED') throw new BfmsError('INVALID_STATUS', 'The fund is closed.');
      if (input.date < f.dateReceived) throw new BfmsError('VALIDATION_FAILED', 'The adjustment date is earlier than the receipt of the fund.');
      const sign = STF_ADJUSTMENT_KINDS.find((k) => k.value === input.kind)!.sign;
      const adjustments = (f.adjustments + sign * input.amount) as Centavos;
      const balance = computeStfBalance({ ...f, adjustments });
      if (balance < 0) throw new BfmsError('INSUFFICIENT_STF_BALANCE', 'The decrease exceeds the unobligated balance of the fund.', { balance: f.balance, decrease: input.amount });
      await assertOpen(tx, f.barangayId, input.date);
      const audit = await AuditWriter.begin(tx, ctx, f.barangayId);
      const now = Timestamp.now();
      const entry: StfHistoryEntry = { date: input.date, kind: input.kind, amount: (sign * input.amount) as Centavos, reference: input.reference, reason: input.reason, by: ctx.userName, at: now.toDate().toISOString() };
      const history = [...(f.history ?? []), entry];
      if (history.length > 300) throw new BfmsError('TOO_MANY_LINES', 'This fund has too many adjustments; register a new fund code.');
      const status = stfStatusFor(balance, f.status, input.kind);
      tx.update(ref, { adjustments, balance, status, history, updatedAt: now, updatedBy: ctx.uid });
      audit.write({ module: COL.specialTrustFunds, recordId: input.stfId, action: 'EDIT', oldValue: { adjustments: f.adjustments, balance: f.balance, status: f.status }, newValue: { adjustments, balance, status, kind: input.kind, amount: input.amount }, reason: input.reason, source: 'callable:adjustSpecialTrustFund' });
      audit.commit();
      return { balance, status };
    });
  },
);

/** DV statuses that count as disbursed from a trust fund. */
const DISBURSED = ['APPROVED', 'ACCEPTED', 'POSTED'];

/**
 * Recompute amountDisbursed (DVs of obligations charged to each fund) and status. Budget keeps
 * amountObligated/balance current at certification; this keeps the utilization figures current.
 */
export const refreshSpecialTrustFunds = secureCallable(z.object({ barangayId: barangay }), async (input, ctx) => {
  ctx.require('read.transactions', input.barangayId);
  if (!ctx.can('treasury.encode', input.barangayId) && !ctx.can('submission.review', input.barangayId)) throw new HttpsError('permission-denied', 'Only the treasury or accounting can refresh trust fund utilization.');
  return db.runTransaction(async (tx) => {
    const [funds, obls] = await Promise.all([
      tx.get(db.collection(COL.specialTrustFunds).where('barangayId', '==', input.barangayId)),
      tx.get(db.collection(COL.obligations).where('barangayId', '==', input.barangayId)),
    ]);
    const charged = obls.docs.filter((o) => o.get('specialTrustFundId') && o.get('dvId') && o.get('status') === 'CERTIFIED');
    const dvs = await Promise.all([...new Set(charged.map((o) => o.get('dvId') as string))].map((id) => tx.get(db.collection(COL.disbursementVouchers).doc(id))));
    const dvAmount = new Map(dvs.filter((d) => d.exists && d.get('barangayId') === input.barangayId && DISBURSED.includes(d.get('status') as string)).map((d) => [d.id, (d.get('grossAmount') as number | undefined) ?? (d.get('netAmount') as number) ?? 0]));
    const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
    const now = Timestamp.now();
    let updated = 0;
    for (const f of funds.docs) {
      const fund = f.data() as SpecialTrustFundRecord;
      const amountDisbursed = charged.filter((o) => o.get('specialTrustFundId') === f.id).reduce((t, o) => t + (dvAmount.get(o.get('dvId') as string) ?? 0), 0);
      const lastKind = fund.history?.at(-1)?.kind;
      const status = stfStatusFor(fund.balance, fund.status, lastKind);
      if (amountDisbursed !== fund.amountDisbursed || status !== fund.status) {
        tx.update(f.ref, { amountDisbursed, status, updatedAt: now });
        updated++;
      }
    }
    if (updated) {
      audit.write({ module: COL.specialTrustFunds, recordId: `refresh-${manilaToday()}`, action: 'EDIT', newValue: { updated }, source: 'callable:refreshSpecialTrustFunds' });
      audit.commit();
    }
    return { funds: funds.size, updated };
  });
});

