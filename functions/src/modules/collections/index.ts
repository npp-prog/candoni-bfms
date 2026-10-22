import {
  BfmsError,
  CASHBOOK_ACCOUNTS,
  COL,
  COLLECTION_MODULE,
  DEPOSIT_MODULE,
  RCD_MODULE,
  RCR_MODULE,
  computeRcdTotals,
  isCollectionCounted,
  type AccountableFormRecord,
  type BankAccountDoc,
  type BarangayId,
  type Centavos,
  type CollectionRecord,
  type DepositRecord,
  type RcdRecord,
  type RcrDoc,
} from '@bfms/shared';
import type { DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../../lib/admin';
import type { ServerSourceModule, SourceRecord } from '../../sources/engine';
import type { GeneratedJevLine } from '../../sources/jev';
import { collectionBody, checkCollectionLines, docId, isoDate, officerName, readCashOfficer, releasedStatus } from './common';

type Snap = DocumentSnapshot;
type Coll = CollectionRecord & { id: string };
const asColl = (s: Snap) => ({ ...(s.data() as CollectionRecord), id: s.id }) as Coll;

/** Firestore allows 500 writes per transaction; an RCD stamps every OR, deposit and RCR it lists. */
const MAX_REPORT_ITEMS = 450;

async function getAllSnaps(tx: Transaction, col: string, ids: readonly string[]): Promise<Snap[]> {
  if (!ids.length) return [];
  return tx.getAll(...ids.map((id) => db.collection(col).doc(id)));
}

function orRange(cs: readonly Coll[]): { orFrom: string | null; orTo: string | null } {
  const s = [...cs].sort((a, b) => a.serialNumber - b.serialNumber);
  return { orFrom: s[0]?.officialReceiptNumber ?? null, orTo: s.at(-1)?.officialReceiptNumber ?? null };
}

// ------------------------------------------------------------------ official receipts

const collection: ServerSourceModule<typeof collectionBody> = {
  def: COLLECTION_MODULE,
  schema: collectionBody,
  // Edits only: a new OR consumes a pre-printed number, so it is created by issueOfficialReceipt.
  async prepare({ input, tx, barangayId, existing }) {
    if (!existing) throw new BfmsError('VALIDATION_FAILED', 'Issue official receipts with "Issue OR" (issueOfficialReceipt) so the number is taken from the accountable form.');
    const c = existing as unknown as SourceRecord & CollectionRecord;
    if (c.depositId) throw new BfmsError('INVALID_STATUS', 'This OR is already on a deposit slip. Void or edit the deposit first.');
    if (Number(input.collectionDate.slice(0, 4)) !== c.fiscalYear) throw new BfmsError('PERIOD_MISMATCH', 'An OR cannot be moved to another fiscal year.');
    const { lines, amount } = await checkCollectionLines(tx, input.lines, barangayId);
    return { ...input, checkDetails: input.paymentMethod === 'CHECK' ? input.checkDetails : null, lines, amount };
  },
  onAction: {
    async CANCEL({ tx, doc, remarks }) {
      const c = doc as unknown as SourceRecord & CollectionRecord;
      if (c.depositId || c.rcdId || c.rcrId) throw new BfmsError('INVALID_STATUS', 'A deposited or reported OR cannot be cancelled.');
      const af = await tx.get(db.collection(COL.accountableForms).doc(c.accountableFormId));
      const f = af.data() as AccountableFormRecord | undefined;
      return ({ now }) => {
        if (f) tx.update(af.ref, { quantityIssued: Math.max(0, f.quantityIssued - 1), quantityCancelled: f.quantityCancelled + 1, updatedAt: now });
        return { cancelReason: remarks };
      };
    },
  },
};

// ------------------------------------------------------------------ deposits

const deposit: ServerSourceModule = {
  def: DEPOSIT_MODULE,
  schema: z.unknown(),
  async prepare() {
    throw new BfmsError('VALIDATION_FAILED', 'Record deposits with saveDeposit (it links the official receipts).');
  },
  onAction: {
    async VOID({ tx, doc }) {
      const d = doc as unknown as SourceRecord & DepositRecord;
      const snaps = await getAllSnaps(tx, COL.collections, d.collectionIds ?? []);
      return ({ now }) => {
        for (const s of snaps) if (s.exists && s.get('depositId') === d.id) tx.update(s.ref, { depositId: null, updatedAt: now });
      };
    },
  },
};

// ------------------------------------------------------------------ RCD

const rcdSchema = z.object({
  accountableOfficerId: docId,
  dateFrom: isoDate,
  dateTo: isoDate,
  fundId: z.string().min(1).max(60).default('GF'),
  differenceExplanation: z.string().trim().max(1000).nullable().default(null),
});

interface RcdSelection {
  collections: Coll[]; // own ORs (incl. cancelled) + ORs remitted through accepted RCRs
  collectionSnaps: Snap[];
  rcrs: Array<RcrDoc & { id: string }>;
  rcrSnaps: Snap[];
  deposits: Array<DepositRecord & { id: string }>;
  depositSnaps: Snap[];
  undepositedBeginning: Centavos;
}

/**
 * READ phase: everything an RCD of `officerId` for [from, to] reports. ORs/deposits already
 * stamped with another RCD are skipped, so consecutive reports never double count.
 */
async function selectRcd(tx: Transaction, barangayId: BarangayId, rcdId: string, officerId: string, from: string, to: string): Promise<RcdSelection> {
  const fy = Number(to.slice(0, 4));
  const free = (v: unknown) => !v || v === rcdId;
  const inRange = (d: string) => d >= from && d <= to;
  const [own, rcrQ, depQ, rcdQ] = await Promise.all([
    tx.get(db.collection(COL.collections).where('barangayId', '==', barangayId).where('collectingOfficerId', '==', officerId).where('fiscalYear', '==', fy)),
    tx.get(db.collection(COL.rcrReports).where('barangayId', '==', barangayId).where('receivingOfficerId', '==', officerId).where('status', '==', 'ACCEPTED')),
    tx.get(db.collection(COL.deposits).where('barangayId', '==', barangayId).where('accountableOfficerId', '==', officerId).where('fiscalYear', '==', fy)),
    tx.get(db.collection(COL.rcdReports).where('barangayId', '==', barangayId).where('accountableOfficerId', '==', officerId)),
  ]);
  const ownSnaps = own.docs.filter((s) => {
    const c = s.data() as CollectionRecord;
    return inRange(c.collectionDate) && !c.rcrId && free(c.rcdId) && ['DRAFT', 'CANCELLED', 'SUBMITTED'].includes(c.status) && (c.status !== 'SUBMITTED' || c.rcdId === rcdId);
  });
  const rcrSnaps = rcrQ.docs.filter((s) => inRange(s.get('remittanceDate') as string) && free(s.get('rcdId')));
  const rcrs = rcrSnaps.map((s) => ({ ...(s.data() as RcrDoc), id: s.id }));
  const remitted = await getAllSnaps(tx, COL.collections, rcrs.flatMap((r) => r.collectionIds));
  const depositSnaps = depQ.docs.filter((s) => {
    const d = s.data() as DepositRecord;
    return inRange(d.depositDate) && free(d.rcdId) && (d.status === 'DRAFT' || d.rcdId === rcdId);
  });
  // Accountability carried forward: the undeposited balance of the latest earlier RCD.
  const prior = rcdQ.docs
    .filter((s) => s.id !== rcdId && s.get('status') !== 'VOID' && (s.get('dateTo') as string) < from && Number((s.get('dateTo') as string).slice(0, 4)) === fy)
    .sort((a, b) => (b.get('dateTo') as string).localeCompare(a.get('dateTo') as string))[0];
  const overlap = rcdQ.docs.find((s) => s.id !== rcdId && s.get('status') !== 'VOID' && (s.get('dateFrom') as string) <= to && from <= (s.get('dateTo') as string));
  if (overlap) throw new BfmsError('VALIDATION_FAILED', `RCD ${overlap.get('rcdNumber') ?? '(draft)'} of this officer already covers ${overlap.get('dateFrom')} to ${overlap.get('dateTo')}.`);
  const collectionSnaps = [...ownSnaps, ...remitted.filter((s) => s.exists)];
  return {
    collections: collectionSnaps.map(asColl).sort((a, b) => a.collectionDate.localeCompare(b.collectionDate) || a.serialNumber - b.serialNumber),
    collectionSnaps,
    rcrs,
    rcrSnaps,
    deposits: depositSnaps.map((s) => ({ ...(s.data() as DepositRecord), id: s.id })).sort((a, b) => a.depositDate.localeCompare(b.depositDate)),
    depositSnaps,
    undepositedBeginning: ((prior?.get('undeposited') as number | undefined) ?? 0) as Centavos,
  };
}

function rcdFields(sel: RcdSelection, explanation: string | null) {
  const counted = sel.collections.filter((c) => isCollectionCounted(c.status));
  const t = computeRcdTotals(sel.undepositedBeginning, counted.map((c) => c.amount), sel.deposits.map((d) => d.amount), explanation);
  return {
    collectionIds: sel.collections.map((c) => c.id),
    depositIds: sel.deposits.map((d) => d.id),
    rcrIds: sel.rcrs.map((r) => r.id),
    collectionCount: counted.length,
    cancelledCount: sel.collections.length - counted.length,
    ...orRange(sel.collections),
    undepositedBeginning: t.undepositedBeginning,
    totalCollections: t.totalCollections,
    totalDeposits: t.totalDeposits,
    undeposited: t.undeposited,
    validationResult: t.result,
    validationMessage: t.message,
  };
}

async function submitRcd({ tx, doc }: { tx: Transaction; doc: SourceRecord }) {
  const r = doc as unknown as SourceRecord & RcdRecord;
  const sel = await selectRcd(tx, r.barangayId, r.id, r.accountableOfficerId, r.dateFrom, r.dateTo);
  const fields = rcdFields(sel, r.differenceExplanation);
  if (!fields.collectionCount && !fields.depositIds.length) throw new BfmsError('VALIDATION_FAILED', 'There are no collections or deposits of this officer in the period.');
  if (fields.validationResult === 'FAILED') throw new BfmsError('VALIDATION_FAILED', `RCD cannot be submitted: ${fields.validationMessage}`, { undeposited: fields.undeposited });
  if (sel.collectionSnaps.length + sel.depositSnaps.length + sel.rcrSnaps.length > MAX_REPORT_ITEMS)
    throw new BfmsError('VALIDATION_FAILED', `An RCD may list at most ${MAX_REPORT_ITEMS} ORs, deposits and remittances; shorten the period.`);
  return ({ now }: { now: FirebaseFirestore.Timestamp }) => {
    for (const s of sel.collectionSnaps) {
      const c = s.data() as CollectionRecord;
      tx.update(s.ref, { rcdId: r.id, status: isCollectionCounted(c.status) ? 'SUBMITTED' : c.status, updatedAt: now });
    }
    for (const s of sel.depositSnaps) tx.update(s.ref, { rcdId: r.id, status: 'SUBMITTED', updatedAt: now });
    for (const s of sel.rcrSnaps) tx.update(s.ref, { rcdId: r.id, updatedAt: now });
    return fields;
  };
}

async function releaseRcd({ tx, doc }: { tx: Transaction; doc: SourceRecord }) {
  const r = doc as unknown as SourceRecord & RcdRecord;
  const [cs, ds, rs] = await Promise.all([getAllSnaps(tx, COL.collections, r.collectionIds ?? []), getAllSnaps(tx, COL.deposits, r.depositIds ?? []), getAllSnaps(tx, COL.rcrReports, r.rcrIds ?? [])]);
  return ({ now }: { now: FirebaseFirestore.Timestamp }) => {
    for (const s of cs) if (s.exists && s.get('rcdId') === r.id) tx.update(s.ref, { rcdId: null, status: releasedStatus(s.data() as CollectionRecord), updatedAt: now });
    for (const s of ds) if (s.exists && s.get('rcdId') === r.id) tx.update(s.ref, { rcdId: null, status: 'DRAFT', updatedAt: now });
    for (const s of rs) if (s.exists && s.get('rcdId') === r.id) tx.update(s.ref, { rcdId: null, updatedAt: now });
  };
}

const rcd: ServerSourceModule<typeof rcdSchema> = {
  def: RCD_MODULE,
  schema: rcdSchema,
  async prepare({ input, tx, barangayId, existing, id }) {
    if (input.dateTo < input.dateFrom) throw new BfmsError('VALIDATION_FAILED', 'The period cannot end before it starts.');
    if (input.dateFrom.slice(0, 4) !== input.dateTo.slice(0, 4)) throw new BfmsError('PERIOD_MISMATCH', 'An RCD must stay within one fiscal year.');
    const officer = await readCashOfficer(tx, input.accountableOfficerId, barangayId);
    const sel = await selectRcd(tx, barangayId, id, input.accountableOfficerId, input.dateFrom, input.dateTo);
    return {
      ...input,
      accountableOfficerName: officerName(officer),
      rcdNumber: (existing?.rcdNumber as string | null | undefined) ?? null,
      ...rcdFields(sel, input.differenceExplanation),
    };
  },
  numbering: { action: 'SUBMIT', docType: 'RCD', field: 'rcdNumber' },
  onAction: {
    SUBMIT: submitRcd,
    RESUBMIT: submitRcd,
    RETURN: releaseRcd,
    VOID: releaseRcd,
    async ACCEPT({ tx, doc }) {
      const r = doc as unknown as SourceRecord & RcdRecord;
      const [cs, ds] = await Promise.all([getAllSnaps(tx, COL.collections, r.collectionIds ?? []), getAllSnaps(tx, COL.deposits, r.depositIds ?? [])]);
      return ({ now }) => {
        for (const s of cs) if (s.exists && isCollectionCounted(s.get('status') as string)) tx.update(s.ref, { status: 'ACCEPTED', updatedAt: now });
        for (const s of ds) if (s.exists) tx.update(s.ref, { status: 'ACCEPTED', updatedAt: now });
      };
    },
  },
  /**
   * One JCT JEV per RCD (docs 04 §9): Dr 1-01-01-010 (collector BT##) / Cr each OR line account;
   * remittances of deputized collectors Dr treasurer / Cr collector; deposits Dr 1-01-02-010 (CIB##) / Cr treasurer.
   */
  async jev({ tx, doc }) {
    const r = doc as unknown as SourceRecord & RcdRecord;
    const [cs, ds, rs] = await Promise.all([getAllSnaps(tx, COL.collections, r.collectionIds ?? []), getAllSnaps(tx, COL.deposits, r.depositIds ?? []), getAllSnaps(tx, COL.rcrReports, r.rcrIds ?? [])]);
    const colls = cs.filter((s) => s.exists).map(asColl).filter((c) => isCollectionCounted(c.status));
    const deps = ds.filter((s) => s.exists).map((s) => ({ ...(s.data() as DepositRecord), id: s.id }));
    const banks = await getAllSnaps(tx, COL.bankAccounts, [...new Set(deps.map((d) => d.bankAccountId))]);
    const bankSl = new Map(banks.filter((b) => b.exists).map((b) => [b.id, (b.data() as BankAccountDoc).subsidiaryId]));
    const lines: GeneratedJevLine[] = [];
    for (const c of colls) {
      lines.push({ accountCode: CASHBOOK_ACCOUNTS.CASH_IN_TREASURY, subsidiaryId: c.collectingOfficerId, debit: c.amount, credit: 0, lineDescription: 'Collections per official receipts' });
      for (const l of c.lines) lines.push({ accountCode: l.accountCode, subsidiaryId: l.subsidiaryId, debit: 0, credit: l.amount, lineDescription: l.natureOfCollection });
    }
    for (const s of rs.filter((x) => x.exists)) {
      const rc = s.data() as RcrDoc;
      lines.push({ accountCode: CASHBOOK_ACCOUNTS.CASH_IN_TREASURY, subsidiaryId: r.accountableOfficerId, debit: rc.totalCollections, credit: 0, lineDescription: 'Remittances received from collectors' });
      lines.push({ accountCode: CASHBOOK_ACCOUNTS.CASH_IN_TREASURY, subsidiaryId: rc.collectorId, debit: 0, credit: rc.totalCollections, lineDescription: `RCR ${rc.rcrNumber ?? ''}` });
    }
    for (const d of deps) {
      const sl = bankSl.get(d.bankAccountId);
      if (!sl) throw new BfmsError('VALIDATION_FAILED', `Deposit ${d.depositSlipNumber}: bank account not found.`);
      lines.push({ accountCode: CASHBOOK_ACCOUNTS.CASH_IN_BANK, subsidiaryId: sl, debit: d.amount, credit: 0, lineDescription: 'Deposits of collections' });
      lines.push({ accountCode: CASHBOOK_ACCOUNTS.CASH_IN_TREASURY, subsidiaryId: r.accountableOfficerId, debit: 0, credit: d.amount, lineDescription: 'Deposits of collections' });
    }
    if (!lines.length) return null;
    const ors = r.orFrom ? ` OR ${r.orFrom}${r.orTo && r.orTo !== r.orFrom ? `–${r.orTo}` : ''}` : '';
    return {
      jevDate: r.dateTo,
      fundId: r.fundId || 'GF',
      journal: 'JCT',
      particulars: `To record collections${ors} and deposits per RCD No. ${r.rcdNumber ?? ''} of ${r.accountableOfficerName} for ${r.dateFrom} to ${r.dateTo}.`,
      primaryReference: r.rcdNumber,
      secondaryReference: r.orFrom ? `OR ${r.orFrom}${r.orTo && r.orTo !== r.orFrom ? `-${r.orTo}` : ''}` : null,
      payeeName: r.accountableOfficerName,
      lines,
    };
  },
};

// ------------------------------------------------------------------ RCR

const rcrSchema = z.object({
  collectorId: docId,
  receivingOfficerId: docId,
  dateFrom: isoDate,
  dateTo: isoDate,
  remittanceDate: isoDate,
  fundId: z.string().min(1).max(60).default('GF'),
  amountRemitted: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/** READ phase: the collector's unreported ORs (incl. cancelled) in the period. */
async function selectRcr(tx: Transaction, barangayId: BarangayId, rcrId: string, collectorId: string, from: string, to: string) {
  const q = await tx.get(db.collection(COL.collections).where('barangayId', '==', barangayId).where('collectingOfficerId', '==', collectorId).where('fiscalYear', '==', Number(to.slice(0, 4))));
  const snaps = q.docs.filter((s) => {
    const c = s.data() as CollectionRecord;
    return c.collectionDate >= from && c.collectionDate <= to && !c.rcdId && (!c.rcrId || c.rcrId === rcrId) && (c.status === 'DRAFT' || c.status === 'CANCELLED' || c.rcrId === rcrId);
  });
  const colls = snaps.map(asColl).sort((a, b) => a.serialNumber - b.serialNumber);
  const counted = colls.filter((c) => isCollectionCounted(c.status));
  return { snaps, colls, fields: { collectionIds: colls.map((c) => c.id), collectionCount: counted.length, totalCollections: counted.reduce((t, c) => t + c.amount, 0) as Centavos, ...orRange(colls) } };
}

async function submitRcr({ tx, doc }: { tx: Transaction; doc: SourceRecord }) {
  const r = doc as unknown as SourceRecord & RcrDoc;
  const sel = await selectRcr(tx, r.barangayId, r.id, r.collectorId, r.dateFrom, r.dateTo);
  if (!sel.fields.collectionCount) throw new BfmsError('VALIDATION_FAILED', 'The collector has no unreported official receipts in the period.');
  if (sel.fields.totalCollections !== r.amountRemitted)
    throw new BfmsError('VALIDATION_FAILED', `The amount remitted must equal the collections (${(sel.fields.totalCollections / 100).toFixed(2)}).`, { totalCollections: sel.fields.totalCollections, amountRemitted: r.amountRemitted });
  if (sel.snaps.length > MAX_REPORT_ITEMS) throw new BfmsError('VALIDATION_FAILED', `An RCR may list at most ${MAX_REPORT_ITEMS} ORs; shorten the period.`);
  return ({ now }: { now: FirebaseFirestore.Timestamp }) => {
    for (const s of sel.snaps) {
      const c = s.data() as CollectionRecord;
      tx.update(s.ref, { rcrId: r.id, status: isCollectionCounted(c.status) ? 'SUBMITTED' : c.status, updatedAt: now });
    }
    return sel.fields;
  };
}

async function releaseRcr({ tx, doc }: { tx: Transaction; doc: SourceRecord }) {
  const r = doc as unknown as SourceRecord & RcrDoc;
  const cs = await getAllSnaps(tx, COL.collections, r.collectionIds ?? []);
  return ({ now }: { now: FirebaseFirestore.Timestamp }) => {
    for (const s of cs) if (s.exists && s.get('rcrId') === r.id) tx.update(s.ref, { rcrId: null, status: releasedStatus({ status: s.get('status') as string, rcrId: null }), updatedAt: now });
  };
}

const rcr: ServerSourceModule<typeof rcrSchema> = {
  def: RCR_MODULE,
  schema: rcrSchema,
  async prepare({ input, tx, barangayId, existing, id }) {
    if (input.dateTo < input.dateFrom) throw new BfmsError('VALIDATION_FAILED', 'The period cannot end before it starts.');
    if (input.remittanceDate < input.dateTo) throw new BfmsError('VALIDATION_FAILED', 'The remittance date cannot be earlier than the last collection date of the period.');
    if (input.dateFrom.slice(0, 4) !== input.remittanceDate.slice(0, 4)) throw new BfmsError('PERIOD_MISMATCH', 'An RCR must stay within one fiscal year.');
    if (input.collectorId === input.receivingOfficerId) throw new BfmsError('VALIDATION_FAILED', 'The collector and the receiving officer must be different persons.');
    const [collector, receiver] = [await readCashOfficer(tx, input.collectorId, barangayId, 'Collector'), await readCashOfficer(tx, input.receivingOfficerId, barangayId, 'Receiving officer')];
    const sel = await selectRcr(tx, barangayId, id, input.collectorId, input.dateFrom, input.dateTo);
    return {
      ...input,
      collectorName: officerName(collector),
      receivingOfficerName: officerName(receiver),
      rcrNumber: (existing?.rcrNumber as string | null | undefined) ?? null,
      rcdId: null,
      ...sel.fields,
    };
  },
  numbering: { action: 'SUBMIT', docType: 'RCR', field: 'rcrNumber' },
  onAction: { SUBMIT: submitRcr, RESUBMIT: submitRcr, RETURN: releaseRcr, VOID: releaseRcr },
};

/** Server definitions (schema, prepare, hooks, JEV template) for this phase's source modules. */
export const COLLECTIONS_SERVER_MODULES: ServerSourceModule[] = [collection, deposit, rcd, rcr] as ServerSourceModule[];
