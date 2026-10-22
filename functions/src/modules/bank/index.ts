import { BANK_MEMO_MODULE, BfmsError, CASH_IN_BANK, COL, defaultMemoAccount, type BankMemoRecord } from '@bfms/shared';
import { z } from 'zod';
import { db } from '../../lib/admin';
import type { ServerSourceModule, SourceRecord } from '../../sources/engine';
import { memoJevLines } from './recon';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ------------------------------------------------------------------ bank memos (RBDCM)
const memoSchema = z.object({
  bankAccountId: z.string().min(1).max(128),
  memoType: z.enum(['DEBIT', 'CREDIT']),
  category: z.enum(['BANK_CHARGES', 'INTEREST_INCOME', 'OTHER']).default('OTHER'),
  memoDate: isoDate,
  bankReference: z.string().trim().max(60).default(''),
  particulars: z.string().trim().min(3).max(500),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  classificationAccountCode: z.string().regex(/^\d-\d{2}-\d{2}-\d{3}$/).nullable().default(null),
  statementId: z.string().max(200).nullable().default(null),
  statementLineId: z.string().max(40).nullable().default(null),
});

const bankMemo: ServerSourceModule<typeof memoSchema> = {
  def: BANK_MEMO_MODULE,
  schema: memoSchema,
  async prepare({ input, tx, barangayId, existing, ctx }) {
    const bank = await tx.get(db.collection(COL.bankAccounts).doc(input.bankAccountId));
    if (!bank.exists || bank.get('barangayId') !== barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'Bank account not found for this barangay.');
    if (input.category === 'BANK_CHARGES' && input.memoType !== 'DEBIT') throw new BfmsError('VALIDATION_FAILED', 'Bank charges are a debit memo.');
    if (input.category === 'INTEREST_INCOME' && input.memoType !== 'CREDIT') throw new BfmsError('VALIDATION_FAILED', 'Interest earned is a credit memo.');
    // The classification account is accounting's call; other encoders keep what is stored (or the default).
    const accounting = ctx.can('jev.prepare', barangayId);
    const code = accounting ? input.classificationAccountCode ?? defaultMemoAccount(input.memoType, input.category) : ((existing?.classificationAccountCode as string | null | undefined) ?? defaultMemoAccount(input.memoType, input.category));
    if (code) {
      if (code === CASH_IN_BANK) throw new BfmsError('INVALID_ACCOUNT', 'The classification account is the other side of Cash in Bank.');
      const acct = await tx.get(db.collection(COL.chartOfAccounts).doc(code));
      if (!acct.exists || acct.get('active') === false) throw new BfmsError('INVALID_ACCOUNT', `Account ${code} is not an active account.`);
    }
    return { ...input, classificationAccountCode: code, memoNumber: (existing?.memoNumber as string | null | undefined) ?? null };
  },
  numbering: { action: 'ACCEPT', docType: 'MEMO', field: 'memoNumber' },
  async jev({ tx, doc }) {
    const m = doc as unknown as SourceRecord & BankMemoRecord;
    if (!m.classificationAccountCode) throw new BfmsError('VALIDATION_FAILED', 'Set the classification account before generating the JEV.');
    const [bank, acct] = await Promise.all([tx.get(db.collection(COL.bankAccounts).doc(m.bankAccountId)), tx.get(db.collection(COL.chartOfAccounts).doc(m.classificationAccountCode))]);
    if (!bank.exists || bank.get('barangayId') !== m.barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'Bank account not found for this barangay.');
    if (!acct.exists || acct.get('active') === false) throw new BfmsError('INVALID_ACCOUNT', `Account ${m.classificationAccountCode} is not an active account.`);
    return {
      jevDate: m.memoDate,
      fundId: (bank.get('fundId') as string | undefined) ?? 'GF',
      journal: 'JCT',
      particulars: `Bank ${m.memoType === 'DEBIT' ? 'debit' : 'credit'} memo: ${m.particulars}`,
      primaryReference: null, // the BM number is stamped by the ACCEPT hook below (allocated after this read phase)
      secondaryReference: m.bankReference || null,
      lines: memoJevLines(m.memoType, m.amount, m.classificationAccountCode, bank.get('subsidiaryId') as string, m.particulars),
    };
  },
  onAction: {
    // WRITE phase after the engine created the JEV: carry the BM number onto the JEV header and lines.
    async ACCEPT({ tx }) {
      return ({ number, jevId }) => {
        if (!number || !jevId) return;
        const ref = db.collection(COL.journalEntries).doc(jevId);
        tx.update(ref, { primaryReference: number });
        for (const n of ['001', '002']) tx.update(ref.collection(COL.lines).doc(n), { primaryReference: number });
      };
    },
  },
};

export const BANK_SERVER_MODULES: ServerSourceModule[] = [bankMemo] as ServerSourceModule[];
