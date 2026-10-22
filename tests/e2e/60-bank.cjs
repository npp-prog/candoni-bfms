const { as, db, admin, expectOk, expectFail, done } = require('./lib.cjs');

// Phase 9 — bank statement, two-sided reconciliation, memo JEVs (RBDCM), finalize → checks CLEARED.
(async () => {
  console.log('Phase 9 Bank reconciliation');
  const ma = await as('ma@test.local'), ar = await as('ar@test.local'), bt = await as('bt@test.local');
  const B = 'AGBOY', FY = 2026, M = 3;
  // A dedicated account (ledger CIB02) so other phases' checks/deposits on CIB01 don't change the figures.
  const existing = (await db.collection('bankAccounts').where('barangayId', '==', B).get()).docs.find((d) => d.get('subsidiaryCode') === 'CIB02');
  if (!existing) await bt('saveBankAccount', { barangayId: B, bankName: 'Development Bank of the Philippines', branch: 'Kabankalan', accountName: 'AGBOY BRGY COUNCIL-CANDONI', accountNumber: '0098765432', accountType: 'CURRENT', fundId: 'GF', subsidiaryCode: 'CIB02', active: true });
  const banks = await db.collection('bankAccounts').where('barangayId', '==', B).get();
  const bankDoc = banks.docs.find((d) => d.get('subsidiaryCode') === 'CIB02');
  if (!bankDoc) { console.log('  FAIL no bank account — run 00-setup first'); process.exit(1); }
  const bankId = bankDoc.id, sl = bankDoc.get('subsidiaryId');
  const now = admin.firestore.Timestamp.now();
  await expectOk('COA auditor signatory', ma('saveSignatory', { barangayId: 'MUNICIPAL', role: 'COA_AUDITOR', name: 'JUANA D. CRUZ', position: 'State Auditor III, COA', validFrom: '2020-01-01', validTo: null, active: true }));

  // ---- Books: AR prepares, MA approves and posts (segregation of duties).
  async function postJev(label, data) {
    const r = await expectOk(`AR drafts JEV: ${label}`, ar('saveJournalDraft', { barangayId: B, fundId: 'GF', journal: 'GJ', ...data }));
    if (!r) return null;
    await ar('submitJournalEntry', { jevId: r.jevId });
    await ma('approveJournalEntry', { jevId: r.jevId });
    return expectOk(`MA posts ${label}`, ma('postJournalEntry', { jevId: r.jevId }));
  }
  const L = (accountCode, debit, credit, subsidiaryId = null) => ({ accountCode, subsidiaryId, debit, credit, lineDescription: '' });
  await postJev('opening cash in bank ₱100,000', { jevDate: '2026-01-01', entryType: 'OPENING', particulars: 'Opening balance — LBP current account', lines: [L('1-01-02-010', 10000000, 0, sl), L('3-01-01-010', 0, 10000000)] });
  await postJev('check 1001 ₱15,000', { jevDate: '2026-03-05', journal: 'JCT', particulars: 'Office supplies — check 1001', lines: [L('5-02-03-010', 1500000, 0), L('1-01-02-010', 0, 1500000, sl)] });
  await postJev('check 1002 ₱8,000', { jevDate: '2026-03-25', journal: 'JCT', particulars: 'Fuel — check 1002', lines: [L('5-02-03-050', 800000, 0), L('1-01-02-010', 0, 800000, sl)] });
  await postJev('deposit ₱20,000', { jevDate: '2026-03-10', particulars: 'Deposit of collections', lines: [L('1-01-02-010', 2000000, 0, sl), L('4-04-01-010', 0, 2000000)] });
  await postJev('deposit ₱5,000', { jevDate: '2026-03-31', particulars: 'Deposit of collections', lines: [L('1-01-02-010', 500000, 0, sl), L('4-04-01-010', 0, 500000)] });

  // ---- Phase 4/5 documents in their contract shapes (written directly; those modules live elsewhere).
  const check = (no, date, amount, status) => ({ barangayId: B, fiscalYear: FY, bankAccountId: bankId, checkNumber: no, checkDate: date, payee: { id: null, name: `Supplier ${no}` }, dvId: null, amount, releasedDate: status === 'RELEASED' ? date : null, clearedDate: null, status, cancelReason: null, createdAt: now, createdBy: 'e2e', updatedAt: now, updatedBy: 'e2e' });
  const deposit = (slip, date, amount, status = 'ACCEPTED') => ({ barangayId: B, fiscalYear: FY, accountingPeriod: date.slice(0, 7), fundId: 'GF', depositDate: date, bankAccountId: bankId, depositSlipNumber: slip, collectionIds: [], amount, validatedAmount: null, attachmentIds: [], rcdId: null, status, revisionNumber: 0, createdAt: now, createdBy: 'e2e', updatedAt: now, updatedBy: 'e2e' });
  const k1 = db.collection('checks').doc(), k2 = db.collection('checks').doc(), k3 = db.collection('checks').doc();
  await k1.set(check('0001001', '2026-03-05', 1500000, 'RELEASED'));
  await k2.set(check('0001002', '2026-03-25', 800000, 'ISSUED'));
  await k3.set(check('0001003', '2026-03-26', 99900, 'VOID'));
  const d1 = db.collection('deposits').doc(), d2 = db.collection('deposits').doc(), d3 = db.collection('deposits').doc();
  await d1.set(deposit('DS-0310', '2026-03-10', 2000000));
  await d2.set(deposit('DS-0331', '2026-03-31', 500000));
  await d3.set(deposit('DS-VOID', '2026-03-12', 123400, 'VOID'));

  // ---- Statement: check 1001 cleared, deposit 1 credited, ₱50 charge, ₱12.34 interest.
  const lines = [
    { date: '2026-03-06', reference: '1001', description: 'CHECK PAID', debit: 1500000, credit: 0 },
    { date: '2026-03-11', reference: '', description: 'DEPOSIT', debit: 0, credit: 2000000 },
    { date: '2026-03-31', reference: '', description: 'SERVICE CHARGE', debit: 5000, credit: 0 },
    { date: '2026-03-31', reference: '', description: 'INTEREST EARNED', debit: 0, credit: 1234 },
  ];
  const per = { barangayId: B, bankAccountId: bankId, fiscalYear: FY, month: M };
  const s1 = await expectOk('BT saves statement with a wrong ending balance', bt('saveBankStatement', { ...per, beginningBalance: 10000000, endingBalance: 10500000, lines }));
  if (s1?.balanced !== false) console.log('  FAIL statement should be flagged unbalanced');
  await expectFail('statement line outside the month rejected', bt('saveBankStatement', { ...per, beginningBalance: 10000000, endingBalance: 10496234, lines: [{ ...lines[0], date: '2026-04-01' }] }), /outside/);
  const s2 = await expectOk('BT corrects ending balance ₱104,962.34', bt('saveBankStatement', { ...per, beginningBalance: 10000000, endingBalance: 10496234, lines }));
  if (s2?.balanced !== true) console.log('  FAIL statement should balance');
  const stmt = (await db.doc(`bankStatements/${B}_${bankId}_${FY}_03`).get()).data();
  const lineId = (desc) => stmt.lines.find((l) => l.description === desc).lineId;

  // ---- Prepare: book 102,000 → adjusted book 101,962.34 = adjusted bank (memos still unrecorded).
  await expectFail('PB cannot prepare a reconciliation', (await as('pb@test.local'))('prepareBankReconciliation', per), /permission/i);
  const p1 = await expectOk('AR prepares reconciliation', ar('prepareBankReconciliation', per));
  console.log('      book/bank/adjBook/adjBank/diff =', p1?.bookBalance, p1?.bankBalance, p1?.adjustedBookBalance, p1?.adjustedBankBalance, p1?.difference);
  const rid = p1?.id;
  let rec = (await db.doc(`bankReconciliations/${rid}`).get()).data();
  const items = (await db.collection(`bankReconciliations/${rid}/items`).get()).docs.map((d) => d.data());
  const cats = items.map((i) => `${i.category}:${i.amount}`).sort().join(' ');
  console.log('      items:', cats);
  if (p1?.bookBalance !== 10200000 || rec.outstandingChecks !== 800000 || rec.depositInTransit !== 500000 || rec.bankCharges !== 5000 || rec.interestIncome !== 1234 || p1?.difference !== 0)
    { console.log('  FAIL unexpected reconciliation figures'); process.exitCode = 1; } else console.log('  ok   matched check 1001 + deposit 1; OC 8,000, DIT 5,000, charges 50.00, interest 12.34 reflected in the adjusted book balance');

  // ---- An unexplained item blocks finalization.
  await expectOk('AR classifies the interest line as "clears a pre-BFMS item" (no effect) → difference', ar('prepareBankReconciliation', { ...per, classifications: { [lineId('INTEREST EARNED')]: 'CLEARED_PRIOR' } }));
  rec = (await db.doc(`bankReconciliations/${rid}`).get()).data();
  console.log('      difference now', rec.difference, '(expect -1234)');
  await expectFail('bad manual match rejected (amounts differ)', ar('prepareBankReconciliation', { ...per, manualMatches: [{ lineId: lineId('SERVICE CHARGE'), sourceCollection: 'checks', sourceId: k2.id }] }), /amounts differ|wrong side/);
  await expectOk('AR submits for review', ar('submitBankReconciliation', { id: rid }));
  await expectFail('AR cannot finalize (recon.finalize is MA)', ar('finalizeBankReconciliation', { id: rid }), /permission/i);
  await expectFail('MA finalize with difference ≠ 0 rejected', ma('finalizeBankReconciliation', { id: rid }), /must equal/);
  await expectFail('prepare while FOR_REVIEW rejected', ar('prepareBankReconciliation', per), /cannot be re-prepared/);
  await expectOk('MA returns it', ma('returnBankReconciliation', { id: rid, remarks: 'Interest earned is not a prior-period item.' }));

  // ---- Memo JEVs: generate from the unrecorded lines, AR submits, MA approves and posts.
  await expectOk('AR resets classifications', ar('prepareBankReconciliation', { ...per, classifications: {} }));
  await expectFail('BT cannot generate memo JEVs (jev.prepare)', bt('generateRbdcmEntries', per), /permission/i);
  const g = await expectOk('AR generates RBDCM entries', ar('generateRbdcmEntries', per));
  console.log('      memos/jevs created:', g?.created, g?.jevs, '(expect 2/2)');
  const memos = (await db.collection('bankMemos').where('barangayId', '==', B).get()).docs;
  for (const m of memos) {
    const md = m.data();
    console.log('      memo', md.memoNumber, md.memoType, md.amount, md.classificationAccountCode, md.status);
    await ar('submitJournalEntry', { jevId: md.jevId });
    await expectFail(`AR cannot approve own memo JEV ${md.memoNumber}`, ar('approveJournalEntry', { jevId: md.jevId }), /permission|segregation|prepared/i);
    await ma('approveJournalEntry', { jevId: md.jevId });
    const posted = await expectOk(`MA posts memo JEV ${md.memoNumber}`, ma('postJournalEntry', { jevId: md.jevId }));
    const jev = (await db.doc(`journalEntries/${md.jevId}`).get()).data();
    if (jev.primaryReference !== md.memoNumber || jev.sourceModule !== 'BANK_MEMO') console.log('  FAIL memo JEV header', jev.primaryReference, jev.sourceModule);
    const after = (await m.ref.get()).data();
    if (after.jevNumber !== posted?.jevNumber) console.log('  FAIL memo not stamped with JEV number');
  }
  const p2 = await expectOk('AR re-prepares after posting', ar('prepareBankReconciliation', per));
  console.log('      book/adjBook/adjBank/diff =', p2?.bookBalance, p2?.adjustedBookBalance, p2?.adjustedBankBalance, p2?.difference, '(expect 10196234 …, 0)');
  rec = (await db.doc(`bankReconciliations/${rid}`).get()).data();
  if (p2?.bookBalance !== 10196234 || rec.bankCharges !== 0 || rec.interestIncome !== 0 || p2?.difference !== 0) { console.log('  FAIL memos should now be recorded'); process.exitCode = 1; }
  await expectOk('AR resubmits', ar('submitBankReconciliation', { id: rid }));
  await expectOk('MA finalizes (difference 0)', ma('finalizeBankReconciliation', { id: rid }));
  const c1 = (await k1.get()).data(), c2 = (await k2.get()).data(), dd1 = (await d1.get()).data();
  console.log('      check 1001:', c1.status, c1.clearedDate, '| check 1002:', c2.status, c2.clearedDate, '| deposit 1 reconciled:', dd1.bankReconciledDate);
  if (c1.status !== 'CLEARED' || c1.clearedDate !== '2026-03-06' || c2.status !== 'ISSUED' || dd1.bankReconciledDate !== '2026-03-11') { console.log('  FAIL clearing'); process.exitCode = 1; }
  await expectFail('statement locked after FINAL', bt('saveBankStatement', { ...per, beginningBalance: 10000000, endingBalance: 10496234, lines }), /no longer be changed/);
  await expectFail('prepare after FINAL rejected', ar('prepareBankReconciliation', per), /cannot be re-prepared/);

  // ---- April: memo entered by hand through the generic engine.
  const mid = await expectOk('BT records a credit memo (no account yet → accounting sets it)', bt('saveSource', { module: 'bankMemo', barangayId: B, data: { bankAccountId: bankId, memoType: 'CREDIT', category: 'OTHER', memoDate: '2026-04-02', bankReference: 'CM-0402', particulars: 'Fund transfer from municipality', amount: 1000000, classificationAccountCode: '4-02-01-020' } }));
  const md0 = (await db.doc(`bankMemos/${mid?.id}`).get()).data();
  if (md0?.classificationAccountCode !== null) console.log('  FAIL BT must not set the classification account');
  await expectFail('Generate JEV without a classification account rejected', ar('sourceAction', { module: 'bankMemo', id: mid?.id, action: 'ACCEPT' }), /classification account/);
  await expectOk('AR sets the classification account', ar('saveSource', { module: 'bankMemo', id: mid?.id, barangayId: B, data: { bankAccountId: bankId, memoType: 'CREDIT', category: 'OTHER', memoDate: '2026-04-02', bankReference: 'CM-0402', particulars: 'Fund transfer from municipality', amount: 1000000, classificationAccountCode: '4-02-01-020' } }));
  const acc = await expectOk('AR generates the JEV → BM number', ar('sourceAction', { module: 'bankMemo', id: mid?.id, action: 'ACCEPT' }));
  console.log('      memo number', acc?.number, 'jev', !!acc?.jevId);
  done();
})();
