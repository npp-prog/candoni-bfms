/**
 * Common primitives used by every BFMS document.
 *
 * MONEY: every peso amount is an integer number of CENTAVOS.
 *   ₱1,234.56  →  123456
 * Use helpers in `accounting/money.ts` to convert at the UI/report edge only.
 */

declare const centavosBrand: unique symbol;
/** Integer centavos. Branded so a raw peso float cannot be passed by accident. */
export type Centavos = number & { readonly [centavosBrand]?: 'Centavos' };

/** Calendar date in Asia/Manila, `YYYY-MM-DD`. Used for accounting/legal dates. */
export type IsoDate = string;

/** Accounting period key `YYYY-MM`. MM = 00 (opening) … 12, 13 (closing entries). */
export type PeriodKey = string;

/** Structural stand-in for Firestore Timestamp (client & admin SDKs both satisfy it). */
export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
}
export type Ts = TimestampLike;

export type BarangayId =
  | 'AGBOY'
  | 'BANGA'
  | 'CABIA-AN'
  | 'CANINGAY'
  | 'EAST'
  | 'GATUSLAO'
  | 'HABA'
  | 'PAYAUAN'
  | 'WEST';

/** Assignment scope: a single barangay or all nine (Municipal Accounting). */
export type BarangayScope = BarangayId | 'ALL';

export type FundId = string; // 'GF' | 'STF-<code>' …

export interface BarangayScoped {
  barangayId: BarangayId;
  fiscalYear: number;
}

export interface PeriodScoped extends BarangayScoped {
  accountingPeriod: PeriodKey;
}

export interface Tracked {
  createdAt: Ts;
  createdBy: string;
  updatedAt: Ts;
  updatedBy: string;
}

/** Display snapshot stored alongside an ID so reports show historical names. */
export interface PartyRef {
  id: string | null;
  name: string;
  address?: string;
  tin?: string;
}

export interface ReturnInfo {
  reasonForReturn: string;
  requiredCorrection: string;
  returnedBy: string;
  returnedAt: Ts;
  assignedTo: string | null;
  resubmittedAt?: Ts | null;
  revisionNumber: number;
}

export interface WorkflowStamps {
  submittedBy?: string | null;
  submittedAt?: Ts | null;
  reviewedBy?: string | null;
  reviewedAt?: Ts | null;
  approvedBy?: string | null;
  approvedAt?: Ts | null;
  acceptedBy?: string | null;
  acceptedAt?: Ts | null;
  postedBy?: string | null;
  postedAt?: Ts | null;
  voidedBy?: string | null;
  voidedAt?: Ts | null;
  voidReason?: string | null;
  returnInfo?: ReturnInfo | null;
  returnHistory?: ReturnInfo[];
  revisionNumber: number;
}

export type WorkflowTracked<S extends string> = Tracked &
  WorkflowStamps & {
    status: S;
  };
