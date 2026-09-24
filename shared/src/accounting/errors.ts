/** Domain error with a stable code; functions map these to HttpsError. */
export type BfmsErrorCode =
  | 'UNBALANCED_ENTRY'
  | 'EMPTY_ENTRY'
  | 'INVALID_LINE'
  | 'INVALID_ACCOUNT'
  | 'INACTIVE_ACCOUNT'
  | 'SUBSIDIARY_REQUIRED'
  | 'SUBSIDIARY_MISMATCH'
  | 'PERIOD_NOT_OPEN'
  | 'PERIOD_MISMATCH'
  | 'INVALID_STATUS'
  | 'ALREADY_POSTED'
  | 'SEGREGATION_OF_DUTIES'
  | 'INSUFFICIENT_APPROPRIATION'
  | 'INSUFFICIENT_STF_BALANCE'
  | 'LIQUIDATION_NOT_RECONCILED'
  | 'RECONCILIATION_NOT_BALANCED'
  | 'DUPLICATE_NUMBER'
  | 'BARANGAY_MISMATCH'
  | 'VALIDATION_FAILED'
  | 'TOO_MANY_LINES';

export class BfmsError extends Error {
  constructor(
    public readonly code: BfmsErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BfmsError';
  }
}
