import {
  BfmsError,
  COL,
  NUMBER_FORMATS,
  formatDocumentNumber,
  sequenceDocId,
  uniqueKeyId,
  type BarangayId,
  type NumberedDocType,
} from '@bfms/shared';
import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { db, Timestamp } from '../lib/admin';

/**
 * Transaction-bound sequence allocator. Two-phase to respect Firestore's reads-before-writes rule.
 *   const seq = await SequenceAllocator.read(tx, bid, fy, 'JEV');   // READ
 *   const jevNo = seq.allocate(month, 'journalEntries', jevId);    // WRITE (unique key)
 *   seq.commit();                                                   // WRITE (sequence doc, once)
 * Concurrency: two transactions racing on the same sequence doc are serialized by Firestore;
 * the loser retries and reads the new value ⇒ gapless, no duplicates.
 */
export class SequenceAllocator {
  private next: number;
  private constructor(
    private readonly tx: Transaction,
    private readonly ref: DocumentReference,
    private readonly barangayId: BarangayId,
    private readonly fiscalYear: number,
    private readonly docType: NumberedDocType,
    current: number,
  ) {
    this.next = current + 1;
    this.start = current;
  }
  private readonly start: number;

  static async read(tx: Transaction, barangayId: BarangayId, fiscalYear: number, docType: NumberedDocType) {
    const ref = db.collection(COL.numberSequences).doc(sequenceDocId(barangayId, fiscalYear, docType));
    const snap = await tx.get(ref);
    const current = (snap.get('currentNumber') as number | undefined) ?? 0;
    return new SequenceAllocator(tx, ref, barangayId, fiscalYear, docType, current);
  }

  allocate(month: number, collection: string, documentId: string): string {
    const { prefix, format } = NUMBER_FORMATS[this.docType];
    const n = this.next++;
    const formatted = formatDocumentNumber(format, prefix, this.fiscalYear, month, n);
    const now = Timestamp.now();
    // Second guard: unique key doc. create() fails the whole transaction on collision.
    this.tx.create(db.collection(COL.uniqueKeys).doc(uniqueKeyId(this.docType, this.barangayId, this.fiscalYear, formatted)), {
      key: formatted,
      collection,
      documentId,
      barangayId: this.barangayId,
      createdAt: now,
    });
    return formatted;
  }

  /** Write the sequence document once, after all allocations in this transaction. */
  commit(): void {
    if (this.next - 1 === this.start) return;
    const { prefix, format } = NUMBER_FORMATS[this.docType];
    this.tx.set(this.ref, {
      barangayId: this.barangayId,
      fiscalYear: this.fiscalYear,
      documentType: this.docType,
      currentNumber: this.next - 1,
      prefix,
      format,
      updatedAt: Timestamp.now(),
    });
  }
}

/** Claim a business-unique value (OR no. in a series, check no. per bank account …). */
export async function assertUniqueAvailable(tx: Transaction, keyId: string): Promise<DocumentReference> {
  const ref = db.collection(COL.uniqueKeys).doc(keyId);
  const snap = await tx.get(ref);
  if (snap.exists) throw new BfmsError('DUPLICATE_NUMBER', `Number already used (${keyId}).`, { existing: snap.get('documentId') });
  return ref;
}
