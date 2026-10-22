const { as, db, expectOk, expectFail, done } = require('./lib.cjs');
// Phase 12 — snapshots, finalize, monthly package. Run after 00-setup and 10-budget (and the module scripts).
(async () => {
  console.log('Phase 12 Report Center');
  const bt = await as('bt@test.local'), ma = await as('ma@test.local'), ar = await as('ar@test.local'), ac = await as('ac@test.local');
  const base = { barangayId: 'AGBOY', fiscalYear: 2026, month: 3 };

  const s1 = await expectOk('AC saves a SAOB version', ac('generateReportSnapshot', { code: 'SAOB', params: base }));
  const s2 = await expectOk('saving again without changes reuses the version', ac('generateReportSnapshot', { code: 'SAOB', params: base }));
  if (s1 && s2 && (s2.id !== s1.id || !s2.reused)) console.log('  FAIL  expected reuse', s1, s2);
  const meta = (await db.doc(`generatedReports/${s1.id}`).get()).data();
  const chunks = await db.collection(`generatedReports/${s1.id}/payload`).get();
  console.log(`      v${meta.version} ${meta.status} hash=${meta.dataHash.slice(0, 10)} chunks=${chunks.size} period=${meta.periodKey}`);
  await expectFail('finalize refused while March is OPEN', ma('finalizeReport', { reportId: s1.id }), /Lock 2026-03/);
  await expectFail('treasurer cannot finalize', bt('finalizeReport', { reportId: s1.id }), /permission/);

  const pkg = await expectOk('BT generates the March package', bt('generateMonthlyPackage', base));
  if (pkg) for (const i of pkg.items) console.log(`      ${i.reportCode.padEnd(14)} ${i.status.padEnd(15)} ${i.overall ?? ''} x${i.versions}`);
  const doc = (await db.doc('reportPackages/AGBOY_2026_03').get()).data();
  const failed = doc.items.filter((i) => i.status === 'FAILED').map((i) => i.reportCode);
  if (failed.length) {
    await expectFail(`submission blocked while FAILED items exist (${failed.join(',')})`, bt('submitMonthlyPackage', base), /Fix and regenerate/);
  } else {
    await expectOk('BT submits the package', bt('submitMonthlyPackage', base));
    const period = (await db.doc('accountingPeriods/AGBOY_2026_03').get()).data();
    console.log('      period status after submit:', period.status, '(expect REVIEW)');
    await expectFail('BT cannot regenerate a submitted package', bt('generateMonthlyPackage', base), /with Municipal Accounting/);
    await expectFail('return needs a reason', ar('reviewPackageItem', { ...base, reportCode: 'SAOB', decision: 'RETURN', remarks: '' }), /reason|corrected/);
    await expectOk('AR returns SAOB', ar('reviewPackageItem', { ...base, reportCode: 'SAOB', decision: 'RETURN', remarks: 'Recheck obligations of March' }));
    for (const i of doc.items.filter((x) => x.status === 'GENERATED' && x.reportCode !== 'SAOB')) await expectOk(`MA accepts ${i.reportCode}`, ma('reviewPackageItem', { ...base, reportCode: i.reportCode, decision: 'ACCEPT' }));
    const after = (await db.doc('reportPackages/AGBOY_2026_03').get()).data();
    console.log('      package after review:', after.status, '(expect RETURNED)');
    await expectOk('BT regenerates (only the returned item changes)', bt('generateMonthlyPackage', base));
    await expectOk('BT resubmits', bt('submitMonthlyPackage', base));
    await expectOk('MA accepts SAOB', ma('reviewPackageItem', { ...base, reportCode: 'SAOB', decision: 'ACCEPT' }));
    const fin = (await db.doc('reportPackages/AGBOY_2026_03').get()).data();
    console.log('      package final:', fin.status, '(expect ACCEPTED)');
  }
  await expectFail('lock refused: bank reconciliation not FINAL', ma('lockAccountingPeriod', { barangayId: 'AGBOY', fiscalYear: 2026, month: 3 }), /not FINAL/);
  await expectOk('MA locks March with a waiver reason', ma('lockAccountingPeriod', { barangayId: 'AGBOY', fiscalYear: 2026, month: 3, reason: 'Bank statement for March not yet received from LBP' }));
  await expectOk('MA finalizes the SAOB version', ma('finalizeReport', { reportId: s1.id }));
  await expectOk('MA reopens March', ma('reopenAccountingPeriod', { barangayId: 'AGBOY', fiscalYear: 2026, month: 3, reason: 'Late obligation to record' }));
  const stale = (await db.doc(`generatedReports/${s1.id}`).get()).data();
  console.log('      after reopen: status', stale.status, 'staleSource', stale.staleSource, '(expect FINAL true)');
  done();
})();
