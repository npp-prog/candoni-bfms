// Legacy workbook import — a small SYNTHETIC workbook (fake names) parsed by the shared parser and
// imported through the import callables into HABA 2026: SL master, opening (period 00), journal,
// prior-year TB, legacy CA list, PPE schedule, cancelled checks. Asserts JEV numbers follow the
// dates, the TB balances, an unbalanced entry is rejected (reported, not imported) and a second
// import of the journal / opening is refused.
const path = require('path');
const { buildSync } = require('esbuild');
const { as, db, expectOk, expectFail, done } = require('./lib.cjs');

// Bundle the pure parser + payload helpers (TypeScript) for this script.
const out = path.join(require('os').tmpdir(), `bfms-import-parser-${process.pid}.cjs`);
buildSync({
  stdin: { contents: "export * from './shared/src/accounting/workbookImport'; export * from './shared/src/accounting/importPayload';", resolveDir: path.resolve(__dirname, '../..'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'warning',
});
const P = require(out);

const B = 'HABA';
const FY = 2026;
const D = (s) => new Date(`${s}T00:00:00Z`);
let failed = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` ${extra}` : ''}`); if (!ok) failed++; };

const HDR = ['Primary Reference', 'Account Code', 'SL', 'Account Name', 'P', 'Debit', 'Credit', 'JEV No', 'Name', 'Secondary Reference', 'Tertiary Reference', 'Date', 'Particulars', 'Transaction Type', 'Month'];
const row = (o) => [o.p ?? null, o.a ?? null, o.sl ?? null, null, null, o.dr ?? null, o.cr ?? null, o.jev ?? null, o.n ?? null, o.s ?? null, o.t ?? null, o.d ? D(o.d) : null, o.part ?? null, o.tt ?? null, o.m ?? null];

const sheets = {
  'TO DO LISTS': [['BARANGAY HABA'], ['Check the ₱10 difference']],
  ACODE: [
    ['Account Code', 'Account Name', 'Normal Balance', null, 'Active Codes', null, null, 'Month Codes', null, null, 'All SL Codes'],
    ['1-01-01-010', 'Cash - In Local Treasury', 'Debit', null, null, null, null, 'January', '01', null, '1-01-01-010', 'BT01', 'JUAN T. DELA CRUZ'],
    ['1-01-02-010', 'Cash in Bank', 'Debit', null, null, null, null, null, null, null, '1-01-02-010', 'CIB01', 'SAMPLE RURAL BANK'],
    ['1-03-03-010', 'Advances for Payroll', 'Debit', null, null, null, null, null, null, null, '1-03-03-010', 'AO01', 'PEDRO M. PENDUKO'],
    ['1-03-03-020', 'Advances to Officers and Employees', 'Debit', null, null, null, null, null, null, null, '1-03-03-020', 'EO01', 'MARIA L. CLARA'],
    ['2-02-01-010', 'Due to BIR', 'Credit', null, null, null, null, null, null, null, '2-02-01-010', 'BIR01', 'BUREAU OF INTERNAL REVENUE'],
  ],
  'PY DB': [
    HDR,
    row({ a: '1-01-01-010', sl: 'BT01', dr: 1500, n: 'JUAN T. DELA CRUZ', d: '2026-01-01', part: 'Opening Balance' }),
    row({ a: '1-01-02-010', sl: 'CIB01', dr: 250000.5, n: 'SAMPLE RURAL BANK', d: '2026-01-01', part: 'Opening Balance' }),
    row({ a: '1-03-03-010', sl: 'AO01', dr: 12000, n: 'PEDRO M. PENDUKO', d: '2026-01-01', part: 'Opening Balance' }),
    row({ a: '1-07-05-020', dr: 60000, d: '2026-01-01', part: 'Opening Balance' }),
    row({ a: '1-07-05-021', cr: 12000, d: '2026-01-01', part: 'Opening Balance' }),
    row({ a: '2-02-01-010', sl: 'BIR01', dr: -300, d: '2026-01-01', part: 'Opening Balance' }), // negative debit = credit
    row({ a: '3-01-01-010', cr: 311200.5, d: '2026-01-01', part: 'Opening Balance' }),
  ],
  '01_CY DB': [
    HDR,
    // listed out of date order on purpose: JEV numbers must still follow the dates
    row({ p: '1000102', a: '5-02-03-010', dr: 5000, n: 'ACME OFFICE SUPPLY', s: '2026-02-001', d: '2026-02-10', part: 'Payment for office supplies', tt: 'Disbursement Voucher', m: '02' }),
    row({ p: '1000102', a: '1-01-02-010', sl: 'CIB01', cr: 4950, n: 'ACME OFFICE SUPPLY', s: '2026-02-001', d: '2026-02-10', part: 'Payment for office supplies', tt: 'Disbursement Voucher', m: '02' }),
    row({ p: '1000102', a: '2-02-01-010', sl: 'BIR01', cr: 50, n: 'ACME OFFICE SUPPLY', s: '2026-02-001', d: '2026-02-10', part: 'Payment for office supplies', tt: 'Disbursement Voucher', m: '02' }),
    row({ p: '0000101-0000110', a: '1-01-01-010', sl: 'BT01', dr: 2500.255, n: 'JUAN T. DELA CRUZ', s: '2026-01-001', d: '2026-01-15', part: 'To record collections per RCD 2026-01-001', tt: 'Collections', m: '01' }),
    row({ p: '0000101-0000110', a: '4-04-01-010', cr: 2500.255, n: 'JUAN T. DELA CRUZ', s: '2026-01-001', d: '2026-01-15', part: 'To record collections per RCD 2026-01-001', tt: 'Collections', m: '01' }),
    row({ p: 'DS-01', a: '1-01-02-010', sl: 'CIB01', dr: 2500.26, n: 'JUAN T. DELA CRUZ', s: '2026-01-001', d: '2026-01-16', part: 'Deposit of collections' }),
    row({ p: 'DS-01', a: '1-01-01-010', sl: 'BT01', cr: 2500.26, n: 'JUAN T. DELA CRUZ', s: '2026-01-001', d: '2026-01-16', part: 'Deposit of collections' }),
    // cancelled check pair (one row without account)
    row({ p: '1000101', dr: 0, n: 'CANCELLED CHECK', t: 'N/A', d: '2026-01-20', part: 'Cancelled Check' }),
    row({ p: '1000101', a: '1-01-02-010', sl: 'CIB01', cr: 0, n: 'CANCELLED CHECK', t: 'N/A', d: '2026-01-20', part: 'Cancelled Check' }),
    // cash advance with a legacy JEV number (kept as tertiary reference)
    row({ p: '1000103', a: '1-03-03-020', sl: 'EO01', dr: 8000, jev: '05-2026-02-003', n: 'MARIA L. CLARA', s: '2026-02-002', d: '2026-02-12', part: 'CA for seminar' }),
    row({ p: '1000103', a: '1-01-02-010', sl: 'CIB01', cr: 8000, jev: '05-2026-02-003', n: 'MARIA L. CLARA', s: '2026-02-002', d: '2026-02-12', part: 'CA for seminar' }),
    // unbalanced by ₱10 → reported, not imported
    row({ p: '1000104', a: '5-02-04-020', dr: 1000, n: 'POWER COOP', s: '2026-03-001', d: '2026-03-05', part: 'Electricity', tt: 'Disbursement Voucher', m: '03' }),
    row({ p: '1000104', a: '1-01-02-010', sl: 'CIB01', cr: 990, n: 'POWER COOP', s: '2026-03-001', d: '2026-03-05', part: 'Electricity', tt: 'Disbursement Voucher', m: '03' }),
    // month column disagrees with the date (warning only)
    row({ p: 'BS', a: '1-01-02-010', sl: 'CIB01', dr: 100000, n: 'BRGY HABA', s: 'BS', d: '2026-03-01', part: 'Record NTA', tt: 'Others', m: '02' }),
    row({ p: 'BS', a: '4-01-04-010', cr: 100000, n: 'BRGY HABA', s: 'BS', d: '2026-03-01', part: 'Record NTA', tt: 'Others', m: '02' }),
    [null, null, null, "Prior Years' Adjustments"], // template residue
  ],
  '02.2_PRETB_3Y': [
    ['fff', 'Normal Balance', 'Account Name', '2026', '2026', '2025', '2025', '2024', '2024'],
    [null, null, null, 'Debit', 'Credit', 'Debit', 'Credit', 'Debit', 'Credit'],
    ['1-01-02-010', 'Debit', 'Cash in Bank', 0, 0, 250000.5, 0, 200000, 0],
    ['1-01-01-010', 'Debit', 'Cash - In Local Treasury', 0, 0, 1500, 0, 1000, 0],
    ['3-01-01-010', 'Credit', 'Accumulated Surplus', 0, 0, 0, 251500.5, 0, 201000],
  ],
  'List of Unliquidated Advances': [
    ['BARANGAY HABA'],
    ['DATE', 'REF', 'ACCOUNT NAME', 'ACCOUNT CODE', 'CHECK', 'NAME', 'PARTICULARS', 'AMOUNT'],
    [D('2024-05-10'), '2024-05-011', 'Payroll Fund', 106, 900001, 'Pedro Penduko', 'CA honoraria', 10000],
    [D('2025-03-02'), '2025-03-020', 'Advances for Payroll', '1-03-03-010', 900002, 'PEDRO M. PENDUKO', 'CA labor payroll', 2000],
    [null, null, null, null, null, null, 'SUBTOTAL', 12000],
  ],
  'PPE Depreciation Schedule': [
    [null, null, null, 'RESIDUAL VALUE', 'DEPRECIABLE AMOUNT', 'LIFE', 'DEPRECIATION EXPENSE'],
    ['1-07-05-020', 'Office Equipment', 60000, 3000, 57000, 5, 11400],
    ['1-07-04-010', 'Buildings', 500000, 0, 500000, 10, 50000],
  ],
};

(async () => {
  console.log('Legacy workbook import (synthetic workbook → HABA 2026)');
  const ma = await as('ma@test.local'), ar = await as('ar@test.local');
  await expectOk('open HABA 2026', ma('openBarangayFiscalYear', { barangayId: B, fiscalYear: FY }).catch((e) => { if (/already|exist/i.test(e.message)) return; throw e; }));
  await expectOk('bank account (CIB01) registered first', ma('saveBankAccount', { barangayId: B, bankName: 'Sample Rural Bank', branch: 'Candoni', accountName: 'BRGY HABA GF', accountNumber: '9990001', accountType: 'CURRENT', fundId: 'GF', subsidiaryCode: 'CIB01', active: true }));

  // ---- Parse
  const w = P.parseWorkbook(sheets, { title: 'HABA synthetic' });
  check('barangay guessed', w.barangayGuess === B, w.barangayGuess);
  check('fiscal year from PY DB', w.fiscalYear === FY, String(w.fiscalYear));
  check('opening balanced (negative debit → credit)', w.opening && w.opening.balanced && w.opening.totalDebit === 32350050, JSON.stringify(w.opening && [w.opening.totalDebit, w.opening.totalCredit]));
  check('6 entries grouped, 1 cancelled check', w.entries.length === 6 && w.cancelledChecks.length === 1, `${w.entries.length}/${w.cancelledChecks.length}`);
  const unb = w.issues.find((i) => i.code === 'UNBALANCED');
  check('₱10 difference reported', unb && /difference 10\.00/.test(unb.message), unb && unb.message);
  check('month mismatch warned', w.issues.some((i) => i.code === 'MONTH_MISMATCH'));
  check('collection amount rounded half-up (2500.255 → 250026)', w.entries.some((e) => e.transactionType === 'COLLECTION' && e.totalDebit === 250026));
  check('deposit type inferred', w.entries.some((e) => e.transactionType === 'DEPOSIT' && e.transactionTypeInferred));
  check('prior years 2025 + 2024', w.priorYears.map((y) => y.fiscalYear).join() === '2025,2024');
  check('legacy CA mapped to AO01 (name match, legacy code 106)', w.legacyCashAdvances.length === 2 && w.legacyCashAdvances.every((c) => c.accountCode === '1-03-03-010' && c.subsidiaryCode === 'AO01'), JSON.stringify(w.legacyCashAdvances.map((c) => c.subsidiaryCode)));
  check('PPE rows with defaults', w.ppeSchedule.length === 2 && w.ppeSchedule[0].residualRateBp === 500 && w.ppeSchedule[0].accumulatedAccountCode === '1-07-05-021' && w.ppeSchedule[1].expenseAccountCode === '5-04-01-030');

  // ---- Permissions / status
  const st = await expectOk('AR reads importStatus (import.manage)', ar('importStatus', { barangayId: B, fiscalYear: FY }));
  check('status: nothing blocked yet', st && Object.keys(st.blocked).length === 0, st && JSON.stringify(st.blocked));
  const fingerprint = P.importFingerprint(w);
  const parts = ['SUBSIDIARIES', 'OPENING', 'JOURNAL', 'PRIOR_YEARS', 'CASH_ADVANCES', 'PPE', 'CANCELLED_CHECKS'];
  await expectFail('AR cannot start an import (import.approve)', ar('importBegin', { barangayId: B, fiscalYear: FY, parts, fingerprint }), /permission/i);

  // ---- Import as the Municipal Accountant
  const begin = await expectOk('MA importBegin', ma('importBegin', { barangayId: B, fiscalYear: FY, parts, fingerprint, sourceTitle: 'HABA synthetic', counts: { entries: w.entries.length } }));
  const importId = begin && begin.importId;
  const subs = await expectOk('importSubsidiaries', ma('importSubsidiaries', { importId, subsidiaries: w.subsidiaries.map(({ source, ...s }) => s) }));
  check('4 SLs created, CIB01 kept (bank account)', subs && subs.created === 4 && subs.skipped.length === 1, JSON.stringify(subs));
  const journal = w.entries.map(P.toEntryPayload); // includes the unbalanced entry on purpose: the server must reject it
  await expectFail('journal before opening refused', ma('importEntries', { importId, kind: 'JOURNAL', entries: journal }), /opening/i);
  const op = await expectOk('import opening', ma('importEntries', { importId, kind: 'OPENING', entries: [P.openingPayload(w.opening, FY)] }));
  check('opening JEV 2026-01-001', op && op.posted[0] && op.posted[0].jevNumber === `${FY}-01-001`, JSON.stringify(op));
  const jr = await expectOk('import journal', ma('importEntries', { importId, kind: 'JOURNAL', entries: journal }));
  check('5 entries posted, unbalanced rejected', jr && jr.posted.length === 5 && jr.rejected.length === 1 && /Total debits must equal|balance/i.test(jr.rejected[0].reason), jr && JSON.stringify(jr.rejected));
  const retry = await expectOk('retry same batch (idempotent)', ma('importEntries', { importId, kind: 'JOURNAL', entries: journal.filter((e) => jr && !jr.rejected.some((r) => r.key === e.key)) }));
  check('retry skips everything', retry && retry.posted.length === 0 && retry.skipped.length === 5, retry && JSON.stringify(retry));
  await expectOk('prior years', ma('importReference', { importId, priorYears: w.priorYears.map((y) => ({ fiscalYear: y.fiscalYear, rows: y.rows })) }));
  await expectOk('legacy cash advances', ma('importReference', { importId, cashAdvances: { offset: 0, items: w.legacyCashAdvances.map(({ sheet, row, ...c }) => c) } }));
  await expectOk('PPE schedule', ma('importReference', { importId, ppe: w.ppeSchedule.map(P.toPpePayload) }));
  const banks = await ma('importStatus', { barangayId: B, fiscalYear: FY });
  await expectOk('cancelled checks', ma('importReference', { importId, cancelledChecks: { bankAccountId: banks.bankAccounts[0].id, items: P.toCancelledCheckPayloads(w.cancelledChecks) } }));
  await expectOk('importFinish', ma('importFinish', { importId }));

  // ---- Assertions on the books
  const jevs = (await db.collection('journalEntries').where('barangayId', '==', B).where('fiscalYear', '==', FY).where('sourceModule', '==', 'IMPORT').get()).docs.map((d) => d.data());
  check('6 IMPORT JEVs posted (opening + 5)', jevs.length === 6 && jevs.every((j) => j.status === 'POSTED'), String(jevs.length));
  const byDate = [...jevs].sort((a, b) => a.jevDate.localeCompare(b.jevDate) || a.jevNumber.localeCompare(b.jevNumber));
  check('JEV numbers in date order', byDate.every((j, i) => i === 0 || j.jevNumber > byDate[i - 1].jevNumber), byDate.map((j) => `${j.jevDate}:${j.jevNumber}`).join(' '));
  const ob = jevs.find((j) => j.entryType === 'OPENING');
  check('opening in period 00', ob && ob.accountingPeriod === `${FY}-00` && ob.jevNumber === `${FY}-01-001`);
  const ca = jevs.find((j) => j.primaryReference === '1000103');
  check('legacy JEV no. kept as tertiary reference; DISBURSEMENT inferred; payee kept', ca && ca.tertiaryReference === '05-2026-02-003' && ca.transactionType === 'DISBURSEMENT' && ca.payeeName === 'MARIA L. CLARA' && ca.journal === 'JCT');
  const bals = (await db.collection('accountBalances').where('barangayId', '==', B).where('fiscalYear', '==', FY).get()).docs.map((d) => d.data()).filter((b) => b.subsidiaryId === null);
  const tDr = bals.reduce((s, b) => s + b.debit, 0), tCr = bals.reduce((s, b) => s + b.credit, 0);
  check('trial balance balanced', tDr === tCr && tDr > 0, `${tDr} / ${tCr}`);
  const cib = bals.filter((b) => b.accountCode === '1-01-02-010').reduce((s, b) => s + b.debit - b.credit, 0);
  check('Cash in Bank = 250,000.50 + 2,500.26 − 4,950 − 8,000 + 100,000', cib === 33955076, String(cib));
  const p00 = bals.filter((b) => b.month === 0).reduce((s, b) => s + b.debit, 0);
  check('period 00 holds the opening', p00 === 32350050, String(p00));
  const lb = await db.doc(`legacyBalances/${B}_2025`).get();
  check('legacyBalances 2025', lb.exists && lb.get('rows').length === 3 && lb.get('kind') === 'PRE_CLOSING_TB');
  const lca = (await db.collection('legacyCashAdvances').where('barangayId', '==', B).get()).docs.map((d) => d.data());
  check('legacy CAs with AO01 ledger', lca.length === 2 && lca.every((c) => c.subsidiaryId === `${B}_1-03-03-010_AO01`));
  const ppe = await db.doc(`ppeSchedules/${B}_${FY}`).get();
  check('ppeSchedules rows', ppe.exists && ppe.get('rows').length === 2);
  const cxl = (await db.collection('cancelledChecks').where('barangayId', '==', B).get()).docs;
  check('cancelled check recorded', cxl.length === 1 && cxl[0].get('checkNumber') === '1000101');
  const audits = (await db.collection('auditLogs').where('barangayId', '==', B).where('action', '==', 'IMPORT_COMMIT').get()).size;
  check('IMPORT_COMMIT audit records', audits >= 5, String(audits));
  const bfy = await db.doc(`barangayFiscalYears/${B}_${FY}`).get();
  check('openingBalancesPosted flag', bfy.get('openingBalancesPosted') === true);

  // ---- Re-import refused
  await expectFail('second journal import refused', ma('importBegin', { barangayId: B, fiscalYear: FY, parts: ['JOURNAL'], fingerprint }), /already imported/i);
  await expectFail('second opening import refused', ma('importBegin', { barangayId: B, fiscalYear: FY, parts: ['OPENING'], fingerprint }), /period .*00|opening/i);
  await expectFail('CA list refused twice', ma('importBegin', { barangayId: B, fiscalYear: FY, parts: ['CASH_ADVANCES'], fingerprint }), /already/i);
  await expectFail('finished import cannot continue', ma('importEntries', { importId, kind: 'JOURNAL', entries: journal.slice(0, 1) }), /finished/i);
  const st2 = await ma('importStatus', { barangayId: B, fiscalYear: FY });
  check('status reports the blocks', st2.blocked.JOURNAL && st2.blocked.OPENING && st2.journalImported && st2.openingPosted);

  if (failed) { console.log(`\n${failed} CHECK(S) FAILED`); process.exit(1); }
  done();
})();
