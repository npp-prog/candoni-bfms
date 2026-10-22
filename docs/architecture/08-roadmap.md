# 08 — Development Roadmap (Section CIV)

Each phase ends with a demo to Municipal Accounting, green CI (unit + rules tests), and a staging deploy. Durations assume one full-time developer working with Claude; adjust them to actual capacity.

| Phase | Scope | Exit criteria | Status |
|---|---|---|---|
| **1 Foundations** | Monorepo, Firebase config, schema/types, Auth, users/roles/assignments → claims, barangay isolation (Rules + Functions), fiscal years, periods (lock/reopen), audit writer (hash-chained), numbering, **posting engine core** (draft/submit/approve/post/reverse JEV), Admin UI, JEV UI | Rules tests pass; an Agboy user cannot read Banga; post/reverse are atomic and audited | **Built — this delivery** |
| 2 Configuration | COA maintenance UI (`coa.manage`), SL master CRUD, funds/STF funds, signatories with terms, FPP, offices, transaction types and JEV templates, settings UI | MA can maintain COA/SL; the report header resolves signatories as of a date | Partly built — barangay setup (bank accounts, subsidiary ledgers, signatories with terms, offices); COA maintenance UI, FPP and JEV templates remain |
| 3 Budget | Appropriations + adjustments, obligations + `certifyObligation`, RAO (per class), SAOB, REAI estimates | An obligation above the available balance is rejected; RAO/SAOB tie to the ordinance | **Built** |
| 4 Collections | ORs/collections (multi-line), accountable forms + RAAF gap detection, deposits, RCD/RCR, Cashbook, auto-JEV from RCD | RCD validator; cashbook roll-forward; JCT entries generated on acceptance | **Built** |
| 5 Disbursements | DV (with tax), checks (booklets, uniqueness), ADA, payroll, Checks Issued/Cancelled | DV → Obligation → Check → JEV chain in one transaction | **Built** |
| 6 Cash advance | CA from DV, aging (scheduled), liquidation with items, refunds, petty cash (PCV/PCR/SPCD) | LR reconciles; aging matches the legacy list for Agboy | **Built** |
| 7 Special Trust Funds | STF registry per fund (TRUST045/048/106/113/115/118 …), RSTF, balance guard | A charge above the STF balance is rejected | **Built** |
| 8 Books | JCT, GJ, GL, SL (collection-group queries), TB (monthly / pre / post-closing), Schedule of Accounts | TB balances; SL = GL for every SL account | **Built** |
| 9 Bank | Statements, reconciliation (two-sided), schedules, RBDCM + memo JEVs | Agboy Dec-2025 BRS reproduces: book 3,638.99 = adjusted bank | **Built** |
| 10 Property | PPE register, depreciation run + JEVs, inventory/stock cards, ICS/PAR/RIS/IAR/RRPE/IIRUP/RPCPPE/RPCI/RSMI, biological assets | Depreciation schedule ties to 1-07-xx-xx1 | **Built** |
| 11 Statements | SFPerf, DSFPerf, SFP, DSFP, SNAE/SCNAE, SCF, SCBAA, NFS editor, SMR | Agboy 2025 statements reproduce the legacy figures | **Built** |
| 12 Report Center | Report model + HTML/PDF/XLSX renderers, versioning, monthly package, compliance matrix, transmittal | Monthly package end-to-end with return and resubmit | **Built** — PDF via browser print, Excel via ExcelJS; document uploads excluded by request |
| 13 Dashboards | Barangay dashboard, municipal 9-card dashboard, financialSummaries maintenance, notifications, global search | Dashboards load from summaries in under 2 s | |
| 14 Migration | Import staging, validators (07 §20.2), preview, approval, commit; Agboy pilot, then 8 barangays | Legacy TB/SFP tie-out 0.00 per barangay | |
| 15 Year-end & go-live | Guided closing, closing entries, post-closing TB, scheduled exports, PITR, load and security testing, UAT sign-off | FY 2026 closed in staging for all 9 barangays | |

## Open decisions for the Municipal Accountant

1. **Deadlines.** Confirm each `complianceRequirements.deadlineRule` against the current MFMB and COA issuances. They are seeded with `deadlineConfirmed: false`.
2. **Liquidation due days** per CA type (`systemSettings/aging.liquidationDueDays`) are seeded as placeholders and need confirmation.
3. **COA corrections.** Confirm the `2-01-02-990` re-code for Other Provisions.
4. **Cut-over date and pilot.** The recommendation is January 1, 2026 with Agboy as pilot, which means back-loading Jan–Sep 2026 from the CY DB.
5. **Self-posting.** Keep `allowSelfPost = false`, which requires a second accounting person to approve or post. Confirm staffing allows this.
6. **Negative opening cash** (Agboy BT01/BT02). Decide on an adjusting entry before or after migration.
