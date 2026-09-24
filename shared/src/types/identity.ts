import type { BarangayId, BarangayScope, IsoDate, PartyRef, Ts, Tracked } from './common';
import type { RoleCode } from '../security/roles';

/** users/{uid} — profile mirror of the Firebase Auth user. */
export interface UserDoc {
  uid: string;
  email: string;
  displayName: string;
  position: string;
  active: boolean;
  defaultBarangayId: BarangayScope | null;
  /** Incremented whenever assignments change; client refreshes ID token when > token.v. */
  claimsVersion: number;
  preferences?: { pageSize?: 25 | 50 | 100; theme?: 'light' | 'dark' | 'system' };
  lastLoginAt?: Ts | null;
  createdAt: Ts;
  updatedAt: Ts;
}

/** roles/{roleId} — catalog (seeded from shared/security/roles.ts). */
export interface RoleDoc {
  roleId: RoleCode;
  label: string;
  description: string;
  claimCode: string;
  allowedScopes: Array<'BARANGAY' | 'ALL'>;
  permissions: string[];
  active: boolean;
}

/** userAssignments/{assignmentId} — source of truth for custom claims. */
export interface UserAssignmentDoc extends Tracked {
  uid: string;
  barangayId: BarangayScope;
  roles: RoleCode[];
  active: boolean;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  remarks?: string;
}

/** Shape of the compact custom claim written by syncClaims(). */
export interface BfmsClaims {
  /** barangay (or 'ALL') → claim codes, e.g. { AGBOY: ['BT','BE'] } */
  a: Partial<Record<BarangayScope, string[]>>;
  /** assignment version */
  v: number;
}

export interface BankAccountSummary {
  bankAccountId: string;
  bankName: string;
  branch: string;
  accountName: string;
  accountNumberMasked: string;
}

export interface SignatoryRef {
  name: string;
  position: string;
}

/** barangays/{barangayId} */
export interface BarangayDoc {
  barangayId: BarangayId;
  barangayCode: string; // '01' … '09'
  barangayName: string;
  municipality: string;
  province: string;
  active: boolean;
  /** Current officials (report signatories are resolved from `signatories` by date). */
  punongBarangay: SignatoryRef | null;
  barangayTreasurer: SignatoryRef | null;
  appropriationChairperson: SignatoryRef | null;
  contactInformation: { address?: string; email?: string; phone?: string };
  bankAccounts: BankAccountSummary[];
  defaultSignatories: Partial<Record<SignatoryRole, string>>; // role → signatories/{id}
  createdAt: Ts;
  updatedAt: Ts;
}

export type SignatoryRole =
  | 'PUNONG_BARANGAY'
  | 'BARANGAY_TREASURER'
  | 'BARANGAY_SECRETARY'
  | 'APPROPRIATIONS_CHAIR'
  | 'PROPERTY_OFFICER'
  | 'MUNICIPAL_ACCOUNTANT'
  | 'COA_AUDITOR';

/** signatories/{id} — term-based so historical reports show the official at that date. */
export interface SignatoryDoc extends Tracked {
  barangayId: BarangayId | 'MUNICIPAL';
  role: SignatoryRole;
  name: string;
  position: string;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  active: boolean;
}

/** offices/{id} — offices/committees a transaction may be attributed to. */
export interface OfficeDoc {
  barangayId: BarangayId;
  officeCode: string;
  officeName: string;
  active: boolean;
}

export type Payee = PartyRef;
