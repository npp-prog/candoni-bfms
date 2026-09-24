import type { ChartOfAccountDoc, SubsidiaryAccountDoc } from '../types/coa';
import type { Centavos } from '../types/common';
import type { JournalLineInput } from '../types/accounting';
import { BfmsError } from './errors';
import { isCentavos, sum } from './money';

/** 150 lines keeps worst-case posting (lines + 2×balance rows + header/audit/sequence) under Firestore’s 500-write transaction limit. */
export const MAX_JEV_LINES = 150;

export interface BalanceCheck {
  totalDebit: Centavos;
  totalCredit: Centavos;
  difference: Centavos;
  balanced: boolean;
}

/** Σ debit vs Σ credit. Pure; used for UI preview AND server enforcement. */
export function computeJournalTotals(lines: readonly Pick<JournalLineInput, 'debit' | 'credit'>[]): BalanceCheck {
  const totalDebit = sum(lines.map((l) => l.debit));
  const totalCredit = sum(lines.map((l) => l.credit));
  const difference = (totalDebit - totalCredit) as Centavos;
  return { totalDebit, totalCredit, difference, balanced: difference === 0 };
}

/**
 * Structural validation of JEV lines. Throws BfmsError on the first violation.
 * Rules:
 *  - at least 2 lines, at most MAX_JEV_LINES
 *  - each amount integer centavos, non-negative
 *  - exactly one of debit/credit > 0 per line
 *  - Σ debit = Σ credit > 0
 */
export function validateJournalBalance(lines: readonly JournalLineInput[]): BalanceCheck {
  if (lines.length < 2) throw new BfmsError('EMPTY_ENTRY', 'A journal entry needs at least two lines.');
  if (lines.length > MAX_JEV_LINES)
    throw new BfmsError('TOO_MANY_LINES', `A journal entry may have at most ${MAX_JEV_LINES} lines.`);
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.accountCode) throw new BfmsError('INVALID_LINE', `Line ${n}: account code is required.`);
    if (!isCentavos(l.debit) || !isCentavos(l.credit))
      throw new BfmsError('INVALID_LINE', `Line ${n}: amounts must be integer centavos.`);
    if (l.debit < 0 || l.credit < 0) throw new BfmsError('INVALID_LINE', `Line ${n}: amounts cannot be negative.`);
    if ((l.debit > 0) === (l.credit > 0))
      throw new BfmsError('INVALID_LINE', `Line ${n}: enter either a debit or a credit, not both or neither.`);
  });
  const totals = computeJournalTotals(lines);
  if (totals.totalDebit === 0) throw new BfmsError('EMPTY_ENTRY', 'A journal entry cannot total zero.');
  if (!totals.balanced)
    throw new BfmsError('UNBALANCED_ENTRY', 'Total debits must equal total credits.', {
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
      difference: totals.difference,
    });
  return totals;
}

/**
 * Validate every line against the Chart of Accounts and subsidiary master.
 * `accounts` and `subsidiaries` are maps of the documents actually read in the posting transaction.
 */
export function validateJournalAccounts(
  lines: readonly JournalLineInput[],
  barangayId: string,
  accounts: ReadonlyMap<string, Pick<ChartOfAccountDoc, 'accountCode' | 'active' | 'requiresSubsidiaryLedger'>>,
  subsidiaries: ReadonlyMap<string, Pick<SubsidiaryAccountDoc, 'accountCode' | 'barangayId' | 'active'>>,
): void {
  lines.forEach((l, i) => {
    const n = i + 1;
    const acct = accounts.get(l.accountCode);
    if (!acct) throw new BfmsError('INVALID_ACCOUNT', `Line ${n}: account ${l.accountCode} is not in the Chart of Accounts.`);
    if (!acct.active) throw new BfmsError('INACTIVE_ACCOUNT', `Line ${n}: account ${l.accountCode} is inactive.`);
    if (acct.requiresSubsidiaryLedger && !l.subsidiaryId)
      throw new BfmsError('SUBSIDIARY_REQUIRED', `Line ${n}: account ${l.accountCode} requires a subsidiary ledger.`);
    if (l.subsidiaryId) {
      const sl = subsidiaries.get(l.subsidiaryId);
      if (!sl) throw new BfmsError('SUBSIDIARY_MISMATCH', `Line ${n}: subsidiary ${l.subsidiaryId} does not exist.`);
      if (sl.barangayId !== barangayId)
        throw new BfmsError('BARANGAY_MISMATCH', `Line ${n}: subsidiary belongs to another barangay.`);
      if (sl.accountCode !== l.accountCode)
        throw new BfmsError(
          'SUBSIDIARY_MISMATCH',
          `Line ${n}: subsidiary ${l.subsidiaryId} is controlled by ${sl.accountCode}, not ${l.accountCode}.`,
        );
      if (!sl.active) throw new BfmsError('SUBSIDIARY_MISMATCH', `Line ${n}: subsidiary ${l.subsidiaryId} is inactive.`);
    }
  });
}

/** Build the reversing lines for a posted JEV (swap debit/credit, keep accounts & SLs). */
export function reverseLines<T extends JournalLineInput>(lines: readonly T[]): JournalLineInput[] {
  return lines.map((l) => ({
    accountCode: l.accountCode,
    subsidiaryId: l.subsidiaryId ?? null,
    debit: l.credit,
    credit: l.debit,
    lineDescription: `Reversal: ${l.lineDescription ?? ''}`.trim(),
    fppId: l.fppId ?? null,
    officeId: l.officeId ?? null,
  }));
}

/** Signed balance in the account's normal direction. */
export function normalSignedBalance(debit: Centavos, credit: Centavos, normal: 'DEBIT' | 'CREDIT'): Centavos {
  return (normal === 'DEBIT' ? debit - credit : credit - debit) as Centavos;
}
