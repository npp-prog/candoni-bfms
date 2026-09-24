#!/usr/bin/env node
/**
 * One-time bootstrap: grant the first Super Admin (and optionally Municipal Accountant) role.
 * Run locally by the project owner with Application Default Credentials — never from CI, never commit keys.
 *
 *   gcloud auth application-default login
 *   node scripts/bootstrap-super-admin.mjs --project candoni-bfms-dev --email you@example.org --name "Full Name" [--accountant]
 *
 * Against emulators: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node scripts/bootstrap-super-admin.mjs --project demo-bfms ...
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]] : acc), []),
);
if (!args.project || !args.email || !args.name) {
  console.error('Usage: --project <id> --email <email> --name "<full name>" [--accountant]');
  process.exit(1);
}
initializeApp({ projectId: args.project });
const auth = getAuth();
const db = getFirestore();

let user;
try {
  user = await auth.getUserByEmail(args.email);
} catch {
  user = await auth.createUser({ email: args.email, displayName: args.name });
  console.log('Created Auth user; use "Forgot password?" on the login page to set a password.');
}
const now = Timestamp.now();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
const roles = ['super_admin', ...(args.accountant ? ['municipal_accountant'] : [])];
await db.doc(`users/${user.uid}`).set(
  { uid: user.uid, email: args.email, displayName: args.name, position: args.accountant ? 'Municipal Accountant' : 'System Administrator', active: true, defaultBarangayId: 'ALL', claimsVersion: 1, createdAt: now, updatedAt: now },
  { merge: true },
);
await db.collection('userAssignments').add({ uid: user.uid, barangayId: 'ALL', roles, active: true, validFrom: today, validTo: null, remarks: 'bootstrap', createdAt: now, createdBy: 'bootstrap', updatedAt: now, updatedBy: 'bootstrap' });
await auth.setCustomUserClaims(user.uid, { a: { ALL: roles.map((r) => (r === 'super_admin' ? 'SA' : 'MA')) }, v: 1 });
await db.collection('auditLogs').add({ timestamp: now, uid: 'bootstrap', userName: 'bootstrap script', roles: [], barangayId: 'SYSTEM', module: 'userAssignments', recordId: user.uid, action: 'CHANGE_ROLE', oldValue: null, newValue: { roles }, reason: 'initial bootstrap', source: 'script:bootstrap-super-admin', requestId: 'bootstrap', prevHash: null, hash: 'bootstrap' });
console.log(`Granted ${roles.join(', ')} @ ALL to ${args.email} (${user.uid}). Sign in, then Administration → System → Seed reference data.`);
