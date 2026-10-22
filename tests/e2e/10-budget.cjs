const { as, db, expectOk, expectFail, done } = require('./lib.cjs');
(async () => {
  console.log('Phase 3 Budget');
  const ac = await as('ac@test.local'), pb = await as('pb@test.local'), bt = await as('bt@test.local'), ma = await as('ma@test.local');
  const save = (who, module, data, id) => who('saveSource', { module, barangayId: 'AGBOY', data, id });
  const act = (who, module, id, action, extra = {}) => who('sourceAction', { module, id, action, ...extra });

  const a1 = await expectOk('AC encodes appropriation 5-02-03-010 ₱100,000', save(ac, 'appropriation', { fiscalYear: 2026, appropriationOrdinanceNumber: '2025-12', appropriationOrdinanceDate: '2025-12-15', appropriationClass: 'REGULAR', accountCode: '5-02-03-010', program: 'General Administration', originalAppropriation: 10000000 }));
  await expectOk('AC edits draft (amount ₱120,000)', save(ac, 'appropriation', { fiscalYear: 2026, appropriationOrdinanceNumber: '2025-12', appropriationOrdinanceDate: '2025-12-15', appropriationClass: 'REGULAR', accountCode: '5-02-03-010', program: 'General Administration', originalAppropriation: 12000000 }, a1.id));
  await expectFail('BT cannot encode appropriation', save(bt, 'appropriation', { fiscalYear: 2026, appropriationOrdinanceNumber: 'x', appropriationOrdinanceDate: '2025-12-15', appropriationClass: 'REGULAR', accountCode: '5-02-03-010', originalAppropriation: 1 }), /permission/i);
  await expectOk('AC submits', act(ac, 'appropriation', a1.id, 'SUBMIT'));
  await expectFail('AC cannot approve (no PB role)', act(ac, 'appropriation', a1.id, 'APPROVE'), /permission/i);
  await expectOk('PB approves → ACTIVE', act(pb, 'appropriation', a1.id, 'APPROVE'));
  await expectFail('AC cannot edit an ACTIVE appropriation', save(ac, 'appropriation', { fiscalYear: 2026, appropriationOrdinanceNumber: '2025-12', appropriationOrdinanceDate: '2025-12-15', appropriationClass: 'REGULAR', accountCode: '5-02-03-010', originalAppropriation: 1 }, a1.id), /no longer be edited/);

  const a2 = await expectOk('AC encodes 5-02-01-010 Travel ₱50,000 SK class', save(ac, 'appropriation', { fiscalYear: 2026, appropriationOrdinanceNumber: '2025-12', appropriationOrdinanceDate: '2025-12-15', appropriationClass: 'SK_10PCT', accountCode: '5-02-01-010', program: 'SK Programs', originalAppropriation: 5000000 }));
  await act(ac, 'appropriation', a2.id, 'SUBMIT'); await act(pb, 'appropriation', a2.id, 'APPROVE');

  const o1 = await expectOk('BT encodes obligation ₱30,000', save(bt, 'obligation', { date: '2026-03-10', payee: { id: null, name: 'ABC Office Supplies', tin: '123-456-789' }, appropriationId: a1.id, particulars: 'Office supplies for Q1', amount: 3000000 }));
  await expectOk('BT submits', act(bt, 'obligation', o1.id, 'SUBMIT'));
  const c1 = await expectOk('AC certifies → OBR number', act(ac, 'obligation', o1.id, 'CERTIFY'));
  console.log('      OBR =', c1 && c1.number);
  const ap = (await db.doc(`appropriations/${a1.id}`).get()).data();
  console.log('      appropriation total/obligations/available =', ap.totalAppropriation, ap.obligations, ap.availableBalance);
  if (ap.availableBalance !== 9000000) { console.log('  FAIL available balance'); process.exitCode = 1; }

  const o2 = await expectOk('BT encodes obligation ₱95,000 (exceeds available ₱90,000)', save(bt, 'obligation', { date: '2026-03-12', payee: { id: null, name: 'XYZ Trading' }, appropriationId: a1.id, particulars: 'Big purchase', amount: 9500000 }));
  await act(bt, 'obligation', o2.id, 'SUBMIT');
  await expectFail('certification rejected: insufficient appropriation', act(ac, 'obligation', o2.id, 'CERTIFY'), /exceeds the available appropriation/);
  await expectOk('AC returns it with a reason', act(ac, 'obligation', o2.id, 'RETURN', { remarks: 'Reduce to the available balance' }));
  await expectOk('BT corrects to ₱20,000', save(bt, 'obligation', { date: '2026-03-12', payee: { id: null, name: 'XYZ Trading' }, appropriationId: a1.id, particulars: 'Purchase reduced', amount: 2000000 }, o2.id));
  await expectOk('BT resubmits', act(bt, 'obligation', o2.id, 'RESUBMIT'));
  await expectOk('AC certifies resubmitted obligation', act(ac, 'obligation', o2.id, 'CERTIFY'));

  const adj = await expectOk('AC encodes supplemental ₱25,000', save(ac, 'appropriationAdjustment', { appropriationId: a1.id, adjustmentType: 'SUPPLEMENTAL', ordinanceNumber: '2026-04', ordinanceDate: '2026-04-02', amount: 2500000, remarks: '' }));
  await act(ac, 'appropriationAdjustment', adj.id, 'SUBMIT');
  await expectOk('PB approves adjustment', act(pb, 'appropriationAdjustment', adj.id, 'APPROVE'));
  const ap2 = (await db.doc(`appropriations/${a1.id}`).get()).data();
  console.log('      after supplemental: total/available =', ap2.totalAppropriation, ap2.availableBalance, '(expect 14500000 / 9500000)');
  await expectOk('AC cancels first obligation', act(ac, 'obligation', o1.id, 'CANCEL', { remarks: 'Purchase did not push through' }));
  const ap3 = (await db.doc(`appropriations/${a1.id}`).get()).data();
  console.log('      after cancel: available =', ap3.availableBalance, '(expect 12500000)');
  await expectOk('estimate RPT share ₱200,000', ac('saveEstimatedIncome', { barangayId: 'AGBOY', fiscalYear: 2026, fundId: 'GF', incomeAccountCode: '4-01-02-040', estimatedIncome: 20000000 }).catch(async (e) => { if (/Chart of Accounts/.test(e.message)) return ac('saveEstimatedIncome', { barangayId: 'AGBOY', fiscalYear: 2026, fundId: 'GF', incomeAccountCode: '4-01-04-010', estimatedIncome: 20000000 }); throw e; }));
  const rao = await db.collection('raoEntries').where('barangayId', '==', 'AGBOY').get();
  console.log('      RAO entries:', rao.size, '(expect 6: 2 appropriations, 2 obligations, 1 supplemental, 1 cancel)');
  const audit = await db.collection('auditLogs').where('barangayId', '==', 'AGBOY').get();
  const wf = await db.collection('workflowHistory').where('barangayId', '==', 'AGBOY').get();
  console.log('      audit logs:', audit.size, ' workflow history:', wf.size);
  done();
})();
