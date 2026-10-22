const { ensureUser, as, expectOk, done } = require('./lib.cjs');
(async () => {
  console.log('Setup users, reference data, fiscal year');
  await ensureUser('ma@test.local', 'Maria Santos', 'ALL', ['municipal_accountant']);
  await ensureUser('ar@test.local', 'Ramon Reyes', 'ALL', ['accounting_reviewer']);
  await ensureUser('bt@test.local', 'Teresa Bautista', 'AGBOY', ['barangay_treasurer']);
  await ensureUser('ac@test.local', 'Carlos Aquino', 'AGBOY', ['appropriations_chair']);
  await ensureUser('pb@test.local', 'Pedro Belmonte', 'AGBOY', ['punong_barangay']);
  await ensureUser('po@test.local', 'Paula Ocampo', 'AGBOY', ['property_officer']);
  const ma = await as('ma@test.local');
  await expectOk('seedReferenceData', ma('seedReferenceData', {}));
  await expectOk('createFiscalYear 2026', ma('createFiscalYear', { fiscalYear: 2026 }).catch((e) => { if (/exist/i.test(e.message)) return; throw e; }));
  await expectOk('openBarangayFiscalYear AGBOY', ma('openBarangayFiscalYear', { barangayId: 'AGBOY', fiscalYear: 2026 }).catch((e) => { if (/already|exist/i.test(e.message)) return; throw e; }));
  const bt = await as('bt@test.local');
  await expectOk('saveBankAccount', bt('saveBankAccount', { barangayId: 'AGBOY', bankName: 'Land Bank of the Philippines', branch: 'Kabankalan City', accountName: 'AGBOY BRGY COUNCIL-CANDONI', accountNumber: '0012345678', accountType: 'CURRENT', fundId: 'GF', subsidiaryCode: 'CIB01', active: true }));
  await expectOk('collecting officer BT01', bt('saveSubsidiaryAccount', { barangayId: 'AGBOY', accountCode: '1-01-01-010', subsidiaryCode: 'BT01', subsidiaryName: 'Teresa Bautista, Barangay Treasurer', type: 'ACCOUNTABLE_OFFICER', active: true }));
  for (const [role, name, pos] of [['PUNONG_BARANGAY', 'PEDRO B. BELMONTE', 'Punong Barangay'], ['BARANGAY_TREASURER', 'TERESA C. BAUTISTA', 'Barangay Treasurer'], ['APPROPRIATIONS_CHAIR', 'CARLOS D. AQUINO', 'Chairperson, Committee on Appropriations']])
    await expectOk(`signatory ${role}`, bt('saveSignatory', { barangayId: 'AGBOY', role, name, position: pos, validFrom: '2023-11-30', validTo: null, active: true }));
  await expectOk('municipal accountant signatory', ma('saveSignatory', { barangayId: 'MUNICIPAL', role: 'MUNICIPAL_ACCOUNTANT', name: 'NEIL P. PRIOLO, CPA', position: 'Municipal Accountant', validFrom: '2020-01-01', validTo: null, active: true }));
  done();
})();
