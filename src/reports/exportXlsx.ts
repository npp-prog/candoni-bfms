import type { ReportModel, TableSection } from '@bfms/shared';
import { formatCell, isNumericType } from './format';

const PAPER = { A4: 9, LEGAL: 5, LETTER: 1 } as const;
const MONEY_FMT = '#,##0.00;(#,##0.00);"-"';

/**
 * Excel export of a ReportModel (ExcelJS, loaded on demand). Money cells are real numbers in
 * pesos with a peso number format, so totals can be re-footed in Excel like the legacy workbooks.
 */
export async function exportReportXlsx(model: ReportModel, fileName: string): Promise<void> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BFMS Candoni';
  const ws = wb.addWorksheet(model.code.slice(0, 31), {
    pageSetup: { paperSize: PAPER[model.paper.size] as never, orientation: model.paper.orientation === 'LANDSCAPE' ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  });
  const width = Math.max(4, ...model.sections.filter((s): s is TableSection => s.kind === 'table').map((s) => s.columns.length));
  let r = 1;
  const centered = (text: string, bold = false, size = 11) => {
    ws.mergeCells(r, 1, r, width);
    const c = ws.getCell(r, 1);
    c.value = text;
    c.font = { bold, size };
    c.alignment = { horizontal: 'center' };
    r++;
  };
  model.agencyHeader.forEach((l, i) => centered(l, i === model.agencyHeader.length - 1));
  r++;
  centered(model.title.toUpperCase(), true, 13);
  model.subtitle.forEach((l) => centered(l));
  r++;
  for (const m of model.meta) {
    ws.getCell(r, 1).value = `${m.label}:`;
    ws.getCell(r, 1).font = { bold: true };
    ws.getCell(r, 2).value = m.value;
    r++;
  }
  if (model.meta.length) r++;

  const thin = { style: 'thin' as const };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  for (const s of model.sections) {
    if (s.kind === 'table') {
      if (s.title) {
        ws.getCell(r, 1).value = s.title;
        ws.getCell(r, 1).font = { bold: true };
        r++;
      }
      if (s.columns.some((c) => c.group)) {
        let c0 = 0;
        while (c0 < s.columns.length) {
          const g = s.columns[c0]!.group;
          let c1 = c0;
          while (c1 + 1 < s.columns.length && g && s.columns[c1 + 1]!.group === g) c1++;
          if (c1 > c0) ws.mergeCells(r, c0 + 1, r, c1 + 1);
          const cell = ws.getCell(r, c0 + 1);
          cell.value = g ?? '';
          cell.font = { bold: true };
          cell.alignment = { horizontal: 'center' };
          for (let k = c0; k <= c1; k++) ws.getCell(r, k + 1).border = border;
          c0 = c1 + 1;
        }
        r++;
      }
      s.columns.forEach((c, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = c.label;
        cell.font = { bold: true };
        cell.alignment = { horizontal: 'center', vertical: 'bottom', wrapText: true };
        cell.border = border;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
        const w = ws.getColumn(i + 1);
        w.width = Math.max(w.width ?? 10, c.type === 'money' ? 16 : c.type === 'date' ? 12 : (c.width ?? 1) * 14);
      });
      r++;
      for (const row of s.rows) {
        const bold = row.style && row.style !== 'normal' && row.style !== 'note';
        s.columns.forEach((c, i) => {
          const cell = ws.getCell(r, i + 1);
          const v = row.cells[c.key] ?? null;
          if (c.type === 'money' && typeof v === 'number') {
            cell.value = v / 100;
            cell.numFmt = MONEY_FMT;
          } else if (isNumericType(c.type) && typeof v === 'number') {
            cell.value = c.type === 'percent' ? v / 100 : v;
            if (c.type === 'percent') cell.numFmt = '0.00%';
          } else cell.value = formatCell(v, c.type);
          cell.border = border;
          if (bold) cell.font = { bold: true };
          if (i === 0 && row.indent) cell.alignment = { indent: row.indent };
        });
        r++;
      }
      r++;
    } else if (s.kind === 'fields') {
      if (s.title) (ws.getCell(r++, 1).value = s.title), (ws.getCell(r - 1, 1).font = { bold: true });
      for (const f of s.fields) {
        ws.getCell(r, 1).value = f.label;
        ws.getCell(r, 1).font = { bold: true };
        const v = f.value;
        if (f.type === 'money' && typeof v === 'number') {
          ws.getCell(r, 2).value = v / 100;
          ws.getCell(r, 2).numFmt = MONEY_FMT;
        } else ws.getCell(r, 2).value = formatCell(v, f.type ?? 'text');
        r++;
      }
      r++;
    } else if (s.kind === 'text') {
      if (s.title) (ws.getCell(r++, 1).value = s.title), (ws.getCell(r - 1, 1).font = { bold: true });
      for (const p of s.paragraphs) {
        ws.mergeCells(r, 1, r, width);
        ws.getCell(r, 1).value = p;
        ws.getCell(r, 1).alignment = { wrapText: true, vertical: 'top' };
        ws.getRow(r).height = Math.min(200, 15 * Math.ceil(p.length / (width * 14)));
        r++;
      }
      r++;
    } else if (s.kind === 'certifications') {
      for (const b of s.boxes) {
        ws.getCell(r, 1).value = b.label;
        ws.getCell(r, 1).font = { bold: true };
        if (b.text) ws.getCell(r, 2).value = b.text;
        r++;
        ws.getCell(r, 2).value = b.name.toUpperCase();
        ws.getCell(r, 2).font = { bold: true };
        ws.getCell(r + 1, 2).value = b.position;
        r += 3;
      }
    }
  }
  if (model.signatories.length) {
    r += 1;
    const step = Math.max(1, Math.floor(width / model.signatories.length));
    model.signatories.forEach((s, i) => {
      const c = 1 + i * step;
      ws.getCell(r, c).value = `${s.label}:`;
      ws.getCell(r + 3, c).value = s.name.toUpperCase();
      ws.getCell(r + 3, c).font = { bold: true };
      ws.getCell(r + 3, c).border = { top: thin };
      ws.getCell(r + 4, c).value = s.position;
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
