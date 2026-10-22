import { formatPesos, type CellValue, type Centavos, type ColumnType } from '@bfms/shared';

/** mm/dd/yyyy, as printed on the legacy forms. */
export function printDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}

/** Cell text for screen and print. Money: centavos → 1,234.56; negatives in parentheses. */
export function formatCell(v: CellValue, type: ColumnType): string {
  if (v === null || v === undefined || v === '') return '';
  switch (type) {
    case 'money':
      return typeof v === 'number' ? formatPesos(v as Centavos) : String(v);
    case 'number':
      return typeof v === 'number' ? v.toLocaleString('en-PH') : String(v);
    case 'percent':
      return typeof v === 'number' ? `${v.toFixed(2)}%` : String(v);
    case 'date':
      return typeof v === 'string' ? printDate(v) : String(v);
    default:
      return String(v);
  }
}

export const isNumericType = (t: ColumnType) => t === 'money' || t === 'number' || t === 'percent';
