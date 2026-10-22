import {
  BARANGAY_IDS,
  BfmsError,
  COL,
  assertAfSerialRange,
  assertDepositMatches,
  assertIsoDate,
  assertPeriodAllowsEncoding,
  afRangeSize,
  afRangesOverlap,
  formatAfSerial,
  isCollectionCounted,
  parseAfSerial,
  periodDocId,
  periodOfDate,
  uniqueKeyId,
  type AccountableFormRecord,
  type BankAccountDoc,
  type BarangayId,
  type Centavos,
  type CollectionRecord,
  type DepositRecord,
  type PeriodStatus,
  type RcrDoc,
} from '@bfms/shared';
import type { DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { AuditWriter, writeWorkflowHistory } from '../../audit/auditWriter';
import { db, Timestamp } from '../../lib/admin';
import { secureCallable } from '../../lib/callable';
import type { CallerContext } from '../../lib/context';
import { SequenceAllocator } from '../../numbering/sequences';
import { centavos, checkCollectionLines, collectionBody, docId, isoDate, officerName, readCashOfficer, serialText } from './common';

/**
 * Phase 4 callables that are not plain source-document saves:
 *  - accountable forms registry (server-only collection): receive, assign, return, void a series;
 *  - issueOfficialReceipt / recordSpoiledReceipt: take a pre-printed OR number from the officer's
 *    series (uniqueKeys/OR_{bid}_{formId}_{serial}) and create the collection in one transaction;
 *  - saveDeposit: deposit slip that links official receipts (sets their depositId).
 */
const barangay = z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]);
const reason = z.string().trim().min(5, 'Please state the reason (at least 5 characters).').max(500);

async function assertEncodingOpen(tx: Transaction, barangayId: BarangayId, date: string) {
  const { fiscalYear, month } = periodOfDate(assertIsoDate(date));
  const p = await tx.get(db.collection(COL.accountingPeriods).doc(periodDocId(barangayId, fiscalYear, month)));
  assertPeriodAllowsEncoding(p.get('status') as PeriodStatus | undefined);
}

// ------------------------------------------------------------------ accountable forms

const formType = z.enum(['AF51', 'AF52', 'AF53', 'AF56', 'CTC', 'OTHER']);

/** Receive a booklet/series (serial range) into stock, optionally issuing it to an officer at once. */
export const receiveAccountableForm = secureCallable(
  z.object({
    barangayId: barangay,
    formType,
    series: z.string().trim().max(60).default(''),
    beginningSerialNumber: serialText,
    endingSerialNumber: serialText,
    dateReceived: isoDate,
    accountableOfficerId: docId.nullable().default(null),
    dateIssued: isoDate.nullable().default(null),
    remarks: z.string().trim().max(500).default(''),
  }),
  async (input, ctx) => {
    ctx.require('accountableForms.manage', input.barangayId);
    const r = { begin: parseAfSerial(input.beginningSerialNumber), end: parseAfSerial(input.endingSerialNumber) };
    assertAfSerialRange(r);
    const width = Math.max(input.beginningSerialNumber.length, input.endingSerialNumber.length);
    const ref = db.collection(COL.accountableForms).doc();
    await db.runTransaction(async (tx) => {
      const officer = input.accountableOfficerId ? await readCashOfficer(tx, input.accountableOfficerId, input.barangayId) : null;
      const same = await tx.get(db.collection(COL.accountableForms).where('barangayId', '==', input.barangayId).where('formType', '==', input.formType));
      const clash = same.docs.find((d) => d.get('status') !== 'VOID' && afRangesOverlap(r, { begin: d.get('beginningSerialNumber') as number, end: d.get('endingSerialNumber') as number }));
      if (clash) throw new BfmsError('DUPLICATE_NUMBER', `Serials ${input.beginningSerialNumber}–${input.endingSerialNumber} overlap series ${clash.get('series')} (${clash.get('beginningSerialNumber')}–${clash.get('endingSerialNumber')}).`);
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const now = Timestamp.now();
      const qty = afRangeSize(r);
      const doc: AccountableFormRecord = {
        barangayId: input.barangayId,
        fiscalYear: Number(input.dateReceived.slice(0, 4)),
        formType: input.formType,
        series: input.series || `${formatAfSerial(r.begin, width)}-${formatAfSerial(r.end, width)}`,
        serialWidth: width,
        beginningSerialNumber: r.begin,
        endingSerialNumber: r.end,
        quantityReceived: qty,
        quantityIssued: 0,
        quantityUsed: 0,
        quantityCancelled: 0,
        endingBalance: qty,
        nextSerialNumber: r.begin,
        dateReceived: input.dateReceived,
        accountableOfficerId: officer ? input.accountableOfficerId! : '',
        accountableOfficerName: officer ? officerName(officer) : null,
        dateIssued: officer ? input.dateIssued ?? input.dateReceived : null,
        remarks: input.remarks,
        status: officer ? 'ACTIVE' : 'DRAFT',
        revisionNumber: 0,
        createdAt: now,
        createdBy: ctx.uid,
        updatedAt: now,
        updatedBy: ctx.uid,
      };
      tx.create(ref, doc);
      writeWorkflowHistory(tx, ctx, { barangayId: input.barangayId, module: COL.accountableForms, recordId: ref.id, fromStatus: null, toStatus: doc.status });
      audit.write({ module: COL.accountableForms, recordId: ref.id, action: 'CREATE', newValue: { formType: doc.formType, series: doc.series, begin: r.begin, end: r.end, accountableOfficerId: doc.accountableOfficerId }, source: 'callable:receiveAccountableForm' });
      audit.commit();
    });
    return { id: ref.id };
  },
);

async function readForm(tx: Transaction, ctx: CallerContext, id: string) {
  const snap = await tx.get(db.collection(COL.accountableForms).doc(id));
  const f = snap.data() as AccountableFormRecord | undefined;
  if (!f) throw new HttpsError('not-found', 'Accountable form series not found.');
  ctx.require('accountableForms.manage', f.barangayId);
  return { snap, f };
}

function formTransition(tx: Transaction, ctx: CallerContext, snap: DocumentSnapshot, f: AccountableFormRecord, audit: AuditWriter, to: string, patch: Record<string, unknown>, remarks: string | null, source: string) {
  const now = Timestamp.now();
  tx.update(snap.ref, { ...patch, status: to, updatedAt: now, updatedBy: ctx.uid });
  writeWorkflowHistory(tx, ctx, { barangayId: f.barangayId, module: COL.accountableForms, recordId: snap.id, fromStatus: f.status, toStatus: to, remarks });
  audit.write({ module: COL.accountableForms, recordId: snap.id, action: to === 'VOID' ? 'VOID' : to === 'RETURNED' ? 'RETURN' : 'ISSUE', oldValue: { status: f.status, accountableOfficerId: f.accountableOfficerId }, newValue: { status: to, ...patch }, reason: remarks, source });
  audit.commit();
}

/** Issue (or re-issue an unused) series to an accountable officer / collector. */
export const assignAccountableForm = secureCallable(z.object({ id: docId, accountableOfficerId: docId, dateIssued: isoDate }), async (input, ctx) => {
  await db.runTransaction(async (tx) => {
    const { snap, f } = await readForm(tx, ctx, input.id);
    if (!['DRAFT', 'ACTIVE'].includes(f.status)) throw new BfmsError('INVALID_STATUS', `A ${f.status} series cannot be assigned.`);
    if (f.quantityUsed > 0) throw new BfmsError('INVALID_STATUS', 'Forms of this series were already used; return the balance and receive it again as a new series for the new officer.');
    if (input.dateIssued < f.dateReceived) throw new BfmsError('VALIDATION_FAILED', 'Forms cannot be issued before they were received.');
    const officer = await readCashOfficer(tx, input.accountableOfficerId, f.barangayId);
    const audit = await AuditWriter.begin(tx, ctx, f.barangayId);
    formTransition(tx, ctx, snap, f, audit, 'ACTIVE', { accountableOfficerId: input.accountableOfficerId, accountableOfficerName: officerName(officer), dateIssued: input.dateIssued }, null, 'callable:assignAccountableForm');
  });
  return { ok: true as const };
});

/** Return the unused balance of a series (officer leaves, forms discontinued). */
export const returnAccountableForm = secureCallable(z.object({ id: docId, date: isoDate, reason }), async (input, ctx) => {
  await db.runTransaction(async (tx) => {
    const { snap, f } = await readForm(tx, ctx, input.id);
    if (!['DRAFT', 'ACTIVE'].includes(f.status)) throw new BfmsError('INVALID_STATUS', `A ${f.status} series cannot be returned.`);
    const audit = await AuditWriter.begin(tx, ctx, f.barangayId);
    formTransition(tx, ctx, snap, f, audit, 'RETURNED', { returnedDate: input.date, remarks: input.reason }, input.reason, 'callable:returnAccountableForm');
  });
  return { ok: true as const };
});

/** Void a series encoded by mistake (only while none of its serials was used). */
export const voidAccountableForm = secureCallable(z.object({ id: docId, reason }), async (input, ctx) => {
  await db.runTransaction(async (tx) => {
    const { snap, f } = await readForm(tx, ctx, input.id);
    if (f.status === 'VOID') return;
    if (f.quantityUsed > 0) throw new BfmsError('INVALID_STATUS', 'Serials of this series were already used; return it instead.');
    const audit = await AuditWriter.begin(tx, ctx, f.barangayId);
    formTransition(tx, ctx, snap, f, audit, 'VOID', { voidReason: input.reason }, input.reason, 'callable:voidAccountableForm');
  });
  return { ok: true as const };
});

// ------------------------------------------------------------------ official receipts

const orTarget = z.object({ barangayId: barangay, collectingOfficerId: docId, accountableFormId: docId.nullish(), officialReceiptNumber: serialText });

/**
 * READ phase shared by issue/spoil: locate the officer's ACTIVE series holding the serial, refuse
 * duplicates (unique key per series) and serials outside the range.
 */
async function takeSerial(tx: Transaction, input: z.infer<typeof orTarget>, date: string) {
  const serial = parseAfSerial(input.officialReceiptNumber);
  const officer = await readCashOfficer(tx, input.collectingOfficerId, input.barangayId, 'Collecting officer');
  let form: DocumentSnapshot | undefined;
  if (input.accountableFormId) {
    form = await tx.get(db.collection(COL.accountableForms).doc(input.accountableFormId));
    if (!form.exists) throw new BfmsError('VALIDATION_FAILED', 'Accountable form series not found.');
  } else {
    const q = await tx.get(db.collection(COL.accountableForms).where('barangayId', '==', input.barangayId).where('accountableOfficerId', '==', input.collectingOfficerId));
    form = q.docs.find((d) => d.get('status') !== 'VOID' && serial >= (d.get('beginningSerialNumber') as number) && serial <= (d.get('endingSerialNumber') as number));
    if (!form) throw new BfmsError('VALIDATION_FAILED', `OR ${input.officialReceiptNumber} is not within any accountable form series issued to ${officer.subsidiaryCode}.`);
  }
  const f = form.data() as AccountableFormRecord;
  if (f.barangayId !== input.barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'The accountable form belongs to another barangay.');
  if (f.accountableOfficerId !== input.collectingOfficerId) throw new BfmsError('VALIDATION_FAILED', `Series ${f.series} is issued to another accountable officer.`);
  if (serial < f.beginningSerialNumber || serial > f.endingSerialNumber)
    throw new BfmsError('VALIDATION_FAILED', `OR ${input.officialReceiptNumber} is outside series ${f.series} (${formatAfSerial(f.beginningSerialNumber, f.serialWidth)}–${formatAfSerial(f.endingSerialNumber, f.serialWidth)}).`);
  if (f.status !== 'ACTIVE') throw new BfmsError('INVALID_STATUS', `Series ${f.series} is ${f.status}; ORs can only be issued from an ACTIVE series.`);
  if (date < (f.dateIssued ?? f.dateReceived)) throw new BfmsError('VALIDATION_FAILED', `The OR date is earlier than the date series ${f.series} was issued to the officer.`);
  const keyRef = db.collection(COL.uniqueKeys).doc(uniqueKeyId('OR', input.barangayId, form.id, serial));
  const key = await tx.get(keyRef);
  if (key.exists) throw new BfmsError('DUPLICATE_NUMBER', `OR ${input.officialReceiptNumber} of series ${f.series} was already used.`, { collectionId: key.get('documentId') });
  await assertEncodingOpen(tx, input.barangayId, date);
  const orNumber = formatAfSerial(serial, f.serialWidth);
  return {
    serial,
    orNumber,
    officer,
    form,
    f,
    /** WRITE phase: unique key + series counters. */
    consume(collectionId: string, cancelled: boolean, now: FirebaseFirestore.Timestamp) {
      tx.create(keyRef, { key: orNumber, collection: COL.collections, documentId: collectionId, barangayId: input.barangayId, createdAt: now });
      const quantityUsed = f.quantityUsed + 1;
      const endingBalance = f.quantityReceived - quantityUsed;
      tx.update(form!.ref, {
        quantityUsed,
        quantityIssued: f.quantityIssued + (cancelled ? 0 : 1),
        quantityCancelled: f.quantityCancelled + (cancelled ? 1 : 0),
        endingBalance,
        nextSerialNumber: Math.max(f.nextSerialNumber, serial + 1),
        status: endingBalance <= 0 ? 'EXHAUSTED' : f.status,
        updatedAt: now,
      });
    },
  };
}

function collectionBase(input: z.infer<typeof orTarget>, t: Awaited<ReturnType<typeof takeSerial>>, ctx: CallerContext, date: string, now: FirebaseFirestore.Timestamp) {
  const { key } = periodOfDate(date);
  return {
    barangayId: input.barangayId,
    fiscalYear: Number(date.slice(0, 4)),
    accountingPeriod: key,
    collectionDate: date,
    officialReceiptNumber: t.orNumber,
    serialNumber: t.serial,
    accountableFormId: t.form.id,
    accountableFormSeries: t.f.series,
    accountableFormType: t.f.formType,
    collectingOfficerId: input.collectingOfficerId,
    collectingOfficerName: officerName(t.officer),
    depositId: null,
    rcdId: null,
    rcrId: null,
    jevId: null,
    revisionNumber: 0,
    createdAt: now,
    createdBy: ctx.uid,
    updatedAt: now,
    updatedBy: ctx.uid,
  };
}

/** Issue an official receipt: the OR is official at once (status DRAFT = issued, not yet reported). */
export const issueOfficialReceipt = secureCallable(orTarget.merge(collectionBody), async (input, ctx) => {
  ctx.require('treasury.encode', input.barangayId);
  const ref = db.collection(COL.collections).doc();
  const out = await db.runTransaction(async (tx) => {
    const t = await takeSerial(tx, input, input.collectionDate);
    const { lines, amount } = await checkCollectionLines(tx, input.lines, input.barangayId);
    const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
    const now = Timestamp.now();
    const doc: CollectionRecord = {
      ...collectionBase(input, t, ctx, input.collectionDate, now),
      fundId: input.fundId,
      payor: input.payor,
      paymentMethod: input.paymentMethod,
      checkDetails: input.paymentMethod === 'CHECK' ? input.checkDetails : null,
      lines,
      amount,
      cancelReason: null,
      status: 'DRAFT',
    };
    tx.create(ref, doc);
    t.consume(ref.id, false, now);
    audit.write({ module: COL.collections, recordId: ref.id, action: 'CREATE', newValue: { officialReceiptNumber: t.orNumber, collectionDate: input.collectionDate, payor: input.payor.name, amount, collectingOfficerId: input.collectingOfficerId }, source: 'callable:issueOfficialReceipt' });
    audit.commit();
    return { officialReceiptNumber: t.orNumber, amount, nextSerialNumber: t.serial + 1 <= t.f.endingSerialNumber ? formatAfSerial(t.serial + 1, t.f.serialWidth) : null };
  });
  return { id: ref.id, ...out };
});

/** Record a spoiled/cancelled pre-printed OR that was never issued, so the series has no gap. */
export const recordSpoiledReceipt = secureCallable(orTarget.extend({ date: isoDate, reason }), async (input, ctx) => {
  ctx.require('treasury.encode', input.barangayId);
  const ref = db.collection(COL.collections).doc();
  await db.runTransaction(async (tx) => {
    const t = await takeSerial(tx, input, input.date);
    const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
    const now = Timestamp.now();
    const doc: CollectionRecord = {
      ...collectionBase(input, t, ctx, input.date, now),
      fundId: 'GF',
      payor: { id: null, name: 'CANCELLED' },
      paymentMethod: 'CASH',
      checkDetails: null,
      lines: [],
      amount: 0 as Centavos,
      cancelReason: input.reason,
      voidReason: input.reason,
      voidedBy: ctx.uid,
      voidedAt: now,
      status: 'CANCELLED',
    };
    tx.create(ref, doc);
    t.consume(ref.id, true, now);
    writeWorkflowHistory(tx, ctx, { barangayId: input.barangayId, module: COL.collections, recordId: ref.id, fromStatus: null, toStatus: 'CANCELLED', remarks: input.reason });
    audit.write({ module: COL.collections, recordId: ref.id, action: 'CANCEL', newValue: { officialReceiptNumber: t.orNumber, status: 'CANCELLED' }, reason: input.reason, source: 'callable:recordSpoiledReceipt' });
    audit.commit();
  });
  return { id: ref.id };
});

// ------------------------------------------------------------------ deposits

/**
 * Create/edit a DRAFT deposit slip. The ORs must be of this barangay, counted (not cancelled/void),
 * not on another slip, dated on/before the deposit, and in the officer's custody (own ORs or ORs
 * remitted to the officer through an RCR). The slip amount must equal the ORs.
 */
export const saveDeposit = secureCallable(
  z.object({
    id: docId.nullish(),
    barangayId: barangay,
    accountableOfficerId: docId,
    depositDate: isoDate,
    bankAccountId: docId,
    depositSlipNumber: z.string().trim().min(1).max(40),
    fundId: z.string().min(1).max(60).default('GF'),
    collectionIds: z.array(docId).min(1, 'Select the official receipts deposited.').max(300),
    amount: centavos,
    validatedAmount: centavos.nullable().default(null),
  }),
  async (input, ctx) => {
    ctx.require('treasury.encode', input.barangayId);
    if (new Set(input.collectionIds).size !== input.collectionIds.length) throw new HttpsError('invalid-argument', 'An official receipt is listed twice.');
    const ref = input.id ? db.collection(COL.deposits).doc(input.id) : db.collection(COL.deposits).doc();
    const fiscalYear = Number(input.depositDate.slice(0, 4));
    await db.runTransaction(async (tx) => {
      let existing: (DepositRecord & { id: string }) | null = null;
      if (input.id) {
        const s = await tx.get(ref);
        if (!s.exists) throw new HttpsError('not-found', 'Deposit not found.');
        existing = { ...(s.data() as DepositRecord), id: s.id };
        if (existing.barangayId !== input.barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'The barangay of a record cannot be changed.');
        if (existing.status !== 'DRAFT') throw new BfmsError('INVALID_STATUS', `A ${existing.status} deposit can no longer be edited.`);
        if (existing.fiscalYear !== fiscalYear) throw new BfmsError('PERIOD_MISMATCH', 'A deposit cannot be moved to another fiscal year.');
      }
      const officer = await readCashOfficer(tx, input.accountableOfficerId, input.barangayId);
      const bank = await tx.get(db.collection(COL.bankAccounts).doc(input.bankAccountId));
      const b = bank.data() as BankAccountDoc | undefined;
      if (!b) throw new BfmsError('VALIDATION_FAILED', 'Bank account not found.');
      if (b.barangayId !== input.barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'The bank account belongs to another barangay.');
      if (!b.active) throw new BfmsError('VALIDATION_FAILED', 'The bank account is inactive.');
      const snaps = await tx.getAll(...input.collectionIds.map((id) => db.collection(COL.collections).doc(id)));
      const colls = snaps.map((s) => {
        if (!s.exists) throw new BfmsError('VALIDATION_FAILED', `Official receipt ${s.id} not found.`);
        return { ...(s.data() as CollectionRecord), id: s.id };
      });
      const rcrIds = [...new Set(colls.map((c) => c.rcrId).filter((x): x is string => !!x))];
      const rcrs = new Map((rcrIds.length ? await tx.getAll(...rcrIds.map((id) => db.collection(COL.rcrReports).doc(id))) : []).map((s) => [s.id, s.data() as RcrDoc | undefined]));
      const removed = existing ? await Promise.all(existing.collectionIds.filter((id) => !input.collectionIds.includes(id)).map((id) => tx.get(db.collection(COL.collections).doc(id)))) : [];
      for (const c of colls) {
        if (c.barangayId !== input.barangayId) throw new BfmsError('BARANGAY_MISMATCH', `OR ${c.officialReceiptNumber} belongs to another barangay.`);
        if (!isCollectionCounted(c.status)) throw new BfmsError('INVALID_STATUS', `OR ${c.officialReceiptNumber} is ${c.status} and cannot be deposited.`);
        if (c.depositId && c.depositId !== ref.id) throw new BfmsError('VALIDATION_FAILED', `OR ${c.officialReceiptNumber} is already on another deposit slip.`);
        if (c.collectionDate > input.depositDate) throw new BfmsError('VALIDATION_FAILED', `OR ${c.officialReceiptNumber} is dated after the deposit.`);
        const rc = c.rcrId ? rcrs.get(c.rcrId) : undefined;
        const custodian = c.collectingOfficerId === input.accountableOfficerId || (rc && rc.receivingOfficerId === input.accountableOfficerId && ['SUBMITTED', 'RESUBMITTED', 'ACCEPTED'].includes(rc.status));
        if (!custodian) throw new BfmsError('VALIDATION_FAILED', `OR ${c.officialReceiptNumber} is not in the custody of ${officer.subsidiaryCode} (collected by another officer and not remitted to them).`);
      }
      const total = colls.reduce((t, c) => t + c.amount, 0) as Centavos;
      assertDepositMatches(input.amount as Centavos, total);
      await assertEncodingOpen(tx, input.barangayId, input.depositDate);
      const seq = existing ? null : await SequenceAllocator.read(tx, input.barangayId, fiscalYear, 'DEP');
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);

      const now = Timestamp.now();
      const { id: _id, ...rest } = input;
      const body = { ...rest, fiscalYear, accountingPeriod: periodOfDate(input.depositDate).key, bankLabel: `${b.bankName} ••••${b.accountNumber.slice(-4)}`, updatedAt: now, updatedBy: ctx.uid };
      if (existing) tx.update(ref, body);
      else {
        const depositNumber = seq!.allocate(Number(input.depositDate.slice(5, 7)), COL.deposits, ref.id);
        seq!.commit();
        tx.create(ref, { ...body, depositNumber, attachmentIds: [], rcdId: null, jevId: null, status: 'DRAFT', revisionNumber: 0, createdAt: now, createdBy: ctx.uid });
      }
      for (const s of snaps) if (s.get('depositId') !== ref.id) tx.update(s.ref, { depositId: ref.id, updatedAt: now });
      for (const s of removed) if (s.exists && s.get('depositId') === ref.id) tx.update(s.ref, { depositId: null, updatedAt: now });
      audit.write({ module: COL.deposits, recordId: ref.id, action: existing ? 'EDIT' : 'CREATE', oldValue: existing ? { amount: existing.amount, collectionIds: existing.collectionIds } : null, newValue: { depositSlipNumber: input.depositSlipNumber, amount: input.amount, collectionIds: input.collectionIds, bankAccountId: input.bankAccountId }, source: 'callable:saveDeposit' });
      audit.commit();
    });
    return { id: ref.id };
  },
);
