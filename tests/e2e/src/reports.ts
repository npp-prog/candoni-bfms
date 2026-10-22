// Usage: tests/e2e/reports.sh [CODES…]  (env P='{"month":3}' overrides params, DUMP=CODE prints the model)
// Runs report builders through the Admin DataSource against the emulator and prints a summary.
const slot = Number(process.env.E2E_SLOT || 0);
process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${slot ? 10080 + slot * 100 : 8080}`;
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { REPORT_BUILDERS, reportBuilder, runReport, type ReportModel } from '@bfms/shared';
import { adminDataSource } from '../../../functions/src/reports/datasource';

if (!getApps().length) initializeApp({ projectId: 'demo-bfms' });
const ds = adminDataSource(getFirestore());
const codes = process.argv.slice(2);
const list = codes.length ? codes : REPORT_BUILDERS.map((b) => b.code);
let failures = 0;
(async () => {
  for (const code of list) {
    const b = reportBuilder(code)!;
    const params: Record<string, unknown> = { barangayId: 'AGBOY', fiscalYear: 2026, month: 3 };
    for (const [k, v] of process.env.P ? Object.entries(JSON.parse(process.env.P)) : []) params[k] = v;
    for (const e of b.extras ?? []) if (e.required && e.options && !params[e.key]) params[e.key] = e.options[0]!.value;
    try {
      const m: ReportModel = await runReport(b, ds, params as never);
      const rows = m.sections.reduce((t, s) => t + (s.kind === 'table' ? s.rows.length : 0), 0);
      console.log(`  ${code.padEnd(20)} sections=${m.sections.length} rows=${rows} empty=${m.isEmpty} sig=${m.signatories.map((s) => s.name || '(blank)').join('|')} ${m.validations.map((v) => `${v.id}:${v.result}`).join(' ')}`);
      if (process.env.DUMP === code) console.log(JSON.stringify(m, null, 1).slice(0, 6000));
    } catch (e) {
      failures++;
      console.log(`  ${code.padEnd(20)} ERROR ${(e as Error).message}`);
    }
  }
  process.exit(failures ? 1 : 0);
})();
