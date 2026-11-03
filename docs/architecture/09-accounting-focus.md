# 09 — Accounting focus (revision of November 2026)

BFMS is now the **barangay accounting system**: the Municipal Accounting Office keeps each
barangay's books from the documents the barangay submits (DVs, checks, RCDs, liquidation reports,
bank statements), as it has done in one Google Sheets workbook per barangay. Transaction processing
inside the barangay (budget, collections, disbursements, payroll, petty cash, trust funds, property
transactions, monthly submission) is **hidden** — the code stays in the repository and returns with
`VITE_ENABLE_TRANSACTION_MODULES=true`.

## Workbook → BFMS

The nine 2025 workbooks (`01_AGBOY_2025` … `09_WEST_2025`) share one template:

| Workbook sheet | BFMS |
|---|---|
| `ACODE` chart of accounts and "All SL Codes" | Chart of Accounts (seeded) · Barangay Setup → Subsidiary ledgers |
| `PY DB` opening balances | Opening-balance journal entry (period 00) |
| `01_CY DB` journal (primary ref, account, SL, debit, credit, JEV no., name, secondary/tertiary ref, date, particulars, transaction type) | **Journal Entries**: encoder by transaction type (Disbursement Voucher, Collections, Deposit, Liquidation, Others, Opening balance); register with the same columns |
| `MASTER DB`, `02.1_TB_DB`, `02.3_Rep_TB` | Trial Balance (monthly / pre-closing / post-closing) |
| `02.2_PRETB_3Y` | Pre-Closing TB, 3-year comparative (`TB_3Y`); prior years imported as `legacyBalances` |
| `Rep_SL Balances` | Schedule of Accounts |
| `03.1_Rep_Gen Ledger`, `03.2_Rep_Sub Ledger` | General Ledger, Subsidiary Ledger |
| `04.1_ChecksIssued`, `04.2_ChecksEncashed`, `04.3_ChecksRecon` (Schedule 1), `04.4_DepositRecon` (Schedule 2), `04_BR` | **Bank Reconciliation** from the journal and the bank statement; cancelled-check register |
| `Aging_Unliquidated CA` / `List of (Unliquidated) Advances` | **Unliquidated Cash Advances** schedule from the journal + legacy items |
| `PPE Depreciation Schedule` / `PPE Depr` | **PPE & Depreciation** schedule per account; generates the depreciation JEV |
| `05.1_SFPer`, `05.1A`, `05.2_SFP`, `05.2A`, `05.3_SCF`, `05.4_SCNAE` | Financial Statements with FY, FY−1, FY−2 comparatives |
| `TO DO LISTS` | **Dashboard** status board per barangay |

## Decisions

- **Posting:** staff encode and submit; the Municipal Accountant reviews and posts in one step
  (`FOR_REVIEW → POSTED`, the approval is recorded at posting). The encoder may not post their own
  entry unless Administration → System allows self-posting (audited).
- **JEV numbers:** `YYYY-MM-NNN`, allocated at posting with a yearly running counter. Legacy JEV
  numbers from imported workbooks are kept in the tertiary reference.
- **Book:** JCT when any line touches a cash account (`1-01-…`), otherwise GJ — decided from the
  lines, not chosen by the encoder.
- **Cancelled checks** are a register (`cancelledChecks`), not zero-amount journal lines.
- **Prior years** before BFMS come from the workbook's pre-closing TB. Checked on Agboy: the 2025
  and 2024 SFP, SFPerf and SCNAE columns reproduce the workbook to the centavo.

## Import

Barangay workbooks are imported from their Excel export (Import Workbook page): the browser parses
the file, shows a preview with every issue (unbalanced entries, unknown accounts/ledgers, dates
outside the year), and the server creates and posts the entries in date order (`sourceModule:
'IMPORT'`), the opening entry in period 00, the subsidiary ledgers, prior-year balances, legacy
cash advances and the PPE schedule. Nothing is uploaded to Storage.
