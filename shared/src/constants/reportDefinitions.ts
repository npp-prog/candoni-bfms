import type { RoleCode } from '../security/roles';
import type {
  DeadlineRule,
  ReportCategory,
  ReportDefinition,
  ReportFrequency,
  ResponsibleOffice,
} from '../types/reporting';

/**
 * Report catalog: the 50 prescribed forms/reports (master prompt §LII) + supplementary schedules.
 * Seeded into reportDefinitions/{reportCode}; administrators may edit deadlines/templates later.
 *
 * DEADLINES are initial values and MUST be confirmed by the Municipal Accountant against the
 * current COA Manual on the Financial Management of Barangays before go-live (flag: deadlineConfirmed).
 */
type Row = [
  code: string,
  form: number | null,
  name: string,
  cat: ReportCategory,
  office: ResponsibleOffice,
  prepared: RoleCode,
  certified: RoleCode | null,
  approved: RoleCode | null,
  freq: ReportFrequency,
  sources: string[],
  pkg: boolean,
  gen: ReportDefinition['generation'],
  paper: [ReportDefinition['paperSize'], ReportDefinition['orientation']],
  validations: string[],
  phase: number,
];

const BT: RoleCode = 'barangay_treasurer';
const AC: RoleCode = 'appropriations_chair';
const PB: RoleCode = 'punong_barangay';
const PO: RoleCode = 'property_officer';
const MA: RoleCode = 'municipal_accountant';
const AS: RoleCode = 'accounting_staff';

const P = (s: ReportDefinition['paperSize'] = 'A4', o: ReportDefinition['orientation'] = 'PORTRAIT') =>
  [s, o] as [ReportDefinition['paperSize'], ReportDefinition['orientation']];

const ROWS: Row[] = [
  // A. Books of accounts
  ['JCT', 1, 'Journal of Cash Transactions', 'BOOKS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'MONTHLY', ['journalEntries', 'lines'], false, 'AUTO', P('LEGAL', 'LANDSCAPE'), ['JEV_BALANCED'], 8],
  ['GJ', 2, 'General Journal', 'BOOKS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'MONTHLY', ['journalEntries', 'lines'], false, 'AUTO', P('LEGAL', 'LANDSCAPE'), ['JEV_BALANCED'], 8],
  ['GL', 3, 'General Ledger', 'BOOKS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'MONTHLY', ['lines', 'accountBalances'], false, 'AUTO', P('A4', 'LANDSCAPE'), [], 8],
  ['SL', 4, 'Subsidiary Ledger', 'BOOKS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'MONTHLY', ['lines', 'accountBalances'], false, 'AUTO', P('A4', 'LANDSCAPE'), ['SL_EQUALS_GL'], 8],
  ['JEV', 5, 'Journal Entry Voucher', 'BOOKS', 'MUNICIPAL_ACCOUNTING', AS, MA, MA, 'PER_TRANSACTION', ['journalEntries', 'lines'], false, 'FORM', P(), ['JEV_BALANCED'], 8],
  // B. Appropriations and obligations
  ['RAO', 6, 'Record of Appropriations and Obligations', 'BUDGET', 'COMMITTEE_ON_APPROPRIATIONS', AC, AC, null, 'MONTHLY', ['appropriations', 'raoEntries', 'obligations'], true, 'AUTO', P('LEGAL', 'LANDSCAPE'), ['OBLIGATION_WITHIN_APPROPRIATION'], 3],
  ['SAOB', 7, 'Statement of Appropriations, Obligations and Balances', 'BUDGET', 'COMMITTEE_ON_APPROPRIATIONS', AC, AC, PB, 'MONTHLY', ['appropriations', 'obligations'], true, 'AUTO', P('LEGAL', 'LANDSCAPE'), ['OBLIGATION_WITHIN_APPROPRIATION'], 3],
  ['REAI', 8, 'Record of Estimated and Actual Income', 'BUDGET', 'BARANGAY_TREASURER', BT, BT, null, 'MONTHLY', ['estimatedIncome', 'collections'], true, 'AUTO', P('LEGAL', 'LANDSCAPE'), [], 3],
  // C. Collections, deposits, remittances and disbursements
  ['CASHBOOK', 9, 'Cashbook', 'COLLECTIONS_DEPOSITS', 'BARANGAY_TREASURER', BT, BT, null, 'MONTHLY', ['collections', 'deposits', 'checks', 'disbursementVouchers', 'pettyCashTransactions'], true, 'AUTO', P('LEGAL', 'LANDSCAPE'), ['CASHBOOK_ROLLFORWARD'], 4],
  ['CASHBOOK_DO', 10, 'Cashbook - Disbursing Officer', 'COLLECTIONS_DEPOSITS', 'BARANGAY_TREASURER', BT, BT, null, 'MONTHLY', ['cashAdvances', 'liquidations', 'payrolls'], true, 'AUTO', P('LEGAL', 'LANDSCAPE'), ['CASHBOOK_ROLLFORWARD'], 6],
  ['RCD', 11, 'Report of Collections and Deposits', 'COLLECTIONS_DEPOSITS', 'BARANGAY_TREASURER', BT, BT, null, 'PER_TRANSACTION', ['collections', 'deposits', 'rcdReports'], true, 'AUTO', P(), ['RCD_COLLECTIONS_EQ_DEPOSITS'], 4],
  ['RCR', 12, 'Report of Collections and Remittances', 'COLLECTIONS_DEPOSITS', 'BARANGAY_TREASURER', BT, BT, null, 'PER_TRANSACTION', ['collections', 'rcrReports'], true, 'AUTO', P(), [], 4],
  ['RBDCM', 13, 'Report of Bank Debit and Credit Memos', 'BANK', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'MONTHLY', ['bankMemos'], false, 'AUTO', P(), [], 9],
  ['BRS', 14, 'Bank Reconciliation Statement', 'BANK', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'MONTHLY', ['bankReconciliations', 'checks', 'deposits', 'bankStatements'], false, 'AUTO', P(), ['BRS_BALANCED'], 9],
  ['DV', 15, 'Disbursement Voucher', 'DISBURSEMENTS', 'BARANGAY_TREASURER', BT, AC, PB, 'PER_TRANSACTION', ['disbursementVouchers'], false, 'FORM', P(), [], 5],
  ['PCV', 16, 'Petty Cash Voucher', 'PETTY_CASH', 'BARANGAY_TREASURER', BT, null, PB, 'PER_TRANSACTION', ['pettyCashTransactions'], false, 'FORM', P(), [], 6],
  ['PCR', 17, 'Petty Cash Record', 'PETTY_CASH', 'BARANGAY_TREASURER', BT, BT, null, 'MONTHLY', ['pettyCashTransactions'], true, 'AUTO', P('A4', 'LANDSCAPE'), [], 6],
  ['PAYROLL', 18, 'Payroll', 'DISBURSEMENTS', 'BARANGAY_TREASURER', BT, BT, PB, 'PER_TRANSACTION', ['payrolls'], true, 'FORM', P('LEGAL', 'LANDSCAPE'), [], 5],
  ['LR', 19, 'Liquidation Report', 'CASH_ADVANCES', 'BARANGAY_TREASURER', BT, BT, PB, 'PER_TRANSACTION', ['liquidations', 'cashAdvances'], true, 'FORM', P(), ['LIQUIDATION_RECONCILES'], 6],
  ['TRANSMITTAL', 20, 'Transmittal Letter', 'COMPLIANCE', 'BARANGAY_TREASURER', BT, null, PB, 'MONTHLY', ['generatedReports'], true, 'AUTO', P(), [], 12],
  ['SPCD', 21, 'Summary of Petty Cash Disbursements', 'PETTY_CASH', 'BARANGAY_TREASURER', BT, BT, null, 'MONTHLY', ['pettyCashTransactions'], true, 'AUTO', P(), [], 6],
  ['RAAF', 22, 'Report of Accountability for Accountable Forms', 'ACCOUNTABLE_FORMS', 'BARANGAY_TREASURER', BT, BT, null, 'MONTHLY', ['accountableForms', 'collections'], true, 'AUTO', P('LEGAL', 'LANDSCAPE'), ['AF_NO_GAPS'], 4],
  // D. Supplies, property and equipment
  ['ARDSM', 23, 'Acknowledgement Receipt for Donated Supplies and Materials', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, PB, 'PER_TRANSACTION', ['inventoryTransactions'], false, 'FORM', P(), [], 10],
  ['RIS', 24, 'Requisition and Issue Slip', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, PB, 'PER_TRANSACTION', ['inventoryTransactions'], false, 'FORM', P(), [], 10],
  ['ICS', 25, 'Inventory Custodian Slip', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, PB, 'PER_TRANSACTION', ['propertyDocuments'], false, 'FORM', P(), [], 10],
  ['STOCK_CARD', 26, 'Stock Card', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, null, 'ON_DEMAND', ['inventoryItems', 'inventoryTransactions'], false, 'AUTO', P(), [], 10],
  ['PR', 27, 'Purchase Request', 'PROPERTY', 'BAC_OR_PROCUREMENT', PO, AC, PB, 'PER_TRANSACTION', ['purchaseRequests'], false, 'FORM', P(), [], 10],
  ['PO', 28, 'Purchase Order', 'PROPERTY', 'BAC_OR_PROCUREMENT', PO, AC, PB, 'PER_TRANSACTION', ['purchaseOrders'], false, 'FORM', P(), [], 10],
  ['PAR', 29, 'Property Acknowledgement Receipt', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, PB, 'PER_TRANSACTION', ['propertyDocuments', 'ppe'], false, 'FORM', P(), [], 10],
  ['PEC', 30, 'Property / Equipment Card', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, null, 'ON_DEMAND', ['ppe'], false, 'AUTO', P(), [], 10],
  ['PELC', 31, 'Property / Equipment Ledger Card', 'PROPERTY', 'MUNICIPAL_ACCOUNTING', AS, MA, null, 'ON_DEMAND', ['ppe', 'ppeDepreciation'], false, 'AUTO', P('A4', 'LANDSCAPE'), [], 10],
  ['AIR', 32, 'Acceptance and Inspection Report', 'PROPERTY', 'INSPECTION_COMMITTEE', PO, null, PB, 'PER_TRANSACTION', ['inventoryTransactions', 'ppe'], false, 'FORM', P(), [], 10],
  ['RRPE', 33, 'Return and Receipt of Property / Equipment', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, PB, 'PER_TRANSACTION', ['propertyDocuments'], false, 'FORM', P(), [], 10],
  ['IIRUP', 34, 'Inventory, Inspection and Appraisal Report', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, PB, 'ON_DEMAND', ['ppe'], false, 'AUTO', P('A4', 'LANDSCAPE'), [], 10],
  ['RPCPPE', 35, 'Report on Inventory of Property and Equipment', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, PB, 'ANNUAL', ['ppe'], false, 'AUTO', P('LEGAL', 'LANDSCAPE'), [], 10],
  ['RPCI', 36, 'Report on Inventory of Supplies and Materials', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, PB, 'SEMESTRAL', ['inventoryItems'], false, 'AUTO', P('LEGAL', 'LANDSCAPE'), [], 10],
  ['RSMI', 37, 'Summary of Supplies and Materials Issued', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, null, 'MONTHLY', ['inventoryTransactions'], true, 'AUTO', P(), [], 10],
  ['BAPC', 38, 'Biological Assets Property Card', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, null, 'ON_DEMAND', ['biologicalAssets'], false, 'AUTO', P(), [], 10],
  ['QRBA', 39, 'Quarterly Report of Biological Assets', 'PROPERTY', 'PROPERTY_OFFICE', PO, null, PB, 'QUARTERLY', ['biologicalAssets'], false, 'AUTO', P(), [], 10],
  // E. Registries
  ['RSTF', 40, 'Registry of Special Trust Fund', 'REGISTRIES', 'BARANGAY_TREASURER', BT, BT, null, 'MONTHLY', ['specialTrustFunds', 'obligations', 'disbursementVouchers'], true, 'AUTO', P('LEGAL', 'LANDSCAPE'), [], 7],
  // F. Financial reports and statements
  ['SMR', 41, 'Statement of Management Responsibility', 'FINANCIAL_STATEMENTS', 'MUNICIPAL_ACCOUNTING', MA, PB, null, 'ANNUAL', ['signatories'], false, 'AUTO', P(), [], 11],
  ['SFPERF', 42, 'Statement of Financial Performance', 'FINANCIAL_STATEMENTS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'ANNUAL', ['accountBalances', 'reportMappings'], false, 'AUTO', P(), [], 11],
  ['DSFPERF', 43, 'Detailed Statement of Financial Performance', 'FINANCIAL_STATEMENTS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'ANNUAL', ['accountBalances', 'reportMappings'], false, 'AUTO', P(), [], 11],
  ['SFP', 44, 'Statement of Financial Position', 'FINANCIAL_STATEMENTS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'ANNUAL', ['accountBalances', 'reportMappings'], false, 'AUTO', P(), ['SFP_BALANCED'], 11],
  ['DSFP', 45, 'Detailed Statement of Financial Position', 'FINANCIAL_STATEMENTS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'ANNUAL', ['accountBalances', 'reportMappings'], false, 'AUTO', P(), ['SFP_BALANCED'], 11],
  ['SNAE', 46, 'Statement of Net Assets / Equity', 'FINANCIAL_STATEMENTS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'ANNUAL', ['accountBalances'], false, 'AUTO', P(), [], 11],
  ['SCNAE', 47, 'Statement of Changes in Net Assets / Equity', 'FINANCIAL_STATEMENTS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'ANNUAL', ['accountBalances'], false, 'AUTO', P(), [], 11],
  ['SCF', 48, 'Statement of Cash Flows', 'FINANCIAL_STATEMENTS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'ANNUAL', ['lines', 'reportMappings'], false, 'AUTO', P(), ['SCF_RECONCILES'], 11],
  ['SCBAA', 49, 'Statement of Comparison of Budget and Actual Amounts', 'FINANCIAL_STATEMENTS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'ANNUAL', ['appropriations', 'obligations', 'estimatedIncome', 'accountBalances'], false, 'AUTO', P('A4', 'LANDSCAPE'), [], 11],
  ['NFS', 50, 'Notes to Financial Statements', 'FINANCIAL_STATEMENTS', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'ANNUAL', ['nfsNarratives', 'accountBalances'], false, 'HYBRID', P(), [], 11],
  // Supplementary schedules
  ['TB', null, 'Trial Balance (Monthly / Pre-Closing / Post-Closing)', 'SCHEDULES', 'MUNICIPAL_ACCOUNTING', MA, MA, null, 'MONTHLY', ['accountBalances'], false, 'AUTO', P(), ['TB_BALANCED'], 8],
  ['CHECKS_ISSUED', null, 'Report of Checks Issued', 'SCHEDULES', 'BARANGAY_TREASURER', BT, BT, null, 'MONTHLY', ['checks'], true, 'AUTO', P('A4', 'LANDSCAPE'), [], 5],
  ['CHECKS_CLEARED', null, 'Checks Cleared / Encashed', 'SCHEDULES', 'MUNICIPAL_ACCOUNTING', AS, MA, null, 'MONTHLY', ['checks', 'bankStatements'], false, 'AUTO', P(), [], 9],
  ['OUTSTANDING_CHECKS', null, 'Schedule of Outstanding Checks', 'SCHEDULES', 'MUNICIPAL_ACCOUNTING', AS, MA, null, 'MONTHLY', ['checks'], false, 'AUTO', P(), [], 9],
  ['CANCELLED_CHECKS', null, 'Cancelled Checks', 'SCHEDULES', 'BARANGAY_TREASURER', BT, BT, null, 'MONTHLY', ['checks'], true, 'AUTO', P(), [], 5],
  ['CA_AGING', null, 'Aging of Unliquidated Cash Advances', 'CASH_ADVANCES', 'MUNICIPAL_ACCOUNTING', AS, MA, null, 'MONTHLY', ['cashAdvances'], false, 'AUTO', P('A4', 'LANDSCAPE'), [], 6],
  ['PPE_DEPRECIATION', null, 'PPE Depreciation Schedule', 'SCHEDULES', 'MUNICIPAL_ACCOUNTING', AS, MA, null, 'ANNUAL', ['ppe', 'ppeDepreciation'], false, 'AUTO', P('A4', 'LANDSCAPE'), [], 10],
  ['SCHEDULE_OF_ACCOUNTS', null, 'Schedule of Accounts (Subsidiary Balances)', 'SCHEDULES', 'MUNICIPAL_ACCOUNTING', AS, MA, null, 'MONTHLY', ['accountBalances', 'subsidiaryAccounts'], false, 'AUTO', P(), ['SL_EQUALS_GL'], 8],
  ['BRS_SCHEDULES', null, 'Bank Reconciliation Schedules', 'BANK', 'MUNICIPAL_ACCOUNTING', AS, MA, null, 'MONTHLY', ['bankReconciliations'], false, 'AUTO', P(), [], 9],
  ['COMPLIANCE', null, 'Compliance Report', 'COMPLIANCE', 'MUNICIPAL_ACCOUNTING', MA, null, null, 'MONTHLY', ['reportSubmissions'], false, 'AUTO', P('A4', 'LANDSCAPE'), [], 12],
];

function defaultDeadline(freq: ReportFrequency, office: ResponsibleOffice): DeadlineRule {
  switch (freq) {
    case 'MONTHLY':
      return office === 'MUNICIPAL_ACCOUNTING'
        ? { kind: 'DAY_OF_FOLLOWING_MONTH', day: 20 }
        : { kind: 'DAYS_AFTER_PERIOD_END', days: 10 };
    case 'QUARTERLY':
      return { kind: 'DAYS_AFTER_PERIOD_END', days: 15 };
    case 'SEMESTRAL':
      return { kind: 'DAYS_AFTER_PERIOD_END', days: 15 };
    case 'ANNUAL':
      return office === 'MUNICIPAL_ACCOUNTING' ? { kind: 'FIXED_DATE_NEXT_YEAR', month: 2, day: 14 } : { kind: 'FIXED_DATE_NEXT_YEAR', month: 1, day: 31 };
    case 'PER_TRANSACTION':
      return { kind: 'NONE' };
    default:
      return { kind: 'NONE' };
  }
}

export const REPORT_DEFINITIONS: readonly (ReportDefinition & { deadlineConfirmed: boolean })[] = ROWS.map(
  ([reportCode, formNumber, reportName, category, responsibleOffice, preparedByRole, certifiedByRole, approvedByRole, frequency, sourceCollections, inMonthlyPackage, generation, [paperSize, orientation], validations, phase]) => ({
    reportCode,
    formNumber,
    reportName,
    category,
    responsibleOffice,
    preparedByRole,
    certifiedByRole,
    approvedByRole,
    frequency,
    deadlineRule: defaultDeadline(frequency, responsibleOffice),
    deadlineConfirmed: false,
    sourceCollections,
    requiredFields: [],
    paperSize,
    orientation,
    templateVersion: 1,
    inMonthlyPackage,
    generation,
    validations,
    phase,
    active: true,
  }),
);

export function reportDefinition(code: string) {
  return REPORT_DEFINITIONS.find((r) => r.reportCode === code);
}
