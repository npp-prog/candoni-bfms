const { as, db, expectOk, expectFail, done } = require('./lib.cjs');

// Bank reconciliation from the JOURNAL (accounting mode: no checks / deposits / ADA documents).
// Book side = posted lines on Cash in Bank / CIB02; bank side = the statements; prior-year
// outstanding checks from the year's set-up; memo JEVs for the unrecorded charge and interest.
(async () => {
  console.log('Bank reconciliation (journal-based)');
  const ma = await as('ma@test.local'), ar = await as('ar@test.local'), bt = await as('bt@test.local'), pb = await as('pb@test.local');
  const B = 'AGBOY', FY = 2026;
  // A failed assertion counts like a failed call (lib.cjs keeps the tally that sets the exit code).
  const check = (label, ok, detail = '') => (ok ? (console.log('  ok  ', label), Promise.resolve()) : expectOk(label, Promise.reject(new Error(String(detail)))));

  // ---- A dedicated account (ledger CIB02) so other scripts' entries on CIB01 don't change the figures.
  const acct = await expectOk('BT creates the CIB02 bank account', bt('saveBankAccount', { barangayId: B, bankName: 'Development Bank of the Philippines', branch: 'Kabankalan City', accountName: 'AGBOY BRGY COUNCIL-CANDONI', accountNumber: '0098765432', accountType: 'CURRENT', fundId: 'GF', subsidiaryCode: 'CIB02', active: true }));
  if (!acct) return done();
  const bankId = acct.id, sl = acct.subsidiaryId;
  console.log('      bankAccountId', bankId);
  await expectOk('COA auditor signatory', ma('saveSignatory', { barangayId: 'MUNICIPAL', role: 'COA_AUDITOR', name: 'AUDITOR SAMPLE', position: 'State Auditor III, COA', validFrom: '2020-01-01', validTo: null, active: true }));

  // ---- Books: AR drafts and submits, MA posts (one step from FOR_REVIEW).
  const L = (accountCode, debit, credit, subsidiaryId = null) => ({ accountCode, subsidiaryId, debit, credit, lineDescription: '' });
  async function post(label, data) {
    const r = await expectOk(`AR drafts JEV: ${label}`, ar('saveJournalDraft', { barangayId: B, fundId: 'GF', ...data }));
    if (!r) return null;
    await expectOk(`AR submits: ${label}`, ar('submitJournalEntry', { jevId: r.jevId }));
    return expectOk(`MA posts: ${label}`, ma('postJournalEntry', { jevId: r.jevId }));
  }
  const disb = (no, date, amount, payee, dv) => ({ jevDate: date, transactionType: 'DISBURSEMENT', payeeName: payee, primaryReference: no, secondaryReference: dv, particulars: `To payment of ${payee}`, lines: [L('5-02-03-010', amount, 0), L('1-01-02-010', 0, amount, sl)] });
  const dep = (date, amount, rcd) => ({ jevDate: date, transactionType: 'DEPOSIT', payeeName: 'Barangay Treasurer', primaryReference: null, secondaryReference: rcd, particulars: `To record deposit based on RCD No. ${rcd}`, lines: [L('1-01-02-010', amount, 0, sl), L('4-04-01-010', 0, amount)] });
  await post('opening Cash in Bank ₱100,000', { jevDate: '2026-01-01', transactionType: 'OPENING', particulars: 'Opening balance — DBP current account', lines: [L('1-01-02-010', 10000000, 0, sl), L('3-01-01-010', 0, 10000000)] });
  await post('check 0001001 ₱15,000', disb('0001001', '2026-03-05', 1500000, 'SUPPLIER ALPHA', '2026-03-001'));
  await post('check 0001002 ₱8,000', disb('0001002', '2026-03-25', 800000, 'SUPPLIER BRAVO', '2026-03-002'));
  await post('deposit ₱20,000', dep('2026-03-10', 2000000, '2026-03-01'));
  await post('deposit ₱5,000 (in transit)', dep('2026-03-31', 500000, '2026-03-02'));
  await expectFail('BT cannot record a cancelled check (jev.prepare)', bt('recordCancelledCheck', { barangayId: B, bankAccountId: bankId, checkNumber: '0001003', checkDate: '2026-03-26', remarks: 'Spoiled' }), /permission/i);
  const cxl = await expectOk('AR records cancelled check 0001003', ar('recordCancelledCheck', { barangayId: B, bankAccountId: bankId, checkNumber: '0001003', checkDate: '2026-03-26', payeeName: 'SUPPLIER CHARLIE', remarks: 'Spoiled in printing' }));

  // ---- Bank: Jan / Feb without movement, March with encashed checks, a deposit, a charge and interest.
  const per = (month) => ({ barangayId: B, bankAccountId: bankId, fiscalYear: FY, month });
  for (const m of [1, 2]) await expectOk(`BT saves the ${m === 1 ? 'January' : 'February'} statement (no movement)`, bt('saveBankStatement', { ...per(m), beginningBalance: 10210000, endingBalance: 10210000, lines: [] }));
  const lines = [
    { date: '2026-03-02', checkNumber: '901', reference: '', description: 'CHECK ENCASHED', debit: 90000, credit: 0 },
    { date: '2026-03-06', checkNumber: '0001001', reference: '', description: 'CHECK ENCASHED', debit: 1500000, credit: 0 },
    { date: '2026-03-11', reference: '', description: 'DEPOSIT', debit: 0, credit: 2000000 },
    { date: '2026-03-31', reference: '', description: 'SERVICE CHARGE', debit: 5000, credit: 0 },
    { date: '2026-03-31', reference: '', description: 'INTEREST EARNED', debit: 0, credit: 1234 },
  ];
  const s1 = await expectOk('BT saves the March statement with a wrong ending balance', bt('saveBankStatement', { ...per(3), beginningBalance: 10210000, endingBalance: 10600000, lines }));
  await check('statement flagged unbalanced', s1?.balanced === false);
  await expectFail('statement line outside the month rejected', bt('saveBankStatement', { ...per(3), beginningBalance: 10210000, endingBalance: 10616234, lines: [{ ...lines[0], date: '2026-04-01' }] }), /outside/);
  const s2 = await expectOk('BT corrects the ending balance ₱106,162.34', bt('saveBankStatement', { ...per(3), beginningBalance: 10210000, endingBalance: 10616234, lines }));
  await check('statement balances', s2?.balanced === true);
  const stmt = (await db.doc(`bankStatements/${B}_${bankId}_${FY}_03`).get()).data();
  const lineId = (desc) => stmt.lines.find((l) => l.description === desc).lineId;
  await check('check number kept on the statement line', stmt.lines[1].checkNumber === '0001001');

  // ---- Prepare before the prior-year items: check 901 is "not in the books", ₱2,100 unexplained.
  await expectFail('PB cannot prepare a reconciliation', pb('prepareBankReconciliation', per(3)), /permission/i);
  const p0 = await expectOk('AR prepares (prior-year items not yet recorded)', ar('prepareBankReconciliation', per(3)));
  console.log('      book/bank/adjBook/adjBank/diff =', p0?.bookBalance, p0?.bankBalance, p0?.adjustedBookBalance, p0?.adjustedBankBalance, p0?.difference);
  await check('book balance from the ledger = ₱102,000', p0?.bookBalance === 10200000);
  await check('difference −₱2,100 (prior-year checks missing)', p0?.difference === -210000, p0?.difference);
  await check('January warning raised', (p0?.warnings ?? []).some((w) => /January 1/.test(w)), JSON.stringify(p0?.warnings));

  // ---- Prior-year outstanding checks (Jan 1): ₱900 (clears in March) and ₱1,200 (stale).
  await expectFail('prior-year item dated in the fiscal year rejected', ar('saveBankOpeningItems', { barangayId: B, bankAccountId: bankId, fiscalYear: FY, outstandingChecks: [{ id: 'a', date: '2026-01-02', checkNumber: '901', payeeName: 'X', dvNumber: '', amount: 90000 }] }), /before/);
  await expectOk('AR records the prior-year outstanding checks', ar('saveBankOpeningItems', {
    barangayId: B, bankAccountId: bankId, fiscalYear: FY, bankBalance: 10210000,
    outstandingChecks: [
      { id: 'py901', date: '2025-12-20', checkNumber: '0000901', payeeName: 'PRIOR PAYEE ONE', dvNumber: '2025-12-010', amount: 90000 },
      { id: 'py902', date: '2025-06-10', checkNumber: '0000902', payeeName: 'PRIOR PAYEE TWO', dvNumber: '2025-06-004', amount: 120000 },
    ],
    depositsInTransit: [],
  }));
  const p1 = await expectOk('AR re-prepares', ar('prepareBankReconciliation', per(3)));
  const rid = p1?.id;
  let rec = (await db.doc(`bankReconciliations/${rid}`).get()).data();
  let items = (await db.collection(`bankReconciliations/${rid}/items`).get()).docs.map((d) => d.data());
  console.log('      items:', items.map((i) => `${i.category}:${i.reference}:${i.amount}`).join(' '));
  await check('OC = 1002 ₱8,000 + prior 902 ₱1,200', rec?.outstandingChecks === 920000, rec?.outstandingChecks);
  await check('DIT ₱5,000', rec?.depositInTransit === 500000);
  await check('charges ₱50 / interest ₱12.34 (items requiring adjustment by agency)', rec?.bankCharges === 5000 && rec?.interestIncome === 1234);
  await check('difference 0 (book 101,962.34 = bank 101,962.34)', p1?.difference === 0 && p1?.adjustedBookBalance === 10196234 && p1?.adjustedBankBalance === 10196234, JSON.stringify(p1));
  await check('stale prior-year check flagged', items.some((i) => i.category === 'OUTSTANDING_CHECK' && i.reference === '0000902' && i.remarks === 'STALE'));
  const keys = (rec?.matches ?? []).map((m) => `${m.bookKey.split(':')[0]}:${m.how}`).sort().join(' ');
  await check('matches: prior-year 901 + check 1001 by number, deposit by amount/date', keys === 'CHK:CHECK_NO JL:AMOUNT_DATE PY:CHECK_NO', keys);
  await check('checks issued this year = 3 (incl. cancelled)', rec?.checksIssuedCount === 3, rec?.checksIssuedCount);

  // ---- An unexplained item blocks finalization.
  await expectOk('AR classifies the interest line as "clears an item not in the books" → difference', ar('prepareBankReconciliation', { ...per(3), classifications: { [lineId('INTEREST EARNED')]: 'CLEARED_PRIOR' } }));
  rec = (await db.doc(`bankReconciliations/${rid}`).get()).data();
  await check('difference now −₱12.34', rec.difference === -1234, rec.difference);
  await expectFail('manual match of a deposit line to a check rejected (wrong side)', ar('prepareBankReconciliation', { ...per(3), manualMatches: [{ lineId: lineId('DEPOSIT'), bookKey: 'CHK:1002' }] }), /wrong side|already/);
  await expectOk('AR submits for review', ar('submitBankReconciliation', { id: rid }));
  await expectFail('AR cannot finalize (recon.finalize is MA)', ar('finalizeBankReconciliation', { id: rid }), /permission/i);
  await expectFail('MA finalize with difference ≠ 0 refused', ma('finalizeBankReconciliation', { id: rid }), /must equal/);
  await expectFail('prepare while FOR_REVIEW rejected', ar('prepareBankReconciliation', per(3)), /cannot be re-prepared/);
  await expectFail('prior-year items locked while FOR_REVIEW', ar('saveBankOpeningItems', { barangayId: B, bankAccountId: bankId, fiscalYear: FY, outstandingChecks: [] }), /no longer be changed/);
  await expectOk('MA returns it', ma('returnBankReconciliation', { id: rid, remarks: 'Interest earned is not a prior-period item.' }));

  // ---- Memo JEVs for the unrecorded charge and interest (transaction type OTHERS).
  await expectOk('AR resets the classifications', ar('prepareBankReconciliation', { ...per(3), classifications: {} }));
  await expectFail('BT cannot generate memo JEVs (jev.prepare)', bt('generateRbdcmEntries', per(3)), /permission/i);
  const g = await expectOk('AR generates RBDCM entries', ar('generateRbdcmEntries', per(3)));
  await check('2 memos / 2 draft JEVs', g?.created === 2 && g?.jevs === 2, JSON.stringify(g));
  const g2 = await expectOk('generating again creates nothing (memos recorded)', ar('generateRbdcmEntries', per(3)));
  await check('no duplicate memos', g2?.created === 0, JSON.stringify(g2));
  for (const mid of g?.memoIds ?? []) {
    const md = (await db.doc(`bankMemos/${mid}`).get()).data();
    const jev0 = (await db.doc(`journalEntries/${md.jevId}`).get()).data();
    await check(`memo ${md.memoNumber} JEV: OTHERS, BANK_MEMO, BM no.`, jev0.transactionType === 'OTHERS' && jev0.sourceModule === 'BANK_MEMO' && jev0.primaryReference === md.memoNumber, JSON.stringify({ t: jev0.transactionType, s: jev0.sourceModule, p: jev0.primaryReference }));
    await expectOk(`AR submits memo JEV ${md.memoNumber}`, ar('submitJournalEntry', { jevId: md.jevId }));
    const posted = await expectOk(`MA posts memo JEV ${md.memoNumber}`, ma('postJournalEntry', { jevId: md.jevId }));
    const after = (await db.doc(`bankMemos/${mid}`).get()).data();
    await check('memo stamped with the JEV number', !!posted && after.jevNumber === posted.jevNumber);
  }
  const p2 = await expectOk('AR re-prepares after posting', ar('prepareBankReconciliation', per(3)));
  rec = (await db.doc(`bankReconciliations/${rid}`).get()).data();
  console.log('      book/adjBook/adjBank/diff =', p2?.bookBalance, p2?.adjustedBookBalance, p2?.adjustedBankBalance, p2?.difference);
  await check('memo JEVs now in the books: book 101,962.34, no charge/interest items, difference 0', p2?.bookBalance === 10196234 && rec.bankCharges === 0 && rec.interestIncome === 0 && p2?.difference === 0);
  await check('memo JEV lines matched to their statement lines', (rec.matches ?? []).filter((m) => m.how === 'MEMO').length === 2);
  await expectOk('AR resubmits', ar('submitBankReconciliation', { id: rid }));
  await expectOk('MA finalizes (difference 0)', ma('finalizeBankReconciliation', { id: rid }));
  rec = (await db.doc(`bankReconciliations/${rid}`).get()).data();
  await check('FINAL with OC ₱9,200 and DIT ₱5,000', rec.status === 'FINAL' && rec.outstandingChecks === 920000 && rec.depositInTransit === 500000 && rec.difference === 0);
  await expectFail('statement locked after FINAL', bt('saveBankStatement', { ...per(3), beginningBalance: 10210000, endingBalance: 10616234, lines }), /no longer be changed/);
  await expectFail('prepare after FINAL rejected', ar('prepareBankReconciliation', per(3)), /cannot be re-prepared/);
  if (cxl) await expectFail('deleting a cancelled check needs a reason', ar('deleteCancelledCheck', { id: cxl.id, reason: 'x' }), /invalid|at least|too small|String/i);

  // ---- April (cumulative): check 1002 encashed and the ₱5,000 deposit credited; only the stale check remains.
  await expectOk('BT saves the April statement', bt('saveBankStatement', { ...per(4), beginningBalance: 10616234, endingBalance: 10316234, lines: [
    { date: '2026-04-01', reference: '', description: 'DEPOSIT', debit: 0, credit: 500000 },
    { date: '2026-04-03', checkNumber: '1002', reference: '', description: 'CHECK ENCASHED', debit: 800000, credit: 0 },
  ] }));
  const p4 = await expectOk('AR prepares April', ar('prepareBankReconciliation', per(4)));
  const r4 = (await db.doc(`bankReconciliations/${p4?.id}`).get()).data();
  await check('April: OC = stale ₱1,200 only, DIT 0, difference 0', r4?.outstandingChecks === 120000 && r4?.depositInTransit === 0 && p4?.difference === 0, JSON.stringify({ oc: r4?.outstandingChecks, dit: r4?.depositInTransit, diff: p4?.difference }));

  console.log(`      P='{"month":3,"bankAccountId":"${bankId}"}'`);
  done();
})();
