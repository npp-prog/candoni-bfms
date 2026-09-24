import type { AttachmentReviewStatus } from '../constants/statuses';
import type { BarangayId, BarangayScope, Ts } from './common';

export const AUDIT_ACTIONS = [
  'CREATE',
  'EDIT',
  'SUBMIT',
  'RETURN',
  'RESUBMIT',
  'APPROVE',
  'ACCEPT',
  'POST',
  'REVERSE',
  'VOID',
  'UPLOAD',
  'DELETE_ATTACHMENT',
  'LOCK_PERIOD',
  'REOPEN_PERIOD',
  'CHANGE_ROLE',
  'FINALIZE_REPORT',
  'CLOSE_YEAR',
  'LOGIN',
  'EXPORT',
  'IMPORT_COMMIT',
  'SEED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** auditLogs/{auditId} — append-only; written only by server in the same transaction. */
export interface AuditLogDoc {
  timestamp: Ts;
  uid: string;
  userName: string;
  roles: string[];
  barangayId: BarangayScope | 'SYSTEM';
  module: string;
  recordId: string;
  action: AuditAction;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  reason: string | null;
  source: string; // 'callable:postJournalEntry' | 'trigger:onCollectionWrite' | 'import'
  requestId: string;
  prevHash: string | null;
  hash: string;
}

/** workflowHistory/{id} */
export interface WorkflowHistoryDoc {
  barangayId: BarangayId;
  module: string;
  recordId: string;
  fromStatus: string | null;
  toStatus: string;
  remarks: string | null;
  actedBy: string;
  actedByName: string;
  actedAt: Ts;
}

/** attachments/{attachmentId} */
export interface AttachmentDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  module: string;
  transactionId: string;
  documentType: string; // 'OR' | 'INVOICE' | 'PAYROLL' | 'DEPOSIT_SLIP' | 'BANK_STATEMENT' …
  fileName: string;
  storagePath: string;
  mimeType: string;
  size: number;
  sha256: string | null;
  uploadedBy: string;
  uploadedAt: Ts;
  version: number;
  supersedesAttachmentId: string | null;
  reviewStatus: AttachmentReviewStatus;
  reviewRemarks: string | null;
}

/** notifications/{id} */
export interface NotificationDoc {
  recipientUid: string;
  barangayId: BarangayScope;
  type: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: Ts;
  readAt: Ts | null;
}

/** importBatches/{batchId} (+ records/{recordId}) */
export interface ImportBatchDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  sourceFile: string;
  sourceKind: 'CY_DB' | 'PY_DB' | 'MASTER_DB' | 'COA' | 'SL_MASTER' | 'CHECKS' | 'CA_AGING' | 'PPE' | 'TB_OPENING';
  status: 'UPLOADED' | 'MAPPED' | 'VALIDATED' | 'FOR_REVIEW' | 'APPROVED' | 'COMMITTED' | 'REJECTED';
  recordCount: number;
  errorCount: number;
  warningCount: number;
  fieldMapping: Record<string, string>;
  createdBy: string;
  createdAt: Ts;
  approvedBy: string | null;
  approvedAt: Ts | null;
  committedAt: Ts | null;
}

export interface ImportRecordDoc {
  sourceFile: string;
  sourceSheet: string;
  sourceRow: number;
  rawData: Record<string, unknown>;
  mappedData: Record<string, unknown> | null;
  validationStatus: 'PENDING' | 'VALID' | 'WARNING' | 'ERROR';
  validationErrors: Array<{ code: string; field: string | null; message: string }>;
  approvedForImport: boolean;
  targetDocumentPath: string | null;
}
