// Google sign-up: requestAccess registers a new Google user with no roles and a PENDING request;
// the Municipal Accountant assigns a role, which marks the request APPROVED.
// The Auth emulator accepts an unsigned JSON id token for google.com credentials.
const path = require('path');
const { createRequire } = require('module');
const { PORTS, db, as, expectOk, expectFail, done } = require('./lib.cjs');
const r = createRequire(path.resolve(__dirname, '../../package.json'));
const { initializeApp } = r('firebase/app');
const { getAuth, connectAuthEmulator, signInWithCredential, signInWithEmailAndPassword, GoogleAuthProvider } = r('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = r('firebase/functions');

function client(name) {
  const app = initializeApp({ apiKey: 'demo', projectId: 'demo-bfms' }, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://127.0.0.1:${PORTS.auth}`, { disableWarnings: true });
  const fns = getFunctions(app, 'asia-southeast1');
  connectFunctionsEmulator(fns, '127.0.0.1', PORTS.functions);
  return { auth, call: (n, d) => httpsCallable(fns, n)(d).then((x) => x.data) };
}

(async () => {
  console.log('Google sign-up');
  const stamp = Date.now();
  const email = `g${stamp}@example.com`;
  const g = client(`google-${stamp}`);
  const cred = GoogleAuthProvider.credential(JSON.stringify({ sub: `g-${stamp}`, email, email_verified: true, name: 'Ana Reyes' }));
  const { user } = await signInWithCredential(g.auth, cred);

  const r1 = await expectOk('first Google sign-in registers an access request', g.call('requestAccess', {}));
  if (r1?.status !== 'PENDING') console.log('  FAIL status', r1);
  const doc = (await db.doc(`users/${user.uid}`).get()).data();
  if (!doc || doc.accessRequest?.status !== 'PENDING' || doc.email !== email || doc.displayName !== 'Ana Reyes') { console.log('  FAIL user doc', doc); process.exitCode = 1; }
  const r2 = await expectOk('second call is idempotent', g.call('requestAccess', {}));
  if (r2?.status !== 'PENDING') console.log('  FAIL idempotent status', r2);
  await expectFail('no roles yet: protected callables refuse', g.call('setAllowSelfPost', { allow: true, reason: 'should be refused for a user with no role' }), /permission|do not have/i);

  // Email/password users cannot use requestAccess to register themselves.
  const p = client(`pw-${stamp}`);
  await r('firebase-admin').auth().createUser({ email: `pw${stamp}@example.com`, password: 'password123' });
  await signInWithEmailAndPassword(p.auth, `pw${stamp}@example.com`, 'password123');
  await expectFail('email/password account cannot self-register', p.call('requestAccess', {}), /Google/);

  const ma = await as('ma@test.local');
  await expectOk('MA assigns a role', ma('setUserAssignment', { uid: user.uid, barangayId: 'AGBOY', roles: ['accounting_staff'], remarks: 'Google sign-up approved' }));
  const after = (await db.doc(`users/${user.uid}`).get()).data();
  if (after.accessRequest?.status !== 'APPROVED') { console.log('  FAIL request not approved', after.accessRequest); process.exitCode = 1; } else console.log('  ok   request marked APPROVED');
  const audit = await db.collection('auditLogs').where('recordId', '==', user.uid).where('source', '==', 'callable:requestAccess').get();
  if (audit.size !== 1) { console.log('  FAIL audit entries', audit.size); process.exitCode = 1; } else console.log('  ok   sign-up audited');
  done();
})().catch((e) => { console.error(e); process.exit(1); });
