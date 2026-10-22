// E2E helpers: admin seeding + per-user client SDK callers against the emulators.
// Ports come from E2E_SLOT (see tests/e2e/emulators.sh); slot 0 = the default firebase.json ports.
const path = require('path');
const slot = Number(process.env.E2E_SLOT || 0);
const PORTS = slot ? { auth: 10099 + slot * 100, firestore: 10080 + slot * 100, functions: 10001 + slot * 100 } : { auth: 9099, firestore: 8080, functions: 5001 };
process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${PORTS.firestore}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${PORTS.auth}`;
const { createRequire } = require('module');
const r = createRequire(path.resolve(__dirname, '../../package.json'));
const admin = r('firebase-admin');
const { initializeApp } = r('firebase/app');
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = r('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = r('firebase/functions');
if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-bfms' });
const db = admin.firestore();
const CODES = { municipal_accountant: 'MA', accounting_reviewer: 'AR', accounting_staff: 'AS', punong_barangay: 'PB', barangay_treasurer: 'BT', appropriations_chair: 'AC', property_officer: 'PO', barangay_encoder: 'BE', auditor: 'AU', super_admin: 'SA' };

async function ensureUser(email, name, scope, roles) {
  let u;
  try { u = await admin.auth().getUserByEmail(email); } catch { u = await admin.auth().createUser({ email, password: 'password123', displayName: name }); }
  await admin.auth().setCustomUserClaims(u.uid, { a: { [scope]: roles.map((x) => CODES[x]) }, v: 1 });
  const now = admin.firestore.Timestamp.now();
  await db.doc(`users/${u.uid}`).set({ uid: u.uid, email, displayName: name, position: roles.join(','), active: true, defaultBarangayId: scope === 'ALL' ? 'AGBOY' : scope, claimsVersion: 1, createdAt: now, updatedAt: now });
  await db.doc(`userAssignments/${u.uid}_${scope}`).set({ uid: u.uid, barangayId: scope, roles, active: true, validFrom: '2020-01-01', validTo: null, createdAt: now, createdBy: 'e2e', updatedAt: now, updatedBy: 'e2e' });
  return u.uid;
}

const apps = {};
async function as(email) {
  if (!apps[email]) {
    const app = initializeApp({ apiKey: 'demo', projectId: 'demo-bfms' }, email);
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://127.0.0.1:${PORTS.auth}`, { disableWarnings: true });
    const fns = getFunctions(app, 'asia-southeast1');
    connectFunctionsEmulator(fns, '127.0.0.1', PORTS.functions);
    await signInWithEmailAndPassword(auth, email, 'password123');
    apps[email] = (name, data) => httpsCallable(fns, name)(data).then((x) => x.data);
  }
  return apps[email];
}

let failures = 0;
async function expectOk(label, p) {
  try { const v = await p; console.log('  ok  ', label); return v; } catch (e) { failures++; console.log('  FAIL', label, '→', e.message); return null; }
}
async function expectFail(label, p, re) {
  try { await p; failures++; console.log('  FAIL', label, '→ expected an error'); } catch (e) {
    if (re && !re.test(e.message)) { failures++; console.log('  FAIL', label, '→ wrong error:', e.message); } else console.log('  ok  ', label, `(${e.message.slice(0, 90)})`);
  }
}
module.exports = { PORTS, db, admin, ensureUser, as, expectOk, expectFail, done: () => { console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED'); process.exit(failures ? 1 : 0); } };
