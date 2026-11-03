import type { JournalBook } from '../types/accounting';

/**
 * Transaction types of the barangay journal — the "Transaction Type" column of the legacy
 * 01_CY DB sheet. Each type pre-fills the encoder (reference labels and a line template) and maps
 * the legacy spelling for workbook import. The book (JCT/GJ) is decided by the lines: any line on
 * a cash account (1-01-…) makes it a cash transaction.
 */
export type TransactionType = 'DISBURSEMENT' | 'COLLECTION' | 'DEPOSIT' | 'LIQUIDATION' | 'OTHERS' | 'OPENING';

export interface TemplateLine {
  side: 'D' | 'C';
  accountCode?: string;
  /** Subsidiary code to pre-select when the barangay has exactly one (CIB01) or a prefix (BT, AO). */
  slPrefix?: string;
  hint: string;
}

export interface TransactionTypeDef {
  code: TransactionType;
  label: string;
  legacyNames: readonly string[];
  primaryLabel: string;
  secondaryLabel: string;
  tertiaryLabel: string;
  template: readonly TemplateLine[];
  particularsHint: string;
}

export const TRANSACTION_TYPES: readonly TransactionTypeDef[] = [
  {
    code: 'DISBURSEMENT',
    label: 'Disbursement Voucher',
    legacyNames: ['Disbursement Voucher', 'DV', 'Disbursement'],
    primaryLabel: 'Check no.',
    secondaryLabel: 'DV no.',
    tertiaryLabel: 'Other ref.',
    template: [
      { side: 'D', hint: 'Expense, cash advance (1-03-03-…), payable or asset' },
      { side: 'C', accountCode: '1-01-02-010', slPrefix: 'CIB', hint: 'Cash in Bank (net of taxes)' },
    ],
    particularsHint: 'To payment for …',
  },
  {
    code: 'COLLECTION',
    label: 'Collections',
    legacyNames: ['Collections', 'Collection'],
    primaryLabel: 'OR nos.',
    secondaryLabel: 'RCD no.',
    tertiaryLabel: 'Other ref.',
    template: [
      { side: 'D', accountCode: '1-01-01-010', slPrefix: 'BT', hint: 'Cash – Local Treasury of the collecting officer' },
      { side: 'C', hint: 'Income (4-…) or trust liability' },
    ],
    particularsHint: 'To record collections based on RCD No. …',
  },
  {
    code: 'DEPOSIT',
    label: 'Deposit',
    legacyNames: ['Deposit', 'Deposits'],
    primaryLabel: 'Deposit slip',
    secondaryLabel: 'RCD no.',
    tertiaryLabel: 'Other ref.',
    template: [
      { side: 'D', accountCode: '1-01-02-010', slPrefix: 'CIB', hint: 'Cash in Bank' },
      { side: 'C', accountCode: '1-01-01-010', slPrefix: 'BT', hint: 'Cash – Local Treasury' },
    ],
    particularsHint: 'To record deposit based on RCD No. …',
  },
  {
    code: 'LIQUIDATION',
    label: 'Liquidation',
    legacyNames: ['Liquidation', 'Liquidations'],
    primaryLabel: 'CA check no.',
    secondaryLabel: 'LR / DV no.',
    tertiaryLabel: 'Other ref.',
    template: [
      { side: 'D', hint: 'Expenses liquidated (or Cash – Local Treasury for a refund)' },
      { side: 'C', accountCode: '1-03-03-010', slPrefix: 'AO', hint: 'Cash advance of the accountable officer' },
    ],
    particularsHint: 'Liquidation of CA for …',
  },
  {
    code: 'OTHERS',
    label: 'Others (NTA/IRA, bank memos, adjustments)',
    legacyNames: ['Others', 'Other', 'Adjustment', 'Adjustments'],
    primaryLabel: 'Primary ref.',
    secondaryLabel: 'Secondary ref.',
    tertiaryLabel: 'Tertiary ref.',
    template: [
      { side: 'D', hint: 'Account debited' },
      { side: 'C', hint: 'Account credited' },
    ],
    particularsHint: 'To record …',
  },
  {
    code: 'OPENING',
    label: 'Opening balance',
    legacyNames: ['Opening Balance', 'Opening'],
    primaryLabel: 'Primary ref.',
    secondaryLabel: 'Secondary ref.',
    tertiaryLabel: 'Tertiary ref.',
    template: [
      { side: 'D', hint: 'Asset balances' },
      { side: 'C', hint: 'Liability and equity balances' },
    ],
    particularsHint: 'Opening balance',
  },
];

export function transactionType(code: string | null | undefined): TransactionTypeDef | undefined {
  return TRANSACTION_TYPES.find((t) => t.code === code);
}

/** Map a legacy "Transaction Type" cell to a code (null when blank/unknown). */
export function transactionTypeFromLegacy(name: string | null | undefined): TransactionType | null {
  const n = (name ?? '').trim().toLowerCase();
  if (!n) return null;
  return TRANSACTION_TYPES.find((t) => t.legacyNames.some((l) => l.toLowerCase() === n))?.code ?? null;
}

/** JCT when any line touches a cash account (1-01-…), otherwise GJ. */
export function bookForLines(lines: ReadonlyArray<{ accountCode: string }>): JournalBook {
  return lines.some((l) => l.accountCode.startsWith('1-01-')) ? 'JCT' : 'GJ';
}
