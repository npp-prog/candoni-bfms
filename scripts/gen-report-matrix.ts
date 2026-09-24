// Prints the COA Form/Report matrix (markdown) from the authoritative REPORT_DEFINITIONS.
// Usage: npx esbuild scripts/gen-report-matrix.ts --bundle --platform=node --format=esm | node --input-type=module
import { REPORT_DEFINITIONS, ROLES } from '../shared/src/index';
const short = (r: keyof typeof ROLES | null) => (r ? ROLES[r].claim : '—');
const rows = REPORT_DEFINITIONS.map((r) =>
  `| ${r.formNumber ?? '—'} | \`${r.reportCode}\` | ${r.reportName} | ${r.responsibleOffice.replace(/_/g, ' ').toLowerCase()} | ${short(r.preparedByRole)} | ${short(r.certifiedByRole)} | ${short(r.approvedByRole)} | ${r.frequency.replace('_', ' ').toLowerCase()} | ${r.generation} | ${r.inMonthlyPackage ? '✓' : ''} | ${r.paperSize} ${r.orientation[0]} | ${r.phase} |`,
);
console.log(['| # | Code | Report / form | Responsible office | Prep | Cert | Appr | Frequency | Gen | Pkg | Paper | Phase |', '|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n'));
