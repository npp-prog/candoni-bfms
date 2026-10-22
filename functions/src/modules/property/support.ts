import {
  BfmsError,
  COL,
  formatPropertyNumber,
  assertPeriodAllowsEncoding,
  periodDocId,
  periodOfDate,
  ppeGroupCode,
  roundQty,
  stockAfterIssue,
  stockAfterReceipt,
  uniqueKeyId,
  type BarangayId,
  type Centavos,
  type InventoryItemRecord,
  type InventoryTxRecord,
  type PpeMovement,
  type PeriodStatus,
  type PpeRecord,
} from '@bfms/shared';
import type { DocumentReference, DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db, FieldValue, Timestamp } from '../../lib/admin';

export const centavos = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const qty = z.number().positive().max(1_000_000).refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, 'At most 3 decimals.');
export const text = (max: number) => z.string().trim().max(max).default('');
export const signer = z.object({ name: z.string().trim().max(160).default(''), position: text(120), office: text(160) }).default({});
export const party = z.object({ id: z.string().max(128).nullable().default(null), name: z.string().trim().min(2).max(160), address: z.string().max(240).optional(), tin: z.string().max(30).optional() });

/** Read a document and require that it belongs to the barangay. */
export async function readOwned(tx: Transaction, collection: string, id: string, barangayId: string, label: string): Promise<DocumentSnapshot> {
  const snap = await tx.get(db.collection(collection).doc(id));
  if (!snap.exists) throw new BfmsError('VALIDATION_FAILED', `${label} not found.`);
  if (snap.get('barangayId') !== barangayId) throw new BfmsError('BARANGAY_MISMATCH', `${label} belongs to another barangay.`);
  return snap;
}

export async function readMany(tx: Transaction, collection: string, ids: readonly string[], barangayId: string, label: string): Promise<Map<string, DocumentSnapshot>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const snaps = await tx.getAll(...uniq.map((id) => db.collection(collection).doc(id)));
  const out = new Map<string, DocumentSnapshot>();
  for (const s of snaps) {
    if (!s.exists) throw new BfmsError('VALIDATION_FAILED', `${label} ${s.id} not found.`);
    if (s.get('barangayId') !== barangayId) throw new BfmsError('BARANGAY_MISMATCH', `${label} ${s.id} belongs to another barangay.`);
    out.set(s.id, s);
  }
  return out;
}

// ------------------------------------------------------------------ property numbers

/**
 * Two-phase allocator for property numbers `YYYY-{PPEcode}-NNNN`: one counter per barangay, year and
 * PPE code (numberSequences/{bid}_{yyyy}_PPE_{gg-sss}); a uniqueKeys doc guards each number.
 */
export class PropertyNumbers {
  private readonly next = new Map<string, { ref: DocumentReference; start: number; n: number }>();
  private constructor(private readonly tx: Transaction, private readonly barangayId: BarangayId, private readonly year: number) {}

  static async read(tx: Transaction, barangayId: BarangayId, year: number, accountCodes: readonly string[]): Promise<PropertyNumbers> {
    const a = new PropertyNumbers(tx, barangayId, year);
    for (const group of new Set(accountCodes.map(ppeGroupCode))) {
      const ref = db.collection(COL.numberSequences).doc(`${barangayId}_${year}_PPE_${group}`);
      const cur = ((await tx.get(ref)).get('currentNumber') as number | undefined) ?? 0;
      a.next.set(group, { ref, start: cur, n: cur });
    }
    return a;
  }

  allocate(accountCode: string, ppeId: string): string {
    const s = this.next.get(ppeGroupCode(accountCode));
    if (!s) throw new Error(`Property number counter for ${accountCode} was not read.`);
    s.n += 1;
    const number = formatPropertyNumber(this.year, accountCode, s.n);
    this.tx.create(db.collection(COL.uniqueKeys).doc(uniqueKeyId('PPENO', this.barangayId, number)), { key: number, collection: COL.ppe, documentId: ppeId, barangayId: this.barangayId, createdAt: Timestamp.now() });
    return number;
  }

  commit(): void {
    for (const [group, s] of this.next)
      if (s.n !== s.start)
        this.tx.set(s.ref, { barangayId: this.barangayId, fiscalYear: this.year, documentType: `PPE-${group}`, currentNumber: s.n, prefix: '', format: '{YYYY}-{PPE}-{N:4}', updatedAt: Timestamp.now() });
  }
}

// ------------------------------------------------------------------ stock cards

export interface StockLineMeta {
  date: string;
  kind: InventoryTxRecord['kind'];
  referenceType: InventoryTxRecord['referenceType'];
  referenceNumber: string;
  office?: string;
  remarks?: string;
  sourceCollection: string | null;
  sourceId: string | null;
}

/**
 * Posts stock-card lines for several items in one transaction. READ: `InventoryPoster.read`;
 * then `receive`/`issue` (pure, validates on-hand and returns the costed line); WRITE: `commit`.
 * Several lines of the same item accumulate in memory, so one RIS cannot over-issue across lines.
 */
export class InventoryPoster {
  private readonly items = new Map<string, { ref: DocumentReference; data: InventoryItemRecord; dirty: boolean }>();
  private readonly pending: Array<Omit<InventoryTxRecord, 'createdAt' | 'updatedAt'>> = [];
  private constructor(private readonly tx: Transaction, private readonly barangayId: BarangayId, private readonly uid: string) {}

  static async read(tx: Transaction, barangayId: BarangayId, uid: string, itemIds: readonly string[]): Promise<InventoryPoster> {
    const p = new InventoryPoster(tx, barangayId, uid);
    const snaps = await readMany(tx, COL.inventoryItems, itemIds, barangayId, 'Inventory item');
    for (const [id, s] of snaps) p.items.set(id, { ref: s.ref, data: s.data() as InventoryItemRecord, dirty: false });
    return p;
  }

  item(id: string): InventoryItemRecord {
    const i = this.items.get(id);
    if (!i) throw new BfmsError('VALIDATION_FAILED', `Inventory item ${id} not found.`);
    return i.data;
  }

  private push(id: string, quantity: number, unitCost: Centavos, totalCost: Centavos, meta: StockLineMeta) {
    const i = this.items.get(id)!;
    const d = i.data;
    d.txCount = (d.txCount ?? 0) + 1;
    i.dirty = true;
    this.pending.push({
      barangayId: this.barangayId,
      fiscalYear: periodOfDate(meta.date).fiscalYear,
      itemId: id,
      date: meta.date,
      kind: meta.kind,
      referenceType: meta.referenceType,
      referenceNumber: meta.referenceNumber,
      quantity,
      unitCost,
      totalCost,
      officeId: null,
      balanceQuantity: d.quantityOnHand,
      balanceUnitCost: d.unitCost,
      seq: d.txCount,
      stockNumber: d.stockNumber,
      description: d.description,
      unit: d.unit,
      accountCode: d.accountCode,
      itemClass: d.itemClass,
      office: meta.office ?? '',
      remarks: meta.remarks ?? '',
      sourceCollection: meta.sourceCollection,
      sourceId: meta.sourceId,
      createdBy: this.uid,
      updatedBy: this.uid,
    });
  }

  receive(id: string, quantity: number, unitCost: Centavos, meta: StockLineMeta) {
    const d = this.item(id);
    const next = stockAfterReceipt(d, quantity, unitCost);
    d.quantityOnHand = next.quantityOnHand;
    d.unitCost = next.unitCost;
    this.push(id, quantity, unitCost, Math.round(quantity * unitCost) as Centavos, meta);
  }

  issue(id: string, quantity: number, meta: StockLineMeta): { unitCost: Centavos; amount: Centavos } {
    const d = this.item(id);
    const r = stockAfterIssue(d, quantity, `${d.stockNumber} ${d.description}`);
    d.quantityOnHand = r.quantityOnHand;
    this.push(id, -quantity, d.unitCost, -r.issueCost as Centavos, meta);
    return { unitCost: d.unitCost, amount: r.issueCost };
  }

  /** Signed count adjustment at the current cost (or `unitCost` for an increase). */
  adjust(id: string, delta: number, meta: StockLineMeta, unitCost?: Centavos) {
    if (delta > 0) return this.receive(id, delta, unitCost ?? this.item(id).unitCost, meta);
    this.issue(id, -delta, meta);
  }

  /** WRITE phase. `referenceNumber` fills lines posted before the document number was allocated. */
  commit(referenceNumber?: string): void {
    const now = Timestamp.now();
    for (const l of this.pending) this.tx.create(db.collection(COL.inventoryTransactions).doc(), { ...l, referenceNumber: l.referenceNumber || referenceNumber || '', createdAt: now, updatedAt: now });
    for (const i of this.items.values())
      if (i.dirty) this.tx.update(i.ref, { quantityOnHand: roundQty(i.data.quantityOnHand), unitCost: i.data.unitCost, txCount: i.data.txCount, updatedAt: now, updatedBy: this.uid });
  }
}

// ------------------------------------------------------------------ PPE helpers

export function movement(m: PpeMovement) {
  return FieldValue.arrayUnion(m);
}

/** PPE that can be the subject of custody documents (PAR, PTR, RRPE, IIRUP). */
export function assertActivePpe(snap: DocumentSnapshot): PpeRecord {
  const p = snap.data() as PpeRecord;
  if (p.status !== 'ACTIVE') throw new BfmsError('INVALID_STATUS', `${p.propertyNumber || snap.id} is ${p.status}; only ACTIVE property can be used.`);
  return p;
}

/** Encoding gate for a date (OPEN or REVIEW period), for actions dated after the document. */
export async function assertOpenPeriod(tx: Transaction, barangayId: BarangayId, date: string): Promise<void> {
  const { fiscalYear, month } = periodOfDate(date);
  const p = await tx.get(db.collection(COL.accountingPeriods).doc(periodDocId(barangayId, fiscalYear, month)));
  assertPeriodAllowsEncoding(p.get('status') as PeriodStatus | undefined);
}
