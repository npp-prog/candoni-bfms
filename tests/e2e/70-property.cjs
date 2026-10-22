const { as, db, expectOk, expectFail, done } = require('./lib.cjs');
// Phase 10 — PR → PO → IAR (stock + PPE), RIS issue, PAR, depreciation run, IIRUP disposal, biological assets.
(async () => {
  console.log('Phase 10 Property');
  const po = await as('po@test.local'), pb = await as('pb@test.local'), ma = await as('ma@test.local'), bt = await as('bt@test.local');
  const B = 'AGBOY';
  const save = (who, module, data, id) => who('saveSource', { module, barangayId: B, data, id });
  const act = (who, module, id, action, extra = {}) => who('sourceAction', { module, id, action, ...extra });
  let fails = 0;
  const check = (label, ok, info = '') => { if (!ok) fails++; console.log(ok ? '  ok  ' : '  FAIL', label, info); };
  const suffix = Date.now().toString(36).slice(-4).toUpperCase(); // reruns on the same emulator need fresh stock nos.

  // ---- item master
  const paper = await expectOk('PO creates stock card (bond paper, 10 reams @ ₱250 opening)', po('saveInventoryItem', { barangayId: B, stockNumber: `OS-${suffix}`, description: 'Bond paper, A4, 70gsm', unit: 'ream', accountCode: '1-04-03-010', itemClass: 'CONSUMABLE', reorderPoint: 5, opening: { date: '2026-01-02', quantity: 10, unitCost: 25000 } }));
  const fan = await expectOk('PO creates semi-expendable stock card (electric fan)', po('saveInventoryItem', { barangayId: B, stockNumber: `SE-${suffix}`, description: 'Electric fan, stand type', unit: 'unit', accountCode: '1-04-03-990', itemClass: 'SEMI_EXPENDABLE', reorderPoint: 0 }));
  await expectFail('duplicate stock number refused', po('saveInventoryItem', { barangayId: B, stockNumber: `OS-${suffix}`, description: 'dup', unit: 'ream', accountCode: '1-04-03-010', itemClass: 'CONSUMABLE' }), /already used/i);
  await expectFail('BT cannot maintain stock cards', bt('saveInventoryItem', { barangayId: B, stockNumber: 'X1', description: 'x item', unit: 'pc', accountCode: '1-04-03-010', itemClass: 'CONSUMABLE' }), /permission/i);

  // ---- PR
  const prData = { prDate: '2026-03-02', office: 'Office of the Punong Barangay', purpose: 'Office supplies and a laptop for barangay records', requestedBy: { name: 'Paula Ocampo', position: 'Property Officer' }, lines: [
    { itemId: paper.id, unit: 'ream', description: 'Bond paper, A4', quantity: 20, estimatedUnitCost: 26000 },
    { itemId: null, unit: 'unit', description: 'Laptop computer, 16GB RAM, 512GB SSD', quantity: 1, estimatedUnitCost: 6500000 },
    { itemId: fan.id, unit: 'unit', description: 'Electric fan, stand type', quantity: 2, estimatedUnitCost: 180000 },
  ] };
  const pr = await expectOk('PO encodes purchase request', save(po, 'purchaseRequest', prData));
  const prs = await expectOk('PO submits PR (PR number)', act(po, 'purchaseRequest', pr.id, 'SUBMIT'));
  check('PR number format', /^PR-2026-03-\d{3}$/.test(prs && prs.number), prs && prs.number);
  await expectFail('PO cannot approve own PR', act(po, 'purchaseRequest', pr.id, 'APPROVE'), /permission/i);
  await expectOk('PB approves PR', act(pb, 'purchaseRequest', pr.id, 'APPROVE'));
  check('PR total ₱73,800', (await db.doc(`purchaseRequests/${pr.id}`).get()).get('totalEstimatedCost') === 7380000);

  // ---- PO
  const poData = { poDate: '2026-03-04', purchaseRequestId: pr.id, supplier: { id: null, name: 'Kabankalan Office Depot', address: 'Kabankalan City', tin: '111-222-333' }, placeOfDelivery: 'Barangay Hall', deliveryTerm: '7 days', paymentTerm: 'Upon delivery', lines: [
    { prLineNo: 1, unit: 'ream', description: 'Bond paper, A4', quantity: 20, unitCost: 25500 },
    { prLineNo: 2, unit: 'unit', description: 'Laptop computer, 16GB RAM, 512GB SSD', quantity: 1, unitCost: 6400000 },
    { prLineNo: 3, unit: 'unit', description: 'Electric fan, stand type', quantity: 2, unitCost: 175000 },
  ] };
  await expectFail('PO quantity above PR refused', save(po, 'purchaseOrder', { ...poData, lines: [{ ...poData.lines[0], quantity: 21 }] }), /requests 20/);
  const pord = await expectOk('PO encodes purchase order', save(po, 'purchaseOrder', poData));
  await act(po, 'purchaseOrder', pord.id, 'SUBMIT');
  const poa = await expectOk('PB approves PO (PO number)', act(pb, 'purchaseOrder', pord.id, 'APPROVE'));
  check('PO number format', /^PO-2026-03-\d{3}$/.test(poa && poa.number), poa && poa.number);

  // ---- IAR
  const iarLines = [
    { poLineNo: 1, kind: 'SUPPLY', itemId: paper.id, description: '', unit: 'ream', quantity: 20, unitCost: 25500 },
    { poLineNo: 2, kind: 'PPE', description: 'Laptop computer, Acer, SN ACR-55821', unit: 'unit', quantity: 1, unitCost: 6400000, ppe: { accountCode: '1-07-05-030', usefulLifeYears: 5, residualValue: null, location: 'Barangay Hall', accountablePerson: 'Paula Ocampo' } },
    { poLineNo: 3, kind: 'SUPPLY', itemId: fan.id, description: '', unit: 'unit', quantity: 2, unitCost: 175000 },
  ];
  const iarData = { iarDate: '2026-03-10', purchaseOrderId: pord.id, invoiceNumber: 'SI-8812', invoiceDate: '2026-03-10', requisitioningOffice: 'Office of the PB', inspectionDate: '2026-03-10', inspectedBy: 'Inspection Committee', lines: iarLines };
  await expectFail('PPE below ₱50,000 refused on IAR', save(po, 'inspection', { ...iarData, lines: [{ ...iarLines[1], unitCost: 4000000 }] }), /below the ₱50,000/);
  await expectFail('stock item at ₱50,000+ refused on IAR', save(po, 'inspection', { ...iarData, lines: [{ ...iarLines[0], unitCost: 5000000 }] }), /capitalization threshold/);
  const iar = await expectOk('PO encodes IAR', save(po, 'inspection', iarData));
  const iars = await expectOk('PO submits IAR (IAR number)', act(po, 'inspection', iar.id, 'SUBMIT'));
  check('IAR number', /^IAR-2026-03-\d{3}$/.test(iars && iars.number), iars && iars.number);
  await expectOk('PB inspects & accepts', act(pb, 'inspection', iar.id, 'APPROVE'));
  const it1 = (await db.doc(`inventoryItems/${paper.id}`).get()).data();
  check('bond paper on hand 30 at moving average ₱253.33', it1.quantityOnHand === 30 && it1.unitCost === 25333, `${it1.quantityOnHand} @ ${it1.unitCost}`);
  const iarDoc = (await db.doc(`inspectionReports/${iar.id}`).get()).data();
  const laptopId = iarDoc.lines[1].ppeIds[0];
  const laptop = (await db.doc(`ppe/${laptopId}`).get()).data();
  check('PPE created with property number YYYY-05-030-NNNN', laptop && /^2026-05-030-\d{4}$/.test(laptop.propertyNumber) && laptop.status === 'ACTIVE', laptop && laptop.propertyNumber);
  check('PPE accounts 1-07-05-031 / 5-04-01-040, residual 5%', laptop.accumulatedDepreciationAccountCode === '1-07-05-031' && laptop.depreciationExpenseAccountCode === '5-04-01-040' && laptop.residualValue === 320000);
  check('PO delivery COMPLETE', (await db.doc(`purchaseOrders/${pord.id}`).get()).get('deliveryStatus') === 'COMPLETE');
  const iar2 = await expectOk('PO encodes a second IAR on the same PO', save(po, 'inspection', { ...iarData, lines: [{ ...iarLines[0], quantity: 1 }] }));
  await act(po, 'inspection', iar2.id, 'SUBMIT');
  await expectFail('over-delivery refused at acceptance', act(pb, 'inspection', iar2.id, 'APPROVE'), /exceeds the 20 ordered/);

  // ---- RIS
  const risBig = await expectOk('PO encodes RIS for 40 reams', save(po, 'requisition', { risDate: '2026-03-12', office: 'Barangay Secretary', purpose: 'Records and certificates', requestedBy: { name: 'Sec. Lito Cruz', position: 'Barangay Secretary' }, lines: [{ itemId: paper.id, quantityRequested: 40 }] }));
  await act(po, 'requisition', risBig.id, 'SUBMIT'); await act(pb, 'requisition', risBig.id, 'APPROVE');
  await expectFail('over-issue refused (only 30 on hand)', act(po, 'requisition', risBig.id, 'ISSUE'), /only 30 on hand/);
  const ris = await expectOk('PO encodes RIS for 12 reams', save(po, 'requisition', { risDate: '2026-03-12', office: 'Barangay Secretary', responsibilityCenterCode: 'OSEC', purpose: 'Records and certificates', requestedBy: { name: 'Sec. Lito Cruz', position: 'Barangay Secretary' }, lines: [{ itemId: paper.id, quantityRequested: 12 }] }));
  await act(po, 'requisition', ris.id, 'SUBMIT');
  await expectFail('cannot issue before PB approval', act(po, 'requisition', ris.id, 'ISSUE'), /not allowed/);
  await act(pb, 'requisition', ris.id, 'APPROVE');
  await expectOk('PO issues 12 reams', act(po, 'requisition', ris.id, 'ISSUE', { payload: { receivedBy: { name: 'Sec. Lito Cruz', position: 'Barangay Secretary' } } }));
  check('stock 18 after issue', (await db.doc(`inventoryItems/${paper.id}`).get()).get('quantityOnHand') === 18);
  await expectOk('stock adjustment −1 (water damage)', po('postStockAdjustment', { barangayId: B, itemId: paper.id, date: '2026-03-20', kind: 'ADJUSTMENT', quantity: -1, remarks: 'Water damaged during typhoon' }));
  await expectOk('physical count 17', po('recordPhysicalCount', { barangayId: B, target: 'ITEM', id: paper.id, date: '2026-06-30', quantity: 17, remarks: 'Count 2026-06-30' }));

  // ---- ICS (semi-expendable)
  const ics = await expectOk('PO encodes ICS for 1 electric fan', save(po, 'ics', { date: '2026-03-15', receivedBy: { name: 'Kgd. Ana Lim', position: 'Barangay Kagawad', office: 'Session Hall' }, lines: [{ itemId: fan.id, quantity: 1, estimatedUsefulLife: 3 }] }));
  await act(po, 'ics', ics.id, 'SUBMIT');
  const icsa = await expectOk('PB approves ICS (ICS number)', act(pb, 'ics', ics.id, 'APPROVE'));
  check('ICS number', /^ICS-2026-03-\d{3}$/.test(icsa && icsa.number), icsa && icsa.number);

  // ---- PAR
  const par = await expectOk('PO encodes PAR for the laptop', save(po, 'par', { date: '2026-03-15', receivedBy: { name: 'Rosa Diaz', position: 'Barangay Secretary', office: 'Secretariat' }, ppeIds: [laptopId] }));
  await act(po, 'par', par.id, 'SUBMIT');
  await expectFail('PO cannot approve PAR', act(po, 'par', par.id, 'APPROVE'), /permission/i);
  const para = await expectOk('PB approves PAR (PAR number)', act(pb, 'par', par.id, 'APPROVE'));
  check('PAR number', /^PAR-2026-03-\d{3}$/.test(para && para.number), para && para.number);
  const lp2 = (await db.doc(`ppe/${laptopId}`).get()).data();
  check('laptop accountable person = Rosa Diaz, PAR stamped', lp2.accountablePerson === 'Rosa Diaz' && lp2.parNumber === (para && para.number));
  await expectFail('second PAR for the same PPE refused', save(po, 'par', { date: '2026-03-16', receivedBy: { name: 'Other Person' }, ppeIds: [laptopId] }), /already covered/);

  // ---- depreciation
  await expectFail('PO cannot run depreciation', po('runMonthlyDepreciation', { barangayId: B, fiscalYear: 2026, month: 3 }), /permission/i);
  const run = await expectOk('MA runs March depreciation', ma('runMonthlyDepreciation', { barangayId: B, fiscalYear: 2026, month: 3 }));
  if (run) {
    const jev = (await db.doc(`journalEntries/${run.jevId}`).get()).data();
    const lines = (await db.collection(`journalEntries/${run.jevId}/lines`).get()).docs.map((d) => d.data());
    const dr = lines.reduce((t, l) => t + l.debit, 0), cr = lines.reduce((t, l) => t + l.credit, 0);
    check('depreciation JEV DRAFT GJ, balanced', jev.status === 'DRAFT' && jev.journal === 'GJ' && jev.sourceModule === 'DEPRECIATION' && dr === cr && dr === run.totalDepreciation, `Dr ${dr} Cr ${cr}`);
    check('laptop depreciation ₱1,013.33 (Dr 5-04-01-040 / Cr 1-07-05-031)', lines.some((l) => l.accountCode === '5-04-01-040' && l.debit >= 101333) && lines.some((l) => l.accountCode === '1-07-05-031' && l.credit >= 101333));
    const lp3 = (await db.doc(`ppe/${laptopId}`).get()).data();
    check('PPE accumulated 101,333, NBV updated', lp3.accumulatedDepreciation === 101333 && lp3.netBookValue === 6400000 - 101333, `${lp3.accumulatedDepreciation}`);
  }
  const rerun = await expectOk('rerun March is idempotent', ma('runMonthlyDepreciation', { barangayId: B, fiscalYear: 2026, month: 3 }));
  check('rerun returns the same run, no new JEV', rerun && rerun.alreadyRun === true && rerun.jevIds.includes(run && run.jevId), run && run.supplementary ? '(first call was a supplementary run: emulator reused)' : '');
  const deps = await db.collection('ppeDepreciation').where('ppeId', '==', laptopId).get();
  const lp4 = (await db.doc(`ppe/${laptopId}`).get()).data();
  check('one ppeDepreciation doc; accumulated unchanged', deps.size === 1 && lp4.accumulatedDepreciation === 101333);
  await expectFail('May before April refused (gap)', ma('runMonthlyDepreciation', { barangayId: B, fiscalYear: 2026, month: 5 }), /Run the earlier months first/);

  // ---- IIRUP
  const ii = await expectOk('PO encodes IIRUP for the laptop', save(po, 'iirup', { date: '2026-03-25', lines: [{ ppeId: laptopId, disposalMode: 'DESTRUCTION', appraisedValue: 0, remarks: 'Water damaged beyond repair' }] }));
  await act(po, 'iirup', ii.id, 'SUBMIT');
  const iia = await expectOk('PB approves IIRUP', act(pb, 'iirup', ii.id, 'APPROVE'));
  check('IIRUP number', /^IIRUP-2026-\d{3}$/.test(iia && iia.number), iia && iia.number);
  check('PPE UNSERVICEABLE', (await db.doc(`ppe/${laptopId}`).get()).get('status') === 'UNSERVICEABLE');
  await expectOk('PO records disposal', act(po, 'iirup', ii.id, 'DISPOSE', { payload: { disposalDate: '2026-03-28', disposalReference: 'Witnessed destruction' } }));
  check('PPE DISPOSED', (await db.doc(`ppe/${laptopId}`).get()).get('status') === 'DISPOSED');

  // ---- PPE encoded directly (existing equipment) and biological assets
  const old = await expectOk('PO encodes existing PPE with opening depreciation', save(po, 'ppe', { description: 'Desktop computer set (2023)', accountCode: '1-07-05-030', acquisitionDate: '2023-06-01', acquisitionCost: 5500000, usefulLifeYears: 5, location: 'Barangay Hall', accountablePerson: 'Rosa Diaz', openingAccumulatedDepreciation: 2612500, openingAsOfPeriod: '2025-12' }));
  await act(po, 'ppe', old.id, 'SUBMIT');
  const olda = await expectOk('PB approves PPE record', act(pb, 'ppe', old.id, 'APPROVE'));
  check('existing PPE numbered 2023-05-030-NNNN', /^2023-05-030-\d{4}$/.test((await db.doc(`ppe/${old.id}`).get()).get('propertyNumber')), olda && olda.status);
  const ptr = await expectOk('PO encodes PTR of the desktop', save(po, 'ptr', { date: '2026-03-26', transferType: 'Reassignment', receivedBy: { name: 'Kgd. Ana Lim', position: 'Barangay Kagawad' }, toLocation: 'Health Center', reason: 'Reassigned to the health center', ppeIds: [old.id] }));
  await act(po, 'ptr', ptr.id, 'SUBMIT');
  const ptra = await expectOk('PB approves PTR', act(pb, 'ptr', ptr.id, 'APPROVE'));
  const dk = (await db.doc(`ppe/${old.id}`).get()).data();
  check('desktop transferred to Ana Lim at Health Center', dk.accountablePerson === 'Kgd. Ana Lim' && dk.location === 'Health Center', ptra && ptra.number);
  const rr = await expectOk('PO encodes RRPE (desktop returned)', save(po, 'rrpe', { date: '2026-03-27', receivedBy: { name: 'Kgd. Ana Lim', position: 'Barangay Kagawad' }, reason: 'End of assignment', lines: [{ ppeId: old.id, condition: 'SERVICEABLE', remarks: 'Working' }] }));
  await act(po, 'rrpe', rr.id, 'SUBMIT');
  await expectOk('PB approves RRPE', act(pb, 'rrpe', rr.id, 'APPROVE'));
  check('desktop back in property office custody', (await db.doc(`ppe/${old.id}`).get()).get('accountablePerson') === '');
  const don = await expectOk('PO encodes ARDSM (5 reams donated)', save(po, 'donation', { iarDate: '2026-03-18', supplier: { id: null, name: 'Candoni Rural Bank' }, remarks: 'Donation for the barangay office', lines: [{ kind: 'SUPPLY', itemId: paper.id, quantity: 5, unitCost: 24000 }] }));
  const dons = await act(po, 'donation', don.id, 'SUBMIT');
  check('ARDSM number', /^ARDSM-2026-03-\d{3}$/.test(dons.number), dons.number);
  await expectOk('PB accepts donation', act(pb, 'donation', don.id, 'APPROVE'));
  check('stock 22 after donation', (await db.doc(`inventoryItems/${paper.id}`).get()).get('quantityOnHand') === 22);
  const bio = await expectOk('PO registers 2 carabaos', save(po, 'biologicalAsset', { kind: 'Carabao', description: 'Draft carabao (DA dispersal)', acquisitionDate: '2026-01-15', quantity: 2, unitCost: 4500000, location: 'Purok 3', custodian: 'Juan Dela Cruz' }));
  await act(po, 'biologicalAsset', bio.id, 'SUBMIT');
  await expectOk('PB approves biological asset', act(pb, 'biologicalAsset', bio.id, 'APPROVE'));
  await expectOk('birth recorded', po('recordBiologicalMovement', { barangayId: B, assetId: bio.id, date: '2026-03-05', kind: 'BIRTH', quantity: 1, amount: 1500000, reference: 'Vet cert 12' }));
  await expectFail('death of 5 refused (3 on hand)', po('recordBiologicalMovement', { barangayId: B, assetId: bio.id, date: '2026-03-06', kind: 'DEATH', quantity: 5 }), /Only 3 on hand/);
  check('3 carabaos on hand', (await db.doc(`biologicalAssets/${bio.id}`).get()).get('quantityOnHand') === 3);

  console.log(`\n  E2E_IDS ${JSON.stringify({ don: don.id, rrpe: rr.id, pr: pr.id, po: pord.id, iar: iar.id, ris: ris.id, ics: ics.id, par: par.id, iirup: ii.id, item: paper.id, ppe: laptopId, ppe2: old.id, bio: bio.id })}`);
  if (fails) { console.log(`\n${fails} CHECK FAILURE(S)`); process.exit(1); }
  done();
})();
