import {
  BARANGAY_IDS,
  BIO_KINDS,
  BfmsError,
  COL,
  PROPERTY_COL,
  applyBioMovement,
  depreciationFor,
  hasDepreciationGap,
  lastDayOfMonth,
  manilaToday,
  monthLabel,
  periodOfDate,
  roundQty,
  uniqueKeyId,
  yearMonth,
  type BarangayId,
  type BiologicalAssetDoc,
  type BioMovement,
  type Centavos,
  type DepreciationRunDoc,
  type InventoryTxRecord,
  type PpeDepreciationDoc,
  type PpeRecord,
} from '@bfms/shared';
import { z } from 'zod';
import { AuditWriter } from '../../audit/auditWriter';
import { db, Timestamp } from '../../lib/admin';
import { secureCallable } from '../../lib/callable';
import { SequenceAllocator, assertUniqueAvailable } from '../../numbering/sequences';
import { createGeneratedJev, type GeneratedJevLine } from '../../sources/jev';
import { InventoryPoster, assertOpenPeriod, centavos, isoDate, qty, readOwned, text } from './support';

const barangayId = z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]);

/** Item master (stock cards). Stock no. is unique per barangay and fixed once created; quantities are server-maintained. */
export const saveInventoryItem = secureCallable(
  z.object({
    id: z.string().max(128).nullish(),
    barangayId,
    stockNumber: z.string().trim().min(1).max(40),
    description: z.string().trim().min(2).max(300),
    unit: z.string().trim().min(1).max(30),
    accountCode: z.string().regex(/^1-04-\d{2}-\d{3}$/, 'Use an inventory account (1-04-xx-xxx).'),
    itemClass: z.enum(['CONSUMABLE', 'SEMI_EXPENDABLE']),
    reorderPoint: z.number().min(0).max(1_000_000).default(0),
    active: z.boolean().default(true),
    /** Balance forwarded when the stock card is opened (create only). */
    opening: z.object({ date: isoDate, quantity: qty, unitCost: centavos }).nullish(),
  }),
  async (input, ctx) => {
    ctx.require('property.manage', input.barangayId);
    const ref = input.id ? db.collection(COL.inventoryItems).doc(input.id) : db.collection(COL.inventoryItems).doc();
    await db.runTransaction(async (tx) => {
      const snap = input.id ? await tx.get(ref) : null;
      if (snap && (!snap.exists || snap.get('barangayId') !== input.barangayId)) throw new BfmsError('VALIDATION_FAILED', 'Inventory item not found.');
      if (snap && snap.get('stockNumber') !== input.stockNumber) throw new BfmsError('VALIDATION_FAILED', 'The stock number of an existing stock card cannot be changed.');
      const acct = await tx.get(db.collection(COL.chartOfAccounts).doc(input.accountCode));
      if (!acct.exists || !acct.get('active')) throw new BfmsError('INVALID_ACCOUNT', `Account ${input.accountCode} is not an active account.`);
      const keyRef = snap ? null : await assertUniqueAvailable(tx, uniqueKeyId('STOCKNO', input.barangayId, input.stockNumber.toUpperCase()));
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const now = Timestamp.now();
      const fields = { stockNumber: input.stockNumber, description: input.description, unit: input.unit, accountCode: input.accountCode, itemClass: input.itemClass, reorderPoint: input.reorderPoint, active: input.active, updatedAt: now, updatedBy: ctx.uid };
      if (snap) {
        tx.update(ref, fields);
        audit.write({ module: COL.inventoryItems, recordId: ref.id, action: 'EDIT', oldValue: { description: snap.get('description'), reorderPoint: snap.get('reorderPoint'), active: snap.get('active') }, newValue: { description: input.description, reorderPoint: input.reorderPoint, active: input.active }, source: 'callable:saveInventoryItem' });
      } else {
        const o = input.opening;
        const q = o ? roundQty(o.quantity) : 0;
        tx.create(ref, { ...fields, barangayId: input.barangayId, fiscalYear: Number(manilaToday().slice(0, 4)), quantityOnHand: q, unitCost: o?.unitCost ?? 0, txCount: o ? 1 : 0, lastCount: null, createdAt: now, createdBy: ctx.uid });
        tx.create(keyRef!, { key: input.stockNumber, collection: COL.inventoryItems, documentId: ref.id, barangayId: input.barangayId, createdAt: now });
        if (o) {
          const line: Omit<InventoryTxRecord, 'createdAt' | 'updatedAt'> = {
            barangayId: input.barangayId, fiscalYear: periodOfDate(o.date).fiscalYear, itemId: ref.id, date: o.date, kind: 'RECEIPT', referenceType: 'ADJ', referenceNumber: 'Balance forwarded',
            quantity: q, unitCost: o.unitCost as Centavos, totalCost: Math.round(q * o.unitCost) as Centavos, officeId: null, balanceQuantity: q, balanceUnitCost: o.unitCost as Centavos, seq: 1,
            stockNumber: input.stockNumber, description: input.description, unit: input.unit, accountCode: input.accountCode, itemClass: input.itemClass, office: '', remarks: 'Opening balance', sourceCollection: null, sourceId: null, createdBy: ctx.uid, updatedBy: ctx.uid,
          };
          tx.create(db.collection(COL.inventoryTransactions).doc(), { ...line, createdAt: now, updatedAt: now });
        }
        audit.write({ module: COL.inventoryItems, recordId: ref.id, action: 'CREATE', newValue: { stockNumber: input.stockNumber, description: input.description, openingQuantity: q }, source: 'callable:saveInventoryItem' });
      }
      audit.commit();
    });
    return { id: ref.id };
  },
);

/** Stock adjustment (count difference, spoilage) or return of unused supplies (RRSP) on a stock card. */
export const postStockAdjustment = secureCallable(
  z.object({
    barangayId,
    itemId: z.string().min(1).max(128),
    date: isoDate,
    kind: z.enum(['ADJUSTMENT', 'RETURN']),
    quantity: z.number().refine((v) => v !== 0 && Math.abs(v) <= 1_000_000, 'Quantity must not be zero.'),
    unitCost: centavos.nullish(),
    reference: text(60),
    office: text(160),
    remarks: z.string().trim().min(5, 'State the reason (at least 5 characters).').max(500),
  }),
  async (input, ctx) => {
    ctx.require('property.manage', input.barangayId);
    if (input.kind === 'RETURN' && input.quantity < 0) throw new BfmsError('VALIDATION_FAILED', 'A return increases stock; enter a positive quantity.');
    return db.runTransaction(async (tx) => {
      await assertOpenPeriod(tx, input.barangayId, input.date);
      const poster = await InventoryPoster.read(tx, input.barangayId, ctx.uid, [input.itemId]);
      const meta = { date: input.date, kind: input.kind, referenceType: input.kind === 'RETURN' ? ('RRSP' as const) : ('ADJ' as const), referenceNumber: input.reference, office: input.office, remarks: input.remarks, sourceCollection: null, sourceId: null };
      poster.adjust(input.itemId, input.quantity, meta, (input.unitCost ?? undefined) as Centavos | undefined);
      const after = poster.item(input.itemId);
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      poster.commit();
      audit.write({ module: COL.inventoryTransactions, recordId: input.itemId, action: 'CREATE', newValue: { kind: input.kind, quantity: input.quantity, balance: after.quantityOnHand }, reason: input.remarks, source: 'callable:postStockAdjustment' });
      audit.commit();
      return { quantityOnHand: after.quantityOnHand, unitCost: after.unitCost };
    });
  },
);

/** Physical count result for the RPCI (stock item) or RPCPPE (PPE record). */
export const recordPhysicalCount = secureCallable(
  z.object({
    barangayId,
    target: z.enum(['ITEM', 'PPE']),
    id: z.string().min(1).max(128),
    date: isoDate,
    quantity: z.number().min(0).max(1_000_000).optional(),
    found: z.boolean().optional(),
    condition: text(60),
    remarks: text(500),
  }),
  async (input, ctx) => {
    ctx.require('property.manage', input.barangayId);
    await db.runTransaction(async (tx) => {
      const snap = await readOwned(tx, input.target === 'ITEM' ? COL.inventoryItems : COL.ppe, input.id, input.barangayId, input.target === 'ITEM' ? 'Inventory item' : 'PPE');
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const lastCount =
        input.target === 'ITEM'
          ? { date: input.date, quantity: roundQty(input.quantity ?? 0), remarks: input.remarks }
          : { date: input.date, found: input.found ?? true, condition: input.condition || 'Serviceable', remarks: input.remarks };
      tx.update(snap.ref, { lastCount, updatedAt: Timestamp.now(), updatedBy: ctx.uid });
      audit.write({ module: snap.ref.parent.id, recordId: snap.id, action: 'EDIT', oldValue: { lastCount: snap.get('lastCount') ?? null }, newValue: { lastCount }, source: 'callable:recordPhysicalCount' });
      audit.commit();
    });
    return { ok: true };
  },
);

/**
 * Monthly depreciation (docs 04 §9): straight line for every ACTIVE PPE from its start period.
 * Idempotent: the run document `depreciationRuns/{bid}_{fy}_{mm}` and the per-asset
 * `ppeDepreciation/{ppeId}_{fy}_{mm}` documents exist once. A rerun never re-depreciates an asset:
 * it returns the existing run, or — when PPE was accepted into an already-run month afterwards —
 * depreciates only those assets with a supplementary DRAFT JEV recorded on the same run.
 * Creates a DRAFT GJ (Dr 5-04-01-xxx / Cr 1-07-xx-xx1) per fund for accounting to approve and post.
 */
export const runMonthlyDepreciation = secureCallable(
  z.object({ barangayId, fiscalYear: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) }),
  async (input, ctx) => {
    ctx.require('jev.prepare', input.barangayId);
    const { barangayId: bid, fiscalYear: fy, month } = input;
    const period = yearMonth(fy, month);
    const runId = `${bid}_${fy}_${String(month).padStart(2, '0')}`;
    const runRef = db.collection(PROPERTY_COL.depreciationRuns).doc(runId);
    return db.runTransaction(async (tx) => {
      const existingSnap = await tx.get(runRef);
      const existing = existingSnap.exists ? (existingSnap.data() as DepreciationRunDoc & { runNumber: string }) : null;
      const jevDate = lastDayOfMonth(fy, month);
      await assertOpenPeriod(tx, bid, jevDate);
      const ppeSnap = await tx.get(db.collection(COL.ppe).where('barangayId', '==', bid).where('status', '==', 'ACTIVE'));
      const assets = ppeSnap.docs
        .map((d) => ({ ref: d.ref, p: d.data() as PpeRecord }))
        .filter(({ p }) => p.depreciationExpenseAccountCode && p.accumulatedDepreciationAccountCode && p.depreciationStartPeriod <= period);
      const gaps = assets.filter(({ p }) => hasDepreciationGap(p, period));
      if (gaps.length)
        throw new BfmsError('VALIDATION_FAILED', `Depreciation for the month before ${period} has not been recorded for ${gaps.length} asset(s) (e.g. ${gaps.slice(0, 3).map(({ p }) => `${p.propertyNumber} last ${p.lastDepreciatedPeriod ?? 'never'}`).join(', ')}). Run the earlier months first, or enter the opening accumulated depreciation on the PPE record.`);
      const depRefs = assets.map(({ ref }) => db.collection(COL.ppeDepreciation).doc(`${ref.id}_${fy}_${String(month).padStart(2, '0')}`));
      const depSnaps = depRefs.length ? await tx.getAll(...depRefs) : [];
      const rows = assets
        .map((a, i) => ({ ...a, depRef: depRefs[i]!, done: depSnaps[i]!.exists, amount: depreciationFor(a.p, period) }))
        .filter((r) => !r.done && r.amount > 0);
      if (existing && !rows.length) return { runId, alreadyRun: true, supplementary: false, jevId: existing.jevId, jevIds: existing.jevIds, itemCount: existing.itemCount, totalDepreciation: existing.totalDepreciation };
      const seq = existing ? null : await SequenceAllocator.read(tx, bid, fy, 'DEPR');
      const audit = await AuditWriter.begin(tx, ctx, bid);

      // ---- compute (pure)
      const byFund = new Map<string, GeneratedJevLine[]>();
      const recap = new Map<string, { depreciationExpenseAccountCode: string; accumulatedDepreciationAccountCode: string; amount: number }>();
      for (const r of rows) {
        const lines = byFund.get(r.p.fundId || 'GF') ?? [];
        lines.push({ accountCode: r.p.depreciationExpenseAccountCode, debit: r.amount, credit: 0 }, { accountCode: r.p.accumulatedDepreciationAccountCode, debit: 0, credit: r.amount });
        byFund.set(r.p.fundId || 'GF', lines);
        const k = `${r.p.depreciationExpenseAccountCode}|${r.p.accumulatedDepreciationAccountCode}`;
        const c = recap.get(k) ?? { depreciationExpenseAccountCode: r.p.depreciationExpenseAccountCode, accumulatedDepreciationAccountCode: r.p.accumulatedDepreciationAccountCode, amount: 0 };
        c.amount += r.amount;
        recap.set(k, c);
      }
      const total = rows.reduce((t, r) => t + r.amount, 0) as Centavos;

      // ---- write
      const now = Timestamp.now();
      const runNumber = existing ? existing.runNumber : seq!.allocate(month, PROPERTY_COL.depreciationRuns, runId);
      seq?.commit();
      const jevIds: string[] = [];
      for (const [fundId, lines] of [...byFund.entries()].sort()) {
        jevIds.push(
          createGeneratedJev(tx, ctx, { barangayId: bid, sourceModule: 'DEPRECIATION', sourceDocumentId: runId }, {
            jevDate,
            fundId,
            journal: 'GJ',
            particulars: `To record ${existing ? 'supplementary ' : ''}depreciation of property, plant and equipment for the month of ${monthLabel(fy, month)} (${rows.filter((r) => (r.p.fundId || 'GF') === fundId).length} assets, straight-line method).`,
            primaryReference: runNumber,
            lines,
          }),
        );
      }
      for (const r of rows) {
        const accumulated = (r.p.accumulatedDepreciation + r.amount) as Centavos;
        const dep: PpeDepreciationDoc = {
          barangayId: bid, fiscalYear: fy, ppeId: r.ref.id, propertyNumber: r.p.propertyNumber, period, month, amount: r.amount, accumulatedAfter: accumulated,
          accountCode: r.p.accountCode, accumulatedDepreciationAccountCode: r.p.accumulatedDepreciationAccountCode, depreciationExpenseAccountCode: r.p.depreciationExpenseAccountCode, runId, createdAt: now,
        };
        tx.create(r.depRef, dep);
        tx.update(r.ref, { accumulatedDepreciation: accumulated, netBookValue: r.p.acquisitionCost - accumulated, lastDepreciatedPeriod: period, updatedAt: now });
      }
      if (existing) {
        for (const l of existing.lines) {
          const k = `${l.depreciationExpenseAccountCode}|${l.accumulatedDepreciationAccountCode}`;
          const c = recap.get(k) ?? { ...l, amount: 0 };
          c.amount += l.amount;
          recap.set(k, c);
        }
      }
      const allJevs = [...(existing?.jevIds ?? []), ...jevIds];
      const run: DepreciationRunDoc & { runNumber: string; jevDate: string; supplements: number } = {
        barangayId: bid, fiscalYear: fy, month, period, status: 'GENERATED', itemCount: (existing?.itemCount ?? 0) + rows.length, totalDepreciation: ((existing?.totalDepreciation ?? 0) + total) as Centavos,
        jevId: existing?.jevId ?? jevIds[0] ?? null, jevIds: allJevs, lines: [...recap.values()].map((l) => ({ ...l, amount: l.amount as Centavos })), runNumber, jevDate,
        supplements: existing ? ((existing as { supplements?: number }).supplements ?? 0) + 1 : 0, createdAt: existing?.createdAt ?? now, createdBy: existing?.createdBy ?? ctx.uid, updatedAt: now, updatedBy: ctx.uid,
      };
      tx.set(runRef, run);
      audit.write({ module: PROPERTY_COL.depreciationRuns, recordId: runId, action: 'GENERATE', newValue: { period, supplementary: !!existing, itemCount: rows.length, totalDepreciation: total, jevIds: jevIds.join(',') }, source: 'callable:runMonthlyDepreciation' });
      audit.commit();
      return { runId, alreadyRun: false, supplementary: !!existing, jevId: jevIds[0] ?? null, jevIds, itemCount: rows.length, totalDepreciation: total };
    });
  },
  { timeoutSeconds: 120 },
);

/** Births, purchases, deaths and dispositions of a biological asset (BAPC lines). */
export const recordBiologicalMovement = secureCallable(
  z.object({
    barangayId,
    assetId: z.string().min(1).max(128),
    date: isoDate,
    kind: z.enum(BIO_KINDS),
    quantity: z.number().int().positive().max(100_000),
    amount: centavos.default(0),
    reference: text(60),
    remarks: text(500),
  }),
  async (input, ctx) => {
    ctx.require('property.manage', input.barangayId);
    return db.runTransaction(async (tx) => {
      const snap = await readOwned(tx, COL.biologicalAssets, input.assetId, input.barangayId, 'Biological asset');
      const a = snap.data() as BiologicalAssetDoc;
      if (a.status !== 'ACTIVE') throw new BfmsError('INVALID_STATUS', `The asset is ${a.status}; only ACTIVE assets record movements.`);
      if (input.date < a.acquisitionDate) throw new BfmsError('VALIDATION_FAILED', 'The movement date is earlier than the acquisition date.');
      await assertOpenPeriod(tx, input.barangayId, input.date);
      const next = applyBioMovement({ quantityOnHand: a.quantityOnHand, carryingAmount: a.carryingAmount }, input.kind, input.quantity, input.amount);
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const m: BioMovement = { seq: (a.movements?.length ?? 0) + 1, date: input.date, kind: input.kind, quantity: input.quantity, amount: next.amount, reference: input.reference, remarks: input.remarks, balanceQuantity: next.quantityOnHand, balanceAmount: next.carryingAmount };
      tx.update(snap.ref, { quantityOnHand: next.quantityOnHand, carryingAmount: next.carryingAmount, movements: [...(a.movements ?? []), m], updatedAt: Timestamp.now(), updatedBy: ctx.uid });
      audit.write({ module: COL.biologicalAssets, recordId: snap.id, action: 'EDIT', oldValue: { quantityOnHand: a.quantityOnHand }, newValue: { kind: input.kind, quantity: input.quantity, quantityOnHand: next.quantityOnHand }, source: 'callable:recordBiologicalMovement' });
      audit.commit();
      return { quantityOnHand: next.quantityOnHand, carryingAmount: next.carryingAmount };
    });
  },
);
