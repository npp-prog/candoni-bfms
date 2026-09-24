import type { Centavos } from '../types/common';

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export const ZERO = 0 as Centavos;

export function isCentavos(v: unknown): v is Centavos {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

export function assertCentavos(v: unknown, field = 'amount'): Centavos {
  if (!isCentavos(v)) throw new MoneyError(`${field} must be an integer number of centavos (got ${String(v)})`);
  return v;
}

/**
 * Parse a peso amount from user/legacy input into centavos.
 * Accepts: 1234.56 · "1,234.56" · "(1,234.56)" · "-1,234.56" · "\-323.44" (Sheets export) · "₱ 1,234.5" · "-" (zero).
 * Rounds half away from zero at the centavo using string arithmetic (no float error).
 */
export function parsePesos(input: string | number | null | undefined): Centavos {
  if (input === null || input === undefined) return ZERO;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError(`Invalid amount: ${input}`);
    return parsePesos(input.toFixed(6));
  }
  let s = input.trim().replace(/\\/g, '').replace(/[₱PHP\s,]/gi, '');
  if (s === '' || s === '-' || s === '—') return ZERO;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d*(\.\d*)?$/.test(s) || s === '.') throw new MoneyError(`Invalid amount: "${input}"`);
  const [whole = '0', frac = ''] = s.split('.');
  const cents2 = (frac + '000').slice(0, 2);
  const third = Number((frac + '000')[2] ?? '0');
  let value = BigInt(whole || '0') * 100n + BigInt(cents2);
  if (third >= 5) value += 1n;
  const n = Number(negative ? -value : value);
  if (!Number.isSafeInteger(n)) throw new MoneyError(`Amount out of range: "${input}"`);
  return (Object.is(n, -0) ? 0 : n) as Centavos;
}

export function sum(values: Iterable<Centavos | number>): Centavos {
  let t = 0;
  for (const v of values) t += assertCentavos(v);
  if (!Number.isSafeInteger(t)) throw new MoneyError('Sum overflow');
  return t as Centavos;
}

export function add(a: Centavos, b: Centavos): Centavos {
  return sum([a, b]);
}

export function sub(a: Centavos, b: Centavos): Centavos {
  return sum([a, -assertCentavos(b)]);
}

export function neg(a: Centavos): Centavos {
  return (-assertCentavos(a) || 0) as Centavos;
}

/** Multiply by a rate in basis points (e.g. 5% EWT = 500), rounding half away from zero. */
export function applyRateBp(amount: Centavos, rateBp: number): Centavos {
  assertCentavos(amount);
  if (!Number.isInteger(rateBp)) throw new MoneyError('rateBp must be an integer');
  const product = BigInt(amount) * BigInt(rateBp);
  const q = product / 10000n;
  const r = product % 10000n;
  const abs = r < 0n ? -r : r;
  const rounded = abs * 2n >= 10000n ? q + (product < 0n ? -1n : 1n) : q;
  return Number(rounded) as Centavos;
}

/** Split an amount into n parts that sum exactly (remainder spread to the first parts). */
export function allocate(amount: Centavos, parts: number): Centavos[] {
  assertCentavos(amount);
  if (!Number.isInteger(parts) || parts <= 0) throw new MoneyError('parts must be a positive integer');
  const base = Math.trunc(amount / parts);
  let rem = amount - base * parts;
  const step = rem < 0 ? -1 : 1;
  return Array.from({ length: parts }, () => {
    if (rem !== 0) {
      rem -= step;
      return (base + step) as Centavos;
    }
    return base as Centavos;
  });
}

const fmt = new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Format centavos for reports. Negative values use accounting parentheses, as in the legacy books:
 * 123456 → "1,234.56"; -32344 → "(323.44)"; 0 → "-" when dashZero.
 */
export function formatPesos(v: Centavos, opts: { dashZero?: boolean; symbol?: boolean; parens?: boolean } = {}): string {
  const { dashZero = false, symbol = false, parens = true } = opts;
  assertCentavos(v);
  if (v === 0 && dashZero) return '-';
  const abs = fmt.format(Math.abs(v) / 100);
  const body = symbol ? `₱${abs}` : abs;
  if (v < 0) return parens ? `(${body})` : `-${body}`;
  return body;
}

export function toPesosNumber(v: Centavos): number {
  return assertCentavos(v) / 100;
}
