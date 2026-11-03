/**
 * Reports of the barangay accounting system (what the Municipal Accounting Office prepares from
 * the barangay's books — the legacy workbook's TB, ledgers, bank reconciliation, schedules and
 * statements). The Report Center lists only these unless transaction modules are enabled.
 */
export const ACCOUNTING_REPORT_CODES = [
  'JEV',
  'JCT',
  'GJ',
  'GL',
  'SL',
  'TB',
  'TB_3Y',
  'SCHEDULE_OF_ACCOUNTS',
  'CHECKS_ISSUED',
  'CHECKS_CLEARED',
  'OUTSTANDING_CHECKS',
  'BRS',
  'BRS_SCHEDULES',
  'RBDCM',
  'CA_AGING',
  'PPE_DEPRECIATION',
  'SFPERF',
  'DSFPERF',
  'SFP',
  'DSFP',
  'SNAE',
  'SCNAE',
  'SCF',
  'NFS',
  'SMR',
] as const;

export function isAccountingReport(code: string): boolean {
  return (ACCOUNTING_REPORT_CODES as readonly string[]).includes(code);
}
