import { BfmsError } from '@bfms/shared';
import { describe, expect, it } from 'vitest';
import { diffFields } from '../src/audit/auditWriter';
import { toHttpsError } from '../src/lib/context';

describe('audit diff', () => {
  it('records only changed top-level fields (ignores updatedAt)', () => {
    const d = diffFields({ a: 1, b: { x: 1 }, updatedAt: 1 }, { a: 1, b: { x: 2 }, c: 'new', updatedAt: 2 });
    expect(d).toEqual({ oldValue: { b: { x: 1 }, c: null }, newValue: { b: { x: 2 }, c: 'new' } });
  });
});

describe('error mapping', () => {
  it('maps domain errors to callable error codes without leaking internals', () => {
    expect(toHttpsError(new BfmsError('UNBALANCED_ENTRY', 'Total debits must equal total credits.')).code).toBe('failed-precondition');
    expect(toHttpsError(new BfmsError('SEGREGATION_OF_DUTIES', 'x')).code).toBe('permission-denied');
    expect(toHttpsError(new BfmsError('DUPLICATE_NUMBER', 'x')).code).toBe('already-exists');
    const internal = toHttpsError(new Error('db password is hunter2'));
    expect(internal.code).toBe('internal');
    expect(internal.message).not.toContain('hunter2');
  });
});
