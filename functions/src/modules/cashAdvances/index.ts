import {
  BfmsError,
  COL,
  LIQUIDATION_MAX_ITEMS,
  LIQUIDATION_MODULE,
  PENDING_LIQUIDATION_STATUSES,
  PETTY_CASH_REPLENISHMENT_MODULE,
  PETTY_CASH_VOUCHER_MODULE,
  assertPettyCashAvailable,
  computeCashAdvanceBalance,
  computeLiquidation,
  liquidationJevLines,
  manilaToday,
  normalizeAgingSettings,
  type Centavos,
  type CashAdvanceRecord,
  type LiquidationRecord,
  type PettyCashFundRecord,
  type PettyCashTxnRecord,
} from '@bfms/shared';
import type { DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../../lib/admin';
import type { ServerSourceModule, SourceRecord } from '../../sources/engine';

const centavos = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = centavos.refine((v) => v > 0, 'Amount must be greater than zero.');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const accountCode = z.string().regex(/^\d-\d{2}-\d{2}-\d{3}$/);
const docId = z.string().min(1).max(200);
const optText = (max: number) => z.string().trim().max(max).nullable().default(null).transform((v) => v || null);
const party = z.object({ id: z.string().max(128).nullable().default(null), name: z.string().trim().min(2).max(160), address: z.string().max(240).optional(), tin: z.string().max(30).optional() });

/** Same-barangay read of a related document (cross-barangay references are rejected). */
export async function readOwned(tx: Transaction, collection: string, id: string, barangayId: string, what: string): Promise<DocumentSnapshot> {
  const snap = await tx.get(db.collection(collection).doc(id));
  if (!snap.exists) throw new BfmsError('VALIDATION_FAILED', `${what} not found.`);
  if (snap.get('barangayId') !== barangayId) throw new BfmsError('BARANGAY_MISMATCH', `The ${what.toLowerCase()} belongs to another barangay.`);
  return snap;
}

/**
 * Validate charged accounts and their subsidiary ledgers (READ phase). Cash and cash-advance
 * accounts cannot be charged by a liquidation/PCV: that would only move cash around.
 */
async function assertCharges(tx: Transaction, barangayId: string, charges: ReadonlyArray<{ accountCode: string; subsidiaryId: string | null }>): Promise<Map<string, string>> {
  const codes = [...new Set(charges.map((c) => c.accountCode))];
  const sls = [...new Set(charges.map((c) => c.subsidiaryId).filter((x): x is string => !!x))];
  const [accts, slSnaps] = await Promise.all([
    Promise.all(codes.map((c) => tx.get(db.collection(COL.chartOfAccounts).doc(c)))),
    Promise.all(sls.map((s) => tx.get(db.collection(COL.subsidiaryAccounts).doc(s)))),
  ]);
  const names = new Map<string, string>();
  for (const a of accts) {
    if (!a.exists || !a.get('active')) throw new BfmsError('INVALID_ACCOUNT', `Account ${a.id} is not an active account.`);
    if (/^1-01-/.test(a.id) || /^1-03-03-/.test(a.id)) throw new BfmsError('INVALID_ACCOUNT', `Account ${a.id} (cash / cash advance) cannot be charged here.`);
    names.set(a.id, a.get('accountName') as string);
  }
  const slById = new Map(slSnaps.map((s) => [s.id, s]));
  for (const c of charges) {
    const acct = accts.find((a) => a.id === c.accountCode)!;
    if (acct.get('requiresSubsidiaryLedger') && !c.subsidiaryId) throw new BfmsError('SUBSIDIARY_REQUIRED', `Account ${c.accountCode} requires a subsidiary ledger.`);
    if (c.subsidiaryId) {
      const s = slById.get(c.subsidiaryId)!;
      if (!s.exists || s.get('barangayId') !== barangayId) throw new BfmsError('SUBSIDIARY_MISMATCH', `Subsidiary ${c.subsidiaryId} not found for this barangay.`);
      if (s.get('accountCode') !== c.accountCode) throw new BfmsError('SUBSIDIARY_MISMATCH', `Subsidiary ${s.get('subsidiaryCode')} is controlled by ${s.get('accountCode')}, not ${c.accountCode}.`);
    }
  }
  return names;
}

export async function assertCashOfficer(tx: Transaction, barangayId: string, subsidiaryId: string, account = '1-01-01-010'): Promise<DocumentSnapshot> {
  const s = await tx.get(db.collection(COL.subsidiaryAccounts).doc(subsidiaryId));
  if (!s.exists || s.get('barangayId') !== barangayId || s.get('accountCode') !== account)
    throw new BfmsError('SUBSIDIARY_MISMATCH', `Select a subsidiary ledger under ${account} of this barangay.`);
  return s;
}

// ------------------------------------------------------------------ liquidation report
const itemSchema = z.object({
  date: isoDate,
  supplier: z.string().trim().max(160).default(''),
  officialReceiptNumber: optText(40),
  invoiceNumber: optText(40),
  particulars: z.string().trim().min(2).max(500),
  accountCode,
  subsidiaryId: z.string().max(200).nullable().default(null).transform((v) => v || null),
  amount: positive,
});

const liquidationSchema = z
  .object({
    cashAdvanceId: docId,
    liquidationDate: isoDate,
    items: z.array(itemSchema).max(LIQUIDATION_MAX_ITEMS, `At most ${LIQUIDATION_MAX_ITEMS} items per report; file another report for the rest.`).default([]),
    cashRefunded: centavos.default(0),
    refundOrNumber: optText(40),
    refundOrDate: isoDate.nullable().default(null),
    refundCashSubsidiaryId: z.string().max(200).nullable().default(null).transform((v) => v || null),
    remarks: z.string().trim().max(1000).default(''),
  })
  .refine((v) => v.items.length > 0 || v.cashRefunded > 0, 'Enter the supported expenditures and/or the cash refunded.')
  .refine((v) => v.cashRefunded === 0 || (!!v.refundOrNumber && !!v.refundCashSubsidiaryId), 'A refund needs the OR number and the collecting officer who received it.')
  .refine((v) => v.items.every((i) => i.date <= v.liquidationDate), 'Item dates cannot be later than the liquidation date.');

async function readCashAdvance(tx: Transaction, id: string, barangayId: string) {
  const snap = await readOwned(tx, COL.cashAdvances, id, barangayId, 'Cash advance');
  return { snap, ca: snap.data() as CashAdvanceRecord };
}

const liquidation: ServerSourceModule<typeof liquidationSchema> = {
  def: LIQUIDATION_MODULE,
  schema: liquidationSchema,
  async prepare({ input, tx, barangayId, id, existing }) {
    const { ca } = await readCashAdvance(tx, input.cashAdvanceId, barangayId);
    if (existing && existing.cashAdvanceId !== input.cashAdvanceId) throw new BfmsError('VALIDATION_FAILED', 'The cash advance of a liquidation report cannot be changed; void it and file a new one.');
    if (['FULLY_LIQUIDATED', 'CLOSED'].includes(ca.status) || ca.outstandingBalance <= 0) throw new BfmsError('INVALID_STATUS', 'This cash advance is already fully liquidated.');
    if (input.liquidationDate < ca.grantDate) throw new BfmsError('VALIDATION_FAILED', 'The liquidation date cannot be earlier than the grant of the cash advance.');
    await assertCharges(tx, barangayId, input.items);
    if (input.refundCashSubsidiaryId) await assertCashOfficer(tx, barangayId, input.refundCashSubsidiaryId);
    // Other reports still in the pipeline reserve part of the outstanding balance.
    const others = await tx.get(db.collection(COL.liquidations).where('barangayId', '==', barangayId).where('cashAdvanceId', '==', input.cashAdvanceId));
    const reserved = others.docs
      .filter((d) => d.id !== id && (PENDING_LIQUIDATION_STATUSES as readonly string[]).includes(d.get('status') as string))
      .reduce((t, d) => t + ((d.get('totalSupported') as number) ?? 0) + ((d.get('cashRefunded') as number) ?? 0), 0);
    const amounts = input.items.map((i) => i.amount as Centavos);
    computeLiquidation({ cashAdvanceOutstanding: (ca.outstandingBalance - reserved) as Centavos, itemAmounts: amounts, cashRefunded: input.cashRefunded as Centavos });
    const { totalSupported, balanceRemaining } = computeLiquidation({ cashAdvanceOutstanding: ca.outstandingBalance, itemAmounts: amounts, cashRefunded: input.cashRefunded as Centavos });
    const fields: Omit<LiquidationRecord, keyof SourceRecord | 'barangayId' | 'fiscalYear' | 'accountingPeriod' | 'status' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy' | 'revisionNumber' | 'jevId'> = {
      liquidationNumber: (existing?.liquidationNumber as string | null | undefined) ?? null,
      cashAdvanceId: input.cashAdvanceId,
      accountableOfficerId: ca.accountableOfficerId,
      accountableOfficerName: ca.accountableOfficerName,
      caAccountCode: ca.accountCode,
      caDvNumber: ca.dvNumber,
      caGrantDate: ca.grantDate,
      caPurpose: ca.purpose,
      liquidationDate: input.liquidationDate,
      items: input.items.map((i) => ({ ...i, amount: i.amount as Centavos, attachmentIds: [] })),
      itemCount: input.items.length,
      totalSupported,
      cashRefunded: input.cashRefunded as Centavos,
      refundOrNumber: input.cashRefunded ? input.refundOrNumber : null,
      refundOrDate: input.cashRefunded ? input.refundOrDate ?? input.liquidationDate : null,
      refundCashSubsidiaryId: input.cashRefunded ? input.refundCashSubsidiaryId : null,
      cashAdvanceAmount: ca.amountGranted,
      outstandingBefore: ca.outstandingBalance,
      balanceRemaining,
      remarks: input.remarks,
    };
    return fields;
  },
  numbering: { action: 'SUBMIT', docType: 'LR', field: 'liquidationNumber' },
  onAction: {
    // Acceptance applies the report to the cash advance in the same transaction (docs 05 §10).
    async ACCEPT({ tx, doc }) {
      const l = doc as unknown as SourceRecord & LiquidationRecord;
      const { snap, ca } = await readCashAdvance(tx, l.cashAdvanceId, l.barangayId);
      const settings = normalizeAgingSettings((await tx.get(db.collection(COL.systemSettings).doc('aging'))).data());
      const { totalSupported, balanceRemaining } = computeLiquidation({ cashAdvanceOutstanding: ca.outstandingBalance, itemAmounts: l.items.map((i) => i.amount), cashRefunded: l.cashRefunded });
      const amountLiquidated = (ca.amountLiquidated + totalSupported) as Centavos;
      const amountRefunded = (ca.amountRefunded + l.cashRefunded) as Centavos;
      const today = manilaToday();
      const next = computeCashAdvanceBalance({ ...ca, amountLiquidated, amountRefunded }, today < ca.grantDate ? ca.grantDate : today, settings.buckets);
      return ({ now }) => {
        tx.update(snap.ref, { amountLiquidated, amountRefunded, ...next, agingAsOf: today, lastLiquidationId: l.id, updatedAt: now });
        return { outstandingBefore: ca.outstandingBalance, balanceRemaining };
      };
    },
  },
  async jev({ tx, doc }) {
    const l = doc as unknown as SourceRecord & LiquidationRecord;
    const ca = (await tx.get(db.collection(COL.cashAdvances).doc(l.cashAdvanceId))).data() as CashAdvanceRecord | undefined;
    return {
      jevDate: l.liquidationDate,
      fundId: ca?.fundId ?? 'GF',
      journal: 'GJ',
      particulars: `To record liquidation of cash advance per DV No. ${l.caDvNumber} of ${l.accountableOfficerName} — ${l.caPurpose}`,
      primaryReference: l.liquidationNumber,
      secondaryReference: l.caDvNumber ? `DV ${l.caDvNumber}` : null,
      tertiaryReference: l.refundOrNumber ? `OR ${l.refundOrNumber}` : null,
      payeeName: l.accountableOfficerName,
      lines: liquidationJevLines({ items: l.items, cashRefunded: l.cashRefunded, refundCashSubsidiaryId: l.refundCashSubsidiaryId, caAccountCode: l.caAccountCode, officerSubsidiaryId: l.accountableOfficerId }),
    };
  },
};

// ------------------------------------------------------------------ petty cash vouchers
const pcvSchema = z.object({
  pettyCashFundId: docId,
  date: isoDate,
  payee: party,
  particulars: z.string().trim().min(3).max(1000),
  accountCode,
  subsidiaryId: z.string().max(200).nullable().default(null).transform((v) => v || null),
  amount: positive,
});

async function readFund(tx: Transaction, id: string, barangayId: string) {
  const snap = await readOwned(tx, COL.pettyCashFunds, id, barangayId, 'Petty cash fund');
  const fund = snap.data() as PettyCashFundRecord;
  return { snap, fund };
}

const pettyCashVoucher: ServerSourceModule<typeof pcvSchema> = {
  def: PETTY_CASH_VOUCHER_MODULE,
  schema: pcvSchema,
  async prepare({ input, tx, barangayId, existing }) {
    if (existing && existing.kind !== 'PAYMENT') throw new BfmsError('VALIDATION_FAILED', 'This record is not a petty cash voucher.');
    const { fund } = await readFund(tx, input.pettyCashFundId, barangayId);
    if (fund.status !== 'ACTIVE') throw new BfmsError('INVALID_STATUS', 'The petty cash fund is closed.');
    if (input.date < fund.dateEstablished) throw new BfmsError('VALIDATION_FAILED', 'The PCV date is earlier than the establishment of the fund.');
    await assertCharges(tx, barangayId, [input]);
    assertPettyCashAvailable(fund.cashOnHand, input.amount as Centavos);
    const fields: Partial<PettyCashTxnRecord> = {
      kind: 'PAYMENT',
      pettyCashFundId: input.pettyCashFundId,
      custodianId: fund.custodianId,
      pcvNumber: (existing?.pcvNumber as string | null | undefined) ?? null,
      date: input.date,
      payee: input.payee,
      particulars: input.particulars,
      accountCode: input.accountCode,
      subsidiaryId: input.subsidiaryId,
      amount: input.amount as Centavos,
      replenishmentDvId: null,
      replenishmentId: null,
      attachmentIds: [],
    } as Partial<PettyCashTxnRecord> & { subsidiaryId: string | null };
    return fields as Record<string, unknown>;
  },
  numbering: { action: 'APPROVE', docType: 'PCV', field: 'pcvNumber' },
  onAction: {
    // Payment: cash on hand goes down, unreplenished up (fund + unreplenished = imprest).
    async APPROVE({ tx, doc }) {
      const t = doc as unknown as SourceRecord & PettyCashTxnRecord;
      const { snap, fund } = await readFund(tx, t.pettyCashFundId, t.barangayId);
      if (fund.status !== 'ACTIVE') throw new BfmsError('INVALID_STATUS', 'The petty cash fund is closed.');
      assertPettyCashAvailable(fund.cashOnHand, t.amount);
      return ({ now }) => {
        tx.update(snap.ref, { cashOnHand: fund.cashOnHand - t.amount, unreplenished: fund.unreplenished + t.amount, updatedAt: now });
      };
    },
    async VOID({ tx, doc }) {
      const t = doc as unknown as SourceRecord & PettyCashTxnRecord;
      if (t.status !== 'APPROVED') return null;
      if (t.replenishmentId) throw new BfmsError('INVALID_STATUS', 'This PCV is already included in a replenishment request and can no longer be cancelled.');
      const { snap, fund } = await readFund(tx, t.pettyCashFundId, t.barangayId);
      return ({ now }) => {
        tx.update(snap.ref, { cashOnHand: fund.cashOnHand + t.amount, unreplenished: fund.unreplenished - t.amount, updatedAt: now });
      };
    },
  },
};

// ------------------------------------------------------------------ petty cash replenishment
const replenishSchema = z.object({
  pettyCashFundId: docId,
  date: isoDate,
  particulars: z.string().trim().min(3).max(1000).default('Replenishment of petty cash fund'),
});

/** Paid PCVs of the fund not yet in another replenishment request. */
async function unreplenishedPcvs(tx: Transaction, fundId: string, barangayId: string, requestId: string) {
  const q = await tx.get(db.collection(COL.pettyCashTransactions).where('barangayId', '==', barangayId).where('pettyCashFundId', '==', fundId));
  return q.docs.filter((d) => d.get('kind') === 'PAYMENT' && d.get('status') === 'APPROVED' && (!d.get('replenishmentId') || d.get('replenishmentId') === requestId));
}

function unmark(tx: Transaction, t: PettyCashTxnRecord) {
  for (const id of t.pcvIds ?? []) tx.update(db.collection(COL.pettyCashTransactions).doc(id), { replenishmentId: null });
}

const pettyCashReplenishment: ServerSourceModule<typeof replenishSchema> = {
  def: PETTY_CASH_REPLENISHMENT_MODULE,
  schema: replenishSchema,
  async prepare({ input, tx, barangayId, id, existing }) {
    if (existing && existing.kind !== 'REPLENISH') throw new BfmsError('VALIDATION_FAILED', 'This record is not a replenishment request.');
    const { fund } = await readFund(tx, input.pettyCashFundId, barangayId);
    if (fund.status !== 'ACTIVE') throw new BfmsError('INVALID_STATUS', 'The petty cash fund is closed.');
    const pcvs = await unreplenishedPcvs(tx, input.pettyCashFundId, barangayId, id);
    if (!pcvs.length) throw new BfmsError('VALIDATION_FAILED', 'There are no paid, unreplenished petty cash vouchers to replenish.');
    return {
      kind: 'REPLENISH',
      pettyCashFundId: input.pettyCashFundId,
      custodianId: fund.custodianId,
      pcvNumber: null,
      replenishmentNumber: (existing?.replenishmentNumber as string | null | undefined) ?? null,
      date: input.date,
      payee: { id: fund.custodianId, name: fund.custodianName },
      particulars: input.particulars,
      accountCode: null,
      pcvIds: pcvs.map((d) => d.id),
      amount: pcvs.reduce((t, d) => t + (d.get('amount') as number), 0),
      replenishmentDvId: null,
      replenishmentDvNumber: null,
      replenishedDate: null,
      attachmentIds: [],
    };
  },
  numbering: { action: 'SUBMIT', docType: 'PCR', field: 'replenishmentNumber' },
  actionPayload: {
    REPLENISH: z.object({ dvId: z.string().max(200).nullish(), dvNumber: z.string().trim().min(1).max(40), replenishedDate: isoDate }),
  },
  onAction: {
    // The request covers every paid PCV not in another request at the moment it is submitted.
    async SUBMIT(args) {
      return snapshotPcvs(args.tx, args.doc as unknown as SourceRecord & PettyCashTxnRecord);
    },
    async RESUBMIT(args) {
      return snapshotPcvs(args.tx, args.doc as unknown as SourceRecord & PettyCashTxnRecord);
    },
    async RETURN({ tx, doc }) {
      return () => unmark(tx, doc as unknown as PettyCashTxnRecord);
    },
    async VOID({ tx, doc }) {
      // Only submitted/approved requests have marked their PCVs (RETURN already released them).
      if (!['SUBMITTED', 'RESUBMITTED', 'APPROVED'].includes(doc.status)) return null;
      return () => unmark(tx, doc as unknown as PettyCashTxnRecord);
    },
    async REPLENISH({ tx, doc, payload }) {
      const t = doc as unknown as SourceRecord & PettyCashTxnRecord;
      const p = payload as { dvId?: string | null; dvNumber: string; replenishedDate: string };
      if (p.replenishedDate < t.date) throw new BfmsError('VALIDATION_FAILED', 'The replenishment date cannot be earlier than the request.');
      const { snap, fund } = await readFund(tx, t.pettyCashFundId, t.barangayId);
      if (p.dvId) {
        const dv = await readOwned(tx, COL.disbursementVouchers, p.dvId, t.barangayId, 'Disbursement voucher');
        if (dv.get('status') === 'VOID') throw new BfmsError('INVALID_STATUS', 'The replenishment DV is void.');
        const gross = (dv.get('grossAmount') as number | undefined) ?? 0;
        if (gross && gross !== t.amount) throw new BfmsError('VALIDATION_FAILED', `The DV amount (${gross / 100}) does not equal the replenishment (${t.amount / 100}).`);
      }
      if (fund.unreplenished < t.amount) throw new BfmsError('VALIDATION_FAILED', 'The fund\'s unreplenished amount is smaller than this request. Check for cancelled PCVs.');
      return ({ now }) => {
        tx.update(snap.ref, { cashOnHand: fund.cashOnHand + t.amount, unreplenished: fund.unreplenished - t.amount, updatedAt: now });
        for (const id of t.pcvIds ?? []) tx.update(db.collection(COL.pettyCashTransactions).doc(id), { replenishmentDvId: p.dvId ?? null, updatedAt: now });
        return { replenishmentDvId: p.dvId ?? null, replenishmentDvNumber: p.dvNumber, replenishedDate: p.replenishedDate };
      };
    },
  },
};

async function snapshotPcvs(tx: Transaction, t: SourceRecord & PettyCashTxnRecord) {
  const pcvs = await unreplenishedPcvs(tx, t.pettyCashFundId, t.barangayId, t.id);
  if (!pcvs.length) throw new BfmsError('VALIDATION_FAILED', 'There are no paid, unreplenished petty cash vouchers to replenish.');
  return () => {
    for (const d of pcvs) tx.update(d.ref, { replenishmentId: t.id });
    return { pcvIds: pcvs.map((d) => d.id), amount: pcvs.reduce((s, d) => s + (d.get('amount') as number), 0) };
  };
}

export const CASH_ADVANCES_SERVER_MODULES: ServerSourceModule[] = [liquidation, pettyCashVoucher, pettyCashReplenishment] as ServerSourceModule[];
