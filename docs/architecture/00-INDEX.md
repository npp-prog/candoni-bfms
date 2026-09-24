# Barangay Financial Management System (BFMS) — Architecture Specification

Municipality of Candoni, Negros Occidental · Municipal Accounting Office
Specification version 1.0 · 2026-09-24 · Status: **Draft for review**

Primary functional reference: *COA Manual on the Financial Management of Barangays* (MFMB).
Secondary reference: the existing barangay workbooks (for example `01_AGBOY_2025 [COA]`) and the
earlier Apps Script prototype `Barangay Accounting System — Master`. These are used for legacy
structure and report layout only. They are **not** production data stores.

This specification answers Section CV of the master development prompt. It maps each of the
24 required items to a document:

| # | Required item | Document |
|---|---|---|
| 1 | System Architecture Diagram | [01-system-architecture.md](01-system-architecture.md#1-system-architecture-diagram) |
| 2 | Firestore Collection Structure | [02-data-model.md](02-data-model.md#2-firestore-collection-structure) |
| 3 | Detailed Firestore Schema | [02-data-model.md](02-data-model.md#3-detailed-firestore-schema) and `shared/src/types/*.ts` (authoritative) |
| 4 | Relationship / Reference Map | [02-data-model.md](02-data-model.md#4-relationship--reference-map) |
| 5 | Role and Permission Matrix | [03-security.md](03-security.md#5-role-and-permission-matrix) and `shared/src/security/permissions.ts` (authoritative) |
| 6 | Firestore Security Rules Strategy | [03-security.md](03-security.md#6-firestore-security-rules-strategy) and `firestore.rules` |
| 7 | Firebase Storage Structure | [03-security.md](03-security.md#7-firebase-storage-structure) and `storage.rules` |
| 8 | Cloud Functions Architecture | [04-accounting-engine.md](04-accounting-engine.md#8-cloud-functions-architecture) |
| 9 | Accounting Posting Architecture | [04-accounting-engine.md](04-accounting-engine.md#9-accounting-posting-architecture) |
| 10 | Transaction Workflow Diagram | [05-workflows.md](05-workflows.md#10-transaction-workflow) |
| 11 | Barangay Submission Workflow | [05-workflows.md](05-workflows.md#11-barangay-submission-workflow) |
| 12 | Municipal Accounting Review Workflow | [05-workflows.md](05-workflows.md#12-municipal-accounting-review-workflow) |
| 13 | Report Generation Architecture | [06-reporting.md](06-reporting.md#13-report-generation-architecture) |
| 14 | Report Responsibility Matrix | [06-reporting.md](06-reporting.md#14-report-responsibility-matrix) |
| 15 | COA Form / Report Matrix | [06-reporting.md](06-reporting.md#15-coa-form--report-matrix) |
| 16 | Financial Statement Mapping Architecture | [06-reporting.md](06-reporting.md#16-financial-statement-mapping-architecture) |
| 17 | Audit Trail Architecture | [04-accounting-engine.md](04-accounting-engine.md#17-audit-trail-architecture) |
| 18 | Numbering Strategy | [04-accounting-engine.md](04-accounting-engine.md#18-numbering-strategy) |
| 19 | Period Locking Strategy | [04-accounting-engine.md](04-accounting-engine.md#19-period-locking-strategy) |
| 20 | Legacy Migration Strategy | [07-migration.md](07-migration.md) |
| 21 | GitHub Repository Structure | [01-system-architecture.md](01-system-architecture.md#21-github-repository-structure) |
| 22 | Netlify Deployment Configuration | [01-system-architecture.md](01-system-architecture.md#22-netlify-deployment-configuration) |
| 23 | Firebase Environment Strategy | [01-system-architecture.md](01-system-architecture.md#23-firebase-environment-strategy) |
| 24 | Development Roadmap | [08-roadmap.md](08-roadmap.md) |

## Design decisions that apply everywhere

These decisions come up in every module, so they are fixed here once.

| Decision | Rule | Why |
|---|---|---|
| **Money** | Store every peso amount as an **integer number of centavos** (`₱1,234.56` becomes `123456`). The TypeScript type is `Centavos`. Convert only at the UI and report edge. | Avoids floating-point drift in debit = credit checks and running balances. The legacy workbook shows `(0.00)` rounding residue on the Trial Balance. |
| **Accounting dates** | Store as ISO strings `YYYY-MM-DD` in Asia/Manila local time (`jevDate`, `dvDate`, `collectionDate`). Store system event times as Firestore `Timestamp`. | A voucher date is a legal date, not an instant. Strings sort correctly and never shift across time zones. |
| **Tenant key** | Every barangay-owned document carries `barangayId` (for example `AGBOY`) and `fiscalYear` (number). Carry `accountingPeriod` (`YYYY-MM`) and `fundId` where they apply. | Barangay isolation in Security Rules and indexed queries. |
| **Deterministic IDs** | Use composite keys where uniqueness is a business rule. Examples: `accountingPeriods/AGBOY_2026_09`, `numberSequences/AGBOY_2026_JEV`, `accountBalances/AGBOY_2026_09_GF_1-01-02-010_CIB01`. | Uniqueness is enforced by the database itself, and the server can read these documents without querying. |
| **Uniqueness guards** | Store controlled numbers (OR number within a series, check number per bank account, DV number, JEV number) as `uniqueKeys/{scope}_{value}` documents. Create them inside the same transaction as the record. | Firestore has no unique indexes. A duplicate `create` fails atomically. |
| **Status changes** | Clients may create and edit only `DRAFT` and `RETURNED` source records. Every other status transition goes through a callable Cloud Function. | Workflow integrity cannot depend on the browser. |
| **Posted data** | `POSTED` JEVs, their lines, finalized reports, audit logs and workflow history are **never** client-writable. Corrections are made through new correcting, adjusting or reversing JEVs. | Immutability (Section XLV). |
| **Derived figures** | `availableBalance`, `outstandingBalance`, `totalDebit`, `difference` and every report total are recomputed on the server, using the pure functions in `shared/src/accounting/*`. | Never trust totals sent from the browser. The UI and the server use the same code, so previews match. |
| **Legacy vocabulary** | Keep the reference scheme of the existing books: *Primary Reference* = check no. / OR no., *Secondary* = DV / RCD no., *Tertiary* = other. Keep JEV numbers in the form `YYYY-MM-NNN` with a yearly running counter. Keep SL codes such as `BT01`, `CIB01`, `AO02`, `EO05` and `BIR01`. | Treasurers and COA auditors already read these. Migration is a mapping, not a reinvention. |
