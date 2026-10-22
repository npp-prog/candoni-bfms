import {
  ADJUSTMENT_TYPES,
  APPROPRIATION_ADJUSTMENT_MODULE,
  APPROPRIATION_MODULE,
  BfmsError,
  COL,
  OBLIGATION_MODULE,
  assertAppropriationAvailable,
  assertStfAvailable,
  computeAppropriationBalance,
  computeStfBalance,
  manilaToday,
  expenseClassOf,
  type AppropriationAdjustmentDoc,
  type AppropriationDoc,
  type Centavos,
  type ObligationDoc,
  type RaoEntryDoc,
  type SpecialTrustFundDoc,
} from '@bfms/shared';
import type { DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db, Timestamp } from '../../lib/admin';
import type { ServerSourceModule, SourceRecord } from '../../sources/engine';

const centavos = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const accountCode = z.string().regex(/^\d-\d{2}-\d{2}-\d{3}$/);
const party = z.object({ id: z.string().max(128).nullable().default(null), name: z.string().trim().min(2).max(160), address: z.string().max(240).optional(), tin: z.string().max(30).optional() });

async function readAppropriation(tx: Transaction, id: string, barangayId: string): Promise<DocumentSnapshot> {
  const snap = await tx.get(db.collection(COL.appropriations).doc(id));
  if (!snap.exists) throw new BfmsError('VALIDATION_FAILED', 'Appropriation not found.');
  if (snap.get('barangayId') !== barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'The appropriation belongs to another barangay.');
  return snap;
}

/** Write a RAO ledger line (raoEntries are server-only, docs 02 §Budget). */
function writeRao(tx: Transaction, e: Omit<RaoEntryDoc, 'createdAt'>) {
  tx.create(db.collection(COL.raoEntries).doc(), { ...e, createdAt: Timestamp.now() });
}

/** Cancellations are recorded today, kept inside the obligation's fiscal year. */
function cancelDate(fiscalYear: number): string {
  const today = manilaToday();
  return today.startsWith(String(fiscalYear)) ? today : `${fiscalYear}-12-31`;
}

// ------------------------------------------------------------------ appropriations
const appropriationSchema = z.object({
  fiscalYear: z.number().int().min(2000).max(2100),
  appropriationOrdinanceNumber: z.string().trim().min(1).max(60),
  appropriationOrdinanceDate: isoDate,
  fundId: z.string().min(1).max(60).default('GF'),
  appropriationClass: z.enum(['REGULAR', 'SK_10PCT', 'LDRRMF_5PCT', 'DF_20PCT', 'CONTINUING', 'OTHER']),
  expenseClass: z.enum(['PS', 'MOOE', 'FE', 'CO']).optional(),
  fppId: z.string().max(60).nullable().default(null),
  program: z.string().trim().max(200).default(''),
  project: z.string().trim().max(200).default(''),
  activity: z.string().trim().max(200).default(''),
  accountCode,
  originalAppropriation: centavos.refine((v) => v > 0, 'Amount must be greater than zero.'),
});

const appropriation: ServerSourceModule<typeof appropriationSchema> = {
  def: APPROPRIATION_MODULE,
  schema: appropriationSchema,
  skipPeriodCheck: true, // year-scoped; the ordinance is often enacted in the prior December
  async prepare({ input, tx }) {
    const acct = await tx.get(db.collection(COL.chartOfAccounts).doc(input.accountCode));
    if (!acct.exists || !acct.get('active')) throw new BfmsError('INVALID_ACCOUNT', `Account ${input.accountCode} is not an active account.`);
    const figures = { originalAppropriation: input.originalAppropriation as Centavos, supplementalAppropriation: 0 as Centavos, realignment: 0 as Centavos, adjustments: 0 as Centavos, obligations: 0 as Centavos };
    const { totalAppropriation, availableBalance } = computeAppropriationBalance(figures);
    return { ...input, expenseClass: input.expenseClass ?? expenseClassOf(input.accountCode), accountName: acct.get('accountName') as string, ...figures, totalAppropriation, availableBalance };
  },
  onAction: {
    // Activation writes the opening RAO line (the appropriation column).
    async APPROVE({ tx, doc }) {
      const a = doc as unknown as SourceRecord & AppropriationDoc;
      return () => {
        writeRao(tx, {
          barangayId: a.barangayId,
          fiscalYear: a.fiscalYear,
          appropriationId: a.id,
          appropriationClass: a.appropriationClass,
          date: a.appropriationOrdinanceDate < `${a.fiscalYear}-01-01` ? `${a.fiscalYear}-01-01` : a.appropriationOrdinanceDate,
          reference: `AO ${a.appropriationOrdinanceNumber}`,
          particulars: 'Appropriation per ordinance',
          appropriation: a.originalAppropriation,
          obligation: 0 as Centavos,
          adjustment: 0 as Centavos,
          remainingBalance: a.availableBalance,
          sourceType: 'APPROPRIATION',
          sourceId: a.id,
        });
      };
    },
  },
};

// ------------------------------------------------------------------ adjustments
const adjustmentSchema = z.object({
  appropriationId: z.string().min(1).max(128),
  adjustmentType: z.enum(['SUPPLEMENTAL', 'REALIGNMENT_IN', 'REALIGNMENT_OUT', 'AUGMENTATION', 'OTHER']),
  ordinanceNumber: z.string().trim().min(1).max(60),
  ordinanceDate: isoDate,
  amount: centavos.refine((v) => v > 0, 'Amount must be greater than zero.'),
  counterpartAppropriationId: z.string().max(128).nullable().default(null),
  remarks: z.string().max(1000).default(''),
});

const adjustment: ServerSourceModule<typeof adjustmentSchema> = {
  def: APPROPRIATION_ADJUSTMENT_MODULE,
  schema: adjustmentSchema,
  skipPeriodCheck: true,
  async prepare({ input, tx, barangayId }) {
    const a = await readAppropriation(tx, input.appropriationId, barangayId);
    if (a.get('status') !== 'ACTIVE') throw new BfmsError('INVALID_STATUS', 'Only an ACTIVE appropriation can be adjusted.');
    return { ...input, fiscalYear: a.get('fiscalYear') as number, appropriationAccountCode: a.get('accountCode') as string, appropriationClass: a.get('appropriationClass') as string };
  },
  onAction: {
    async APPROVE({ tx, doc }) {
      const adj = doc as unknown as SourceRecord & AppropriationAdjustmentDoc;
      const snap = await readAppropriation(tx, adj.appropriationId, adj.barangayId);
      const a = snap.data() as AppropriationDoc;
      if (a.status !== 'ACTIVE') throw new BfmsError('INVALID_STATUS', 'The appropriation is no longer active.');
      const sign = ADJUSTMENT_TYPES.find((t) => t.value === adj.adjustmentType)?.sign ?? 1;
      const delta = sign * adj.amount;
      const figures = {
        originalAppropriation: a.originalAppropriation,
        supplementalAppropriation: (a.supplementalAppropriation + (adj.adjustmentType === 'SUPPLEMENTAL' ? adj.amount : 0)) as Centavos,
        realignment: (a.realignment + (adj.adjustmentType.startsWith('REALIGNMENT') ? delta : 0)) as Centavos,
        adjustments: (a.adjustments + (adj.adjustmentType === 'AUGMENTATION' || adj.adjustmentType === 'OTHER' ? delta : 0)) as Centavos,
        obligations: a.obligations,
      };
      const next = computeAppropriationBalance(figures);
      if (next.availableBalance < 0)
        throw new BfmsError('INSUFFICIENT_APPROPRIATION', 'The reduction exceeds the unobligated balance of the appropriation.', { available: a.availableBalance, reduction: adj.amount });
      return ({ now }) => {
        tx.update(snap.ref, { ...figures, ...next, updatedAt: now });
        writeRao(tx, {
          barangayId: adj.barangayId,
          fiscalYear: a.fiscalYear,
          appropriationId: adj.appropriationId,
          appropriationClass: a.appropriationClass,
          date: adj.ordinanceDate,
          reference: `Ord. ${adj.ordinanceNumber}`,
          particulars: ADJUSTMENT_TYPES.find((t) => t.value === adj.adjustmentType)?.label ?? adj.adjustmentType,
          appropriation: 0 as Centavos,
          obligation: 0 as Centavos,
          adjustment: delta as Centavos,
          remainingBalance: next.availableBalance,
          sourceType: 'ADJUSTMENT',
          sourceId: adj.id,
        });
      };
    },
  },
};

// ------------------------------------------------------------------ obligations
const obligationSchema = z.object({
  date: isoDate,
  payee: party,
  appropriationId: z.string().min(1).max(128),
  specialTrustFundId: z.string().max(128).nullable().default(null),
  particulars: z.string().trim().min(3).max(2000),
  amount: centavos.refine((v) => v > 0, 'Amount must be greater than zero.'),
});

const obligation: ServerSourceModule<typeof obligationSchema> = {
  def: OBLIGATION_MODULE,
  schema: obligationSchema,
  async prepare({ input, tx, barangayId }) {
    const a = await readAppropriation(tx, input.appropriationId, barangayId);
    if (a.get('status') !== 'ACTIVE') throw new BfmsError('INVALID_STATUS', 'Obligations can only be charged to an ACTIVE appropriation.');
    if (Number(input.date.slice(0, 4)) !== a.get('fiscalYear')) throw new BfmsError('PERIOD_MISMATCH', 'The obligation date must fall in the appropriation\'s fiscal year.');
    if (input.specialTrustFundId) {
      const stf = await tx.get(db.collection(COL.specialTrustFunds).doc(input.specialTrustFundId));
      if (!stf.exists || stf.get('barangayId') !== barangayId) throw new BfmsError('VALIDATION_FAILED', 'Special Trust Fund not found for this barangay.');
    }
    // Snapshot the appropriation's classification so reports read one document.
    return {
      ...input,
      fundId: a.get('fundId') as string,
      program: a.get('program') as string,
      project: a.get('project') as string,
      activity: a.get('activity') as string,
      accountCode: a.get('accountCode') as string,
      appropriationClass: a.get('appropriationClass') as string,
      expenseClass: a.get('expenseClass') as string,
      obligationNumber: null,
      certifiedBy: null,
      certifiedAt: null,
      dvId: null,
    };
  },
  numbering: { action: 'CERTIFY', docType: 'OBR', field: 'obligationNumber' },
  onAction: {
    async CERTIFY({ tx, doc }) {
      const o = doc as unknown as SourceRecord & ObligationDoc;
      const snap = await readAppropriation(tx, o.appropriationId, o.barangayId);
      const a = snap.data() as AppropriationDoc;
      if (a.status !== 'ACTIVE') throw new BfmsError('INVALID_STATUS', 'The appropriation is not active.');
      assertAppropriationAvailable(a.availableBalance, o.amount);
      let stfSnap: DocumentSnapshot | null = null;
      if (o.specialTrustFundId) {
        stfSnap = await tx.get(db.collection(COL.specialTrustFunds).doc(o.specialTrustFundId));
        const f = stfSnap.data() as SpecialTrustFundDoc | undefined;
        if (!f) throw new BfmsError('VALIDATION_FAILED', 'Special Trust Fund not found.');
        assertStfAvailable(f.balance, o.amount);
      }
      const obligations = (a.obligations + o.amount) as Centavos;
      const next = computeAppropriationBalance({ ...a, obligations });
      return ({ now, number }) => {
        tx.update(snap.ref, { obligations, ...next, updatedAt: now });
        if (stfSnap) {
          const f = stfSnap.data() as SpecialTrustFundDoc;
          const amountObligated = (f.amountObligated + o.amount) as Centavos;
          tx.update(stfSnap.ref, { amountObligated, balance: computeStfBalance({ ...f, amountObligated }), updatedAt: now });
        }
        writeRao(tx, {
          barangayId: o.barangayId,
          fiscalYear: o.fiscalYear,
          appropriationId: o.appropriationId,
          appropriationClass: a.appropriationClass,
          date: o.date,
          reference: number ?? '',
          particulars: `${o.payee.name} — ${o.particulars}`.slice(0, 500),
          appropriation: 0 as Centavos,
          obligation: o.amount,
          adjustment: 0 as Centavos,
          remainingBalance: next.availableBalance,
          sourceType: 'OBLIGATION',
          sourceId: o.id,
        });
      };
    },
    async CANCEL({ tx, doc, remarks }) {
      const o = doc as unknown as SourceRecord & ObligationDoc & { dvId?: string | null };
      if (o.dvId) {
        const dv = await tx.get(db.collection(COL.disbursementVouchers).doc(o.dvId));
        if (dv.exists && dv.get('status') !== 'VOID')
          throw new BfmsError('INVALID_STATUS', 'This obligation is already charged by a disbursement voucher. Void the DV first.');
      }
      const snap = await readAppropriation(tx, o.appropriationId, o.barangayId);
      const a = snap.data() as AppropriationDoc;
      const obligations = (a.obligations - o.amount) as Centavos;
      const next = computeAppropriationBalance({ ...a, obligations });
      const stfSnap = o.specialTrustFundId ? await tx.get(db.collection(COL.specialTrustFunds).doc(o.specialTrustFundId)) : null;
      return ({ now }) => {
        tx.update(snap.ref, { obligations, ...next, updatedAt: now });
        if (stfSnap?.exists) {
          const f = stfSnap.data() as SpecialTrustFundDoc;
          const amountObligated = (f.amountObligated - o.amount) as Centavos;
          tx.update(stfSnap.ref, { amountObligated, balance: computeStfBalance({ ...f, amountObligated }), updatedAt: now });
        }
        writeRao(tx, {
          barangayId: o.barangayId,
          fiscalYear: o.fiscalYear,
          appropriationId: o.appropriationId,
          appropriationClass: a.appropriationClass,
          date: cancelDate(o.fiscalYear),
          reference: o.obligationNumber ?? '',
          particulars: `Cancelled: ${remarks ?? ''}`.slice(0, 500),
          appropriation: 0 as Centavos,
          obligation: -o.amount as Centavos,
          adjustment: 0 as Centavos,
          remainingBalance: next.availableBalance,
          sourceType: 'OBLIGATION_CANCEL',
          sourceId: o.id,
        });
      };
    },
  },
};

export const BUDGET_SERVER_MODULES: ServerSourceModule[] = [appropriation, adjustment, obligation] as ServerSourceModule[];
