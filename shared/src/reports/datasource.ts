/**
 * Minimal read API that report builders and loaders use, implemented twice:
 *   - client: src/services/datasource.ts (Firebase JS SDK, subject to Security Rules)
 *   - server: functions/src/reports/datasource.ts (Admin SDK, for FINAL snapshots)
 * Builders therefore produce byte-identical models on screen and in the stored snapshot.
 *
 * RULES REMINDER: every query on a barangay-owned collection MUST include
 * `['barangayId', '==', id]` or the client query is rejected by the rules.
 */
export type FilterOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'array-contains';
export type Filter = readonly [field: string, op: FilterOp, value: unknown];
export type OrderBy = readonly [field: string, dir?: 'asc' | 'desc'];

export type WithId<T> = T & { id: string };

export interface DataSource {
  get<T>(collection: string, id: string): Promise<WithId<T> | null>;
  list<T>(collection: string, filters: readonly Filter[], orderBy?: readonly OrderBy[], limit?: number): Promise<WithId<T>[]>;
  /** Collection-group query (e.g. 'lines' across journalEntries). */
  listGroup<T>(subcollection: string, filters: readonly Filter[], orderBy?: readonly OrderBy[], limit?: number): Promise<WithId<T>[]>;
  /** Sub-collection of one document: listSub('journalEntries', jevId, 'lines'). */
  listSub<T>(collection: string, id: string, subcollection: string, orderBy?: readonly OrderBy[]): Promise<WithId<T>[]>;
}
