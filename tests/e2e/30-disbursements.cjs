// Phase 5 — DVs, checks, ADA, payroll. Run after 00-setup.cjs and 10-budget.cjs on the same slot.
const { as, db, ensureUser, expectOk, expectFail, done } = require('./lib.cjs');
const P = (pesos) => Math.round(pesos * 100);
let bad = 0;
function check(label, cond, detail = '') {
  if (cond) console.log('  ok  ', label);
  else { bad++; process.exitCode = 1; console.log('  FAIL', label, detail); }
}
(async () => {
  console.log('Phase 5 Disbursements');
  // A user holding both PB and BT roles exercises segregation of duties on DV approval.
  await ensureUser('pbt@test.local', 'Dual Role Officer', 'AGBOY', ['punong_barangay', 'barangay_treasurer']);
  const ac = await as('ac@test.local'), pb = await as('pb@test.local'), bt = await as('bt@test.local'), ma = await as('ma@test.local'), ar = await as('ar@test.local'), pbt = await as('pbt@test.local');
  const save = (who, module, data, id) => who('saveSource', { module, barangayId: 'AGBOY', data, id });
  const act = (who, module, id, action, extra = {}) => who('sourceAction', { module, id, action, ...extra });
  const DV = 'disbursementVoucher';
  const sl = (account, code, name, type) => expectOk(`SL ${code} under ${account}`, bt('saveSubsidiaryAccount', { barangayId: 'AGBOY', accountCode: account, subsidiaryCode: code, subsidiaryName: name, type, active: true }));
  const bir = await sl('2-02-01-010', 'BIR01', 'Bureau of Internal Revenue', 'BIR');
  const eo = await sl('1-03-03-020', 'EO01', 'Juan D. Cruz, Barangay Kagawad', 'CASH_ADVANCE');
  const ao = await sl('1-03-03-010', 'AO01', 'Teresa C. Bautista, Disbursing Officer', 'CASH_ADVANCE');
  const banks = await db.collection('bankAccounts').where('barangayId', '==', 'AGBOY').get();
  const bank = banks.docs[0];
  const bankId = bank.id, cib = bank.get('subsidiaryId');

  // Budget prerequisites: appropriations + certified obligations.
  async function appropriation(accountCode, amount) {
    const a = await save(ac, 'appropriation', { fiscalYear: 2026, appropriationOrdinanceNumber: '2025-12', appropriationOrdinanceDate: '2025-12-15', appropriationClass: 'REGULAR', accountCode, program: 'General Administration', originalAppropriation: amount });
    await act(ac, 'appropriation', a.id, 'SUBMIT'); await act(pb, 'appropriation', a.id, 'APPROVE');
    return a.id;
  }
  async function obligation(appropriationId, payee, particulars, amount, date = '2026-03-05') {
    const o = await save(bt, 'obligation', { date, payee: { id: null, name: payee }, appropriationId, particulars, amount });
    await act(bt, 'obligation', o.id, 'SUBMIT'); await act(ac, 'obligation', o.id, 'CERTIFY');
    return o.id;
  }
  const appMooe = await appropriation('5-02-99-990', P(200000));
  const appHon = await appropriation('5-01-02-050', P(500000));
  const o1 = await obligation(appMooe, 'Candoni Hardware', 'Repair materials for barangay hall', P(10000));
  const oHon = await obligation(appHon, 'Barangay officials', 'Honoraria March 2026', P(30000));

  // ---- 1. Regular DV with EWT against a certified obligation
  const base = { dvDate: '2026-03-10', dvCategory: 'REGULAR', payee: { id: null, name: 'Candoni Hardware', tin: '123-456-789-000', address: 'Poblacion, Candoni' }, particulars: 'Repair materials for barangay hall per PO 2026-03-001', obligationId: o1, paymentMethod: 'CHECK', taxDeductions: [{ taxType: 'EWT', rateBp: 100 }] };
  await expectFail('DV above the certified obligation is rejected', save(bt, DV, { ...base, charges: [{ accountCode: '5-02-99-990', amount: P(12000) }] }), /exceeds the certified obligation/);
  await expectFail('expense DV without obligation is rejected', save(bt, DV, { ...base, obligationId: null, charges: [{ accountCode: '5-02-99-990', amount: P(100) }] }), /obligation/i);
  const dv1 = await expectOk('BT encodes DV ₱10,000 less 1% EWT', save(bt, DV, { ...base, charges: [{ accountCode: '5-02-99-990', amount: P(10000) }] }));
  let d1 = (await db.doc(`disbursementVouchers/${dv1.id}`).get()).data();
  check('server totals: gross 1,000,000 · tax 10,000 · net 990,000', d1.grossAmount === P(10000) && d1.totalTaxes === P(100) && d1.netAmount === P(9900), JSON.stringify([d1.grossAmount, d1.totalTaxes, d1.netAmount]));
  check('BIR01 ledger resolved for taxes withheld', d1.taxSubsidiaryId === bir.id, d1.taxSubsidiaryId);
  await expectOk('BT submits DV', act(bt, DV, dv1.id, 'SUBMIT'));
  await expectFail('BT cannot approve (no PB role)', act(bt, DV, dv1.id, 'APPROVE'), /permission/i);
  const ap1 = await expectOk('PB approves → DV number', act(pb, DV, dv1.id, 'APPROVE'));
  console.log('      DV no. =', ap1 && ap1.number);
  check('DV number format YYYY-MM-NNN', /^2026-03-\d{3}$/.test(ap1 && ap1.number));
  check('obligation.dvId linked', (await db.doc(`obligations/${o1}`).get()).get('dvId') === dv1.id);
  await expectFail('AC cannot cancel the obligation of an approved DV', act(ac, 'obligation', o1, 'CANCEL', { remarks: 'Testing the DV link guard' }), /Void the DV first/);
  await expectFail('accounting cannot accept an unpaid DV', act(ar, DV, dv1.id, 'ACCEPT'), /approved and paid/);
  await expectOk('BT issues check 1762250', act(bt, DV, dv1.id, 'ISSUE_CHECK', { payload: { bankAccountId: bankId, checkNumber: '1762250', checkDate: '2026-03-12' } }));
  const chk1 = (await db.collection('checks').where('barangayId', '==', 'AGBOY').where('checkNumber', '==', '1762250').get()).docs[0];
  check('check ISSUED for DV net', chk1 && chk1.get('status') === 'ISSUED' && chk1.get('amount') === P(9900) && chk1.get('dvNumber') === ap1.number);
  await expectFail('voiding a DV with an issued check is refused', act(ma, DV, dv1.id, 'VOID', { remarks: 'Testing void guard' }), /Cancel the check/);
  await expectOk('BT releases the check', act(bt, DV, dv1.id, 'RELEASE', { payload: { releasedDate: '2026-03-13' } }));
  check('check RELEASED with date', (await chk1.ref.get()).get('status') === 'RELEASED');
  const acc1 = await expectOk('AR accepts → DRAFT JCT JEV', act(ar, DV, dv1.id, 'ACCEPT'));
  const jevId = acc1 && acc1.jevId;
  const lines = jevId ? (await db.collection(`journalEntries/${jevId}/lines`).get()).docs.map((d) => d.data()) : [];
  const ln = (code, side) => lines.filter((l) => l.accountCode === code).reduce((t, l) => t + l[side], 0);
  check('JEV Dr expense = gross', ln('5-02-99-990', 'debit') === P(10000));
  check('JEV Cr CIB01 = net', ln('1-01-02-010', 'credit') === P(9900) && lines.find((l) => l.accountCode === '1-01-02-010').subsidiaryId === cib);
  check('JEV Cr BIR01 = tax', ln('2-02-01-010', 'credit') === P(100) && lines.find((l) => l.accountCode === '2-02-01-010').subsidiaryId === bir.id);
  const jev = jevId && (await db.doc(`journalEntries/${jevId}`).get()).data();
  check('JEV is JCT, dated on the check, references check & DV', jev && jev.journal === 'JCT' && jev.jevDate === '2026-03-12' && jev.primaryReference === '1762250' && jev.secondaryReference === ap1.number);
  await expectOk('AR submits the JEV', ar('submitJournalEntry', { jevId }));
  await expectOk('MA approves the JEV', ma('approveJournalEntry', { jevId }));
  const posted = await expectOk('MA posts the JEV', ma('postJournalEntry', { jevId }));
  console.log('      JEV no. =', posted && posted.jevNumber);
  d1 = (await db.doc(`disbursementVouchers/${dv1.id}`).get()).data();
  check('DV is POSTED with the JEV number', d1.status === 'POSTED' && d1.jevNumber === (posted && posted.jevNumber), d1.status);

  // ---- 2. Segregation of duties: PB approving their own DV
  const o2 = await obligation(appMooe, 'Juan Store', 'Cleaning supplies', P(1500));
  const dv2 = await expectOk('dual-role officer encodes a DV', save(pbt, DV, { dvDate: '2026-03-11', dvCategory: 'REGULAR', payee: { id: null, name: 'Juan Store' }, particulars: 'Cleaning supplies', obligationId: o2, paymentMethod: 'CHECK', charges: [{ accountCode: '5-02-99-990', amount: P(1500) }] }));
  await act(pbt, DV, dv2.id, 'SUBMIT');
  await expectFail('PB cannot approve a DV they prepared', act(pbt, DV, dv2.id, 'APPROVE'), /prepared this record/);

  // ---- 3. Cash advance DV → cashAdvances doc; check numbers unique per bank account; cancel & re-issue
  const ca = await expectOk('BT encodes CA DV ₱5,000 for EO01 (official travel)', save(bt, DV, { dvDate: '2026-03-15', dvCategory: 'CASH_ADVANCE', payee: { id: eo.id, name: 'Juan D. Cruz' }, particulars: 'Cash advance for travel to Bacolod City (DILG seminar)', paymentMethod: 'CHECK', charges: [{ accountCode: '1-03-03-020', subsidiaryId: eo.id, amount: P(5000) }], cashAdvance: { accountableOfficerId: eo.id, cashAdvanceType: 'OFFICIAL_TRAVEL', purpose: 'DILG seminar, Bacolod City' } }));
  await act(bt, DV, ca.id, 'SUBMIT');
  const apCa = await expectOk('PB approves CA DV', act(pb, DV, ca.id, 'APPROVE'));
  const caDv = (await db.doc(`disbursementVouchers/${ca.id}`).get()).data();
  const caDoc = caDv.cashAdvanceId && (await db.doc(`cashAdvances/${caDv.cashAdvanceId}`).get()).data();
  check('cashAdvances doc created and linked', !!caDoc && caDoc.dvId === ca.id && caDoc.dvNumber === apCa.number);
  check('CA: officer EO01, granted = outstanding = net, ACTIVE', caDoc && caDoc.accountableOfficerId === eo.id && caDoc.accountCode === '1-03-03-020' && caDoc.amountGranted === P(5000) && caDoc.outstandingBalance === P(5000) && caDoc.status === 'ACTIVE' && caDoc.isLegacy === false);
  check('CA due date = grant + 30 days (official travel)', caDoc && caDoc.grantDate === '2026-03-15' && caDoc.liquidationDueDate === '2026-04-14', caDoc && caDoc.liquidationDueDate);
  await expectFail('duplicate check number on the same bank account is rejected', act(bt, DV, ca.id, 'ISSUE_CHECK', { payload: { bankAccountId: bankId, checkNumber: '1762250', checkDate: '2026-03-16' } }), /already used/);
  await expectOk('issue check 1762251', act(bt, DV, ca.id, 'ISSUE_CHECK', { payload: { bankAccountId: bankId, checkNumber: '1762251', checkDate: '2026-03-16' } }));
  check('CA picks up the check number', (await db.doc(`cashAdvances/${caDv.cashAdvanceId}`).get()).get('checkNumber') === '1762251');
  await expectOk('cancel check 1762251 (spoiled) from the DV', act(bt, DV, ca.id, 'CANCEL_PAYMENT', { remarks: 'Spoiled — wrong amount in words', payload: { cancelledDate: '2026-03-16' } }));
  await expectFail('cancelled check number cannot be reused', act(bt, DV, ca.id, 'ISSUE_CHECK', { payload: { bankAccountId: bankId, checkNumber: '1762251', checkDate: '2026-03-16' } }), /already used/);
  await expectOk('re-issue with check 1762252', act(bt, DV, ca.id, 'ISSUE_CHECK', { payload: { bankAccountId: bankId, checkNumber: '1762252', checkDate: '2026-03-16' } }));
  const chk3 = (await db.collection('checks').where('barangayId', '==', 'AGBOY').where('checkNumber', '==', '1762252').get()).docs[0];
  await expectOk('void check 1762252 from the checks register', bt('cancelCheck', { checkId: chk3.id, status: 'VOID', reason: 'Payee requested ADA instead', cancelledDate: '2026-03-17' }));
  check('voided check keeps its number (VOID)', (await chk3.ref.get()).get('status') === 'VOID' && (await db.doc(`disbursementVouchers/${ca.id}`).get()).get('paymentStatus') === 'UNPAID');
  await expectOk('re-issue with check 1762253', act(bt, DV, ca.id, 'ISSUE_CHECK', { payload: { bankAccountId: bankId, checkNumber: '1762253', checkDate: '2026-03-17' } }));
  await expectOk('release CA check', act(bt, DV, ca.id, 'RELEASE', { payload: { releasedDate: '2026-03-17' } }));
  const accCa = await expectOk('AR accepts CA DV', act(ar, DV, ca.id, 'ACCEPT'));
  const caLines = accCa ? (await db.collection(`journalEntries/${accCa.jevId}/lines`).get()).docs.map((d) => d.data()) : [];
  check('CA JEV: Dr 1-03-03-020 EO01 / Cr CIB', caLines.some((l) => l.accountCode === '1-03-03-020' && l.subsidiaryId === eo.id && l.debit === P(5000)) && caLines.some((l) => l.accountCode === '1-01-02-010' && l.credit === P(5000)));

  // ---- 4. ADA payment
  const o3 = await obligation(appMooe, 'CENECO', 'Electricity, February 2026', P(2500));
  const dv3 = await save(bt, DV, { dvDate: '2026-03-18', dvCategory: 'REGULAR', payee: { id: null, name: 'Central Negros Electric Cooperative' }, particulars: 'Electricity, February 2026', obligationId: o3, paymentMethod: 'ADA', charges: [{ accountCode: '5-02-99-990', amount: P(2500) }] });
  await act(bt, DV, dv3.id, 'SUBMIT'); await act(pb, DV, dv3.id, 'APPROVE');
  await expectFail('ADA DV cannot be paid by check', act(bt, DV, dv3.id, 'ISSUE_CHECK', { payload: { bankAccountId: bankId, checkNumber: '1762260', checkDate: '2026-03-18' } }), /not by check/);
  const ada = await expectOk('issue ADA', act(bt, DV, dv3.id, 'ISSUE_ADA', { payload: { bankAccountId: bankId, adaDate: '2026-03-18' } }));
  const d3 = (await db.doc(`disbursementVouchers/${dv3.id}`).get()).data();
  check('ADA numbered ADA-2026-03-NNN', /^ADA-2026-03-\d{3}$/.test(d3.adaNumber || ''), d3.adaNumber);

  // ---- 5. Payroll → DV (check), and payroll paid through a cash advance
  const entries = [
    { payeeName: 'Pedro B. Belmonte', position: 'Punong Barangay', grossAmount: P(12000), deductions: [{ description: 'W/Tax', accountCode: '2-02-01-010', amount: P(600) }] },
    { payeeName: 'Juan D. Cruz', position: 'Barangay Kagawad', grossAmount: P(9000), deductions: [{ description: 'W/Tax', accountCode: '2-02-01-010', amount: P(450) }] },
    { payeeName: 'Ana E. Reyes', position: 'Barangay Kagawad', grossAmount: P(9000), deductions: [] },
  ];
  const pr = await expectOk('BT encodes honoraria payroll (3 payees)', save(bt, 'payroll', { payrollDate: '2026-03-25', payrollType: 'HONORARIA', payPeriodFrom: '2026-03-01', payPeriodTo: '2026-03-31', particulars: 'Honoraria of barangay officials', obligationId: oHon, expenseAccountCode: '5-01-02-050', paymentMethod: 'CHECK', entries }));
  const prd = (await db.doc(`payrolls/${pr.id}`).get()).data();
  check('payroll totals recomputed (gross 30,000 · ded 1,050 · net 28,950)', prd.grossAmount === P(30000) && prd.totalDeductions === P(1050) && prd.netAmount === P(28950) && prd.entryCount === 3 && prd.entries[0].netAmount === P(11400));
  await expectFail('DV cannot be created from an unapproved payroll', bt('createDvFromPayroll', { payrollId: pr.id, dvDate: '2026-03-26' }), /APPROVED payroll/);
  await act(bt, 'payroll', pr.id, 'SUBMIT');
  const apPr = await expectOk('PB approves payroll → PR number', act(pb, 'payroll', pr.id, 'APPROVE'));
  check('payroll number PR-2026-03-NNN', /^PR-2026-03-\d{3}$/.test(apPr && apPr.number));
  const prDv = await expectOk('create DV from payroll', bt('createDvFromPayroll', { payrollId: pr.id, dvDate: '2026-03-26', paymentMethod: 'CHECK', bankAccountId: bankId }));
  await expectFail('second DV for the same payroll is refused', bt('createDvFromPayroll', { payrollId: pr.id, dvDate: '2026-03-26' }), /already has DV/);
  const pdv = (await db.doc(`disbursementVouchers/${prDv.dvId}`).get()).data();
  check('payroll DV: category PAYROLL, gross 30,000, BIR deduction 1,050, net 28,950, linked both ways', pdv.dvCategory === 'PAYROLL' && pdv.grossAmount === P(30000) && pdv.totalOtherDeductions === P(1050) && pdv.netAmount === P(28950) && pdv.payrollId === pr.id && (await db.doc(`payrolls/${pr.id}`).get()).get('dvId') === prDv.dvId);
  await act(bt, DV, prDv.dvId, 'SUBMIT'); const apPdv = await act(pb, DV, prDv.dvId, 'APPROVE');
  check('payroll gets the DV number on approval', (await db.doc(`payrolls/${pr.id}`).get()).get('dvNumber') === apPdv.number);
  await expectOk('issue payroll check', act(bt, DV, prDv.dvId, 'ISSUE_CHECK', { payload: { bankAccountId: bankId, checkNumber: '1762254', checkDate: '2026-03-27' } }));
  const accPr = await expectOk('AR accepts payroll DV', act(ar, DV, prDv.dvId, 'ACCEPT'));
  const pl = accPr ? (await db.collection(`journalEntries/${accPr.jevId}/lines`).get()).docs.map((d) => d.data()) : [];
  check('payroll JEV: Dr honoraria 30,000 / Cr BIR01 1,050 / Cr CIB 28,950', pl.some((l) => l.accountCode === '5-01-02-050' && l.debit === P(30000)) && pl.some((l) => l.accountCode === '2-02-01-010' && l.subsidiaryId === bir.id && l.credit === P(1050)) && pl.some((l) => l.accountCode === '1-01-02-010' && l.credit === P(28950)));
  await expectOk('mark payees signed', bt('setPayrollSignatures', { payrollId: pr.id, signed: [true, true, false] }));

  const pr2 = await expectOk('BT encodes BHW allowance payroll paid via cash advance (AO01)', save(bt, 'payroll', { payrollDate: '2026-03-25', payrollType: 'ALLOWANCE', payPeriodFrom: '2026-03-01', payPeriodTo: '2026-03-31', expenseAccountCode: '5-01-02-990', paymentMethod: 'CASH_ADVANCE', disbursingOfficerId: ao.id, entries: [{ payeeName: 'Lorna Gatuslao', position: 'BHW', grossAmount: P(1500), deductions: [] }, { payeeName: 'Rosa Banga', position: 'BHW', grossAmount: P(1500), deductions: [] }] }));
  await act(bt, 'payroll', pr2.id, 'SUBMIT'); await act(pb, 'payroll', pr2.id, 'APPROVE');
  const caPrDv = await expectOk('create CA DV from payroll', bt('createDvFromPayroll', { payrollId: pr2.id, dvDate: '2026-03-26', paymentMethod: 'CHECK' }));
  await act(bt, DV, caPrDv.dvId, 'SUBMIT'); await expectOk('PB approves payroll CA DV', act(pb, DV, caPrDv.dvId, 'APPROVE'));
  const cpd = (await db.doc(`disbursementVouchers/${caPrDv.dvId}`).get()).data();
  const cpa = cpd.cashAdvanceId && (await db.doc(`cashAdvances/${cpd.cashAdvanceId}`).get()).data();
  check('payroll CA: category CASH_ADVANCE, AO01, ₱3,000, due in 5 days, linked to payroll', cpd.dvCategory === 'CASH_ADVANCE' && cpa && cpa.accountableOfficerId === ao.id && cpa.cashAdvanceType === 'PAYROLL' && cpa.amountGranted === P(3000) && cpa.liquidationDueDate === '2026-03-31' && (await db.doc(`payrolls/${pr2.id}`).get()).get('cashAdvanceId') === cpd.cashAdvanceId);

  if (bad) { console.log(`\n${bad} CHECK FAILURE(S)`); process.exit(1); }
  done();
})();
