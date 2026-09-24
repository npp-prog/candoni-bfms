#!/usr/bin/env python3
"""Regenerate shared/src/constants/coaSeed.ts from scripts/legacy-agboy-2025-coa.json.

The JSON was extracted from the Trial Balance sheet of `01_AGBOY_2025 [COA]`.
Corrections applied (see reviewNote in the output):
  * 'Other Provisions' re-coded 2-01-02-010 -> 2-01-02-990 (duplicate code in legacy)
  * 1-03-01-011 Allowance for Impairment - AR: normal balance DEBIT -> CREDIT
"""
import json, pathlib
root = pathlib.Path(__file__).resolve().parents[1]
coa = json.loads((root / 'scripts/legacy-agboy-2025-coa.json').read_text())
seen, rows = set(), []
for x in coa:
    code, name, nb, note = x['code'], x['name'].strip(), x['normal'].upper(), None
    if code == '2-01-02-010' and name == 'Other Provisions':
        code = '2-01-02-990'
        note = ('Legacy workbook used 2-01-02-010 for both Leave Benefits Payable and Other Provisions; '
                're-coded to 2-01-02-990 pending Municipal Accountant confirmation.')
    if code == '1-03-01-011':
        nb = 'CREDIT'
        note = 'Legacy workbook tagged normal balance DEBIT; contra-asset corrected to CREDIT.'
    name = name.replace('Subidy', 'Subsidy').replace(' -Other', '- Other')
    assert code not in seen, f'duplicate {code}'
    seen.add(code)
    rows.append((code, name, nb[0], note))
out = ["/**", " * Chart of Accounts seed — barangay accounts in use by Candoni barangays.",
       " * Source: 01_AGBOY_2025 [COA] (Trial Balance sheet, 274 accounts), with corrections noted inline.",
       " * Generated once by scripts/gen-coa-seed.py; edit here, then re-seed via seedReferenceData.",
       " * Tuple: [accountCode, accountName, normalBalance ('D'|'C'), reviewNote?]", " */",
       "export type CoaSeedRow = readonly [code: string, name: string, normal: 'D' | 'C', note?: string];", "",
       "export const COA_SEED: readonly CoaSeedRow[] = ["]
for c, n, b, note in rows:
    s = f"  ['{c}', {json.dumps(n, ensure_ascii=False)}, '{b}'"
    if note:
        s += f", {json.dumps(note)}"
    out.append(s + "],")
out.append("];")
(root / 'shared/src/constants/coaSeed.ts').write_text("\n".join(out) + "\n")
print(len(rows), 'accounts written')
