# 05 — Workflows

The allowed transitions per module live in `shared/src/workflow/transitions.ts`. The server rejects any transition not listed there. Every transition writes one `workflowHistory` record and one `auditLogs` record in the same transaction.

## 10. Transaction Workflow

### Generic source-document lifecycle

```mermaid
stateDiagram-v2
  [*] --> DRAFT: encode (client write)
  DRAFT --> DRAFT: edit (client write, audited by trigger)
  DRAFT --> SUBMITTED: submitTransaction — server validates & certifies
  SUBMITTED --> FOR_REVIEW: accounting opens it (auto)
  FOR_REVIEW --> RETURNED: returnTransaction (reason, requiredCorrection, assignedTo)
  RETURNED --> RETURNED: correct (client write)
  RETURNED --> RESUBMITTED: submitTransaction (revisionNumber+1)
  RESUBMITTED --> FOR_REVIEW
  FOR_REVIEW --> ACCEPTED: acceptBarangaySubmission → generates DRAFT JEV
  ACCEPTED --> POSTED: postJournalEntry (JEV posted, source stamped)
  DRAFT --> VOID: voidTransaction (reason)
  SUBMITTED --> VOID: voidTransaction (MA, reason)
  POSTED --> [*]
```

### DV-specific path (disbursement chain from Section CIII)

```mermaid
flowchart LR
  A["DV DRAFT<br/>(Treasurer)"] --> B["Obligation<br/>certifyObligation (AC)<br/>available ≥ amount?"]
  B -->|no| X["rejected: insufficient appropriation"]
  B -->|yes| C["RAO line written"]
  C --> D["PB approves DV<br/>dvNumber assigned"]
  D --> E["Check PREPARED→ISSUED<br/>(uniqueKey per bank+check no.)"]
  E --> F["Cashbook line (derived)"]
  F --> G["Monthly submission"]
  G --> H["Accounting accepts<br/>DRAFT JEV (JCT)"]
  H --> I["postJournalEntry"]
  I --> J["GL/SL · TB · FS"]
  E -.cash advance type.-> K["cashAdvances ACTIVE<br/>(AO/EO subsidiary)"]
  K --> L["Liquidation → GJ JEV → CA balance"]
```

Validations at each gate:

| Gate | Server check |
|---|---|
| Certify obligation | Appropriation exists, same barangay/FY/fund, status ACTIVE. `available ≥ amount`. For STF charges: `stf.balance ≥ amount`. |
| PB approval | Obligation certified. `gross − tax − other = net`. Supporting documents for the DV type exist in `attachments` (the checklist comes from `transactionTypes`). Approver ≠ preparer. |
| Issue check | Check number is within the booklet range and not already used for that bank account. Amount = DV net. |
| Submit | Period OPEN/REVIEW. All required fields present. Totals recomputed. |
| Accept | Reviewer has `submission.accept`. The JEV template resolves to active accounts. |
| Post | See [04 §9](04-accounting-engine.md#9-accounting-posting-architecture). |

## 11. Barangay Submission Workflow

This is the monthly cycle for each barangay.

```mermaid
sequenceDiagram
  actor BT as Barangay Treasurer
  actor AC as Committee on Appropriations
  actor PB as Punong Barangay
  participant SYS as BFMS
  actor MA as Municipal Accounting
  BT->>SYS: Encode ORs, deposits, DVs, checks, payroll, CA, liquidations (throughout month)
  AC->>SYS: Certify obligations; RAO updates automatically
  PB->>SYS: Approve DVs / payrolls / CAs
  BT->>SYS: Upload bank statement, deposit slips, supporting docs
  BT->>SYS: "Generate Monthly Submission Package" (month M)
  SYS-->>BT: Checklist: REQUIRED / GENERATED / MISSING / NOT APPLICABLE + validation (PASSED/WARNING/FAILED)
  BT->>SYS: Fix FAILED items (e.g., RCD collections ≠ deposits unexplained)
  BT->>SYS: Certify & Submit package (Cashbook, RCD, RAAF, Checks Issued, CA/LR, Payroll, REAI; AC submits RAO/SAOB)
  SYS->>MA: Notification "AGBOY 2026-09 package submitted"
  SYS->>SYS: accountingPeriods/AGBOY_2026_09 → REVIEW; reportSubmissions cells → SUBMITTED
```

The package is a `generatedReports` bundle: each report is a versioned snapshot with `sourceDataCutoff`. The package manifest records every report's version, so later edits cannot silently change what was submitted.

## 12. Municipal Accounting Review Workflow

```mermaid
flowchart TB
  Q["Review queue<br/>(compliance matrix → cell click)"] --> R{"Review each item<br/>docs complete? amounts tie?"}
  R -->|deficient| RET["Return<br/>reasonForReturn, requiredCorrection,<br/>assignedTo, revisionNumber+1"]
  RET --> N1["Notify Treasurer"] --> BT["Treasurer corrects → RESUBMITTED"] --> Q
  R -->|ok| ACC["Accept → DRAFT JEVs generated<br/>(JCT for cash, GJ for non-cash)"]
  ACC --> CLS["Classify / adjust accounts (AS/AR)"]
  CLS --> REV["Review JEV (AR)"] --> APP["Approve (MA)"] --> POST["Post (MA)"]
  POST --> BR["Bank Reconciliation (AS prepares, MA finalizes)"]
  BR --> TB["Monthly TB — must balance"]
  TB --> LOCK["Lock period"]
  LOCK --> FIN["Finalize monthly reports (FINAL versions)"]
  FIN --> CM["Compliance matrix cell = ACCEPTED"]
```

Return records are never overwritten. Each return appends to `returnHistory[]` on the document, and `workflowHistory` holds the full trail, so the original and every revision stay visible.
