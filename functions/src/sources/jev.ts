import {
  COL,
  periodOfDate,
  validateJournalBalance,
  type BarangayId,
  type Centavos,
  type JournalBook,
  type JournalEntryDoc,
  type JournalLineDoc,
  type SourceModule,
} from '@bfms/shared';
import type { Transaction } from 'firebase-admin/firestore';
import { db, Timestamp } from '../lib/admin';
import type { CallerContext } from '../lib/context';

export interface GeneratedJevLine {
  accountCode: string;
  subsidiaryId?: string | null;
  debit: Centavos | number;
  credit: Centavos | number;
  lineDescription?: string;
}

export interface GeneratedJev {
  jevDate: string;
  fundId: string;
  journal: JournalBook;
  particulars: string;
  primaryReference?: string | null;
  secondaryReference?: string | null;
  tertiaryReference?: string | null;
  payeeName?: string | null;
  lines: GeneratedJevLine[];
}

/**
 * Merge lines with the same account + subsidiary + side (keeps generated JEVs compact),
 * dropping zero lines.
 */
export function consolidateLines(lines: readonly GeneratedJevLine[]): GeneratedJevLine[] {
  const out = new Map<string, GeneratedJevLine>();
  for (const l of lines) {
    if (!l.debit && !l.credit) continue;
    const side = l.debit ? 'D' : 'C';
    const k = `${l.accountCode}|${l.subsidiaryId ?? ''}|${side}`;
    const cur = out.get(k);
    if (cur) {
      cur.debit = (cur.debit as number) + (l.debit as number);
      cur.credit = (cur.credit as number) + (l.credit as number);
    } else out.set(k, { ...l, subsidiaryId: l.subsidiaryId ?? null });
  }
  // Debits first, as in the legacy books.
  return [...out.values()].sort((a, b) => (b.debit ? 1 : 0) - (a.debit ? 1 : 0));
}

/**
 * WRITE-phase helper: create a DRAFT journal entry generated from a source document
 * (docs 04 §9 "Where JEVs come from"). Validates balance first so an unbalanced template
 * aborts the whole transaction. Accounting then reviews, may reclassify accounts, approves and posts.
 */
export function createGeneratedJev(
  tx: Transaction,
  ctx: Pick<CallerContext, 'uid'>,
  src: { barangayId: BarangayId; sourceModule: SourceModule; sourceDocumentId: string },
  jev: GeneratedJev,
): string {
  const lines = consolidateLines(jev.lines);
  validateJournalBalance(lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit as Centavos, credit: l.credit as Centavos })));
  const { fiscalYear, key } = periodOfDate(jev.jevDate);
  const ref = db.collection(COL.journalEntries).doc();
  const now = Timestamp.now();
  const totalDebit = lines.reduce((t, l) => t + (l.debit as number), 0) as Centavos;
  const header: Omit<JournalEntryDoc, 'submittedBy'> = {
    barangayId: src.barangayId,
    fiscalYear,
    accountingPeriod: key,
    jevNumber: null,
    jevDate: jev.jevDate,
    fundId: jev.fundId,
    journal: jev.journal,
    entryType: 'REGULAR',
    sourceModule: src.sourceModule,
    sourceDocumentId: src.sourceDocumentId,
    primaryReference: jev.primaryReference ?? null,
    secondaryReference: jev.secondaryReference ?? null,
    tertiaryReference: jev.tertiaryReference ?? null,
    particulars: jev.particulars.slice(0, 2000),
    totalDebit,
    totalCredit: totalDebit,
    lineCount: lines.length,
    reversesJevId: null,
    reversedByJevId: null,
    status: 'DRAFT',
    revisionNumber: 0,
    createdAt: now,
    createdBy: ctx.uid,
    updatedAt: now,
    updatedBy: ctx.uid,
  };
  tx.create(ref, header);
  lines.forEach((l, i) => {
    const line: JournalLineDoc = {
      barangayId: src.barangayId,
      fiscalYear,
      accountingPeriod: key,
      fundId: jev.fundId,
      jevId: ref.id,
      jevDate: jev.jevDate,
      jevNumber: null,
      journal: jev.journal,
      entryType: 'REGULAR',
      posted: false,
      lineNo: i + 1,
      accountCode: l.accountCode,
      subsidiaryId: l.subsidiaryId ?? null,
      debit: l.debit as Centavos,
      credit: l.credit as Centavos,
      lineDescription: l.lineDescription ?? '',
      primaryReference: jev.primaryReference ?? null,
      secondaryReference: jev.secondaryReference ?? null,
      payeeName: jev.payeeName ?? null,
      fppId: null,
      officeId: null,
    };
    tx.set(ref.collection(COL.lines).doc(String(i + 1).padStart(3, '0')), line);
  });
  return ref.id;
}
