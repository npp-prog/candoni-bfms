import type { DataSource, Filter, OrderBy, WithId } from '@bfms/shared';
import type { Firestore, Query } from 'firebase-admin/firestore';

function apply(q: Query, filters: readonly Filter[], orderBy: readonly OrderBy[] = [], limit?: number): Query {
  let out = q;
  for (const [f, op, v] of filters) out = out.where(f, op, v);
  for (const [f, dir] of orderBy) out = out.orderBy(f, dir ?? 'asc');
  if (limit) out = out.limit(limit);
  return out;
}

/** Server implementation of the report DataSource (Admin SDK) — used for FINAL snapshots. */
export function adminDataSource(db: Firestore): DataSource {
  return {
    async get<T>(col: string, id: string) {
      const s = await db.collection(col).doc(id).get();
      return s.exists ? ({ ...(s.data() as T), id: s.id } as WithId<T>) : null;
    },
    async list<T>(col: string, filters: readonly Filter[], orderBy?: readonly OrderBy[], limit?: number) {
      const s = await apply(db.collection(col), filters, orderBy, limit).get();
      return s.docs.map((d) => ({ ...(d.data() as T), id: d.id }) as WithId<T>);
    },
    async listGroup<T>(sub: string, filters: readonly Filter[], orderBy?: readonly OrderBy[], limit?: number) {
      const s = await apply(db.collectionGroup(sub), filters, orderBy, limit).get();
      return s.docs.map((d) => ({ ...(d.data() as T), id: d.id }) as WithId<T>);
    },
    async listSub<T>(col: string, id: string, sub: string, orderBy?: readonly OrderBy[]) {
      const s = await apply(db.collection(col).doc(id).collection(sub), [], orderBy).get();
      return s.docs.map((d) => ({ ...(d.data() as T), id: d.id }) as WithId<T>);
    },
  };
}
