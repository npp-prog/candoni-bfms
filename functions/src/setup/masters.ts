import { BARANGAY_IDS, COL, type BarangayId } from '@bfms/shared';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { AuditWriter } from '../audit/auditWriter';
import { db, Timestamp } from '../lib/admin';
import { secureCallable } from '../lib/callable';

/**
 * Barangay master data (Phase 2 essentials the later phases depend on): bank accounts,
 * subsidiary ledgers (accountable officers BT##, banks CIB##, AO/EO for cash advances, payees),
 * term-based signatories, and offices. All writes are server-side and audited.
 */
const barangay = z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]);
const code = z.string().trim().regex(/^[A-Z0-9-]{2,20}$/, 'Use letters, digits and dashes (e.g. BT01, CIB01).');
const accountCode = z.string().regex(/^\d-\d{2}-\d{2}-\d{3}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function subsidiaryId(barangayId: string, account: string, sub: string): string {
  return `${barangayId}_${account}_${sub}`;
}

const SL_TYPES = ['ACCOUNTABLE_OFFICER', 'EMPLOYEE', 'SUPPLIER', 'BANK', 'RECEIVABLE', 'PAYABLE', 'BIR', 'CASH_ADVANCE', 'SPECIAL_TRUST_FUND', 'GOVERNMENT_AGENCY', 'OTHER'] as const;

export const saveSubsidiaryAccount = secureCallable(
  z.object({ barangayId: barangay, accountCode, subsidiaryCode: code, subsidiaryName: z.string().trim().min(2).max(160), type: z.enum(SL_TYPES), partyId: z.string().max(128).nullable().default(null), active: z.boolean().default(true) }),
  async (input, ctx) => {
    ctx.require('barangay.setup', input.barangayId);
    const id = subsidiaryId(input.barangayId, input.accountCode, input.subsidiaryCode);
    const ref = db.collection(COL.subsidiaryAccounts).doc(id);
    await db.runTransaction(async (tx) => {
      const [snap, acct] = await Promise.all([tx.get(ref), tx.get(db.collection(COL.chartOfAccounts).doc(input.accountCode))]);
      if (!acct.exists) throw new HttpsError('failed-precondition', `Account ${input.accountCode} is not in the Chart of Accounts.`);
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const now = Timestamp.now();
      const data = { ...input, updatedAt: now, updatedBy: ctx.uid };
      if (snap.exists) tx.update(ref, data);
      else tx.create(ref, { ...data, createdAt: now, createdBy: ctx.uid });
      audit.write({ module: COL.subsidiaryAccounts, recordId: id, action: snap.exists ? 'EDIT' : 'CREATE', newValue: { ...input }, source: 'callable:saveSubsidiaryAccount' });
      audit.commit();
    });
    return { id };
  },
);

export const saveBankAccount = secureCallable(
  z.object({
    id: z.string().max(128).nullish(),
    barangayId: barangay,
    bankName: z.string().trim().min(2).max(120),
    branch: z.string().trim().max(120).default(''),
    accountName: z.string().trim().min(2).max(160),
    accountNumber: z.string().trim().min(4).max(40),
    accountType: z.enum(['CURRENT', 'SAVINGS', 'TIME_DEPOSIT']).default('CURRENT'),
    fundId: z.string().min(1).max(60).default('GF'),
    subsidiaryCode: code.default('CIB01'),
    active: z.boolean().default(true),
  }),
  async (input, ctx) => {
    ctx.require('barangay.setup', input.barangayId);
    const ref = input.id ? db.collection(COL.bankAccounts).doc(input.id) : db.collection(COL.bankAccounts).doc();
    const glAccountCode = '1-01-02-010';
    const slId = subsidiaryId(input.barangayId, glAccountCode, input.subsidiaryCode);
    await db.runTransaction(async (tx) => {
      const [snap, sl] = await Promise.all([tx.get(ref), tx.get(db.collection(COL.subsidiaryAccounts).doc(slId))]);
      if (snap.exists && snap.get('barangayId') !== input.barangayId) throw new HttpsError('permission-denied', 'Bank account belongs to another barangay.');
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const now = Timestamp.now();
      const { id: _id, subsidiaryCode, ...rest } = input;
      const data = { ...rest, glAccountCode, subsidiaryId: slId, subsidiaryCode, updatedAt: now, updatedBy: ctx.uid };
      if (snap.exists) tx.update(ref, data);
      else tx.create(ref, { ...data, createdAt: now, createdBy: ctx.uid });
      // Cash in Bank subsidiary ledger for this account (CIB##).
      const slData = { barangayId: input.barangayId, accountCode: glAccountCode, subsidiaryCode, subsidiaryName: `${input.bankName} ${input.accountNumber}`, type: 'BANK', partyId: ref.id, active: input.active, updatedAt: now, updatedBy: ctx.uid };
      if (sl.exists) tx.update(sl.ref, slData);
      else tx.create(sl.ref, { ...slData, createdAt: now, createdBy: ctx.uid });
      audit.write({ module: COL.bankAccounts, recordId: ref.id, action: snap.exists ? 'EDIT' : 'CREATE', newValue: { bankName: input.bankName, accountNumber: input.accountNumber, subsidiaryId: slId }, source: 'callable:saveBankAccount' });
      audit.commit();
    });
    return { id: ref.id, subsidiaryId: slId };
  },
);

const SIGNATORY_ROLES = ['PUNONG_BARANGAY', 'BARANGAY_TREASURER', 'BARANGAY_SECRETARY', 'APPROPRIATIONS_CHAIR', 'PROPERTY_OFFICER', 'MUNICIPAL_ACCOUNTANT', 'COA_AUDITOR'] as const;

export const saveSignatory = secureCallable(
  z.object({
    id: z.string().max(128).nullish(),
    barangayId: z.union([barangay, z.literal('MUNICIPAL')]),
    role: z.enum(SIGNATORY_ROLES),
    name: z.string().trim().min(3).max(120),
    position: z.string().trim().min(3).max(160),
    validFrom: isoDate,
    validTo: isoDate.nullable().default(null),
    active: z.boolean().default(true),
  }),
  async (input, ctx) => {
    if (input.barangayId === 'MUNICIPAL') ctx.require('admin.config.manage', 'ALL');
    else ctx.require('barangay.setup', input.barangayId);
    if (input.validTo && input.validTo < input.validFrom) throw new HttpsError('invalid-argument', 'The term cannot end before it starts.');
    const ref = input.id ? db.collection(COL.signatories).doc(input.id) : db.collection(COL.signatories).doc();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && snap.get('barangayId') !== input.barangayId) throw new HttpsError('permission-denied', 'Signatory belongs to another barangay.');
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId === 'MUNICIPAL' ? 'ALL' : input.barangayId);
      const now = Timestamp.now();
      const { id: _id, ...data } = input;
      if (snap.exists) tx.update(ref, { ...data, updatedAt: now, updatedBy: ctx.uid });
      else tx.create(ref, { ...data, createdAt: now, createdBy: ctx.uid, updatedAt: now, updatedBy: ctx.uid });
      audit.write({ module: COL.signatories, recordId: ref.id, action: snap.exists ? 'EDIT' : 'CREATE', newValue: { ...data }, source: 'callable:saveSignatory' });
      audit.commit();
    });
    return { id: ref.id };
  },
);

export const saveOffice = secureCallable(
  z.object({ id: z.string().max(128).nullish(), barangayId: barangay, officeCode: code, officeName: z.string().trim().min(2).max(160), active: z.boolean().default(true) }),
  async (input, ctx) => {
    ctx.require('barangay.setup', input.barangayId);
    const ref = input.id ? db.collection(COL.offices).doc(input.id) : db.collection(COL.offices).doc(`${input.barangayId}_${input.officeCode}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const { id: _id, ...data } = input;
      tx.set(ref, { ...data, updatedAt: Timestamp.now() }, { merge: true });
      audit.write({ module: COL.offices, recordId: ref.id, action: snap.exists ? 'EDIT' : 'CREATE', newValue: { ...data }, source: 'callable:saveOffice' });
      audit.commit();
    });
    return { id: ref.id };
  },
);
