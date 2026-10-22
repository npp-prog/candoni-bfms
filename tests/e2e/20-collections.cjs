const { as, db, ensureUser, expectOk, expectFail, done } = require('./lib.cjs');
// Phase 4: accountable forms → ORs → RCR (deputized collector) → deposit → RCD → JEV → POSTED.
(async () => {
  console.log('Phase 4 Collections');
  await ensureUser('bt-banga@test.local', 'Bella Gomez', 'BANGA', ['barangay_treasurer']);
  const bt = await as('bt@test.local'), ar = await as('ar@test.local'), ma = await as('ma@test.local'), pb = await as('pb@test.local'), btB = await as('bt-banga@test.local');
  const save = (who, module, data, id) => who('saveSource', { module, barangayId: 'AGBOY', data, id });
  const act = (who, module, id, action, extra = {}) => who('sourceAction', { module, id, action, ...extra });
  const BT01 = 'AGBOY_1-01-01-010_BT01', BT02 = 'AGBOY_1-01-01-010_BT02';
  const bank = (await db.collection('bankAccounts').where('barangayId', '==', 'AGBOY').get()).docs[0];

  // ---- masters
  await expectOk('deputized collector ledger BT02', bt('saveSubsidiaryAccount', { barangayId: 'AGBOY', accountCode: '1-01-01-010', subsidiaryCode: 'BT02', subsidiaryName: 'Jose Ramos, Deputized Collector', type: 'ACCOUNTABLE_OFFICER', active: true }));
  await expectOk('trust liability ledger TL01', bt('saveSubsidiaryAccount', { barangayId: 'AGBOY', accountCode: '2-03-01-010', subsidiaryCode: 'TL01', subsidiaryName: 'Performance bonds', type: 'OTHER', active: true }));
  await expectOk('open FY 2026 for BANGA', ma('openBarangayFiscalYear', { barangayId: 'BANGA', fiscalYear: 2026 }).catch((e) => { if (/already|exist/i.test(e.message)) return; throw e; }));
  await expectOk('BANGA collector ledger', btB('saveSubsidiaryAccount', { barangayId: 'BANGA', accountCode: '1-01-01-010', subsidiaryCode: 'BT01', subsidiaryName: 'Bella Gomez, Barangay Treasurer', type: 'ACCOUNTABLE_OFFICER', active: true }));

  // ---- accountable forms
  const af1 = await expectOk('BT receives AF51 1762201–1762250 and issues it to BT01', bt('receiveAccountableForm', { barangayId: 'AGBOY', formType: 'AF51', beginningSerialNumber: '1762201', endingSerialNumber: '1762250', dateReceived: '2026-03-01', accountableOfficerId: BT01, dateIssued: '2026-03-01' }));
  await expectFail('overlapping series rejected', bt('receiveAccountableForm', { barangayId: 'AGBOY', formType: 'AF51', beginningSerialNumber: '1762240', endingSerialNumber: '1762260', dateReceived: '2026-03-01' }), /overlap/);
  const af2 = await expectOk('AF51 1762301–1762350 received into stock', bt('receiveAccountableForm', { barangayId: 'AGBOY', formType: 'AF51', beginningSerialNumber: '1762301', endingSerialNumber: '1762350', dateReceived: '2026-03-01' }));
  await expectOk('… and assigned to deputized collector BT02', bt('assignAccountableForm', { id: af2.id, accountableOfficerId: BT02, dateIssued: '2026-03-02' }));
  await expectFail('PB cannot manage accountable forms', pb('receiveAccountableForm', { barangayId: 'AGBOY', formType: 'AF51', beginningSerialNumber: '9000001', endingSerialNumber: '9000050', dateReceived: '2026-03-01' }), /permission/i);
  const afB = await expectOk('BANGA series 5000001–5000050', btB('receiveAccountableForm', { barangayId: 'BANGA', formType: 'AF51', beginningSerialNumber: '5000001', endingSerialNumber: '5000050', dateReceived: '2026-03-01', accountableOfficerId: 'BANGA_1-01-01-010_BT01' }));

  // ---- official receipts
  const issue = (who, data) => who('issueOfficialReceipt', { barangayId: 'AGBOY', collectingOfficerId: BT01, fundId: 'GF', paymentMethod: 'CASH', checkDetails: null, ...data });
  const or1 = await expectOk('OR 1762201 clearance fee ₱150', issue(bt, { officialReceiptNumber: '1762201', collectionDate: '2026-03-02', payor: { id: null, name: 'Juan Dela Cruz' }, lines: [{ accountCode: '4-04-01-010', natureOfCollection: 'Barangay clearance', amount: 15000 }] }));
  console.log('      next OR suggested =', or1 && or1.nextSerialNumber);
  await expectFail('trust line without a subsidiary ledger rejected', issue(bt, { officialReceiptNumber: '1762202', collectionDate: '2026-03-03', payor: { id: null, name: 'ABC Construction' }, lines: [{ accountCode: '2-03-01-010', amount: 500000 }] }), /requires a subsidiary/);
  const or2 = await expectOk('OR 1762202 multi-line (market fees + performance bond)', issue(bt, { officialReceiptNumber: '1762202', collectionDate: '2026-03-03', payor: { id: null, name: 'ABC Construction' }, paymentMethod: 'CHECK', checkDetails: { bank: 'LBP', checkNumber: '0001234', checkDate: '2026-03-03' }, lines: [{ accountCode: '4-04-02-020', natureOfCollection: 'Market stall fees', amount: 25000 }, { accountCode: '2-03-01-010', subsidiaryId: 'AGBOY_2-03-01-010_TL01', natureOfCollection: 'Performance bond', amount: 500000 }] }));
  const or3 = await expectOk('OR 1762203 issued', issue(bt, { officialReceiptNumber: '1762203', collectionDate: '2026-03-03', payor: { id: null, name: 'Wrong Payor' }, lines: [{ accountCode: '4-04-01-010', amount: 10000 }] }));
  await expectOk('OR 1762203 cancelled (spoiled)', act(bt, 'collection', or3.id, 'CANCEL', { remarks: 'Spoiled — wrong payor written' }));
  await expectOk('unused OR 1762204 recorded as spoiled', bt('recordSpoiledReceipt', { barangayId: 'AGBOY', collectingOfficerId: BT01, officialReceiptNumber: '1762204', date: '2026-03-04', reason: 'Torn original copy' }));
  const or5 = await expectOk('OR 1762205 RPT share ₱1,000', issue(bt, { officialReceiptNumber: '1762205', collectionDate: '2026-03-04', payor: { id: null, name: 'Maria Lopez' }, lines: [{ accountCode: '4-01-01-010', natureOfCollection: 'Real property tax share', amount: 100000 }] }));
  await expectFail('duplicate OR 1762201 rejected', issue(bt, { officialReceiptNumber: '1762201', collectionDate: '2026-03-04', payor: { id: null, name: 'Dup' }, lines: [{ accountCode: '4-04-01-010', amount: 100 }] }), /already used/);
  await expectFail('OR 1762299 outside every series rejected', issue(bt, { officialReceiptNumber: '1762299', collectionDate: '2026-03-04', payor: { id: null, name: 'Xavier Cruz' }, lines: [{ accountCode: '4-04-01-010', amount: 100 }] }), /not within any accountable form/);
  await expectFail('OR outside the named series rejected', issue(bt, { accountableFormId: af1.id, officialReceiptNumber: '1762251', collectionDate: '2026-03-04', payor: { id: null, name: 'Xavier Cruz' }, lines: [{ accountCode: '4-04-01-010', amount: 100 }] }), /outside series/);
  await expectFail('OR from the deputy\'s series under BT01 rejected', issue(bt, { officialReceiptNumber: '1762301', collectionDate: '2026-03-04', payor: { id: null, name: 'Xavier Cruz' }, lines: [{ accountCode: '4-04-01-010', amount: 100 }] }), /not within any/);
  await expectFail('expense account on an OR rejected', issue(bt, { officialReceiptNumber: '1762206', collectionDate: '2026-03-04', payor: { id: null, name: 'Xavier Cruz' }, lines: [{ accountCode: '5-02-01-010', amount: 100 }] }), /not a receipt account/);
  await expectOk('correct OR 1762205 payor (saveSource edit)', save(bt, 'collection', { collectionDate: '2026-03-04', fundId: 'GF', payor: { id: null, name: 'Maria L. Lopez' }, paymentMethod: 'CASH', checkDetails: null, lines: [{ accountCode: '4-01-01-010', natureOfCollection: 'Real property tax share', amount: 100000 }] }, or5.id));
  await expectFail('new OR through saveSource refused', save(bt, 'collection', { collectionDate: '2026-03-04', payor: { id: null, name: 'Xavier Cruz' }, lines: [{ accountCode: '4-04-01-010', amount: 100 }] }), /Issue OR/);
  const orB = await expectOk('BANGA issues OR 5000001', issue(btB, { barangayId: 'BANGA', collectingOfficerId: 'BANGA_1-01-01-010_BT01', officialReceiptNumber: '5000001', collectionDate: '2026-03-02', payor: { id: null, name: 'Banga payor' }, lines: [{ accountCode: '4-04-01-010', amount: 5000 }] }));
  const af = (await db.doc(`accountableForms/${af1.id}`).get()).data();
  console.log('      AF 1762201–250: used/issued/cancelled/balance/next =', af.quantityUsed, af.quantityIssued, af.quantityCancelled, af.endingBalance, af.nextSerialNumber, '(expect 5 3 2 45 1762206)');
  if (af.quantityUsed !== 5 || af.quantityIssued !== 3 || af.quantityCancelled !== 2 || af.nextSerialNumber !== 1762206) { console.log('  FAIL accountable form counters'); process.exitCode = 1; }

  // ---- deputized collector remits through an RCR
  const orD = await expectOk('deputy BT02 issues OR 1762301 ₱200', issue(bt, { collectingOfficerId: BT02, officialReceiptNumber: '1762301', collectionDate: '2026-03-05', payor: { id: null, name: 'Pedro Santos' }, lines: [{ accountCode: '4-04-01-010', natureOfCollection: 'Certification fee', amount: 20000 }] }));
  const rcr = await expectOk('RCR BT02 → BT01 drafted', save(bt, 'rcr', { collectorId: BT02, receivingOfficerId: BT01, dateFrom: '2026-03-01', dateTo: '2026-03-05', remittanceDate: '2026-03-05', amountRemitted: 20000 }));
  await expectOk('RCR submitted', act(bt, 'rcr', rcr.id, 'SUBMIT'));
  await expectOk('treasurer acknowledges the remittance', act(bt, 'rcr', rcr.id, 'ACCEPT'));

  // ---- deposits
  const dep = (who, data, id) => who('saveDeposit', { id, barangayId: 'AGBOY', accountableOfficerId: BT01, depositDate: '2026-03-06', bankAccountId: bank.id, depositSlipNumber: 'DS-0306', fundId: 'GF', ...data });
  const ids = [or1.id, or2.id, or5.id, orD.id];
  const total = 15000 + 525000 + 100000 + 20000;
  await expectFail('deposit exceeding collections rejected', dep(bt, { collectionIds: ids, amount: total + 100 }), /exceed collections/);
  await expectFail('deposit of another barangay\'s OR rejected', dep(bt, { collectionIds: [...ids, orB.id], amount: total + 5000 }), /another barangay/);
  await expectFail('deposit of a cancelled OR rejected', dep(bt, { collectionIds: [...ids, or3.id], amount: total }), /CANCELLED/);
  const d1 = await expectOk('deposit slip DS-0306 for 4 ORs', dep(bt, { collectionIds: ids, amount: total, validatedAmount: total }));
  await expectFail('an OR cannot be on two slips', dep(bt, { depositSlipNumber: 'DS-0307', collectionIds: [or1.id], amount: 15000 }), /another deposit slip/);
  await expectFail('a deposited OR cannot be cancelled', act(bt, 'collection', or1.id, 'CANCEL', { remarks: 'Trying to cancel a deposited OR' }), /deposited or reported/);

  // ---- RCD
  const rcd = await expectOk('RCD of BT01 for March drafted', save(bt, 'rcd', { accountableOfficerId: BT01, dateFrom: '2026-03-01', dateTo: '2026-03-31', fundId: 'GF', differenceExplanation: null }));
  let r = (await db.doc(`rcdReports/${rcd.id}`).get()).data();
  console.log('      RCD collections/deposits/undeposited =', r.totalCollections, r.totalDeposits, r.undeposited, r.validationResult, `(expect ${total} ${total} 0 PASSED); ORs`, r.orFrom, '–', r.orTo, 'listed', r.collectionIds.length);
  if (r.totalCollections !== total || r.undeposited !== 0) { console.log('  FAIL RCD totals'); process.exitCode = 1; }
  await expectFail('overlapping RCD for the same officer rejected', save(bt, 'rcd', { accountableOfficerId: BT01, dateFrom: '2026-03-15', dateTo: '2026-04-15' }), /already covers/);
  const s1 = await expectOk('BT submits RCD → number', act(bt, 'rcd', rcd.id, 'SUBMIT'));
  console.log('      RCD No. =', s1 && s1.number);
  await expectFail('BT cannot accept its own RCD', act(bt, 'rcd', rcd.id, 'ACCEPT'), /permission/i);
  await expectFail('a reported OR can no longer be edited', save(bt, 'collection', { collectionDate: '2026-03-04', payor: { id: null, name: 'Changed' }, lines: [{ accountCode: '4-01-01-010', amount: 100000 }] }, or5.id), /no longer be edited/);
  await expectOk('AR returns the RCD', act(ar, 'rcd', rcd.id, 'RETURN', { remarks: 'Attach the validated deposit slip' }));
  const back = (await db.doc(`collections/${or1.id}`).get()).data();
  console.log('      after return: OR status/rcdId =', back.status, back.rcdId, '(expect DRAFT null)');
  await expectOk('BT resubmits', act(bt, 'rcd', rcd.id, 'RESUBMIT'));
  const acc = await expectOk('AR accepts → DRAFT JEV', act(ar, 'rcd', rcd.id, 'ACCEPT'));
  const jevId = acc && acc.jevId;
  if (jevId) {
    const jev = (await db.doc(`journalEntries/${jevId}`).get()).data();
    const lines = (await db.collection(`journalEntries/${jevId}/lines`).get()).docs.map((d) => d.data());
    const dr = lines.reduce((t, l) => t + l.debit, 0), cr = lines.reduce((t, l) => t + l.credit, 0);
    console.log('      JEV', jev.status, jev.journal, jev.jevDate, 'Dr', dr, 'Cr', cr, 'lines', lines.length);
    for (const l of lines) console.log('        ', l.accountCode.padEnd(12), (l.subsidiaryId || '').padEnd(26), String(l.debit).padStart(8), String(l.credit).padStart(8), l.lineDescription);
    if (jev.status !== 'DRAFT' || dr !== cr || dr === 0) { console.log('  FAIL JEV not a balanced DRAFT'); process.exitCode = 1; }
    await expectOk('AR submits the JEV', ar('submitJournalEntry', { jevId }));
    await expectOk('MA approves the JEV', ma('approveJournalEntry', { jevId }));
    const p = await expectOk('MA posts the JEV', ma('postJournalEntry', { jevId }));
    console.log('      JEV No. =', p && p.jevNumber);
  }
  r = (await db.doc(`rcdReports/${rcd.id}`).get()).data();
  console.log('      RCD status =', r.status, '(expect POSTED)');
  if (r.status !== 'POSTED') { console.log('  FAIL RCD not POSTED'); process.exitCode = 1; }
  const statuses = await Promise.all([or1, or3, orD].map(async (o) => (await db.doc(`collections/${o.id}`).get()).get('status')));
  console.log('      OR statuses (1762201, 1762203, 1762301) =', statuses.join(' '), '(expect ACCEPTED CANCELLED ACCEPTED)');
  console.log('      deposit status =', (await db.doc(`deposits/${d1.id}`).get()).get('status'), '(expect ACCEPTED)');

  // ---- undeposited collections carried to the next report
  const or6 = await expectOk('OR 1762206 on Apr 30 (after banking hours)', issue(bt, { officialReceiptNumber: '1762206', collectionDate: '2026-04-30', payor: { id: null, name: 'Late Payor' }, lines: [{ accountCode: '4-04-01-010', natureOfCollection: 'Barangay clearance', amount: 50000 }] }));
  const apr = await expectOk('April RCD drafted', save(bt, 'rcd', { accountableOfficerId: BT01, dateFrom: '2026-04-01', dateTo: '2026-04-30', differenceExplanation: null }));
  await expectFail('undeposited without explanation cannot be submitted', act(bt, 'rcd', apr.id, 'SUBMIT'), /explanation/);
  await expectOk('explanation added', save(bt, 'rcd', { accountableOfficerId: BT01, dateFrom: '2026-04-01', dateTo: '2026-04-30', differenceExplanation: 'Collected after banking hours on April 30; deposited May 2.' }, apr.id));
  await expectOk('April RCD submitted with WARNING', act(bt, 'rcd', apr.id, 'SUBMIT'));
  await expectOk('May deposit of OR 1762206', dep(bt, { depositDate: '2026-05-02', depositSlipNumber: 'DS-0502', collectionIds: [or6.id], amount: 50000 }));
  const may = await expectOk('May RCD drafted', save(bt, 'rcd', { accountableOfficerId: BT01, dateFrom: '2026-05-01', dateTo: '2026-05-31', differenceExplanation: null }));
  const m = (await db.doc(`rcdReports/${may.id}`).get()).data();
  console.log('      May RCD beginning/collections/deposits/undeposited =', m.undepositedBeginning, m.totalCollections, m.totalDeposits, m.undeposited, m.validationResult, '(expect 50000 0 50000 0 PASSED)');
  if (m.undepositedBeginning !== 50000 || m.undeposited !== 0 || m.validationResult !== 'PASSED') { console.log('  FAIL carry-forward'); process.exitCode = 1; }
  await expectOk('May RCD submitted', act(bt, 'rcd', may.id, 'SUBMIT'));
  console.log('      RCD id for reports:', rcd.id, ' April:', apr.id, ' RCR id:', rcr.id);
  done();
})();
