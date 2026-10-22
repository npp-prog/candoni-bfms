import {
  BfmsError,
  CASHBOOK_ACCOUNTS,
  COL,
  assertCollectionLines,
  collectionAmount,
  type BarangayId,
  type Centavos,
  type ChartOfAccountDoc,
  type CollectionLine,
  type SubsidiaryAccountDoc,
} from '@bfms/shared';
import type { Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../../lib/admin';

/** Shared zod pieces and READ-phase helpers of the Phase 4 callables and engine modules. */
export const centavos = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const accountCode = z.string().regex(/^\d-\d{2}-\d{2}-\d{3}$/);
export const docId = z.string().min(1).max(128);
export const party = z.object({ id: z.string().max(128).nullable().default(null), name: z.string().trim().min(2).max(160), address: z.string().max(240).optional(), tin: z.string().max(30).optional() });
export const serialText = z.string().trim().regex(/^\d{1,12}$/, 'Use the digits printed on the form.');

export const collectionLine = z.object({
  accountCode,
  subsidiaryId: z.string().max(128).nullable().default(null),
  natureOfCollection: z.string().trim().max(200).default(''),
  amount: centavos.refine((v) => v > 0, 'Amount must be greater than zero.'),
});

/** Fields of an OR the encoder controls (number/series/officer are fixed once issued). */
export const collectionBody = z.object({
  collectionDate: isoDate,
  fundId: z.string().min(1).max(60).default('GF'),
  payor: party,
  paymentMethod: z.enum(['CASH', 'CHECK', 'ADA', 'BANK_TRANSFER', 'OTHER']).default('CASH'),
  checkDetails: z.object({ bank: z.string().trim().min(2).max(120), checkNumber: z.string().trim().min(1).max(40), checkDate: isoDate }).nullable().default(null),
  lines: z.array(collectionLine).min(1).max(20),
});
export type CollectionBody = z.infer<typeof collectionBody>;

/** An accountable officer / collector is a subsidiary ledger of Cash – In Local Treasury (BT##). */
export async function readCashOfficer(tx: Transaction, id: string, barangayId: BarangayId, what = 'Accountable officer'): Promise<SubsidiaryAccountDoc> {
  const snap = await tx.get(db.collection(COL.subsidiaryAccounts).doc(id));
  const sl = snap.data() as SubsidiaryAccountDoc | undefined;
  if (!sl) throw new BfmsError('VALIDATION_FAILED', `${what} ${id} is not a subsidiary ledger.`);
  if (sl.barangayId !== barangayId) throw new BfmsError('BARANGAY_MISMATCH', `${what} belongs to another barangay.`);
  if (sl.accountCode !== CASHBOOK_ACCOUNTS.CASH_IN_TREASURY) throw new BfmsError('SUBSIDIARY_MISMATCH', `${what} must be a ledger under ${CASHBOOK_ACCOUNTS.CASH_IN_TREASURY} (BT##).`);
  if (!sl.active) throw new BfmsError('SUBSIDIARY_MISMATCH', `${what} ${sl.subsidiaryCode} is inactive.`);
  return sl;
}

export const officerName = (sl: SubsidiaryAccountDoc) => `${sl.subsidiaryCode} — ${sl.subsidiaryName}`;

/**
 * Validate OR lines against the Chart of Accounts and the subsidiary master (the same checks
 * posting will run, so an RCD never produces a JEV that cannot be posted). Blank nature of
 * collection defaults to the account title.
 */
export async function checkCollectionLines(tx: Transaction, lines: CollectionBody['lines'], barangayId: BarangayId): Promise<{ lines: CollectionLine[]; amount: Centavos }> {
  assertCollectionLines(lines as CollectionLine[]);
  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const sls = [...new Set(lines.map((l) => l.subsidiaryId).filter((s): s is string => !!s))];
  const [acctSnaps, slSnaps] = await Promise.all([
    tx.getAll(...codes.map((c) => db.collection(COL.chartOfAccounts).doc(c))),
    sls.length ? tx.getAll(...sls.map((s) => db.collection(COL.subsidiaryAccounts).doc(s))) : Promise.resolve([]),
  ]);
  const accts = new Map(acctSnaps.filter((s) => s.exists).map((s) => [s.id, s.data() as ChartOfAccountDoc]));
  const slMap = new Map(slSnaps.filter((s) => s.exists).map((s) => [s.id, s.data() as SubsidiaryAccountDoc]));
  const out = lines.map((l, i): CollectionLine => {
    const a = accts.get(l.accountCode);
    if (!a) throw new BfmsError('INVALID_ACCOUNT', `Line ${i + 1}: account ${l.accountCode} is not in the Chart of Accounts.`);
    if (!a.active) throw new BfmsError('INACTIVE_ACCOUNT', `Line ${i + 1}: account ${l.accountCode} is inactive.`);
    if (a.requiresSubsidiaryLedger && !l.subsidiaryId) throw new BfmsError('SUBSIDIARY_REQUIRED', `Line ${i + 1}: account ${l.accountCode} requires a subsidiary ledger.`);
    if (l.subsidiaryId) {
      const sl = slMap.get(l.subsidiaryId);
      if (!sl || sl.barangayId !== barangayId || sl.accountCode !== l.accountCode || !sl.active)
        throw new BfmsError('SUBSIDIARY_MISMATCH', `Line ${i + 1}: subsidiary ${l.subsidiaryId} is not an active ledger of ${l.accountCode} for this barangay.`);
    }
    return { accountCode: l.accountCode, subsidiaryId: l.subsidiaryId ?? null, natureOfCollection: l.natureOfCollection || a.accountName, amount: l.amount as Centavos };
  });
  return { lines: out, amount: collectionAmount(out) };
}

/** Status an OR returns to when the report holding it is returned or voided. */
export function releasedStatus(c: { status: string; rcrId?: string | null }): string {
  if (c.status === 'CANCELLED' || c.status === 'VOID') return c.status;
  return c.rcrId ? 'SUBMITTED' : 'DRAFT';
}
