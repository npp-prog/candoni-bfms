# 03 — Security: Roles, Rules, Storage

## 5. Role and Permission Matrix

The authoritative source is `shared/src/security/permissions.ts`. That same file is used by the Cloud Functions (enforcement), the UI (menu and button visibility) and the rules tests.

### Roles

| Code | Role | Typical scope | Claim code |
|---|---|---|---|
| `super_admin` | Super Admin | `ALL` | `SA` |
| `municipal_accountant` | Municipal Accountant | `ALL` | `MA` |
| `accounting_reviewer` | Accounting Reviewer | `ALL` | `AR` |
| `accounting_staff` | Accounting Staff | `ALL` or specific barangays | `AS` |
| `punong_barangay` | Punong Barangay | one barangay | `PB` |
| `barangay_treasurer` | Barangay Treasurer | one barangay | `BT` |
| `appropriations_chair` | Chairperson, Committee on Appropriations | one barangay | `AC` |
| `property_officer` | Property / Inventory Officer | one barangay | `PO` |
| `barangay_encoder` | Barangay Encoder | one barangay | `BE` |
| `auditor` | Auditor / Read-only | `ALL` or specific barangays | `AU` |

A user can have several assignments, for example `BT@AGBOY` and `BE@AGBOY`, or `AS@ALL`. The custom claim is compact because Firebase custom claims are limited to 1000 bytes:

```json
{ "a": { "AGBOY": ["BT", "BE"] }, "v": 7 }
{ "a": { "ALL": ["MA"] }, "v": 3 }
```

`v` is the assignment version. A daily scheduled function, `resyncDatedAssignments` (00:05 PHT), re-syncs claims for assignments whose `validFrom`/`validTo` falls due, so expired roles drop out of the token and future-dated ones activate. The client forces an ID-token refresh when `users/{uid}.claimsVersion` is greater than the token's `v`. Every function also re-reads the active assignments on sensitive operations, so a revoked role stops working immediately, before the token expires.

### Permission matrix

✓ = granted · ◐ = granted but limited (see the note) · — = not granted

| Permission | SA | MA | AR | AS | PB | BT | AC | PO | BE | AU |
|---|---|---|---|---|---|---|---|---|---|---|
| `admin.users.manage` (users, roles, assignments) | ✓ | ◐¹ | — | — | — | — | — | — | — | — |
| `admin.config.manage` (barangays, deadlines, settings, report definitions) | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `coa.manage` (Chart of Accounts, report mappings) | — | ✓ | — | — | — | — | — | — | — | — |
| `subsidiary.manage` | — | ✓ | ✓ | ✓ | — | — | — | — | — | — |
| `fiscalYear.manage` | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `period.lock` | — | ✓ | ✓ | — | — | — | — | — | — | — |
| `period.reopen` (reason required) | — | ✓ | — | — | — | — | — | — | — | — |
| `budget.encode` (appropriations, estimates) | — | ✓ | — | ✓ | — | — | ✓ | — | ✓ | — |
| `budget.certify` (availability of appropriation) | — | — | — | — | — | — | ✓ | — | — | — |
| `obligation.encode` | — | — | — | — | — | ✓ | ✓ | — | ✓ | — |
| `treasury.encode` (collections, deposits, DV, checks, payroll, liquidation, petty cash) | — | — | — | — | — | ✓ | — | — | ✓ | — |
| `accountableForms.manage` | — | — | — | ✓ | — | ✓ | — | — | — | — |
| `treasury.submit` (certify & submit to Municipal Accounting) | — | — | — | — | — | ✓ | ◐² | — | — | — |
| `transaction.approve` (PB approval of DV, payroll, CA) | — | — | — | — | ✓ | — | — | — | — | — |
| `submission.review` (review, return) | — | ✓ | ✓ | ✓ | — | — | — | — | — | — |
| `submission.accept` | — | ✓ | ✓ | — | — | — | — | — | — | — |
| `jev.prepare` (draft JEV, classify accounts) | — | ✓ | ✓ | ✓ | — | — | — | — | — | — |
| `jev.review` | — | ✓ | ✓ | — | — | — | — | — | — | — |
| `jev.approve` | — | ✓ | — | — | — | — | — | — | — | — |
| `jev.post` | — | ✓ | — | — | — | — | — | — | — | — |
| `jev.reverse` (adjusting, correcting, reversing) | — | ✓ | — | — | — | — | — | — | — | — |
| `recon.prepare` | — | ✓ | ✓ | ✓ | — | ◐³ | — | — | — | — |
| `recon.finalize` | — | ✓ | — | — | — | — | — | — | — | — |
| `property.manage` | — | — | — | ✓ | — | — | — | ✓ | — | — |
| `report.generate` (live) | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `report.submit` | — | — | — | — | — | ✓ | ✓ | ✓ | — | — |
| `report.finalize` (freeze official version) | — | ✓ | — | — | — | — | — | — | — | — |
| `nfs.edit` | — | ✓ | ✓ | — | — | — | — | — | — | — |
| `attachment.upload` | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `yearEnd.close` | — | ✓ | — | — | — | — | — | — | — | — |
| `import.manage` (legacy migration) | — | ✓ | ✓ | ✓ | — | — | — | — | — | — |
| `import.approve` | — | ✓ | — | — | — | — | — | — | — | — |
| `audit.read` | ✓ | ✓ | ✓ | — | — | — | — | — | — | ✓ |
| `read.barangay` (all non-audit data in scope) | ◐⁴ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ◐⁵ |

1. The MA may assign barangay-level roles and `AS`. Only SA may grant `MA`, `SA` or `AR`. Nobody may change their own roles, and a function blocks this.
2. The Committee on Appropriations submits RAO/SAOB only.
3. The Treasurer may enter bank statement lines and propose reconciling items. Only accounting can finalize.
4. Super Admin sees configuration and users, but **not** transactional data, unless SA is also granted an accounting role. This satisfies "Super Admin must not automatically alter posted records".
5. Auditors see only records with status ≥ `SUBMITTED`, and reports with status `ACCEPTED`/`FINAL`.

**Segregation of duties** (enforced in functions):

- The preparer of a JEV cannot approve or post that same JEV, unless the barangay has `systemSettings.global.allowSelfPost = true`. That setting is off by default; it is a small-office fallback and is logged.
- The Treasurer who encoded a DV cannot also approve it as PB, even if the same person holds both assignments.
- The same person cannot both prepare and finalize a bank reconciliation.

## 6. Firestore Security Rules Strategy

The full implementation is in `/firestore.rules`, tested by `tests/rules/*.test.ts`.

**Layer model**

```
deny-by-default
 └─ isSignedIn() && isActive()                  // claims present, not disabled
     └─ hasAnyRole(resource.barangayId, readers)  // ALL-scope or bid-scope claim
         └─ hasAnyRole(bid, [...])              // role check per operation
             └─ status gate                     // resource.status in ['DRAFT','RETURNED']
                 └─ field gate                  // immutable keys, no server-owned fields
```

**Helper functions** (excerpt):

```js
function a() { return request.auth.token.a; }
function canAccessBarangay(bid) { return a().keys().hasAny([bid, 'ALL']); }
// ALL-scope first: document-independent, so Municipal Accounting list queries are provable
function hasAnyRole(bid, roles) { return a().get('ALL', []).hasAny(roles) || a().get(bid, []).hasAny(roles); }
function unchanged(keys) { return !request.resource.data.diff(resource.data).affectedKeys().hasAny(keys); }
function serverOwned() { return ['status','submittedBy','submittedAt','reviewedBy','reviewedAt','approvedBy',
  'approvedAt','postedBy','postedAt','jevId','jevNumber','totalDebit','totalCredit','availableBalance',
  'outstandingBalance','revisionNumber','returnInfo','createdAt','createdBy']; }
```

**Patterns per collection class**

| Class | Read | Create | Update | Delete |
|---|---|---|---|---|
| Reference (`chartOfAccounts`, `roles`, `reportDefinitions`, `reportMappings`, `funds`) | any signed-in active user | ✗ | ✗ | ✗ |
| Barangay master and config | in barangay scope | ✗ | ✗ | ✗ |
| Source documents (`collections`, `deposits`, `disbursementVouchers`, `checks`, `payrolls`, `liquidations`, `pettyCashTransactions`, `obligations`, `appropriations`, `ppe` …) | barangay scope and role; auditor: status ≥ SUBMITTED | role at `request.resource.data.barangayId`, `status == 'DRAFT'`, `createdBy == uid`, no server-owned fields | only if `resource.status in [DRAFT, RETURNED]`, barangayId/fiscalYear/status unchanged, no server-owned fields changed | ✗ (void through a function) |
| Accounting core (`journalEntries`, `lines`, `accountBalances`, `numberSequences`, `uniqueKeys`, `cashAdvances`, `raoEntries`, `generatedReports`, `reportSubmissions`, `financialSummaries`) | barangay scope (not SA) | ✗ | ✗ | ✗ |
| `auditLogs` | `audit.read` roles only | ✗ | ✗ | ✗ |
| `workflowHistory` | barangay scope | ✗ | ✗ | ✗ |
| `attachments` | barangay scope | uploader, own barangay, `reviewStatus` must be `INCOMPLETE` | ✗ (review through a function) | ✗ |
| `users/{uid}` | self, or admin | ✗ | self: only `displayName` and `preferences` | ✗ |
| `notifications` | recipient | ✗ | recipient: only `readAt` | ✗ |

**Why status changes are server-only.** If rules allowed `DRAFT → SUBMITTED` from the client, the client could submit a DV with a tampered `netAmount`. Instead, `submitTransaction()` re-reads the document, recomputes totals, validates the period and appropriation, stamps `submittedBy/At`, writes `workflowHistory` and `auditLogs`, and only then changes the status. All of this happens in one transaction.

**Collection-group reads.** `match /{path=**}/lines/{lineId}` allows `read` when `canAccessBarangay(resource.data.barangayId)`. Because of that, a GL query **must** include `where('barangayId','==', bid)`, or the rules reject the whole query. This makes barangay isolation hold at query time as well.

**Rules tests** (`tests/rules/firestore.rules.test.ts`, run by `npm run test:rules` in CI; acceptance criterion "Barangay users cannot access another barangay"):

- An Agboy treasurer cannot `get` a Banga collection, `list` Banga DVs, or run a collection-group query on lines without `barangayId == 'AGBOY'`.
- A treasurer cannot create a DV with `status: 'POSTED'`, cannot update a `SUBMITTED` DV, and cannot write `journalEntries`.
- Nobody (not even MA) can write `journalEntries`, `auditLogs` or `accountBalances` from the client.
- SA cannot read `journalEntries` unless SA also holds MA.

## 7. Firebase Storage Structure

```
barangays/{barangayId}/{fiscalYear}/{module}/{recordId}/{attachmentId}_{safeFileName}
   module ∈ collections | deposits | disbursements | checks | cash-advances | liquidations |
            petty-cash | payroll | bank-reconciliation | bank-statements | property | budget |
            trust-funds | accounting
barangays/{barangayId}/{fiscalYear}/reports/{reportCode}/{period}/v{version}.{pdf|xlsx}   (server-only)
imports/{batchId}/{fileName}                                                              (accounting only)
```

Example: `barangays/AGBOY/2026/liquidations/Lq8f2.../A1b2_OR-001.pdf`

**`storage.rules` enforces:**

- Read: signed in and `canAccessBarangay(barangayId)` from the path. Claims are the only input: Storage rules can call `firestore.get()`, but claims are cheaper and cannot be spoofed. An Agboy user cannot fetch a Banga file by editing the URL. Download URLs are **not** used (they are bearer tokens); the app downloads with `getBlob()`, which goes through the rules.
- **Auditors do not get direct Storage read on supporting documents.** Storage rules cannot see the parent record's status, and auditors must not see DRAFT records. They receive files through a server-issued, status-checked download (Phase 12), and they can read FINAL report files directly.
- Write: role in (`attachment.upload` roles) at that barangay. Size ≤ 25 MB. `contentType` must match `application/pdf | image/(jpeg|png|webp) | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. Overwrites and deletes are not allowed: a replacement is a new version.
- `reports/**` and `imports/**`: client write ✗. Only the Admin SDK in functions writes there.

An `onObjectFinalized` function checks that an `attachments` metadata document exists for each upload, fills in `size` and `mimeType` from the actual object, and quarantines orphans.
