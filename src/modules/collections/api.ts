import type { AccountableFormDoc, BarangayId, PartyRef, PaymentMethod } from '@bfms/shared';
import { callFn } from '../../services/functions/api';

/** Typed wrappers for the Phase 4 callables (functions/src/modules/collections/callables.ts). */
export interface OrLineInput {
  accountCode: string;
  subsidiaryId: string | null;
  natureOfCollection: string;
  amount: number;
}

export interface OrBodyInput {
  collectionDate: string;
  fundId: string;
  payor: PartyRef;
  paymentMethod: PaymentMethod;
  checkDetails: { bank: string; checkNumber: string; checkDate: string } | null;
  lines: OrLineInput[];
}

export const collectionsApi = {
  issueOfficialReceipt: callFn<OrBodyInput & { barangayId: BarangayId; collectingOfficerId: string; accountableFormId?: string | null; officialReceiptNumber: string }, { id: string; officialReceiptNumber: string; amount: number; nextSerialNumber: string | null }>('issueOfficialReceipt'),
  recordSpoiledReceipt: callFn<{ barangayId: BarangayId; collectingOfficerId: string; accountableFormId?: string | null; officialReceiptNumber: string; date: string; reason: string }, { id: string }>('recordSpoiledReceipt'),
  saveDeposit: callFn<{ id?: string; barangayId: BarangayId; accountableOfficerId: string; depositDate: string; bankAccountId: string; depositSlipNumber: string; fundId: string; collectionIds: string[]; amount: number; validatedAmount: number | null }, { id: string }>('saveDeposit'),
  receiveAccountableForm: callFn<{ barangayId: BarangayId; formType: AccountableFormDoc['formType']; series: string; beginningSerialNumber: string; endingSerialNumber: string; dateReceived: string; accountableOfficerId: string | null; dateIssued: string | null; remarks: string }, { id: string }>('receiveAccountableForm'),
  assignAccountableForm: callFn<{ id: string; accountableOfficerId: string; dateIssued: string }, { ok: true }>('assignAccountableForm'),
  returnAccountableForm: callFn<{ id: string; date: string; reason: string }, { ok: true }>('returnAccountableForm'),
  voidAccountableForm: callFn<{ id: string; reason: string }, { ok: true }>('voidAccountableForm'),
};
