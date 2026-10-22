const { as, db, admin, expectOk, expectFail, done } = require('./lib.cjs');

let bad = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) bad++;
  console.log(ok ? '  ok  ' : '  FAIL', label, ok ? `= ${JSON.stringify(actual)}` : `→ got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
const get = async (col, id) => (await db.doc(`${col}/${id}`).get()).data();

(async () => {
  console.log('Phases 6–7 Cash advances, liquidations, petty cash, special trust funds');
  const bt = await as('bt@test.local'), pb = await as('pb@test.local'), ma = await as('ma@test.local'), ac = await as('ac@test.local'), ar = await as('ar@test.local');
  const save = (who, module, data, id) => who('saveSource', { module, barangayId: 'AGBOY', data, id });
  const act = (who, module, id, action, extra = {}) => who('sourceAction', { module, id, action, ...extra });
  const now = admin.firestore.Timestamp.now();
  const BT01 = 'AGBOY_1-01-01-010_BT01', EO01 = 'AGBOY_1-03-03-020_EO01', PC01 = 'AGBOY_1-01-01-020_PC01';

  await expectOk('EO01 ledger (1-03-03-020)', bt('saveSubsidiaryAccount', { barangayId: 'AGBOY', accountCode: '1-03-03-020', subsidiaryCode: 'EO01', subsidiaryName: 'Teresa Bautista, Barangay Treasurer', type: 'CASH_ADVANCE', active: true }));
  await expectOk('PC01 custodian ledger (1-01-01-020)', bt('saveSubsidiaryAccount', { barangayId: 'AGBOY', accountCode: '1-01-01-020', subsidiaryCode: 'PC01', subsidiaryName: 'Teresa Bautista, Petty Cash Custodian', type: 'ACCOUNTABLE_OFFICER', active: true }));

  // ---- cash advance as Phase 5 creates it from an approved CASH_ADVANCE DV
  const ca = (id, o) => db.doc(`cashAdvances/${id}`).set({
    barangayId: 'AGBOY', fiscalYear: 2026, accountableOfficerId: EO01, accountableOfficerName: 'Teresa Bautista, Barangay Treasurer', accountCode: '1-03-03-020',
    cashAdvanceType: 'SPECIAL_PURPOSE', dvId: `dv-${id}`, dvNumber: o.dvNumber, checkId: null, checkNumber: '1762301', grantDate: o.grantDate, purpose: o.purpose,
    amountGranted: o.amount, amountLiquidated: 0, amountRefunded: 0, outstandingBalance: o.amount, liquidationDueDate: o.due, daysOutstanding: 0, agingCategory: '0-30 days',
    status: 'ACTIVE', isLegacy: false, updatedAt: now,
  });
  await ca('e2e-ca-1', { dvNumber: '2026-03-010', grantDate: '2026-03-02', purpose: 'Barangay sports fest supplies', amount: 1000000, due: '2026-12-31' });
  await ca('e2e-ca-2', { dvNumber: '2026-01-004', grantDate: '2026-01-05', purpose: 'Clean-up drive', amount: 200000, due: '2026-02-04' });

  const items1 = [
    { date: '2026-03-05', supplier: 'ABC Trading', officialReceiptNumber: '1001', invoiceNumber: null, particulars: 'Trophies and medals', accountCode: '5-02-03-010', subsidiaryId: null, amount: 400000 },
    { date: '2026-03-06', supplier: 'Ceres Liner', officialReceiptNumber: null, invoiceNumber: 'T-55', particulars: 'Transportation of athletes', accountCode: '5-02-01-010', subsidiaryId: null, amount: 200000 },
  ];
  const lr1 = await expectOk('BT encodes LR (₱6,000 of ₱10,000)', save(bt, 'liquidation', { cashAdvanceId: 'e2e-ca-1', liquidationDate: '2026-03-10', items: items1, cashRefunded: 0 }));
  await expectFail('PB cannot encode a liquidation', save(pb, 'liquidation', { cashAdvanceId: 'e2e-ca-1', liquidationDate: '2026-03-10', items: items1 }), /permission/i);
  await expectFail('item charged to cash is rejected', save(bt, 'liquidation', { cashAdvanceId: 'e2e-ca-1', liquidationDate: '2026-03-10', items: [{ ...items1[0], accountCode: '1-01-01-010' }] }), /cannot be charged/);
  const s1 = await expectOk('BT submits → LR number', act(bt, 'liquidation', lr1.id, 'SUBMIT'));
  console.log('      LR =', s1 && s1.number);
  await expectFail('MA cannot accept before PB approval', act(ma, 'liquidation', lr1.id, 'ACCEPT'), /not allowed/);
  await expectOk('PB approves', act(pb, 'liquidation', lr1.id, 'APPROVE'));
  const a1 = await expectOk('AR (accounting reviewer) accepts → GJ JEV', act(ar, 'liquidation', lr1.id, 'ACCEPT'));
  const jev = a1 && (await get('journalEntries', a1.jevId));
  const jl = a1 ? (await db.collection(`journalEntries/${a1.jevId}/lines`).get()).docs.map((d) => d.data()) : [];
  check('JEV journal/status', jev && [jev.journal, jev.status, jev.sourceModule], ['GJ', 'DRAFT', 'LIQUIDATION']);
  check('JEV balances (Dr = Cr = ₱6,000)', [jl.reduce((t, l) => t + l.debit, 0), jl.reduce((t, l) => t + l.credit, 0)], [600000, 600000]);
  check('JEV credit line is 1-03-03-020 EO01', jl.filter((l) => l.credit).map((l) => [l.accountCode, l.subsidiaryId]), [['1-03-03-020', EO01]]);
  let c1 = await get('cashAdvances', 'e2e-ca-1');
  check('CA after LR1 status/outstanding/liquidated', [c1.status, c1.outstandingBalance, c1.amountLiquidated], ['PARTIALLY_LIQUIDATED', 400000, 600000]);

  await expectFail('LR rejected: items ₱3,000 + refund ₱1,500 exceed outstanding ₱4,000', save(bt, 'liquidation', { cashAdvanceId: 'e2e-ca-1', liquidationDate: '2026-03-20', items: [{ ...items1[0], date: '2026-03-18', amount: 300000 }], cashRefunded: 150000, refundOrNumber: '7654321', refundCashSubsidiaryId: BT01 }), /exceed the outstanding/);
  await expectFail('refund without OR / collecting officer rejected', save(bt, 'liquidation', { cashAdvanceId: 'e2e-ca-1', liquidationDate: '2026-03-20', items: [], cashRefunded: 100000 }), /OR number/);
  const lr2 = await expectOk('BT encodes LR2 (₱3,000 + refund ₱1,000 OR 7654321)', save(bt, 'liquidation', { cashAdvanceId: 'e2e-ca-1', liquidationDate: '2026-03-20', items: [{ ...items1[0], date: '2026-03-18', particulars: 'Snacks for participants', amount: 300000 }], cashRefunded: 100000, refundOrNumber: '7654321', refundOrDate: '2026-03-20', refundCashSubsidiaryId: BT01 }));
  await expectFail('a parallel LR may not over-commit the advance', save(bt, 'liquidation', { cashAdvanceId: 'e2e-ca-1', liquidationDate: '2026-03-21', items: [{ ...items1[0], date: '2026-03-18', amount: 100 }] }), /exceed the outstanding/);
  await act(bt, 'liquidation', lr2.id, 'SUBMIT');
  await expectOk('PB returns LR2', act(pb, 'liquidation', lr2.id, 'RETURN', { remarks: 'Attach the OR of the refund' }));
  await expectOk('BT resubmits LR2', act(bt, 'liquidation', lr2.id, 'RESUBMIT'));
  await expectOk('PB approves LR2', act(pb, 'liquidation', lr2.id, 'APPROVE'));
  const a2 = await expectOk('MA accepts LR2', act(ma, 'liquidation', lr2.id, 'ACCEPT'));
  const jl2 = a2 ? (await db.collection(`journalEntries/${a2.jevId}/lines`).get()).docs.map((d) => d.data()) : [];
  check('LR2 JEV refund line Dr 1-01-01-010 BT01 ₱1,000', jl2.filter((l) => l.accountCode === '1-01-01-010').map((l) => [l.subsidiaryId, l.debit]), [[BT01, 100000]]);
  c1 = await get('cashAdvances', 'e2e-ca-1');
  check('CA fully liquidated', [c1.status, c1.outstandingBalance, c1.amountLiquidated, c1.amountRefunded], ['FULLY_LIQUIDATED', 0, 900000, 100000]);
  await expectFail('no LR on a fully liquidated CA', save(bt, 'liquidation', { cashAdvanceId: 'e2e-ca-1', liquidationDate: '2026-03-25', items: items1 }), /fully liquidated/);
  await expectOk('AR submits, MA approves and posts the LR JEV', ar('submitJournalEntry', { jevId: a1.jevId }).then(() => ma('approveJournalEntry', { jevId: a1.jevId })).then(() => ma('postJournalEntry', { jevId: a1.jevId })));
  check('posted LR stamped POSTED', (await get('liquidations', lr1.id)).status, 'POSTED');

  // ---- aging
  await expectFail('BT cannot run the aging refresh', bt('recomputeCashAdvanceAging', { barangayId: 'AGBOY' }), /permission/i);
  const ag = await expectOk('MA refreshes aging', ma('recomputeCashAdvanceAging', { barangayId: 'AGBOY' }));
  console.log('      ', JSON.stringify(ag));
  const c2 = await get('cashAdvances', 'e2e-ca-2');
  check('CA2 past due → OVERDUE', [c2.status, c2.daysOutstanding > 200, c2.agingCategory], ['OVERDUE', true, '181-365 days']);
  const asOf = await expectOk('aging as of 2026-01-20', ma('recomputeCashAdvanceAging', { barangayId: 'AGBOY', asOf: '2026-01-20' }));
  check('CA2 as of 2026-01-20 ACTIVE 15 days', [(await get('cashAdvances', 'e2e-ca-2')).status, (await get('cashAdvances', 'e2e-ca-2')).daysOutstanding, asOf && asOf.overdue], ['ACTIVE', 15, 0]);
  await ma('recomputeCashAdvanceAging', { barangayId: 'AGBOY' });

  // ---- legacy CA
  await expectFail('BT cannot record a legacy CA', bt('recordLegacyCashAdvance', { barangayId: 'AGBOY', accountableOfficerId: EO01, cashAdvanceType: 'OFFICIAL_TRAVEL', purpose: 'Travel to Bacolod', grantDate: '2025-11-10', dvNumber: '2025-11-031', amountGranted: 500000 }), /permission/i);
  await expectFail('legacy CA needs a 1-03-03 ledger', ma('recordLegacyCashAdvance', { barangayId: 'AGBOY', accountableOfficerId: BT01, cashAdvanceType: 'OFFICIAL_TRAVEL', purpose: 'Travel', grantDate: '2025-11-10', dvNumber: '2025-11-031', amountGranted: 500000 }), /1-03-03/);
  const leg = await expectOk('MA records legacy CA ₱5,000 (₱1,000 liquidated before migration)', ma('recordLegacyCashAdvance', { barangayId: 'AGBOY', accountableOfficerId: EO01, cashAdvanceType: 'OFFICIAL_TRAVEL', purpose: 'Travel to Bacolod for BFMS training', grantDate: '2025-11-10', dvNumber: '2025-11-031', amountGranted: 500000, openingLiquidated: 100000 }));
  const lc = leg && (await get('cashAdvances', leg.id));
  check('legacy CA', lc && [lc.isLegacy, lc.outstandingBalance, lc.status, lc.liquidationDueDate], [true, 400000, 'OVERDUE', '2025-12-10']);

  // ---- special trust fund
  const bank = (await db.collection('bankAccounts').where('barangayId', '==', 'AGBOY').limit(1).get()).docs[0];
  const stf = await expectOk('BT registers STF TRUST106 ₱50,000 from DOH', bt('registerSpecialTrustFund', { barangayId: 'AGBOY', fundCode: 'trust106', fundName: 'DOH Barangay Health Program', source: 'DOH', purpose: 'Health emergency supplies', dateReceived: '2026-03-01', amountReceived: 5000000, reference: 'CM 2026-03-01', bankAccountId: bank && bank.id }));
  check('STF id / fundId', stf && [stf.id, (await get('specialTrustFunds', stf.id)).fundId], ['AGBOY_STF-TRUST106', 'STF-TRUST106']);
  const sj = stf && stf.jevId ? (await db.collection(`journalEntries/${stf.jevId}/lines`).get()).docs.map((d) => [d.get('accountCode'), d.get('debit'), d.get('credit')]) : [];
  check('STF receipt JEV Dr CIB / Cr Trust Liabilities', sj.sort(), [['1-01-02-010', 5000000, 0], ['2-03-01-010', 0, 5000000]]);
  await expectFail('duplicate fund code rejected', bt('registerSpecialTrustFund', { barangayId: 'AGBOY', fundCode: 'TRUST106', fundName: 'Dup fund', source: 'DOH', purpose: 'dup', dateReceived: '2026-03-01', amountReceived: 1 }), /already registered/);
  const ap = await expectOk('AC encodes appropriation for the trust fund', save(ac, 'appropriation', { fiscalYear: 2026, appropriationOrdinanceNumber: '2026-03', appropriationOrdinanceDate: '2026-03-01', appropriationClass: 'OTHER', accountCode: '5-02-03-010', program: 'DOH Health Program', originalAppropriation: 10000000 }));
  await act(ac, 'appropriation', ap.id, 'SUBMIT'); await act(pb, 'appropriation', ap.id, 'APPROVE');
  const o1 = await expectOk('BT encodes obligation ₱30,000 charged to TRUST106', save(bt, 'obligation', { date: '2026-03-12', payee: { id: null, name: 'Medical Supply Co.' }, appropriationId: ap.id, specialTrustFundId: stf.id, particulars: 'Medicines and supplies', amount: 3000000 }));
  await act(bt, 'obligation', o1.id, 'SUBMIT');
  await expectOk('AC certifies → STF balance reduced', act(ac, 'obligation', o1.id, 'CERTIFY'));
  check('STF after certification (obligated/balance)', [(await get('specialTrustFunds', stf.id)).amountObligated, (await get('specialTrustFunds', stf.id)).balance], [3000000, 2000000]);
  const o2 = await expectOk('BT encodes obligation ₱25,000 (above STF balance ₱20,000)', save(bt, 'obligation', { date: '2026-03-15', payee: { id: null, name: 'Medical Supply Co.' }, appropriationId: ap.id, specialTrustFundId: stf.id, particulars: 'More supplies', amount: 2500000 }));
  await act(bt, 'obligation', o2.id, 'SUBMIT');
  await expectFail('certification above STF balance rejected', act(ac, 'obligation', o2.id, 'CERTIFY'), /Special Trust Fund/);
  await expectFail('decrease beyond the balance rejected', bt('adjustSpecialTrustFund', { stfId: stf.id, date: '2026-03-16', kind: 'RETURN', amount: 2500000, reason: 'Return unused to DOH' }), /exceeds the unobligated/);
  await expectOk('additional DOH tranche ₱5,000', bt('adjustSpecialTrustFund', { stfId: stf.id, date: '2026-03-16', kind: 'ADDITIONAL_RECEIPT', amount: 500000, reference: 'CM 2026-03-16', reason: 'Second tranche from DOH' }));
  await expectOk('certification now within the STF balance', act(ac, 'obligation', o2.id, 'CERTIFY'));
  // A DV paying the first obligation (Phase 5 shape) for utilization.
  await db.doc('disbursementVouchers/e2e-dv-stf').set({ barangayId: 'AGBOY', fiscalYear: 2026, accountingPeriod: '2026-03', dvNumber: '2026-03-015', dvDate: '2026-03-18', dvCategory: 'REGULAR', payee: { id: null, name: 'Medical Supply Co.' }, particulars: 'Medicines', fundId: 'GF', obligationId: o1.id, grossAmount: 3000000, netAmount: 2850000, status: 'APPROVED', createdBy: 'e2e', revisionNumber: 0 });
  await db.doc(`obligations/${o1.id}`).update({ dvId: 'e2e-dv-stf' });
  await expectOk('refresh STF utilization', bt('refreshSpecialTrustFunds', { barangayId: 'AGBOY' }));
  const sf = await get('specialTrustFunds', stf.id);
  check('STF fully utilized (balance/disbursed/status)', [sf.balance, sf.amountDisbursed, sf.status], [0, 3000000, 'FULLY_UTILIZED']);

  // ---- petty cash
  await expectFail('custodian ledger must be under 1-01-01-020', bt('establishPettyCashFund', { barangayId: 'AGBOY', custodianId: BT01, fundAmount: 500000, dateEstablished: '2026-03-01', establishedDvNumber: '2026-03-001' }), /1-01-01-020/);
  const pf = await expectOk('establish petty cash ₱5,000', bt('establishPettyCashFund', { barangayId: 'AGBOY', custodianId: PC01, fundAmount: 500000, dateEstablished: '2026-03-01', establishedDvNumber: '2026-03-001' }));
  await expectFail('second active fund for the same custodian rejected', bt('establishPettyCashFund', { barangayId: 'AGBOY', custodianId: PC01, fundAmount: 1, dateEstablished: '2026-03-01', establishedDvNumber: 'x' }), /already has an active/);
  const pcv = (amount, accountCode, particulars, date) => save(bt, 'pettyCashVoucher', { pettyCashFundId: pf.id, date, payee: { id: null, name: 'Juan dela Cruz' }, particulars, accountCode, amount });
  const p1 = await expectOk('PCV ₱1,200 office supplies', pcv(120000, '5-02-03-010', 'Ballpens and folders', '2026-03-05'));
  const p2 = await expectOk('PCV ₱800 transportation', pcv(80000, '5-02-01-010', 'Tricycle fare to the municipal hall', '2026-03-06'));
  for (const p of [p1, p2]) { await act(bt, 'pettyCashVoucher', p.id, 'SUBMIT'); }
  const n1 = await expectOk('PB approves & pays PCV1 → PCV number', act(pb, 'pettyCashVoucher', p1.id, 'APPROVE'));
  console.log('      PCV =', n1 && n1.number);
  await act(pb, 'pettyCashVoucher', p2.id, 'APPROVE');
  let fund = await get('pettyCashFunds', pf.id);
  check('fund after PCVs (cash/unreplenished)', [fund.cashOnHand, fund.unreplenished], [300000, 200000]);
  await expectFail('PCV above cash on hand rejected', pcv(350000, '5-02-03-010', 'Big purchase', '2026-03-07'), /exceeds the petty cash on hand/);
  const r = await expectOk('replenishment request', save(bt, 'pettyCashReplenishment', { pettyCashFundId: pf.id, date: '2026-03-20' }));
  check('request lists the 2 PCVs (₱2,000)', [(await get('pettyCashTransactions', r.id)).pcvIds.length, (await get('pettyCashTransactions', r.id)).amount], [2, 200000]);
  await expectOk('submit request', act(bt, 'pettyCashReplenishment', r.id, 'SUBMIT'));
  await expectFail('PCV in a request cannot be cancelled', act(pb, 'pettyCashVoucher', p1.id, 'VOID', { remarks: 'Wrong payee entered' }), /replenishment/);
  await expectOk('PB approves request', act(pb, 'pettyCashReplenishment', r.id, 'APPROVE'));
  await expectFail('replenish needs the DV number', act(bt, 'pettyCashReplenishment', r.id, 'REPLENISH', { payload: { replenishedDate: '2026-03-25' } }), /dvNumber/);
  await expectOk('record replenishment DV 2026-03-020', act(bt, 'pettyCashReplenishment', r.id, 'REPLENISH', { payload: { dvNumber: '2026-03-020', replenishedDate: '2026-03-25' } }));
  fund = await get('pettyCashFunds', pf.id);
  check('fund replenished (cash/unreplenished)', [fund.cashOnHand, fund.unreplenished], [500000, 0]);
  await expectFail('no replenishment without unreplenished PCVs', save(bt, 'pettyCashReplenishment', { pettyCashFundId: pf.id, date: '2026-03-26' }), /no paid, unreplenished/);
  const cl = await expectOk('close fund: return ₱5,000 under OR', bt('closePettyCashFund', { fundId: pf.id, date: '2026-03-31', kind: 'RETURN', refundOrNumber: '7654400', cashSubsidiaryId: BT01 }));
  check('fund closed, return JEV generated', [(await get('pettyCashFunds', pf.id)).status, !!(cl && cl.jevId), cl && cl.amount], ['CLOSED', true, 500000]);

  if (bad) { console.log(`\n${bad} CHECK(S) FAILED`); process.exit(1); }
  done();
})();
