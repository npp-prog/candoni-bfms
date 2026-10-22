// Phases 8 & 11 — books of accounts and financial statements.
// Posts manual JEVs (AR prepares, MA approves + posts), then builds every books/FS report through
// tests/e2e/reports.sh for March and December and asserts the validators.
const path = require('path');
const { execFileSync } = require('child_process');
const { as, db, expectOk, expectFail, done } = require('./lib.cjs');

const B = 'AGBOY';
const FY = 2026;
const CIT = `${B}_1-01-01-010_BT01`;
const CIB = `${B}_1-01-02-010_CIB01`;
const AP = `${B}_2-01-01-010_AP01`;
const BIR = `${B}_2-02-01-010_BIR01`;
const P = (n) => Math.round(n * 100); // pesos → centavos
const dr = (accountCode, amount, subsidiaryId = null, lineDescription = '') => ({ accountCode, subsidiaryId, debit: P(amount), credit: 0, lineDescription });
const cr = (accountCode, amount, subsidiaryId = null, lineDescription = '') => ({ accountCode, subsidiaryId, debit: 0, credit: P(amount), lineDescription });

let failed = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` ${extra}` : ''}`); if (!ok) failed++; };

(async () => {
  // Other phases' scripts may have posted to the same bank ledger first; assert this script's change only.
  const cibBefore = (await db.collection('accountBalances').where('barangayId', '==', B).where('fiscalYear', '==', FY).get()).docs
    .map((d) => d.data()).filter((b) => b.accountCode === '1-01-02-010' && b.subsidiaryId === null).reduce((t, b) => t + b.debit - b.credit, 0);
  console.log('Phases 8 & 11 — Books of accounts and financial statements');
  const ma = await as('ma@test.local'), ar = await as('ar@test.local'), bt = await as('bt@test.local');

  // Subsidiary ledgers used below (BT01 and CIB01 come from 00-setup).
  await expectOk('SL AP01 (supplier)', bt('saveSubsidiaryAccount', { barangayId: B, accountCode: '2-01-01-010', subsidiaryCode: 'AP01', subsidiaryName: 'ABC Office Supplies', type: 'SUPPLIER', active: true }));
  await expectOk('SL BIR01', bt('saveSubsidiaryAccount', { barangayId: B, accountCode: '2-02-01-010', subsidiaryCode: 'BIR01', subsidiaryName: 'Bureau of Internal Revenue', type: 'BIR', active: true }));

  /** AR prepares and submits; MA approves and posts (segregation of duties). */
  async function postJev(label, entry) {
    const s = await expectOk(`AR drafts: ${label}`, ar('saveJournalDraft', { barangayId: B, fundId: 'GF', ...entry }));
    if (!s) return null;
    await ar('submitJournalEntry', { jevId: s.jevId });
    await ma('approveJournalEntry', { jevId: s.jevId });
    const p = await expectOk(`MA posts: ${label}`, ma('postJournalEntry', { jevId: s.jevId }));
    return p && { jevId: s.jevId, jevNumber: p.jevNumber };
  }

  const opening = await postJev('opening balances (period 00)', {
    jevDate: `${FY}-01-01`, journal: 'GJ', entryType: 'OPENING', particulars: 'To record beginning balances per audited 2025 statements',
    lines: [dr('1-01-01-010', 50000, CIT), dr('1-01-02-010', 500000, CIB), dr('1-07-05-020', 200000), cr('1-07-05-021', 40000), cr('2-01-01-010', 30000, AP), cr('3-01-01-010', 680000)],
  });
  const ob = opening && (await db.doc(`journalEntries/${opening.jevId}`).get()).data();
  check('opening entry is in period 00', ob && ob.accountingPeriod === `${FY}-00`, ob && ob.accountingPeriod);

  await postJev('IRA share + clearance fees collected (JCT)', {
    jevDate: `${FY}-01-15`, journal: 'JCT', primaryReference: 'OR 0000101-0000102', secondaryReference: 'RCD 2026-01-001', particulars: 'Collections per RCD 2026-01-001',
    lines: [dr('1-01-01-010', 125000, CIT), cr('4-01-04-010', 120000), cr('4-04-01-010', 5000)],
  });
  await postJev('deposit to LBP (JCT)', {
    jevDate: `${FY}-01-16`, journal: 'JCT', primaryReference: 'DS 0001', secondaryReference: 'RCD 2026-01-001', particulars: 'Deposit of collections',
    lines: [dr('1-01-02-010', 125000, CIB), cr('1-01-01-010', 125000, CIT)],
  });
  await postJev('office supplies, tax withheld (JCT)', {
    jevDate: `${FY}-02-10`, journal: 'JCT', primaryReference: 'Chk 0000451', secondaryReference: 'DV 2026-02-001', particulars: 'Payment for office supplies, ABC Office Supplies',
    lines: [dr('5-02-03-010', 20000), cr('1-01-02-010', 18000, CIB), cr('2-02-01-010', 2000, BIR)],
  });
  await postJev('honoraria (JCT)', {
    jevDate: `${FY}-03-05`, journal: 'JCT', primaryReference: 'Chk 0000452', secondaryReference: 'DV 2026-03-001', particulars: 'Honoraria of barangay officials, March',
    lines: [dr('5-01-02-050', 30000), cr('1-01-02-010', 30000, CIB)],
  });
  await postJev('ICT equipment (JCT, investing)', {
    jevDate: `${FY}-03-20`, journal: 'JCT', primaryReference: 'Chk 0000453', secondaryReference: 'DV 2026-03-002', particulars: 'Purchase of laptop computer',
    lines: [dr('1-07-05-030', 40000), cr('1-01-02-010', 40000, CIB)],
  });
  await postJev('payment of prior-year payable (JCT)', {
    jevDate: `${FY}-03-25`, journal: 'JCT', primaryReference: 'Chk 0000454', secondaryReference: 'DV 2026-03-003', particulars: 'Payment of 2025 account, ABC Office Supplies',
    lines: [dr('2-01-01-010', 30000, AP), cr('1-01-02-010', 30000, CIB)],
  });
  await postJev('BIR remittance (JCT)', {
    jevDate: `${FY}-03-28`, journal: 'JCT', primaryReference: 'Chk 0000455', secondaryReference: 'DV 2026-03-004', particulars: 'Remittance of taxes withheld, February',
    lines: [dr('2-02-01-010', 2000, BIR), cr('1-01-02-010', 2000, CIB)],
  });
  await postJev('electricity accrual (GJ)', {
    jevDate: `${FY}-03-31`, journal: 'GJ', entryType: 'ADJUSTING', particulars: 'To accrue March electricity',
    lines: [dr('5-02-04-020', 3500), cr('2-01-01-010', 3500, AP)],
  });
  await postJev('depreciation (GJ)', {
    jevDate: `${FY}-03-31`, journal: 'GJ', particulars: 'Depreciation of office equipment, Q1',
    lines: [dr('5-04-01-040', 1000), cr('1-07-05-021', 1000)],
  });

  // Rejections: unbalanced submit, self-approval, editing a posted entry, NFS permission.
  const bad = await expectOk('AR drafts an unbalanced entry', ar('saveJournalDraft', { barangayId: B, fundId: 'GF', jevDate: `${FY}-03-31`, journal: 'GJ', particulars: 'Unbalanced test', lines: [dr('5-02-03-010', 100), cr('2-01-01-010', 90, AP)] }));
  if (bad) await expectFail('submit refused: unbalanced', ar('submitJournalEntry', { jevId: bad.jevId }), /debits must equal/i);
  const own = await expectOk('MA drafts an entry', ma('saveJournalDraft', { barangayId: B, fundId: 'GF', jevDate: `${FY}-03-31`, journal: 'GJ', particulars: 'Self approval test', lines: [dr('5-02-03-010', 100), cr('2-01-01-010', 100, AP)] }));
  if (own) { await ma('submitJournalEntry', { jevId: own.jevId }); await expectFail('MA cannot approve own entry', ma('approveJournalEntry', { jevId: own.jevId }), /prepared this record/i); }
  if (opening) await expectFail('posted JEV cannot be edited', ar('saveJournalDraft', { jevId: opening.jevId, barangayId: B, fundId: 'GF', jevDate: `${FY}-01-01`, journal: 'GJ', entryType: 'OPENING', particulars: 'Edit after posting', lines: [dr('1-01-01-010', 1, CIT), cr('3-01-01-010', 1)] }), /cannot be edited/i);

  // Balances: SL rows sum to the roll-up (written in the same transaction as the posting).
  const bals = (await db.collection('accountBalances').where('barangayId', '==', B).where('fiscalYear', '==', FY).get()).docs.map((d) => d.data());
  const sum = (f) => bals.filter(f).reduce((t, b) => t + b.debit - b.credit, 0);
  check('CIB roll-up = Σ SL', sum((b) => b.accountCode === '1-01-02-010' && b.subsidiaryId === null) === sum((b) => b.accountCode === '1-01-02-010' && b.subsidiaryId !== null));
  check('cash in bank moved by ₱505,000', sum((b) => b.accountCode === '1-01-02-010' && b.subsidiaryId === null) - cibBefore === P(500000 + 125000 - 18000 - 30000 - 40000 - 30000 - 2000));

  // NFS narrative callable.
  await expectFail('BT cannot edit NFS narrative', bt('saveNfsNarrative', { barangayId: B, fiscalYear: FY, notes: [{ title: 'General Information', body: 'x' }] }), /permission/i);
  const n1 = await expectOk('MA saves NFS narrative v1', ma('saveNfsNarrative', { barangayId: B, fiscalYear: FY, expectedVersion: 0, notes: [{ title: 'General Information', body: 'Barangay Agboy is a political unit of Candoni.\n\nSecond paragraph.' }, { title: 'Basis of Preparation', body: 'PPSAS, accrual basis.' }] }));
  check('NFS version 1', n1 && n1.version === 1);
  const n2 = await expectOk('AR saves NFS narrative v2', ar('saveNfsNarrative', { barangayId: B, fiscalYear: FY, expectedVersion: 1, notes: [{ title: 'General Information', body: 'Updated.' }, { title: 'Basis of Preparation', body: 'PPSAS, accrual basis.' }, { title: 'Cash', body: 'See schedule.' }] }));
  check('NFS version 2', n2 && n2.version === 2);
  await expectFail('stale NFS save refused', ma('saveNfsNarrative', { barangayId: B, fiscalYear: FY, expectedVersion: 1, notes: [{ title: 'General Information', body: 'Old copy' }] }), /someone else saved/i);
  const vers = await db.collection(`nfsNarratives/${B}_${FY}/versions`).get();
  check('NFS versions kept', vers.size === 2, `(${vers.size})`);

  // Reports through the Admin DataSource (same builders as the browser).
  const run = (codes, params) => {
    const out = execFileSync(path.resolve(__dirname, 'reports.sh'), codes, { env: { ...process.env, P: JSON.stringify(params) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(out.replace(/^/gm, '    '));
    return out;
  };
  const BOOKS = ['JCT', 'GJ', 'GL', 'SL', 'TB', 'SCHEDULE_OF_ACCOUNTS'];
  const FS = ['SFP', 'DSFP', 'SFPERF', 'DSFPERF', 'SNAE', 'SCNAE', 'SCF', 'SCBAA', 'NFS', 'SMR'];
  let mar = '', dec = '', jev = '', glYear = '';
  try {
    mar = run([...BOOKS, ...FS], { month: 3, accountCode: '1-01-02-010' });
    dec = run([...BOOKS, ...FS], { month: 12, accountCode: '2-01-01-010' });
    glYear = run(['GL', 'TB'], { month: 12, accountCode: '1-01-02-010', variant: 'YEAR' });
    jev = opening ? run(['JEV'], { documentId: opening.jevId }) : '';
    run(['TB'], { month: 12, variant: 'POST_CLOSING' });
  } catch (e) {
    failed++;
    console.log('  FAIL reports.sh', e.stdout || e.message);
  }
  const has = (out, code, v) => new RegExp(`^\\s*${code}\\s.*${v}`, 'm').test(out);
  check('no report errors', !/ERROR/.test(mar + dec + jev + glYear));
  for (const [label, out] of [['March', mar], ['December', dec]]) {
    check(`${label}: TB balanced`, has(out, 'TB', 'TB_BALANCED:PASSED'));
    check(`${label}: SFP balanced`, has(out, 'SFP', 'SFP_BALANCED:PASSED') && has(out, 'DSFP', 'SFP_BALANCED:PASSED'));
    check(`${label}: SCF reconciles`, has(out, 'SCF', 'SCF_RECONCILES:PASSED'));
    check(`${label}: SL = GL`, has(out, 'SL', 'SL_EQUALS_GL:PASSED') && has(out, 'SCHEDULE_OF_ACCOUNTS', 'SL_EQUALS_GL:PASSED'));
  }
  check('March: JCT and GJ balanced and not empty', has(mar, 'JCT', 'empty=false.*JEV_BALANCED:PASSED') && has(mar, 'GJ', 'empty=false.*JEV_BALANCED:PASSED'));
  check('December: journals empty (no December postings)', has(dec, 'JCT', 'empty=true') && has(dec, 'GJ', 'empty=true'));
  check('JEV form balanced', has(jev, 'JEV', 'JEV_BALANCED:PASSED'));
  if (failed) { console.log(`\n${failed} CHECK(S) FAILED`); process.exit(1); }
  done();
})();
