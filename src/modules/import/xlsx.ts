/**
 * ExcelJS workbook → plain sheets (`unknown[][]` per sheet) for the pure parser in
 * shared/src/accounting/workbookImport.ts. Formula cells give their cached result, rich text its
 * plain text, error cells null. Only the sheets the parser reads are converted in full; the others
 * keep their first rows (title lines used to guess the barangay).
 */
import type { Workbook, CellValue } from 'exceljs';

const FULL = /acode|py\s*db|cy\s*db|pre\s*tb|unliquidated|advances|aging|ppe/i;
const TITLE_ROWS = 10;

export function plainCell(v: CellValue | undefined): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return plainCell((v as { result?: CellValue }).result);
    if ('richText' in v) return (v as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as { text: unknown }).text);
    if ('error' in v) return null;
    if ('formula' in v || 'sharedFormula' in v) return null;
  }
  return null;
}

export function workbookToSheets(wb: Workbook): Record<string, unknown[][]> {
  const out: Record<string, unknown[][]> = {};
  wb.eachSheet((ws) => {
    const full = FULL.test(ws.name);
    const last = full ? ws.rowCount : Math.min(ws.rowCount, TITLE_ROWS);
    const rows: unknown[][] = [];
    for (let r = 1; r <= last; r++) {
      const values = ws.getRow(r).values as CellValue[] | undefined;
      rows.push(Array.isArray(values) ? values.slice(1).map(plainCell) : []);
    }
    // Trim trailing empty rows (exported sheets keep thousands of formatted blanks).
    while (rows.length && rows[rows.length - 1]!.every((c) => c === null || c === '')) rows.pop();
    out[ws.name] = rows;
  });
  return out;
}

/** Read an .xlsx File in the browser (ExcelJS is loaded on demand — it is large). */
export async function readWorkbookFile(file: File): Promise<Record<string, unknown[][]>> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  return workbookToSheets(wb);
}
