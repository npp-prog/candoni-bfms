// Accountant's schedules — List/Aging of Unliquidated Cash Advances and the PPE Depreciation
// Schedule, both driven by the posted JOURNAL (barangay HABA so other scripts' AGBOY data does not
// interfere). AR prepares/submits JEVs, MA posts; legacy items via saveLegacyCashAdvance; PPE via
// savePpeSchedule + generateDepreciationJev; then the CA_AGING / PPE_DEPRECIATION validators.
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { as, db, expectOk, expectFail, done } = require('./lib.cjs');

const ROOT = path.resolve(__dirname, '../..');
const B = 'HABA';
const FY = 2026;
const P = (n) => Math.round(n * 100); // pesos → centavos
const dr = (accountCode, amount, subsidiaryId = null, lineDescription = '') => ({ accountCode, subsidiaryId, debit: P(amount), credit: 0, lineDescription });
const cr = (accountCode, amount, subsidiaryId = null, lineDescription = '') => ({ accountCode, subsidiaryId, debit: 0, credit: P(amount), lineDescription });
const CIB = `${B}_1-01-02-010_CIB01`;
const AO = `${B}_1-03-03-010_AO01`;
const EO = `${B}_1-03-03-020_EO01`;

let bad = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) bad++;
  console.log(ok ? '  ok  ' : '  FAIL', label, ok ? `= ${JSON.stringify(actual)}` : `→ got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

/** Bundle the shared schedule loaders + report runner (TypeScript) in memory and load them. */
function loadShared() {
  const { buildSync } = require(require.resolve('esbuild', { paths: [ROOT] }));
  const out = buildSync({
    stdin: {
      contents: [
        "export { loadCaSchedule, loadPpeSchedule } from './shared/src/accounting/schedulesData';",
        "export { runReport, reportBuilder } from './shared/src/index';",
        "export { adminDataSource } from './functions/src/reports/datasource';",
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['firebase-admin', 'firebase-admin/*'],
    logLevel: 'warning',
  });
  const file = path.join(ROOT, 'tests/e2e/.schedules-inline.cjs');
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(ROOT);
  m._compile(out.outputFiles[0].text, file);
  return m.exports;
}

(async () => {
  console.log('Schedules — unliquidated cash advances & PPE depreciation (journal-driven)');
  const S = loadShared();
  const ds = S.adminDataSource(db);
  const ma = await as('ma@test.local'), ar = await as('ar@test.local'), bt = await as('bt@test.local');

  await expectOk(`openBarangayFiscalYear ${B}`, ma('openBarangayFiscalYear', { barangayId: B, fiscalYear: FY }).catch((e) => { if (/already|exist/i.test(e.message)) return; throw e; }));
  await expectOk('SL CIB01', ma('saveSubsidiaryAccount', { barangayId: B, accountCode: '1-01-02-010', subsidiaryCode: 'CIB01', subsidiaryName: 'LBP Current Account', type: 'BANK', active: true }));
  await expectOk('SL AO01 (Advances for Payroll)', ma('saveSubsidiaryAccount', { barangayId: B, accountCode: '1-03-03-010', subsidiaryCode: 'AO01', subsidiaryName: 'Juan Dela Cruz, Barangay Treasurer', type: 'ACCOUNTABLE_OFFICER', active: true }));
  await expectOk('SL EO01 (Advances to Officers)', ar('saveSubsidiaryAccount', { barangayId: B, accountCode: '1-03-03-020', subsidiaryCode: 'EO01', subsidiaryName: 'Ana Reyes, Barangay Kagawad', type: 'CASH_ADVANCE', active: true }));

  /** AR prepares and submits; MA posts directly from FOR_REVIEW. */
  async function postJev(label, entry) {
    const s = await expectOk(`AR drafts: ${label}`, ar('saveJournalDraft', { barangayId: B, fundId: 'GF', ...entry }));
    if (!s) return null;
    await ar('submitJournalEntry', { jevId: s.jevId });
    const p = await expectOk(`MA posts: ${label}`, ma('postJournalEntry', { jevId: s.jevId }));
    return p && { jevId: s.jevId, jevNumber: p.jevNumber };
  }

  // Skip re-posting when the script is re-run against the same emulator.
  const already = !(await db.collection('journalEntries').where('barangayId', '==', B).where('fiscalYear', '==', FY).limit(1).get()).empty;
  if (already) console.log('  (HABA already has entries — re-run: skipping postings)');
  else {
    await postJev('opening balances', {
      jevDate: `${FY}-01-01`, transactionType: 'OPENING', journal: 'GJ', particulars: 'To record beginning balances per 2025 books',
      lines: [
        dr('1-01-02-010', 1000000, CIB), dr('1-03-03-010', 30000, AO), dr('1-03-03-020', 5000, EO),
        dr('1-07-04-010', 600000), dr('1-07-05-020', 57075), dr('1-07-06-010', 100000),
        cr('1-07-05-021', 10844.25), cr('1-07-06-011', 90000), cr('3-01-01-010', 1691230.75),
      ],
    });
    await postJev('CA granted — check 0001001', {
      jevDate: `${FY}-02-05`, transactionType: 'DISBURSEMENT', payeeName: 'Juan Dela Cruz', primaryReference: '0001001', secondaryReference: '2026-02-001', particulars: 'Cash advance for honoraria of barangay workers',
      lines: [dr('1-03-03-010', 50000, AO), cr('1-01-02-010', 50000, CIB)],
    });
    await postJev('CA granted — check 0001002', {
      jevDate: `${FY}-03-10`, transactionType: 'DISBURSEMENT', payeeName: 'Juan Dela Cruz', primaryReference: '0001002', secondaryReference: '2026-03-005', particulars: 'Cash advance for labor payroll, drainage',
      lines: [dr('1-03-03-010', 20000, AO), cr('1-01-02-010', 20000, CIB)],
    });
    await postJev('liquidation naming DV 2026-03-005 (targeted)', {
      jevDate: `${FY}-03-20`, transactionType: 'LIQUIDATION', payeeName: 'Juan Dela Cruz', primaryReference: 'LR 2026-03-001', particulars: 'Liquidation of labor payroll, drainage',
      lines: [dr('5-01-02-050', 20000), cr('1-03-03-010', 20000, AO, 'Liquidation of DV 2026-03-005')],
    });
    await postJev('liquidation without reference (FIFO)', {
      jevDate: `${FY}-04-15`, transactionType: 'LIQUIDATION', payeeName: 'Juan Dela Cruz', primaryReference: 'LR 2026-04-001', particulars: 'Liquidation of prior-year advances',
      lines: [dr('5-01-02-050', 25000), cr('1-03-03-010', 25000, AO)],
    });
  }

  // ---- legacy items (callables, permission jev.prepare, validation)
  const legacy = (data) => ar('saveLegacyCashAdvance', { barangayId: B, fiscalYear: FY, ...data });
  const legacyDocs = async () => (await db.collection('legacyCashAdvances').where('barangayId', '==', B).where('fiscalYear', '==', FY).get()).docs;
  if (!(await legacyDocs()).length) {
    await expectOk('legacy AO01 #1 (₱18,000, 2024)', legacy({ accountCode: '1-03-03-010', subsidiaryId: AO, date: '2024-11-15', checkNumber: '1218491', dvNumber: '2024-11-085', particulars: 'C/A labor payroll reforestation', amount: P(18000) }));
    await expectOk('legacy AO01 #2 (₱12,000, 2025)', legacy({ accountCode: '1-03-03-010', subsidiaryId: AO, date: '2025-06-30', checkNumber: '1346308', dvNumber: '2025-06-004', particulars: 'C/A honoraria of barangay officials', amount: P(12000) }));
    await expectOk('legacy EO01 (₱4,000 — ₱1,000 short of the SL)', legacy({ accountCode: '1-03-03-020', subsidiaryId: EO, date: '2025-11-20', checkNumber: '1581688', dvNumber: null, particulars: 'C/A farmers general assembly', amount: P(4000) }));
  }
  await expectFail('BT (AGBOY only) cannot add a HABA legacy item', bt('saveLegacyCashAdvance', { barangayId: B, fiscalYear: FY, accountCode: '1-03-03-010', subsidiaryId: AO, date: '2025-01-01', particulars: 'x advance', amount: 100 }), /permission/i);
  await expectFail('non-advance account rejected', legacy({ accountCode: '1-01-01-010', subsidiaryId: null, officerName: 'Someone', date: '2025-01-01', particulars: 'not an advance', amount: 100 }), /not a cash advance account/);
  await expectFail('SL of another account rejected', legacy({ accountCode: '1-03-03-010', subsidiaryId: EO, date: '2025-01-01', particulars: 'wrong ledger', amount: 100 }), /controlled by/);
  await expectFail('zero amount rejected', legacy({ accountCode: '1-03-03-010', subsidiaryId: AO, date: '2025-01-01', particulars: 'zero', amount: 0 }), /zero/i);
  const tmp = await expectOk('add a temporary legacy item', legacy({ accountCode: '1-03-03-010', subsidiaryId: AO, date: '2025-02-01', particulars: 'temporary', amount: 100 }));
  if (tmp) {
    await expectOk('edit it', legacy({ id: tmp.id, accountCode: '1-03-03-010', subsidiaryId: AO, date: '2025-02-02', particulars: 'temporary (edited)', amount: 200 }));
    check('edited amount stored', (await db.doc(`legacyCashAdvances/${tmp.id}`).get()).get('amount'), 200);
    await expectOk('delete it', ar('deleteLegacyCashAdvance', { id: tmp.id, reason: 'entered by mistake' }));
    check('deleted', (await db.doc(`legacyCashAdvances/${tmp.id}`).get()).exists, false);
    const logs = (await db.collection('auditLogs').where('recordId', '==', tmp.id).get()).docs.map((d) => d.get('action')).sort();
    check('audited CREATE/EDIT/VOID', logs, ['CREATE', 'EDIT', 'VOID']);
  }

  // ---- schedule as of April 30: EO01 legacy detail is short of the opening SL balance
  let s = await S.loadCaSchedule(ds, B, FY, `${FY}-04-30`);
  const sl = (sch, id) => sch.sls.find((x) => x.subsidiaryId === id);
  check('AO01 schedule = ledger (Apr 30)', [sl(s, AO).scheduleBalance, sl(s, AO).ledgerBalance], [P(55000), P(55000)]);
  const fixed = (await legacyDocs()).some((d) => d.get('amount') === P(1000));
  if (!fixed) {
    check('EO01 difference flagged (legacy ₱4,000 vs opening ₱5,000)', [sl(s, EO).scheduleBalance, sl(s, EO).ledgerBalance, sl(s, EO).difference], [P(4000), P(5000), -P(1000)]);
    check('schedule not reconciled', s.reconciled, false);
    await expectOk('add the missing EO01 legacy item (₱1,000)', legacy({ accountCode: '1-03-03-020', subsidiaryId: EO, date: '2025-12-27', checkNumber: '1655319', particulars: 'C/A barangay officials honoraria', amount: P(1000) }));
  }
  if (!already)
    await postJev('over-liquidation by EO01 (₱6,000 against ₱5,000)', {
      jevDate: `${FY}-05-10`, transactionType: 'LIQUIDATION', payeeName: 'Ana Reyes', primaryReference: 'LR 2026-05-001', particulars: 'Liquidation of cash advances, Ana Reyes',
      lines: [dr('5-02-01-010', 6000), cr('1-03-03-020', 6000, EO)],
    });

  // ---- schedule as of December 31
  s = await S.loadCaSchedule(ds, B, FY, `${FY}-12-31`);
  const ao = sl(s, AO), eo = sl(s, EO);
  check('AO01 items outstanding (FIFO + targeted)', ao.items.map((i) => [i.date, i.outstanding]), [['2024-11-15', 0], ['2025-06-30', P(5000)], [`${FY}-02-05`, P(50000)], [`${FY}-03-10`, 0]]);
  check('targeted liquidation applied to DV 2026-03-005', ao.items[3].applications.map((a) => [a.amount, a.targeted]), [[P(20000), true]]);
  check('FIFO liquidation split over the legacy items', [ao.items[0].applied, ao.items[1].applied], [P(18000), P(7000)]);
  check('check no. / DV no. from the JEV references', [ao.items[2].checkNumber, ao.items[2].dvNumber], ['0001001', '2026-02-001']);
  check('aging buckets', ao.items.filter((i) => i.outstanding).map((i) => [i.days, i.bucket]), [[549, 'Over 1 year'], [329, '181-365 days']]);
  check('EO01 over-liquidated: negative line = negative SL', [eo.scheduleBalance, eo.ledgerBalance, eo.items.find((i) => i.source === 'UNAPPLIED_CREDIT')?.outstanding], [-P(1000), -P(1000), -P(1000)]);
  check('schedule reconciled with GL/SL', s.reconciled, true);
  const g = s.officers.find((o) => o.officerName.startsWith('Juan'));
  check('officer sub-total', g && g.total, P(55000));
  check('grand total', s.grandTotal, P(54000));

  const caModel = await S.runReport(S.reportBuilder('CA_AGING'), ds, { barangayId: B, fiscalYear: FY, asOf: `${FY}-12-31` });
  check('CA_AGING validators', caModel.validations.map((v) => `${v.id}:${v.result}`), ['CA_SCHEDULE_EQUALS_SL:PASSED', 'CA_NEGATIVE_SL:WARNING']);
  const caRows = caModel.sections[0].rows;
  check('CA_AGING grouped by officer with sub-totals', caRows.filter((r) => r.style === 'heading' || r.style === 'subtotal' || r.style === 'grandtotal').map((r) => r.style), ['heading', 'subtotal', 'heading', 'subtotal', 'grandtotal']);
  check('CA_AGING prepared by the Municipal Accountant', caModel.signatories.map((x) => x.label), ['Prepared by']);

  // ---- PPE schedule
  const rows = [
    { accountCode: '1-07-04-010', costOverride: null, residualRateBp: 0, usefulLifeYears: 10, accumulatedAccountCode: '1-07-04-011', expenseAccountCode: '5-04-01-030', remarks: '' },
    { accountCode: '1-07-05-020', costOverride: null, residualRateBp: 500, usefulLifeYears: 5, accumulatedAccountCode: '1-07-05-021', expenseAccountCode: '5-04-01-040', remarks: '' },
    { accountCode: '1-07-06-010', costOverride: null, residualRateBp: 500, usefulLifeYears: 5, accumulatedAccountCode: '1-07-06-011', expenseAccountCode: '5-04-01-050', remarks: 'nearly fully depreciated' },
  ];
  await expectFail('BT cannot save the HABA PPE schedule', bt('savePpeSchedule', { barangayId: B, fiscalYear: FY, rows }), /permission/i);
  await expectFail('land is not depreciable', ar('savePpeSchedule', { barangayId: B, fiscalYear: FY, rows: [{ ...rows[0], accountCode: '1-07-01-010', accumulatedAccountCode: '1-07-01-011' }] }), /not a depreciable/);
  await expectFail('expense account must be 5-04-01', ar('savePpeSchedule', { barangayId: B, fiscalYear: FY, rows: [{ ...rows[0], expenseAccountCode: '5-02-01-010' }] }), /depreciation expense/);
  await expectOk('AR saves the PPE schedule', ar('savePpeSchedule', { barangayId: B, fiscalYear: FY, rows }));
  const v = await S.loadPpeSchedule(ds, B, FY, null);
  check('schedule rows (cost, residual, depreciable, annual, this year)', v.rows.map((r) => [r.accountCode, r.cost, r.residualValue, r.depreciableAmount, r.annualDepreciation, r.periodDepreciation]), [
    ['1-07-04-010', P(600000), 0, P(600000), P(60000), P(60000)],
    ['1-07-05-020', P(57075), P(2853.75), P(54221.25), P(10844.25), P(10844.25)],
    ['1-07-06-010', P(100000), P(5000), P(95000), P(19000), P(5000)],
  ]);

  const runRef = db.doc(`depreciationRuns/${B}_${FY}_YR`);
  const prevRun = (await runRef.get()).data();
  const prevPosted = prevRun && (await db.doc(`journalEntries/${prevRun.jevId}`).get()).get('status') === 'POSTED';
  let jevId = prevPosted ? prevRun.jevId : null;
  if (!prevPosted) {
    const g1 = await expectOk('AR generates the year-end depreciation JEV', ar('generateDepreciationJev', { barangayId: B, fiscalYear: FY, replace: !!prevRun }));
    const lines = g1 ? (await db.collection(`journalEntries/${g1.jevId}/lines`).orderBy('lineNo').get()).docs.map((d) => d.data()) : [];
    check('JEV lines (Dr expense / Cr accumulated, consolidated, capped)', lines.map((l) => [l.accountCode, l.debit, l.credit]), [
      ['5-04-01-030', P(60000), 0], ['5-04-01-040', P(10844.25), 0], ['5-04-01-050', P(5000), 0],
      ['1-07-04-011', 0, P(60000)], ['1-07-05-021', 0, P(10844.25)], ['1-07-06-011', 0, P(5000)],
    ]);
    const h = g1 && (await db.doc(`journalEntries/${g1.jevId}`).get()).data();
    check('JEV header', h && [h.status, h.jevDate, h.journal, h.transactionType, h.payeeName, h.sourceModule, h.sourceDocumentId, h.particulars], ['DRAFT', `${FY}-12-31`, 'GJ', 'OTHERS', null, 'DEPRECIATION', `${B}_${FY}_YR`, `To record depreciation of PPE for the year ${FY}`]);
    await expectFail('duplicate for the same year refused', ar('generateDepreciationJev', { barangayId: B, fiscalYear: FY }), /already exists/);
    await expectFail('monthly run refused while the year-end entry exists', ar('generateDepreciationJev', { barangayId: B, fiscalYear: FY, month: 6 }), /year-end/);
    const g2 = await expectOk('replace the unposted draft', ar('generateDepreciationJev', { barangayId: B, fiscalYear: FY, replace: true }));
    check('old draft removed', g1 && (await db.doc(`journalEntries/${g1.jevId}`).get()).exists, false);
    check('run points to the new JEV', (await runRef.get()).get('jevId'), g2 && g2.jevId);
    jevId = g2 && g2.jevId;
    if (jevId) {
      await expectOk('AR submits the depreciation JEV', ar('submitJournalEntry', { jevId }));
      const posted = await expectOk('MA posts the depreciation JEV', ma('postJournalEntry', { jevId }));
      check('run stamped with the JEV number', (await runRef.get()).get('jevNumber'), posted && posted.jevNumber);
    }
  }
  await expectFail('regenerating a posted period refused', ar('generateDepreciationJev', { barangayId: B, fiscalYear: FY, replace: true }), /already recorded/);

  const ppeModel = await S.runReport(S.reportBuilder('PPE_DEPRECIATION'), ds, { barangayId: B, fiscalYear: FY });
  check('PPE_DEPRECIATION validator', ppeModel.validations.map((x) => `${x.id}:${x.result}`), ['PPE_DEPRECIATION_RECORDED:PASSED']);
  check('PPE_DEPRECIATION recap (debit total)', ppeModel.sections[1].rows.find((r) => r.style === 'total').cells.debit, P(75844.25));
  const after = await S.loadPpeSchedule(ds, B, FY, null);
  check('year figures unchanged after posting (cap uses accumulated brought in)', after.rows.map((r) => r.periodDepreciation), [P(60000), P(10844.25), P(5000)]);
  check('accumulated per GL after posting', after.rows.map((r) => r.accumulatedEnd), [P(60000), P(21688.5), P(95000)]);

  // ---- server-side build through reports.sh (same builders, Admin DataSource)
  for (const [code, params] of [['CA_AGING', { barangayId: B, asOf: `${FY}-12-31` }], ['PPE_DEPRECIATION', { barangayId: B }]]) {
    try {
      const out = execFileSync('sh', [path.join(__dirname, 'reports.sh'), code], { cwd: ROOT, env: { ...process.env, P: JSON.stringify(params) }, encoding: 'utf8' });
      console.log(out.trimEnd());
      check(`reports.sh ${code} builds`, /ERROR/.test(out), false);
    } catch (e) {
      bad++;
      console.log('  FAIL reports.sh', code, e.message);
    }
  }

  if (bad) {
    console.log(`\n${bad} CHECK(S) FAILED`);
    process.exit(1);
  }
  done();
})();
