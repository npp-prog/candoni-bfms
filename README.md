# BFMS: Barangay Financial Management System

Municipality of Candoni, Negros Occidental · Municipal Accounting Office

BFMS is one centralized, database-driven financial management and accounting system for the nine barangays of Candoni: Agboy, Banga, Cabia-an, Caningay, East, Gatuslao, Haba, Payauan and West. It follows the **COA Manual on the Financial Management of Barangays**. Transactions are entered once. They are then validated, certified, submitted, reviewed, accepted and posted, and every related book, register, schedule and statement is generated from them.

**Stack.** React + Vite + TypeScript + Tailwind, hosted on Netlify. Firebase Auth, Cloud Firestore, Storage and Cloud Functions (TypeScript, `asia-southeast1`). Source control on GitHub.

## Start here

- **Architecture specification:** [`docs/architecture/00-INDEX.md`](docs/architecture/00-INDEX.md) covers all 24 items of Section CV.
- **Roadmap and open decisions:** [`docs/architecture/08-roadmap.md`](docs/architecture/08-roadmap.md).

## Repository layout

| Path | What |
|---|---|
| `src/` | React app: layouts, contexts (auth/claims, barangay, toast), modules |
| `shared/` | `@bfms/shared`: all document types, permission matrix, COA seed, and the **pure accounting rules** used by both the server (enforce) and the UI (preview) |
| `functions/` | Cloud Functions: secure callable pipeline, claims sync, periods, numbering, hash-chained audit, **posting engine** |
| `firestore.rules`, `storage.rules` | Barangay isolation and immutability. Tests are in `tests/rules/` |
| `firestore.indexes.json` | Composite indexes, including the collection-group indexes for GL/SL |
| `scripts/` | Bootstrap admin, COA seed generator, report-matrix generator, legacy COA extract |

## What is built (Phase 1)

- Auth with email and password. `userAssignments` are synced to compact custom claims `{a:{AGBOY:['BT']}}`, and the client refreshes its token automatically when roles change.
- Ten roles and a 34-permission matrix. Only a Super Admin can grant privileged roles, nobody can change their own roles, and Super Admin has no accounting authority by default.
- Barangay isolation enforced **three times**: in the Security Rules, in the Storage rules, and in every Cloud Function, which re-reads assignments on each call.
- Fiscal years, 14 periods per barangay-year (00 opening, 01–12, 13 closing), and review, lock and reopen. Reopening requires a justification and flags FINAL reports as stale.
- A JEV engine: save draft, submit, approve, return, **post** and **reverse**. It enforces debit = credit, valid accounts and SL requirements, open periods, segregation of duties, gapless `YYYY-MM-NNN` numbering, atomic balance aggregates, and the audit and workflow trail, all in one Firestore transaction.
- A hash-chained, append-only audit log.
- Seeds for the 274-account COA (extracted from the Agboy 2025 workbook, with legacy errors corrected), the nine barangays, the roles, and the full report catalog (50 prescribed forms and supplementary schedules).
- UI: login, dashboard, Administration (users and roles, fiscal years and periods, COA, seed), and Accounting (JEV list and editor with a live balance preview).

## Local development

```bash
npm install
cp .env.example .env.local                 # VITE_USE_EMULATORS=true
npx firebase emulators:start --project demo-bfms   # auth, firestore, functions, storage
npm run build -w functions                  # functions are bundled to functions/lib
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
  npm run bootstrap:admin -- --project demo-bfms --email admin@example.org --name "Admin User" --accountant
npm run dev                                 # http://localhost:5173
```

Then sign in (use "Forgot password?" in the Auth emulator UI to set a password), open **Administration → System → Seed reference data**, create FY 2026, and open it for a barangay.

## Verify

```bash
npm run typecheck     # web + shared + functions
npm test              # accounting rules + permission matrix + functions libs
npm run test:rules    # Firestore rules in the emulator (needs Java 21)
npm run build
```

## Deploy

- **Netlify:** connect the GitHub repo. The build settings come from `netlify.toml`. Set the `VITE_FIREBASE_*` variables per deploy context. The suggested domain is `bfms.mgocandoni.com` (CNAME in Squarespace DNS, then add it to Firebase Auth authorized domains).
- **Firebase:** `.firebaserc` defines the aliases `dev`, `staging` and `prod`. CI deploys rules, indexes and functions using Workload Identity Federation (`.github/workflows/ci.yml`). **Never commit service-account keys.**
- Production: enable Firestore PITR and scheduled exports, App Check, and the Auth password policy (see `docs/architecture/01-system-architecture.md` §23).

## Money and dates

All amounts are **integer centavos** (`Centavos`), and accounting dates are `YYYY-MM-DD` in Asia/Manila time. Use `parsePesos` and `formatPesos` from `@bfms/shared` at the UI and report edge only.
