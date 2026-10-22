/**
 * Firestore Security Rules tests — run with `npm run test:rules` (starts the emulator).
 * Covers the acceptance criteria: barangay isolation, role restrictions, status gates,
 * posted-entry immutability, audit-log immutability.
 */
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, collectionGroup, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;

const claims = {
  agboyTreasurer: { a: { AGBOY: ['BT'] }, v: 1 },
  bangaTreasurer: { a: { BANGA: ['BT'] }, v: 1 },
  accountant: { a: { ALL: ['MA'] }, v: 1 },
  superAdmin: { a: { ALL: ['SA'] }, v: 1 },
  auditorAgboy: { a: { AGBOY: ['AU'] }, v: 1 },
  nobody: {},
};
const as = (who: keyof typeof claims) => env.authenticatedContext(`${who}-uid`, claims[who]).firestore();

const draftDv = (uid: string, extra: Record<string, unknown> = {}) => ({
  barangayId: 'AGBOY',
  fiscalYear: 2026,
  accountingPeriod: '2026-09',
  status: 'DRAFT',
  revisionNumber: 0,
  particulars: 'Fuel',
  grossAmount: 440000,
  createdBy: uid,
  createdAt: serverTimestamp(),
  updatedBy: uid,
  updatedAt: serverTimestamp(),
  ...extra,
});

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-bfms',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
afterAll(async () => env?.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'collections/agboy1'), { barangayId: 'AGBOY', fiscalYear: 2026, status: 'DRAFT', createdBy: 'agboyTreasurer-uid', amount: 100 });
    await setDoc(doc(db, 'collections/banga1'), { barangayId: 'BANGA', fiscalYear: 2026, status: 'DRAFT', createdBy: 'bangaTreasurer-uid', amount: 100 });
    await setDoc(doc(db, 'disbursementVouchers/submitted'), { barangayId: 'AGBOY', fiscalYear: 2026, status: 'SUBMITTED', createdBy: 'agboyTreasurer-uid', netAmount: 5 });
    await setDoc(doc(db, 'disbursementVouchers/draft'), { barangayId: 'AGBOY', fiscalYear: 2026, status: 'DRAFT', createdBy: 'agboyTreasurer-uid', particulars: 'x' });
    await setDoc(doc(db, 'journalEntries/jev1'), { barangayId: 'AGBOY', fiscalYear: 2026, status: 'POSTED', totalDebit: 100, totalCredit: 100 });
    await setDoc(doc(db, 'journalEntries/jev1/lines/001'), { barangayId: 'AGBOY', jevId: 'jev1', posted: true, accountCode: '1-01-02-010', debit: 100, credit: 0 });
    await setDoc(doc(db, 'journalEntries/jevB/lines/001'), { barangayId: 'BANGA', jevId: 'jevB', posted: true, accountCode: '1-01-02-010', debit: 100, credit: 0 });
    await setDoc(doc(db, 'auditLogs/a1'), { barangayId: 'AGBOY', action: 'POST' });
    await setDoc(doc(db, 'chartOfAccounts/1-01-02-010'), { accountCode: '1-01-02-010', active: true });
  });
});

describe('barangay isolation', () => {
  it('Agboy treasurer reads Agboy, not Banga', async () => {
    await assertSucceeds(getDoc(doc(as('agboyTreasurer'), 'collections/agboy1')));
    await assertFails(getDoc(doc(as('agboyTreasurer'), 'collections/banga1')));
  });
  it('list queries must be scoped to the user’s barangay', async () => {
    const db = as('agboyTreasurer');
    await assertSucceeds(getDocs(query(collection(db, 'collections'), where('barangayId', '==', 'AGBOY'))));
    await assertFails(getDocs(collection(db, 'collections')));
    await assertFails(getDocs(query(collection(db, 'collections'), where('barangayId', '==', 'BANGA'))));
  });
  it('GL collection-group queries require barangayId filter', async () => {
    const db = as('agboyTreasurer');
    await assertSucceeds(getDocs(query(collectionGroup(db, 'lines'), where('barangayId', '==', 'AGBOY'))));
    await assertFails(getDocs(collectionGroup(db, 'lines')));
  });
  it('Municipal Accountant reads every barangay', async () => {
    await assertSucceeds(getDoc(doc(as('accountant'), 'collections/banga1')));
    await assertSucceeds(getDocs(collection(as('accountant'), 'collections')));
  });
  it('users without assignments see nothing', async () => {
    await assertFails(getDoc(doc(as('nobody'), 'chartOfAccounts/1-01-02-010')));
  });
});

describe('source-document writes', () => {
  // Source documents are written only by Cloud Functions (saveSource / module callables), which
  // validate against related records (series, obligations, balances). Even a valid draft is refused.
  it('treasurer cannot write even a valid DRAFT DV directly', async () => {
    await assertFails(setDoc(doc(as('agboyTreasurer'), 'disbursementVouchers/new1'), draftDv('agboyTreasurer-uid')));
  });
  it('cannot create in another barangay, as POSTED, with server fields, or as someone else', async () => {
    const db = as('agboyTreasurer');
    await assertFails(setDoc(doc(db, 'disbursementVouchers/x1'), draftDv('agboyTreasurer-uid', { barangayId: 'BANGA' })));
    await assertFails(setDoc(doc(db, 'disbursementVouchers/x2'), draftDv('agboyTreasurer-uid', { status: 'POSTED' })));
    await assertFails(setDoc(doc(db, 'disbursementVouchers/x3'), draftDv('agboyTreasurer-uid', { dvNumber: '2026-09-001' })));
    await assertFails(setDoc(doc(db, 'disbursementVouchers/x4'), draftDv('someone-else')));
    await assertFails(setDoc(doc(db, 'disbursementVouchers/x5'), draftDv('agboyTreasurer-uid', { netAmount: 1 })));
  });
  it('cannot edit DRAFT or SUBMITTED records directly', async () => {
    const db = as('agboyTreasurer');
    const touch = { updatedBy: 'agboyTreasurer-uid', updatedAt: serverTimestamp() };
    await assertFails(updateDoc(doc(db, 'disbursementVouchers/draft'), { particulars: 'Fuel for patrol', ...touch }));
    await assertFails(updateDoc(doc(db, 'disbursementVouchers/draft'), { status: 'SUBMITTED', ...touch }));
    await assertFails(updateDoc(doc(db, 'disbursementVouchers/draft'), { barangayId: 'BANGA', ...touch }));
    await assertFails(updateDoc(doc(db, 'disbursementVouchers/draft'), { netAmount: 1, ...touch }));
    await assertFails(updateDoc(doc(db, 'disbursementVouchers/submitted'), { particulars: 'tamper', ...touch }));
  });
  it('auditor cannot see drafts but can see submitted records', async () => {
    await assertFails(getDoc(doc(as('auditorAgboy'), 'disbursementVouchers/draft')));
    await assertSucceeds(getDoc(doc(as('auditorAgboy'), 'disbursementVouchers/submitted')));
    await assertFails(setDoc(doc(as('auditorAgboy'), 'disbursementVouchers/a1'), draftDv('auditorAgboy-uid')));
  });
});

describe('accounting core immutability', () => {
  it('nobody writes journal entries, lines, balances, sequences or audit logs from the client', async () => {
    for (const who of ['agboyTreasurer', 'accountant', 'superAdmin'] as const) {
      const db = as(who);
      await assertFails(updateDoc(doc(db, 'journalEntries/jev1'), { totalDebit: 1 }));
      await assertFails(setDoc(doc(db, 'journalEntries/jev1/lines/002'), { barangayId: 'AGBOY', jevId: 'jev1' }));
      await assertFails(setDoc(doc(db, 'accountBalances/x'), { barangayId: 'AGBOY' }));
      await assertFails(setDoc(doc(db, 'numberSequences/AGBOY_2026_JEV'), { currentNumber: 0 }));
      await assertFails(updateDoc(doc(db, 'auditLogs/a1'), { action: 'EDIT' }));
      await assertFails(setDoc(doc(db, 'chartOfAccounts/9-99-99-999'), { accountCode: '9-99-99-999' }));
    }
  });
  it('super admin has no access to transactional data by default', async () => {
    await assertFails(getDoc(doc(as('superAdmin'), 'journalEntries/jev1')));
    await assertFails(getDoc(doc(as('superAdmin'), 'collections/agboy1')));
  });
  it('audit logs are readable by accountant and auditor, not by treasurers', async () => {
    await assertSucceeds(getDoc(doc(as('accountant'), 'auditLogs/a1')));
    await assertSucceeds(getDoc(doc(as('auditorAgboy'), 'auditLogs/a1')));
    await assertFails(getDoc(doc(as('agboyTreasurer'), 'auditLogs/a1')));
  });
});
